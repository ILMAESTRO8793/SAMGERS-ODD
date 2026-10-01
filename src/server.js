import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPORTS, BOOKS, TZ, DAY, trackedKeys } from './config.js';
import { migrate, q, getConfig, setConfig, eventsBySports, creditsSummary } from './db.js';
import { quota } from './odds.js';
import { startCollector, setNotifier, viewers, state, run, liveJob, refreshUpcoming, findOpening, fillBefore, fetchProps } from './collector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

/* ---------- usuarios y sesiones ---------- */
const USERS = new Map((process.env.USERS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const i = s.indexOf(':');
  return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1)];
}));
if (!USERS.size) console.warn('Aviso: no hay USERS configurados; nadie podrá entrar.');
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('Aviso: falta SESSION_SECRET; las sesiones se cerrarán en cada reinicio.');

const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function makeToken(user) {
  const body = `${Buffer.from(user).toString('base64url')}.${Date.now() + 120 * DAY}`;
  return `${body}.${sign(body)}`;
}
function readToken(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 3) return null;
  const body = parts[0] + '.' + parts[1];
  if (!safeEq(sign(body), parts[2]) || Number(parts[1]) < Date.now()) return null;
  const user = Buffer.from(parts[0], 'base64url').toString();
  return USERS.has(user) ? user : null;
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
function setSession(req, res, value, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${value}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`);
}
const attempts = new Map();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));

app.post('/api/login', (req, res) => {
  const ip = req.ip, a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 6) return res.status(429).json({ error: 'loginMany' });
  a.n++; attempts.set(ip, a);
  const user = String(req.body.user || '').trim().toLowerCase(), pass = String(req.body.pass || '');
  if (!USERS.has(user) || !safeEq(USERS.get(user), pass)) return res.status(401).json({ error: 'loginBad' });
  attempts.delete(ip);
  setSession(req, res, makeToken(user), 120 * 86400);
  res.json({ user });
});
app.post('/api/logout', (req, res) => { setSession(req, res, '', 0); res.json({ ok: true }); });

app.use('/api', (req, res, next) => {
  const user = readToken(cookies(req).sid);
  if (!user) return res.status(401).json({ error: 'auth' });
  req.user = user;
  next();
});

/* ---------- datos ---------- */
const shape = r => ({
  id: r.id, sport: r.sport, home: r.home, away: r.away, c: r.commence.getTime(),
  snaps: { open: r.open_snap, before: r.before_snap },
  live: r.live_snap, books: r.books, score: r.score, ended: r.ended,
  pub: r.pub_at ? { at: r.pub_at.getTime(), from: r.pub_from ? r.pub_from.getTime() : null, hist: r.pub_hist } : null,
  chk: r.last_check ? r.last_check.getTime() : null,
  last: [r.live_snap, r.cur_snap, r.before_snap, r.open_snap].filter(Boolean).sort((a, b) => b.t - a.t)[0] || null
});
async function statusInfo() {
  const cfg = await getConfig();
  const c = await creditsSummary();
  return {
    remaining: quota.remaining ?? c.remaining, used24: c.used24, byKind: c.byKind, cap: cfg.dailyCap, capHit: state.capHit,
    lastRun: state.lastRun, lastError: state.lastError, viewers: viewers.size
  };
}

app.get('/api/me', async (req, res) => res.json({ user: req.user, tz: TZ, sports: SPORTS, books: BOOKS, config: await getConfig() }));

app.get('/api/events', async (req, res) => {
  const cfg = await getConfig();
  const tab = SPORTS[req.query.tab] ? req.query.tab : 'nfl';
  const keys = trackedKeys(cfg, tab);
  const now = Date.now();
  const rows = keys.length ? await eventsBySports(keys, now - 14 * DAY, now + 30 * DAY) : [];
  res.json({ events: rows.map(shape), status: await statusInfo() });
});

app.get('/api/status', async (req, res) => res.json(await statusInfo()));

app.put('/api/config', async (req, res) => {
  const b = req.body || {}, patch = {};
  if (b.sports) patch.sports = Object.fromEntries(Object.keys(SPORTS).map(t => [t, !!b.sports[t]]));
  if (Array.isArray(b.leagues)) patch.leagues = b.leagues.filter(k => SPORTS.soc.some(l => l.k === k));
  if (Array.isArray(b.books)) patch.books = ['fanduel', ...b.books.filter(k => BOOKS[k] && k !== 'fanduel')];
  if (b.extras != null) patch.extras = !!b.extras;
  if (typeof b.ladder === 'string') patch.ladder = b.ladder.slice(0, 100);
  if ([60, 120, 300].includes(Number(b.liveSec))) patch.liveSec = Number(b.liveSec);
  if ([30, 60, 120].includes(Number(b.watchMin))) patch.watchMin = Number(b.watchMin);
  if (Number(b.dailyCap) >= 0) patch.dailyCap = Math.min(100000, Math.round(Number(b.dailyCap)));
  res.json({ config: await setConfig(patch) });
  broadcast();
});

app.post('/api/refresh', async (req, res) => {
  const tab = SPORTS[req.query.tab] ? req.query.tab : 'nfl';
  await run('actualizar', async () => (await refreshUpcoming(tab)) | (await liveJob(tab)));
  res.json({ ok: true, error: state.lastError && Date.now() - state.lastError.at < 5000 ? state.lastError.message : null });
});

async function eventRow(id) { const r = await q('select * from events where id = $1', [id]); return r.rows[0]; }
app.post('/api/events/:id/find-opening', async (req, res) => {
  const e = await eventRow(req.params.id); if (!e) return res.status(404).json({ error: 'notFound' });
  try { res.json(await findOpening(e)); } catch (err) { res.status(502).json({ error: err.message }); }
});
app.get('/api/events/:id/props', async (req, res) => {
  const r = await q('select props_open, props, props_t from events where id = $1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'notFound' });
  const x = r.rows[0];
  res.json({ open: x.props_open, cur: x.props, checked: x.props_t ? x.props_t.getTime() : null });
});
app.post('/api/events/:id/props/refresh', async (req, res) => {
  const e = await eventRow(req.params.id); if (!e) return res.status(404).json({ error: 'notFound' });
  if (e.sport !== 'basketball_nba') return res.status(400).json({ error: 'notNba' });
  try { const ok = await fetchProps(e, 'props-manual'); res.json({ ok }); } catch (err) { res.status(502).json({ error: err.message }); }
});
app.post('/api/events/:id/fill-before', async (req, res) => {
  const e = await eventRow(req.params.id); if (!e) return res.status(404).json({ error: 'notFound' });
  try { res.json(await fillBefore(e)); } catch (err) { res.status(502).json({ error: err.message }); }
});

/* ---------- en vivo: aviso a las apps abiertas ---------- */
const streams = new Map();
function broadcast() { for (const res of streams.values()) res.write('event: update\ndata: {}\n\n'); }
setNotifier(broadcast);
app.get('/api/stream', (req, res) => {
  const id = crypto.randomUUID();
  const tab = SPORTS[req.query.tab] ? req.query.tab : 'nfl';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n\n');
  streams.set(id, res);
  viewers.set(id, { tab });
  const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
  req.on('close', () => { clearInterval(ping); streams.delete(id); viewers.delete(id); });
});

/* ---------- app ---------- */
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, p) => { if (/\.(html|webmanifest|js)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); }
}));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

await migrate();
app.listen(PORT, () => {
  console.log(`SAMGERS ODDS en el puerto ${PORT} (zona horaria ${TZ})`);
  startCollector();
});
