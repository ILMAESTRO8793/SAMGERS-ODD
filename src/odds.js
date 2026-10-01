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
    const isTot = m.key === 'totals' || m.key === 'alternate_totals';
    const key = isTot ? 'totals' : m.key;
    o[key] = o[key] || {};
    for (const oc of m.outcomes || []) {
      if (isTot) {
        const k = oc.name + '|' + oc.point;
        if (m.key === 'alternate_totals' && o.totals[k]) continue;
        o.totals[k] = { p: oc.price, pt: oc.point };
        if (m.key === 'totals') o.tmain = oc.point;
      } else o[key][oc.name] = { p: oc.price, pt: oc.point };
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
  const out = { ...o };
  for (const k in x) {
    if (k === 'tmain') continue;
    if (k === 'totals') out.totals = { ...x.totals, ...(o.totals || {}) };
    else out[k] = x[k];
  }
  return out;
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
