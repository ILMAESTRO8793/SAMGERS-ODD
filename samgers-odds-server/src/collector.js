import { FEATURED, EXTRA_SOC, DAY, BOOKS, ACTIVE, PRIMARY, OTHER, trackedKeys, dayKey, hhmm } from './config.js';
import { getConfig, upsertEvent, updateEvent, addSnapshot, eventsBySports, usedLast24, prune } from './db.js';
import { apiGet, norm, normMain, extrasMain, allBooks, withExtras, normProps } from './odds.js';
const normFD = (ev, k) => normMain(ev, PRIMARY(k), OTHER(k));

export const state = { noFd: new Map(), lastActive: 0, missing: new Set(), lastRun: {}, lastError: null, lastBefore: 0, lastIntl: 0, lastProps: 0, lastWatch: 0, lastLive: 0, done: new Set(), queued: new Set(), capHit: false };
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
const bookList = () => Object.keys(BOOKS).join(',');
const isSoc = (cfg, k) => k.startsWith('soccer_') && cfg.extras;
const groupBy = (rows, f) => rows.reduce((m, r) => (m.get(f(r)) || m.set(f(r), []).get(f(r))).push(r) && m, new Map());

/* Cuotas por liga y, si FanDuel no viene en esa respuesta para algún partido, se pide ese partido solo.
   (The Odds API a veces no incluye a FanDuel en la lista de la liga, sobre todo en selecciones; si no hay
   cuotas, la consulta por partido no cuesta créditos.) */
async function oddsById(k, rows, books, kind) {
  const data = await apiGet(`/sports/${k}/odds`, oddsParams(books), kind, { allow404: true }) || [];
  const byId = new Map(data.map(e => [e.id, e]));
  const inList = new Set(byId.keys());
  for (const e of rows) {
    if (norm(byId.get(e.id), PRIMARY(k))) continue;
    // Solo FanDuel: si FanDuel no tiene ese partido, la consulta no cuesta créditos.
    if (state.noFd.get(e.id) > Date.now()) continue;
    const one = await apiGet(`/sports/${k}/events/${e.id}/odds`, oddsParams(PRIMARY(k)), kind + '-partido', { allow404: true });
    if (one && norm(one, PRIMARY(k))) byId.set(e.id, one);
    else state.noFd.set(e.id, Date.now() + 3 * 3600e3); // no volver a preguntar por ese partido en 3 horas
  }
  return { byId, inList };
}

async function extrasFor(k, id, kind) {
  return extrasMain(await apiGet(`/sports/${k}/events/${id}/odds`, oddsParams(bookList(), EXTRA_SOC), kind, { allow404: true }), PRIMARY(k), OTHER(k));
}

/* Líneas de jugadores NBA: puntos, rebotes y asistencias (principal y alternativas) */
const NBA = 'basketball_nba';
// Grupos separados: si FanDuel o la API no tienen un mercado, los demás grupos siguen funcionando.
const PROP_GROUPS = [
  ['points', 'rebounds', 'assists'],
  ['threes', 'points_rebounds_assists'],
  ['points_rebounds', 'points_assists', 'rebounds_assists'],
  ['steals', 'blocks', 'turnovers']
].map(g => g.flatMap(m => [`player_${m}`, `player_${m}_alternate`]).join(','));
function mergeProps(a, b) {
  if (!a) return b; if (!b) return a;
  for (const bk in b) a[bk] = { ...(a[bk] || {}), ...b[bk] };
  return a;
}
export async function fetchProps(e, kind) {
  let p = null;
  for (const markets of PROP_GROUPS) {
    try {
      const j = await apiGet(`/sports/${NBA}/events/${e.id}/odds`, oddsParams(bookList(), markets), kind, { allow404: true });
      p = mergeProps(p, normProps(j));
    } catch (err) { if (err.fatal) throw err; }
  }
  const t = Date.now();
  const f = { props_t: new Date(t) };
  if (p) { f.props = { t, by: p }; if (!e.props_open) f.props_open = { t, by: p }; }
  await updateEvent(e.id, f);
  if (p) notify();
  return !!p;
}
/* Busca cuándo FanDuel publica las líneas de jugadores (cada 2 horas, solo partidos de las próximas 36 h). */
async function propsProbe() {
  const cfg = await getConfig();
  if (!cfg.sports.nba) return false;
  const now = Date.now();
  const rows = await eventsBySports([NBA], now, now + 36 * 3600e3);
  for (const e of rows) {
    if (e.props_open || (e.props_t && now - e.props_t.getTime() < 2 * 3600e3)) continue;
    await fetchProps(e, 'props-apertura');
  }
  return false;
}

/* 0) Qué competiciones tiene activas The Odds API (gratis). */
async function refreshActive() {
  const list = await apiGet('/sports', {}, 'deportes');
  if (Array.isArray(list) && list.length) ACTIVE.keys = new Set(list.map(s => s.key));
  return true;
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
      (!e.last_check || now - e.last_check.getTime() >= Math.min(12 * 3600e3, 30 * 60e3 * 2 ** Math.min(e.checks, 5))));
    if (!due.length) continue;
    const { byId } = await oddsById(k, due, bookList(), 'apertura');
    const t = Date.now();
    for (const e of due) {
      const o = normFD(byId.get(e.id), k);
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
// mode: 'missing' = solo partidos sin lectura (con BTTS/goles) · 'update' = refresca todos (sin pedir BTTS/goles otra vez) · 'final' = 11:50 pm, todo
export async function beforeJob(mode = 'final') {
  const cfg = await getConfig();
  const now = Date.now(), tomorrow = dayKey(now + DAY);
  const rows = (await eventsBySports(trackedKeys(cfg), now, now + 2 * DAY)).filter(e => e.open_snap && dayKey(e.commence) === tomorrow && (mode !== 'missing' || !e.before_snap));
  let changed = false;
  for (const [k, list] of groupBy(rows, r => r.sport)) {
    const { byId } = await oddsById(k, list, bookList(), 'dia-antes');
    const t = Date.now();
    for (const e of list) {
      const o = normFD(byId.get(e.id), k);
      if (!o) continue;
      const snap = { t, o, src: 'live' };
      if (isSoc(cfg, k)) {
        const x = mode === 'update' ? null : await extrasFor(k, e.id, 'dia-antes-extras');
        if (x) { snap.o = withExtras(o, x); await updateEvent(e.id, { xo: x, xt: new Date(t) }); }
        else if (e.xo) snap.o = withExtras(o, e.xo);
      }
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
  const rows = (await eventsBySports(trackedKeys(cfg), now, now + 10 * 60e3)).filter(e => !e.close_done && e.open_snap);
  if (!rows.length) return false;
  let changed = false;
  for (const [k, list] of groupBy(rows, r => r.sport)) {
    const { byId } = await oddsById(k, list, bookList(), 'cierre');
    const t = Date.now();
    for (const e of list) {
      const ev = byId.get(e.id), o = normFD(ev, k);
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
export async function liveJob(forceTab, forceLeague) {
  const cfg = await getConfig();
  const views = forceTab ? [{ tab: forceTab, league: forceLeague || 'all' }] : [...viewers.values()];
  const tabs = new Set(views.map(v => v.tab));
  if (!tabs.size) return false;
  // Fútbol con "todas mis ligas": solo partidos jugándose o que empiezan en la próxima hora (muchas ligas = muchos créditos).
  // Si eliges una liga en el selector, esa liga se actualiza completa.
  const wide = new Set(), full = new Set();
  for (const v of views) for (const k of trackedKeys(cfg, v.tab)) {
    if (v.tab === 'soc' && v.league !== 'all') { if (k === v.league) full.add(k); }
    else if (v.tab === 'soc' && !forceTab) wide.add(k); else full.add(k);
  }
  if (!forceTab) {
    const used = await usedLast24();
    state.capHit = used >= cfg.dailyCap;
    if (state.capHit) return false;
  }
  const keys = [...new Set([...full, ...wide])];
  if (!keys.length) return false;
  const now = Date.now(), today = dayKey(now);
  const rows = (await eventsBySports(keys, now - 6 * 3600e3, now + 36 * 3600e3)).filter(e => {
    const c = e.commence.getTime();
    if (e.ended || !e.open_snap) return false;
    if (c <= now) return now - c < 5 * 3600e3;
    if (dayKey(c) !== today) return false;
    return full.has(e.sport) || c - now <= 60 * 60e3;
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
    const { byId, inList } = await oddsById(k, list.filter(e => !e.ended), bookList(), 'en-vivo');
    const t = Date.now();
    for (const e of list) {
      if (e.ended) continue;
      const ev = byId.get(e.id);
      const started = e.commence.getTime() <= t;
      if (!ev && !inList.has(e.id)) { if (started) { await updateEvent(e.id, { ended: true }); changed = true; } continue; }
      const o = normFD(ev, k);
      if (!o) { state.missing.add(e.id); continue; }
      state.missing.delete(e.id);
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

/* Cuota actual de los partidos que aún no son hoy (al tocar "Actualizar ahora"): 3 créditos por liga. */
export async function refreshUpcoming(tab) {
  const cfg = await getConfig();
  const now = Date.now(), today = dayKey(now), tomorrow = dayKey(now + DAY);
  let changed = false;
  for (const k of trackedKeys(cfg, tab)) {
    const rows = (await eventsBySports([k], now, now + 30 * DAY)).filter(e => dayKey(e.commence) !== today);
    if (!rows.length) continue;
    const { byId } = await oddsById(k, rows, bookList(), 'actualizar');
    const t = Date.now();
    for (const e of rows) {
      const o = normFD(byId.get(e.id), k);
      if (!o) continue;
      const snap = { t, o, src: 'live' };
      if (!e.open_snap) await updateEvent(e.id, { open_snap: snap, pub_at: new Date(t), pub_from: e.last_check });
      // Si el partido es mañana, esta lectura también es la del "día antes".
      if (dayKey(e.commence) === tomorrow) {
        const b = { ...snap, o: isSoc(cfg, k) && e.xo ? withExtras(o, e.xo) : o };
        await updateEvent(e.id, { cur_snap: snap, before_snap: b });
        await addSnapshot(e.id, 'before', b);
      } else {
        const cs = isSoc(cfg, k) && e.xo ? { ...snap, o: withExtras(o, e.xo) } : snap;
        await updateEvent(e.id, { cur_snap: cs });
        await addSnapshot(e.id, 'current', cs);
      }
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
    { regions: 'us', bookmakers: PRIMARY(e.sport), markets, oddsFormat: 'decimal', date: iso }, 'historico', { allow404: true });
  if (!j) return null;
  const o = norm(j.data, PRIMARY(e.sport));
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
  if (now - state.lastActive >= 6 * 3600e3) { state.lastActive = now; run('deportes', refreshActive); }
  if (now - state.lastWatch >= cfg.watchMin * 60e3) { state.lastWatch = now; run('vigilancia', watchJob); }
  if (now - state.lastProps >= 30 * 60e3) { state.lastProps = now; run('props', propsProbe); }
  // Día antes (el día anterior al partido, hora de Panamá):
  // - a cualquier hora, cada 30 min, guarda los partidos de mañana que aún no tengan lectura;
  // - a las 6 am, 12 pm y 6 pm la actualiza con la cuota del momento;
  // - a las 11:50 pm guarda la última cuota del día.
  if (now - state.lastBefore >= 2 * 3600e3) { state.lastBefore = now; run('dia-antes', () => beforeJob('missing')); }
  for (const at of [6 * 60, 12 * 60, 18 * 60]) {
    const k2 = dk + '@' + at;
    if (mins >= at && mins < at + 30 && !state.done.has(k2)) { state.done.add(k2); run('dia-antes-update', () => beforeJob('update')); }
  }
  const key = dk + '@2350';
  if (mins >= 23 * 60 + 50 && !state.done.has(key)) { state.done.add(key); run('dia-antes-final', () => beforeJob('final')); }
  run('cierre', closeJob);
  if (viewers.size && now - state.lastLive >= cfg.liveSec * 1000) { state.lastLive = now; run('en-vivo', () => liveJob()); }
  if (mins === 4 * 60 && !state.done.has(dk + '@prune')) { state.done.add(dk + '@prune'); run('limpieza', async () => { await prune(); return false; }); }
}
export function startCollector() {
  setInterval(() => tick().catch(e => console.error('[tick]', e.message)), 30e3);
  setTimeout(() => tick().catch(e => console.error('[tick]', e.message)), 3000);
}
