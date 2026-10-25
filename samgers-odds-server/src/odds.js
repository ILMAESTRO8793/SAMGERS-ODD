import { API_BASE, API_KEY } from './config.js';
import { q } from './db.js';

export const quota = { remaining: null, used: null };

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; this.fatal = status === 401 || status === 429; }
}

export async function apiGet(path, params = {}, kind = 'other', { allow404 = false } = {}) {
  if (!API_KEY) throw new ApiError(401, 'Falta ODDS_API_KEY en el servidor');
  const url = new URL(API_BASE + path);
  url.searchParams.set('apiKey', API_KEY);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new ApiError(0, 'Sin conexión con The Odds API: ' + e.message); }
  const last = Number(r.headers.get('x-requests-last') || 0);
  const rem = r.headers.get('x-requests-remaining');
  if (rem != null) quota.remaining = Number(rem);
  if (r.headers.get('x-requests-used') != null) quota.used = Number(r.headers.get('x-requests-used'));
  if (last > 0) {
    q(`insert into credit_log (kind, path, cost, remaining) values ($1,$2,$3,$4)`,
      [kind, path.replace(/events\/[^/]+/, 'events/:id'), last, rem != null ? Number(rem) : null]).catch(() => {});
  }
  if (allow404 && (r.status === 404 || r.status === 422)) return null;
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).message || ''; } catch {}
    throw new ApiError(r.status, msg || `Error ${r.status}`);
  }
  return r.json();
}

/* Normaliza las cuotas de una casa: { h2h:{name:{p,pt}}, spreads:{...}, totals:{'Over|2.5':{p,pt}}, btts:{...}, tmain } */
export function norm(ev, book = 'fanduel') {
  const b = ((ev && ev.bookmakers) || []).find(x => x.key === book);
  if (!b) return null;
  const o = {};
  for (const m of b.markets || []) {
    if (m.key === 'alternate_team_totals') continue;
    const isTot = m.key === 'totals' || m.key === 'alternate_totals';
    const key = isTot ? 'totals' : m.key;
    o[key] = o[key] || {};
    for (const oc of m.outcomes || []) {
      if (isTot) {
        const k = oc.name + '|' + oc.point;
        if (m.key === 'alternate_totals' && o.totals[k]) continue;
        o.totals[k] = { p: oc.price, pt: oc.point };
        if (m.key === 'totals') o.tmain = oc.point;
      } else if (m.key === 'team_totals') o.team_totals[`${oc.description}|${oc.name}`] = { p: oc.price, pt: oc.point };
      else o[key][oc.name] = { p: oc.price, pt: oc.point };
    }
  }
  return Object.keys(o).length ? o : null;
}

export function allBooks(ev) {
  const by = {};
  for (const b of (ev && ev.bookmakers) || []) { const o = norm(ev, b.key); if (o) by[b.key] = o; }
  return by;
}

export function withExtras(o, x) {
  if (!o || !x) return o;
  const out = { ...o, _from: { ...(o._from || {}) } };
  const xf = x._from || {};
  for (const k in x) {
    if (k === 'tmain' || k === '_from') continue;
    if (k === 'totals') {
      // Si la línea principal es de una casa, no se mezclan líneas alternativas de otra.
      if (o.totals && ((o._from && o._from.totals) || null) !== (xf.totals || null)) continue;
      out.totals = { ...x.totals, ...(o.totals || {}) };
      if (xf.totals && !o.totals) out._from.totals = xf.totals;
    } else { out[k] = x[k]; if (xf[k]) out._from[k] = xf[k]; else delete out._from[k]; }
  }
  if (!Object.keys(out._from).length) delete out._from;
  return out;
}

/* Las 5 casas en orden de prioridad: cada mercado sale de la primera casa que lo tenga (y se marca de cuál vino).
   Además guarda el "consenso": la probabilidad sin margen promedio de las demás casas, para calcular el edge. */
const FILL = ['h2h', 'spreads', 'totals', 'btts', 'team_totals'];
export function normMain(ev, prio) {
  const by = {};
  for (const b of prio) { const o = norm(ev, b); if (o) by[b] = o; }
  const books = prio.filter(b => by[b]);
  if (!books.length) return null;
  const f = { _from: {} };
  for (const mk of FILL) {
    const b = books.find(x => by[x][mk]);
    if (!b) continue;
    f[mk] = by[b][mk];
    if (mk === 'totals' && by[b].tmain != null) f.tmain = by[b].tmain;
    if (b !== prio[0]) f._from[mk] = b;
  }
  if (!Object.keys(f._from).length) delete f._from;
  f.bk = books.find(x => by[x].h2h) || books[0]; // casa de la que salió el moneyline
  if (!f.h2h && !f.spreads && !f.totals) return null;
  const hb = books.find(x => by[x].h2h);
  const others = books.filter(x => x !== hb && by[x].h2h);
  if (f.h2h && others.length) {
    const acc = {}; let n = 0;
    for (const x of others) {
      const h = by[x].h2h, ks = Object.keys(f.h2h);
      if (!ks.every(k => h[k] && h[k].p > 1)) continue;
      const inv = ks.map(k => 1 / h[k].p), sum = inv.reduce((a, c) => a + c, 0);
      ks.forEach((k, i2) => { acc[k] = (acc[k] || 0) + inv[i2] / sum; });
      n++;
    }
    if (n) { for (const k in acc) acc[k] /= n; f.cons = { p: acc, n }; }
  }
  return f;
}
export function extrasMain(ev, prio) {
  const out = {};
  for (const mk of ['btts', 'totals', 'team_totals']) {
    for (const b of prio) {
      const o = norm(ev, b);
      if (o && o[mk]) { out[mk] = o[mk]; if (b !== prio[0]) (out._from = out._from || {})[mk] = b; break; }
    }
  }
  return Object.keys(out).length ? out : null;
}

/* Líneas de jugadores (NBA): { fanduel: { points: { 'Jugador': { main:{pt,o,u}, alts:{ '24.5':{pt,o,u} } } } } } */
export function normProps(ev) {
  const out = {};
  for (const b of (ev && ev.bookmakers) || []) {
    const bk = {};
    for (const m of b.markets || []) {
      const alt = m.key.endsWith('_alternate');
      const stat = m.key.replace(/^player_/, '').replace(/_alternate$/, '');
      bk[stat] = bk[stat] || {};
      for (const oc of m.outcomes || []) {
        const pl = oc.description || oc.name;
        const side = oc.name === 'Under' ? 'u' : 'o';
        const P = bk[stat][pl] = bk[stat][pl] || { main: null, alts: {} };
        if (!alt) {
          if (!P.main) P.main = { pt: oc.point };
          if (P.main.pt === oc.point) P.main[side] = oc.price;
        } else {
          const a = P.alts[oc.point] = P.alts[oc.point] || { pt: oc.point };
          a[side] = oc.price;
        }
      }
    }
    if (Object.keys(bk).length) out[b.key] = bk;
  }
  return Object.keys(out).length ? out : null;
}
