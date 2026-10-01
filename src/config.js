export const TZ = process.env.APP_TZ || 'America/Panama';
export const API_BASE = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4';
export const API_KEY = process.env.ODDS_API_KEY || '';

export const FEATURED = 'h2h,spreads,totals';
export const EXTRA_SOC = 'btts,alternate_totals';

export const SPORTS = {
  nfl: [{ k: 'americanfootball_nfl', n: 'NFL' }],
  ncaaf: [{ k: 'americanfootball_ncaaf', n: 'NCAAF' }],
  nba: [{ k: 'basketball_nba', n: 'NBA' }],
  soc: [
    { k: 'soccer_epl', n: 'Premier League' },
    { k: 'soccer_spain_la_liga', n: 'LaLiga' },
    { k: 'soccer_italy_serie_a', n: 'Serie A' },
    { k: 'soccer_germany_bundesliga', n: 'Bundesliga' },
    { k: 'soccer_france_ligue_one', n: 'Ligue 1' },
    { k: 'soccer_uefa_champs_league', n: 'Champions League' },
    { k: 'soccer_uefa_europa_league', n: 'Europa League' },
    { k: 'soccer_uefa_europa_conference_league', n: 'Conference League' },
    { k: 'soccer_netherlands_eredivisie', n: 'Eredivisie' },
    { k: 'soccer_portugal_primeira_liga', n: 'Primeira Liga' }
  ],
  // Selecciones nacionales: se llena solo desde The Odds API (ver refreshIntl en collector.js)
  intl: []
};

const INTL_RE = /^soccer_(?!.*club)(fifa|uefa_nations|uefa_euro_|uefa_european_championship|conmebol_copa_america|africa_cup|concacaf_gold|concacaf_nations|afc_asian|asian_cup|international|.*qualif|.*friendl)/;
export const isIntlKey = k => INTL_RE.test(k) && !/winner/.test(k);

export const BOOKS = { fanduel: 'FanDuel', codere_it: 'Codere' };

export const DEFAULT_CONFIG = {
  sports: { nfl: true, ncaaf: true, nba: true, soc: true, intl: true },
  leagues: ['soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a', 'soccer_germany_bundesliga',
    'soccer_france_ligue_one', 'soccer_uefa_champs_league'],
  books: ['fanduel', 'codere_it'],
  extras: true,
  ladder: '0.5, 1.5, 2.5, 3.5',
  liveSec: 120,
  watchMin: 30,
  dailyCap: 1500
};

export const tabOf = k => {
  if (isIntlKey(k)) return 'intl';
  for (const t in SPORTS) if (SPORTS[t].some(l => l.k === k)) return t;
  return 'soc';
};
export const leagueName = k => {
  for (const t in SPORTS) for (const l of SPORTS[t]) if (l.k === k) return l.n;
  return k;
};
export function trackedKeys(cfg, tab) {
  const out = [];
  for (const t of ['nfl', 'ncaaf', 'nba']) if (cfg.sports[t] && (!tab || tab === t)) out.push(...SPORTS[t].map(l => l.k));
  if (cfg.sports.soc && (!tab || tab === 'soc')) out.push(...SPORTS.soc.filter(l => cfg.leagues.includes(l.k)).map(l => l.k));
  if (cfg.sports.intl && (!tab || tab === 'intl')) out.push(...SPORTS.intl.map(l => l.k));
  return out;
}

export const DAY = 864e5;
export const dayKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
export const hhmm = ts => new Date(ts).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
