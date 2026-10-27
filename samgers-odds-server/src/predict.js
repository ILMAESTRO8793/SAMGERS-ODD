/* Pronóstico gratis, sin claves de API.
   Base: probabilidad sin margen de las casas (consenso) y el movimiento de la línea. Cuando el partido se encuentra
   en ESPN (datos públicos) suma: lesiones, forma reciente, récord de local/visitante, descanso (NBA), estadio,
   enfrentamientos directos y la proyección de ESPN (NBA). Si ESPN no responde, el pronóstico sale solo con las cuotas. */
import { TZ, leagueName } from './config.js';

const ESPN = process.env.ESPN_BASE || 'https://site.api.espn.com/apis/site/v2/sports';
const SLUG = {
  basketball_nba: 'basketball/nba',
  soccer_epl: 'soccer/eng.1', soccer_spain_la_liga: 'soccer/esp.1', soccer_italy_serie_a: 'soccer/ita.1',
  soccer_germany_bundesliga: 'soccer/ger.1', soccer_france_ligue_one: 'soccer/fra.1', soccer_uefa_champs_league: 'soccer/uefa.champions',
  soccer_uefa_europa_league: 'soccer/uefa.europa', soccer_uefa_europa_conference_league: 'soccer/uefa.europa.conf',
  soccer_netherlands_eredivisie: 'soccer/ned.1', soccer_portugal_primeira_liga: 'soccer/por.1', soccer_usa_mls: 'soccer/usa.1',
  soccer_efl_champ: 'soccer/eng.2', soccer_fa_cup: 'soccer/eng.fa', soccer_england_efl_cup: 'soccer/eng.league_cup',
  soccer_spain_copa_del_rey: 'soccer/esp.copa_del_rey', soccer_italy_coppa_italia: 'soccer/ita.coppa_italia',
  soccer_germany_bundesliga2: 'soccer/ger.2', soccer_germany_liga3: 'soccer/ger.3', soccer_germany_dfb_pokal: 'soccer/ger.dfb_pokal',
  soccer_france_coupe_de_france: 'soccer/fra.coupe_de_france', soccer_spl: 'soccer/sco.1', soccer_belgium_first_div: 'soccer/bel.1',
  soccer_austria_bundesliga: 'soccer/aut.1', soccer_switzerland_superleague: 'soccer/sui.1', soccer_denmark_superliga: 'soccer/den.1',
  soccer_norway_eliteserien: 'soccer/nor.1', soccer_sweden_allsvenskan: 'soccer/swe.1', soccer_finland_veikkausliiga: 'soccer/fin.1',
  soccer_greece_super_league: 'soccer/gre.1', soccer_turkey_super_league: 'soccer/tur.1'
};

/* ---------- utilidades ---------- */
const get = async url => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Mozilla/5.0' } }); return r.ok ? await r.json() : null; }
  catch { return null; }
};
const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'ss', 'as', 'sv', 'vfl', 'vfb', 'club', 'de', 'the', 'cd', 'ud', 'rc', 'rcd', 'fk', 'sk', 'if', 'bk', 'calcio']);
const toks = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ')
  .split(/\s+/).filter(w => w && !STOP.has(w));
function sim(a, b) {
  const A = toks(a), B = toks(b);
  if (!A.length || !B.length) return 0;
  const inter = A.filter(w => B.includes(w) || B.some(x => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x)))).length;
  return inter / Math.min(A.length, B.length);
}
const ymd = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
const pct = x => (x * 100).toFixed(0) + '%';
function fair(h) {
  if (!h) return null;
  const ks = Object.keys(h).filter(k => h[k] && h[k].p > 1);
  if (ks.length < 2) return null;
  const inv = ks.map(k => 1 / h[k].p), sum = inv.reduce((a, b) => a + b, 0);
  return Object.fromEntries(ks.map((k, i) => [k, inv[i] / sum]));
}

/* ---------- ESPN ---------- */
async function espnData(e) {
  const slug = SLUG[e.sport];
  if (!slug) return null;
  const c = e.commence.getTime();
  let ev = null, comp = null;
  for (const d of [c, c - 864e5, c + 864e5]) {
    const sb = await get(`${ESPN}/${slug}/scoreboard?dates=${ymd(d)}`);
    for (const x of (sb && sb.events) || []) {
      const cp = x.competitions && x.competitions[0];
      const cs = (cp && cp.competitors) || [];
      const h = cs.find(t => t.homeAway === 'home'), a = cs.find(t => t.homeAway === 'away');
      if (!h || !a) continue;
      const hn = h.team && (h.team.displayName || h.team.name), an = a.team && (a.team.displayName || a.team.name);
      const ok = (sim(hn, e.home) >= 0.5 && sim(an, e.away) >= 0.5) || (sim(hn, e.away) >= 0.5 && sim(an, e.home) >= 0.5);
      if (ok) { ev = x; comp = cp; break; }
    }
    if (ev) break;
  }
  if (!ev) return null;
  const sum = await get(`${ESPN}/${slug}/summary?event=${ev.id}`) || {};
  const side = name => comp.competitors.reduce((best, t) => (sim(t.team && t.team.displayName, name) > sim(best.team && best.team.displayName, name) ? t : best), comp.competitors[0]);
  const out = { id: ev.id, link: (ev.links && ev.links[0] && ev.links[0].href) || null, teams: {} };
  const venue = (sum.gameInfo && sum.gameInfo.venue) || comp.venue;
  if (venue) out.venue = [venue.fullName, venue.address && venue.address.city].filter(Boolean).join(', ');
  for (const [key, name] of [['home', e.home], ['away', e.away]]) {
    const t = side(name), id = t.team && t.team.id, T = { name, injuries: [] };
    for (const r of t.records || []) {
      const ty = String(r.type || r.name || '').toLowerCase();
      if (ty.includes('home')) T.homeRec = r.summary; else if (ty.includes('road') || ty.includes('away')) T.awayRec = r.summary; else if (!T.rec) T.rec = r.summary;
    }
    if (t.form) T.form = String(t.form).toUpperCase().slice(-5).split('');
    const l5 = (sum.lastFiveGames || []).find(g => g.team && (g.team.id === id || sim(g.team.displayName, name) >= 0.5));
    if (!T.form && l5 && l5.events) T.form = l5.events.map(x => String(x.gameResult || '').toUpperCase().slice(0, 1)).filter(Boolean).slice(0, 5);
    const inj = (sum.injuries || []).find(g => g.team && (g.team.id === id || sim(g.team.displayName, name) >= 0.5));
    T.injuries = ((inj && inj.injuries) || []).map(x => ({ name: x.athlete && x.athlete.displayName, status: x.status || (x.type && x.type.description) || '' })).filter(x => x.name);
    if (e.sport === 'basketball_nba' && id) {
      const sch = await get(`${ESPN}/${slug}/teams/${id}/schedule`);
      const prev = ((sch && sch.events) || []).map(x => Date.parse(x.date)).filter(d => d < c - 3 * 3600e3).sort((a, b) => b - a)[0];
      if (prev) T.restDays = Math.max(0, Math.round((c - prev) / 864e5) - 1);
    }
    T.isHome = t.homeAway === 'home';
    out.teams[key] = T;
  }
  const pr = sum.predictor;
  if (pr && pr.homeTeam && pr.awayTeam) {
    const hp = parseFloat(pr.homeTeam.gameProjection), ap = parseFloat(pr.awayTeam.gameProjection);
    if (hp > 0 && ap > 0) out.espnProj = out.teams.home.isHome ? { home: hp / 100, away: ap / 100 } : { home: ap / 100, away: hp / 100 };
  }
  if (Array.isArray(sum.seasonseries) && sum.seasonseries[0] && sum.seasonseries[0].summary) out.h2h = sum.seasonseries[0].summary;
  const hh = sum.headToHeadGames && sum.headToHeadGames[0];
  if (!out.h2h && hh && hh.events && hh.events.length) {
    const w = hh.events.filter(x => x.gameResult === 'W').length, l = hh.events.filter(x => x.gameResult === 'L').length;
    out.h2h = { who: (hh.team && hh.team.displayName) || e.home, w, d: hh.events.length - w - l, l };
  }
  return out;
}

/* ---------- modelo ---------- */
const formScore = f => (f || []).reduce((s, r) => s + (r === 'W' || r === 'G' ? 1 : r === 'L' || r === 'P' ? -1 : 0), 0);
const outCount = T => ((T && T.injuries) || []).reduce((s, x) => s + (/out|suspend/i.test(x.status) ? 1 : /doubt|question/i.test(x.status) ? 0.5 : 0), 0);

const TXT = {
  es: {
    draw: 'Empate', inj: 'Lesiones y estado físico', form: 'Forma reciente y trayectoria', venue: 'Lugar del partido', h2h: 'Enfrentamientos directos', odds: 'Lo que dicen las cuotas', rest: 'Descanso',
    noInj: 'sin bajas reportadas', noData: 'no se encontró este partido en ESPN, así que el pronóstico se basa solo en las cuotas', last5: 'últimos 5', rec: 'récord', home: 'de local', away: 'de visitante',
    restD: d => (d === 0 ? 'juega en back-to-back (sin descanso)' : `${d} día(s) de descanso`),
    oddsT: (m, mv) => `Las casas dan (sin su margen): ${m}.${mv ? ' Movimiento desde la apertura: ' + mv + '.' : ''}`,
    espn: p => `La proyección de ESPN da ${p}.`,
    sum: (pick, p, why) => `Sugerencia: ${pick}, con ${p} de probabilidad. ${why}`,
    whyBase: 'Parte de la probabilidad de las casas y se ajusta por', noAdj: 'No hay factores fuertes que cambien lo que ya dice el mercado, así que el pronóstico sigue a las casas.',
    value: (o, a, b) => `${o}: modelo ${a} contra ${b} de las casas`, noValue: 'sin valor claro: el modelo y las casas coinciden',
    conf: { baja: 'baja', media: 'media', alta: 'alta' }, h2hW: (who, w, d, l) => `${who}: ${w} ganados, ${d} empates y ${l} perdidos en los últimos ${w + d + l}`,
    move: t => `dinero entrando hacia ${t}`, moreOut: t => `más bajas en ${t}`, betterForm: t => `mejor forma reciente de ${t}`, b2b: t => `${t} juega en back-to-back`, proj: 'la proyección de ESPN',
    noOdds: 'Todavía no hay cuotas de moneyline para este partido'
  },
  en: {
    draw: 'Draw', inj: 'Injuries and fitness', form: 'Recent form and trajectory', venue: 'Venue', h2h: 'Head to head', odds: 'What the odds say', rest: 'Rest',
    noInj: 'no reported absences', noData: 'this game was not found on ESPN, so the prediction is based only on the odds', last5: 'last 5', rec: 'record', home: 'at home', away: 'on the road',
    restD: d => (d === 0 ? 'plays a back-to-back (no rest)' : `${d} day(s) of rest`),
    oddsT: (m, mv) => `The books give (without their margin): ${m}.${mv ? ' Movement since the opening: ' + mv + '.' : ''}`,
    espn: p => `ESPN's projection gives ${p}.`,
    sum: (pick, p, why) => `Pick: ${pick}, with a ${p} probability. ${why}`,
    whyBase: 'It starts from the books\' probability and adjusts for', noAdj: 'No strong factor changes what the market already says, so the prediction follows the books.',
    value: (o, a, b) => `${o}: model ${a} vs books ${b}`, noValue: 'no clear value: the model and the books agree',
    conf: { baja: 'low', media: 'medium', alta: 'high' }, h2hW: (who, w, d, l) => `${who}: ${w} won, ${d} drawn and ${l} lost in the last ${w + d + l}`,
    move: t => `money moving toward ${t}`, moreOut: t => `more absences for ${t}`, betterForm: t => `better recent form for ${t}`, b2b: t => `${t} on a back-to-back`, proj: 'ESPN\'s projection',
    noOdds: 'There are no moneyline odds for this game yet'
  }
};

export const aiReady = () => true;

export async function predict(e, lang = 'es') {
  const L = TXT[lang === 'en' ? 'en' : 'es'];
  const soc = e.sport.startsWith('soccer_');
  const latest = [e.live_snap, e.cur_snap, e.before_snap, e.open_snap].filter(Boolean).sort((a, b) => b.t - a.t)[0];
  const mf = fair(latest && latest.o && latest.o.h2h);
  if (!mf || mf[e.home] == null || mf[e.away] == null) throw new Error(L.noOdds);
  const cons = latest.o.cons && latest.o.cons.p;
  const m = {};
  for (const k of [e.home, e.away, ...(soc ? ['Draw'] : [])]) {
    const a = mf[k] != null ? mf[k] : 0, b = cons && cons[k] != null ? cons[k] : a;
    m[k] = (a + b) / 2;
  }
  const norm = o => { const s = Object.values(o).reduce((x, y) => x + y, 0); for (const k in o) o[k] /= s; return o; };
  norm(m);
  const p = { ...m }, why = [];
  const shift = (side, pts, reason) => {
    if (!pts) return;
    const other = side === e.home ? e.away : e.home, d = pts / 100;
    p[side] = Math.max(0.01, p[side] + d); p[other] = Math.max(0.01, p[other] - d);
    why.push(reason);
  };

  // movimiento de la línea desde la apertura
  const of = fair(e.open_snap && e.open_snap.o && e.open_snap.o.h2h);
  let mvTxt = '';
  if (of && of[e.home] != null && of[e.away] != null && e.open_snap !== latest) {
    const dh = (mf[e.home] - of[e.home]) * 100, da = (mf[e.away] - of[e.away]) * 100;
    mvTxt = `${e.home} ${dh >= 0 ? '+' : ''}${dh.toFixed(1)} pts, ${e.away} ${da >= 0 ? '+' : ''}${da.toFixed(1)} pts`;
    const toward = dh >= da ? e.home : e.away, size = Math.max(dh, da);
    if (size >= 3) shift(toward, Math.min(2, size * 0.25), L.move(toward));
  }

  const espn = await espnData(e);
  const factors = [];
  if (espn) {
    const H = espn.teams.home, A = espn.teams.away;
    const injTxt = T => (T.injuries.length ? T.injuries.slice(0, 5).map(x => `${x.name} (${x.status})`).join(', ') : L.noInj);
    factors.push({ title: L.inj, text: `${e.home}: ${injTxt(H)}. ${e.away}: ${injTxt(A)}.` });
    const io = outCount(A) - outCount(H);
    if (Math.abs(io) >= 1) { const t = io > 0 ? e.home : e.away; shift(t, Math.min(soc ? 3 : 4, Math.abs(io) * (soc ? 1 : 1.5)), L.moreOut(t === e.home ? e.away : e.home)); }
    const fT = T => [T.form && T.form.length ? `${L.last5}: ${T.form.join('-')}` : '', T.rec ? `${L.rec} ${T.rec}` : ''].filter(Boolean).join(', ') || '—';
    factors.push({ title: L.form, text: `${e.home}: ${fT(H)}. ${e.away}: ${fT(A)}.` });
    const fd = formScore(H.form) - formScore(A.form);
    if (Math.abs(fd) >= 2) { const t = fd > 0 ? e.home : e.away; shift(t, Math.min(3, Math.abs(fd) * 0.6), L.betterForm(t)); }
    factors.push({ title: L.venue, text: [espn.venue, H.homeRec ? `${e.home} ${L.home}: ${H.homeRec}` : '', A.awayRec ? `${e.away} ${L.away}: ${A.awayRec}` : ''].filter(Boolean).join('. ') || '—' });
    if (!soc && (H.restDays != null || A.restDays != null)) {
      factors.push({ title: L.rest, text: `${e.home}: ${H.restDays != null ? L.restD(H.restDays) : '—'}. ${e.away}: ${A.restDays != null ? L.restD(A.restDays) : '—'}.` });
      if (H.restDays === 0 && A.restDays > 0) shift(e.away, 2, L.b2b(e.home));
      if (A.restDays === 0 && H.restDays > 0) shift(e.home, 2, L.b2b(e.away));
    }
    if (espn.h2h) factors.push({ title: L.h2h, text: typeof espn.h2h === 'string' ? espn.h2h : L.h2hW(espn.h2h.who, espn.h2h.w, espn.h2h.d, espn.h2h.l) });
    if (espn.espnProj) {
      const d = (espn.espnProj.home - p[e.home]) * 25;
      if (Math.abs(d) >= 0.5) shift(e.home, d, L.proj);
    }
  } else {
    factors.push({ title: L.inj, text: L.noData });
  }
  norm(p);
  const mTxt = Object.entries(m).map(([k, v]) => `${k === 'Draw' ? L.draw : k} ${pct(v)}`).join(', ');
  factors.push({ title: L.odds, text: L.oddsT(mTxt, mvTxt) + (espn && espn.espnProj ? ' ' + L.espn(`${e.home} ${pct(espn.espnProj.home)}, ${e.away} ${pct(espn.espnProj.away)}`) : '') });

  const order = Object.entries(p).sort((a, b) => b[1] - a[1]);
  const gap = (order[0][1] - order[1][1]) * 100;
  const pick = order[0][0] === 'Draw' ? L.draw : order[0][0];
  const values = Object.keys(p).filter(k => (p[k] - m[k]) * 100 >= 3).map(k => L.value(k === 'Draw' ? L.draw : k, pct(p[k]), pct(m[k])));
  return {
    pick, confidence: L.conf[gap >= 20 ? 'alta' : gap >= 8 ? 'media' : 'baja'],
    prob: { home: p[e.home], away: p[e.away], draw: soc ? p.Draw : null },
    summary: L.sum(pick, pct(order[0][1]), why.length ? `${L.whyBase}: ${why.join('; ')}.` : L.noAdj),
    factors, value: values.length ? values.join('; ') : L.noValue,
    sources: espn && espn.link ? [{ title: 'ESPN', url: espn.link }] : [],
    model: 'samgers-v1', lang, t: Date.now(), espn: !!espn, league: soc ? leagueName(e.sport) : 'NBA', tz: TZ
  };
}
