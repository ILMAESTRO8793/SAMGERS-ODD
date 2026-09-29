import { FEATURED, EXTRA_SOC, DAY, tabOf, trackedKeys, dayKey, hhmm } from './config.js';
import { getConfig, upsertEvent, updateEvent, addSnapshot, eventsBySports, usedLast24, prune } from './db.js';
import { apiGet, norm, allBooks, withExtras } from './odds.js';

export const state = { lastRun: {}, lastError: null, lastWatch: 0, lastLive: 0, done: new Set(), queued: new Set(), capHit: false };
export const viewers = new Map(); // id -> { tab }
let notify = () => {};
export const setNotifier = fn => { notify = fn; };

let chain = Promise.resolve();
export function run(name, fn) {
  if (state.queued.has(name)) return chain;
  state.queued.add(name);
  chain = chain.then(async () => {
    try {
      const changed = await fn();
      state.lastRun[name] = Date.now();
      if (changed) notify();
    } catch (e) {
      state.lastError = { job: name, message: e.message, at: Date.now() };
      console.error(`[${name}]`, e.message);
    } finally { state.queued.delete(name); }
  });
  return chain;
}

const oddsParams = (books = 'fanduel', markets = FEATURED) =>
  ({ regions: 'us', bookmakers: books, markets, oddsFormat: 'decimal', dateFormat: 'iso' });
const bookList = cfg => ['fanduel', ...cfg.books.filter(b => b !== 'fanduel')].slice(0, 10).join(',');
const isSoc = (cfg, k) => tabOf(k) === 'soc' && cfg.extras;
const groupBy = (rows, f) => rows.reduce((m, r) => (m.get(f(r)) || m.set(f(r), []).get(f(r))).push(r) && m, new Map());

async function extrasFor(k, id, kind) {
  return norm(await apiGet(`/sports/${k}/events/${id}/odds`, oddsParams('fanduel', EXTRA_SOC), kind, { allow404: true }));
}

/* 1) Vigilancia: detecta cuándo FanDuel publica cada partido y guarda la apertura. */
async function watchJob() {
  const cfg = await getConfig();
  let changed = false;
  for (const k of trackedKeys(cfg)) {
    const evs = await apiGet(`/sports/${k}/events`, { dateFormat: 'iso' }, 'vigilancia', { allow404: true }) || [];
    for (const ev of evs) await upsertEvent(ev, k);
    const now = Date.now();
    const rows = await eventsBySports([k], now, now + 30 * DAY);
    const due = rows.filter(e => !e.open_snap &&
      (!e.last_check || now - e.last_check.getTime() >= Math.min(6 * 3600e3, 30 * 60e3 * 2 ** Math.min(e.checks, 4))));
    if (!due.length) continue;
    const data = await apiGet(`/sports/${k}/odds`, oddsParams(), 'apertura', { allow404: true }) || [];
    const byId = new Map(data.map(e => [e.id, e]));
    const t = Date.now();
    for (const e of due) {
      const o = norm(byId.get(e.id));
      if (!o) { await updateEvent(e.id, { last_check: new Date(t), checks: e.checks + 1 }); continue; }
      const snap = { t, o, src: 'live' };
      if (isSoc(cfg, k)) { const x = await extrasFor(k, e.id, 'apertura-extras'); if (x) snap.o = withExtras(o, x); }
      await updateEvent(e.id, { open_snap: snap, pub_at: new Date(t), pub_from: e.last_check, last_check: new Date(t) });
      await addSnapshot(e.id, 'open', snap);
      changed = true;
    }
  }
  return changed;
}

/* 2) Día antes: última cuota del día anterior al partido (18:00 y 23:50, hora de Panamá). */
export async function beforeJob() {
  const cfg = await getConfig();
  const now = Date.now(), tomorrow = dayKey(now + DAY);
  const rows = (await eventsBySports(trackedKeys(cfg), now, now + 2 * DAY)).filter(e => dayKey(e.commence) === tomorrow);
  let changed = false;
  for (const [k, list] of groupBy(rows, r => r.sport)) {
    const data = await apiGet(`/sports/${k}/odds`, oddsParams(), 'dia-antes', { allow404: true }) || [];
    const byId = new Map(data.map(e => [e.id, e]));
    const t = Date.now();
    for (const e of list) {
      const o = norm(byId.get(e.id));
      if (!o) continue;
      const snap = { t, o, src: 'live' };
      if (isSoc(cfg, k)) { const x = await extrasFor(k, e.id, 'dia-antes-extras'); if (x) { snap.o = withExtras(o, x); await updateEvent(e.id, { xo: x, xt: new Date(t) }); } }
      if (!e.open_snap) await updateEvent(e.id, { open_snap: snap, pub_at: new Date(t), pub_from: e.last_check });
      await updateEvent(e.id, { before_snap: snap });
      await addSnapshot(e.id, 'before', snap);
      changed = true;
    }
  }
  return changed;
}

/* 3) Cierre: cuota justo antes del inicio (aunque nadie tenga la app abierta). */
export async function closeJob() {
  const cfg = await getConfig();
  const now = Date.now();
  const rows = (await eventsBySports(trackedKeys(cfg), now, now + 10 * 60e3)).filter(e => !e.close_done);
  if (!rows.length) return false;
  let changed = false;
  for (const [k, list] of groupBy(rows, r => r.sport)) {
    const data = await apiGet(`/sports/${k}/odds`, oddsParams(bookList(cfg)), 'cierre', { allow404: true }) || [];
    const byId = new Map(data.map(e => [e.id, e]));
    const t = Date.now();
    for (const e of list) {
      const ev = byId.get(e.id), o = norm(ev);
      if (o) {
        const snap = { t, o: withExtras(o, e.xo), src: 'live', inplay: false };
        await updateEvent(e.id, { live_snap: snap, books: { t, by: allBooks(ev), inplay: false } });
        await addSnapshot(e.id, 'close', snap);
        changed = true;
      }
      await updateEvent(e.id, { close_done: true });
    }
  }
  return changed;
}

/* 4) En vivo: solo mientras alguien tenga la app abierta (o al pulsar Actualizar ahora). */
const liveSnapAt = new Map();
export async function liveJob(forceTab) {
  const cfg = await getConfig();
  const tabs = forceTab ? new Set([forceTab]) : new Set([...viewers.values()].map(v => v.tab));
  if (!tabs.size) return false;
  if (!forceTab) {
    const used = await usedLast24();
    state.capHit = used >= cfg.dailyCap;
    if (state.capHit) return false;
  }
  const keys = [...new Set([...tabs].flatMap(tb => trackedKeys(cfg, tb)))];
  const now = Date.now(), today = dayKey(now);
  const rows = (await eventsBySports(keys, now - 6 * 3600e3, now + 36 * 3600e3)).filter(e => {
    const c = e.commence.getTime();
    return !e.ended && ((c > now && dayKey(c) === today) || (c <= now && now - c < 5 * 3600e3));
  });
  if (!rows.length) return false;
  let changed = false;
  for (const [k, list] of groupBy(rows, r => r.sport)) {
    if (list.some(e => e.commence.getTime() <= now)) {
      const sc = await apiGet(`/sports/${k}/scores`, { daysFrom: 1, dateFormat: 'iso' }, 'marcador', { allow404: true }) || [];
      const ids = new Set(list.map(e => e.id));
      for (const g of sc) {
        if (!ids.has(g.id) || !g.scores) continue;
        const get = n => { const r = g.scores.find(x => x.name === n); return r ? r.score : null; };
        await updateEvent(g.id, { score: { h: get(g.home_team), a: get(g.away_team), done: !!g.completed, t: g.last_update ? Date.parse(g.last_update) : now }, ...(g.completed ? { ended: true } : {}) });
        if (g.completed) list.find(e => e.id === g.id).ended = true;
        changed = true;
      }
    }
    const data = await apiGet(`/sports/${k}/odds`, oddsParams(bookList(cfg)), 'en-vivo', { allow404: true }) || [];
    const byId = new Map(data.map(e => [e.id, e]));
    const t = Date.now();
    for (const e of list) {
      if (e.ended) continue;
      const ev = byId.get(e.id);
      const started = e.commence.getTime() <= t;
      if (!ev) { if (started) { await updateEvent(e.id, { ended: true }); changed = true; } continue; }
      const o = norm(ev);
      if (!o) continue;
      let xo = e.xo, xt = e.xt ? e.xt.getTime() : 0;
      if (isSoc(cfg, k) && t - xt >= 10 * 60e3) {
        const x = await extrasFor(k, e.id, 'en-vivo-extras');
        if (x) { xo = x; xt = t; await updateEvent(e.id, { xo: x, xt: new Date(t) }); }
      }
      const snap = { t, o: t - xt < 30 * 60e3 ? withExtras(o, xo) : o, src: 'live', inplay: started };
      await updateEvent(e.id, { live_snap: snap, books: { t, by: allBooks(ev), inplay: started } });
      if (t - (liveSnapAt.get(e.id) || 0) >= 10 * 60e3) { liveSnapAt.set(e.id, t); await addSnapshot(e.id, started ? 'live' : 'gameday', snap); }
      changed = true;
    }
  }
  return changed;
}

/* Histórico (plan pagado) */
async function hist(e, ts, only) {
  const cfg = await getConfig();
  const iso = new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const markets = only || (FEATURED + (isSoc(cfg, e.sport) ? ',' + EXTRA_SOC : ''));
  const j = await apiGet(`/historical/sports/${e.sport}/events/${e.id}/odds`,
    { regions: 'us', bookmakers: 'fanduel', markets, oddsFormat: 'decimal', date: iso }, 'historico', { allow404: true });
  if (!j) return null;
  const o = norm(j.data);
  return o ? { t: Date.parse(j.timestamp), o, src: 'hist' } : null;
}
export async function findOpening(e) {
  const now = Date.now(), c = e.commence.getTime();
  const has = async ts => !!(await hist(e, ts, 'h2h'));
  let hi = Math.min(e.pub_at ? e.pub_at.getTime() : (e.open_snap ? e.open_snap.t : c - 60e3), now - 10 * 60e3, c - 60e3);
  let lo = Math.max(e.pub_from ? e.pub_from.getTime() : 0, c - 14 * DAY);
  if (!(await has(hi))) return { ok: false, reason: 'noHist' };
  let exact = true;
  if (await has(lo)) { hi = lo; exact = false; }
  else while (hi - lo > 15 * 60e3) { const mid = Math.round((lo + hi) / 2); if (await has(mid)) hi = mid; else lo = mid; }
  const s = await hist(e, hi);
  if (!s) return { ok: false, reason: 'noReadAt' };
  await updateEvent(e.id, { open_snap: s, pub_at: new Date(s.t), pub_from: exact ? new Date(lo) : null, pub_hist: true });
  await addSnapshot(e.id, 'open', s);
  notify();
  return { ok: true, exact, t: s.t };
}
export async function fillBefore(e) {
  const c = e.commence.getTime();
  if (e.before_snap || c - DAY > Date.now()) return { ok: false, reason: 'noGaps' };
  const s = await hist(e, c - DAY);
  if (!s) return { ok: false, reason: 'noHist' };
  await updateEvent(e.id, { before_snap: s });
  await addSnapshot(e.id, 'before', s);
  notify();
  return { ok: true };
}

/* Reloj: revisa cada 30 segundos qué toca hacer. */
async function tick() {
  const cfg = await getConfig();
  const now = Date.now(), dk = dayKey(now);
  const [h, m] = hhmm(now).split(':').map(Number), mins = h * 60 + m;
  if (now - state.lastWatch >= cfg.watchMin * 60e3) { state.lastWatch = now; run('vigilancia', watchJob); }
  for (const at of [18 * 60, 23 * 60 + 50]) {
    const key = dk + '@' + at;
    if (mins >= at && mins < at + 9 && !state.done.has(key)) { state.done.add(key); run('dia-antes', beforeJob); }
  }
  run('cierre', closeJob);
  if (viewers.size && now - state.lastLive >= cfg.liveSec * 1000) { state.lastLive = now; run('en-vivo', () => liveJob()); }
  if (mins === 4 * 60 && !state.done.has(dk + '@prune')) { state.done.add(dk + '@prune'); run('limpieza', async () => { await prune(); return false; }); }
}
export function startCollector() {
  setInterval(() => tick().catch(e => console.error('[tick]', e.message)), 30e3);
  setTimeout(() => tick().catch(e => console.error('[tick]', e.message)), 3000);
}
