export const TZ = process.env.APP_TZ || 'America/Panama';
export const API_BASE = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4';
export const API_KEY = process.env.ODDS_API_KEY || '';

export const FEATURED = 'h2h,spreads,totals';
export const EXTRA_SOC = 'btts,alternate_totals,team_totals';
// 5 casas principales por deporte, en orden de prioridad. Cada mercado se toma de la primera casa que lo tenga.
export const PRIO = {
  soc: ['fanduel', 'codere_it', 'pinnacle', 'draftkings', 'onexbet'],
  us: ['fanduel', 'draftkings', 'betmgm', 'williamhill_us', 'pinnacle']
};
export const PRIORITY = k => (String(k).startsWith('soccer_') ? PRIO.soc : PRIO.us);
export const PRIMARY = k => PRIORITY(k)[0];

export const SPORTS = {
  nfl: [{ k: 'americanfootball_nfl', n: 'NFL' }],
  ncaaf: [{ k: 'americanfootball_ncaaf', n: 'NCAAF' }],
  nba: [{ k: 'basketball_nba', n: 'NBA' }],
  nhl: [{ k: 'icehockey_nhl', n: 'NHL' }],
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
    { k: 'soccer_portugal_primeira_liga', n: 'Primeira Liga' },
    { k: 'soccer_usa_mls', n: 'MLS' },
    { k: 'soccer_efl_champ', n: 'Championship (Inglaterra)' },
    { k: 'soccer_fa_cup', n: 'FA Cup' },
    { k: 'soccer_england_efl_cup', n: 'EFL Cup (Carabao)' },
    { k: 'soccer_spain_copa_del_rey', n: 'Copa del Rey' },
    { k: 'soccer_italy_coppa_italia', n: 'Coppa Italia' },
    { k: 'soccer_germany_bundesliga2', n: '2. Bundesliga' },
    { k: 'soccer_germany_liga3', n: '3. Liga' },
    { k: 'soccer_germany_dfb_pokal', n: 'DFB-Pokal' },
    { k: 'soccer_france_coupe_de_france', n: 'Coupe de France' },
    { k: 'soccer_spl', n: 'Premiership (Escocia)' },
    { k: 'soccer_belgium_first_div', n: 'Bélgica' },
    { k: 'soccer_austria_bundesliga', n: 'Austria' },
    { k: 'soccer_switzerland_superleague', n: 'Suiza' },
    { k: 'soccer_denmark_superliga', n: 'Dinamarca' },
    { k: 'soccer_norway_eliteserien', n: 'Noruega' },
    { k: 'soccer_sweden_allsvenskan', n: 'Suecia (Allsvenskan)' },
    { k: 'soccer_finland_veikkausliiga', n: 'Finlandia' },
    { k: 'soccer_greece_super_league', n: 'Grecia' },
    { k: 'soccer_turkey_super_league', n: 'Turquía' }
  ]
};

// Competiciones que The Odds API tiene activas ahora mismo (se actualiza sola cada 6 horas; consulta gratis).
export const ACTIVE = { keys: null };
export const isActive = k => !ACTIVE.keys || ACTIVE.keys.has(k);

export const BOOKS = { fanduel: 'FanDuel', codere_it: 'Codere', draftkings: 'DraftKings', betmgm: 'BetMGM', williamhill_us: 'Caesars', pinnacle: 'Pinnacle', onexbet: '1xBet' };
// Casas para las player props de la NBA.
export const PROPS_BOOKS = ['fanduel', 'draftkings', 'betmgm', 'codere_it'];

export const DEFAULT_CONFIG = {
  sports: { nfl: true, ncaaf: true, nba: true, nhl: true, soc: true },
  leagues: null, // null = todas las ligas de fútbol de la lista
  books: ['fanduel', 'codere_it'],
  extras: true,
  ladder: '0.5, 1.5, 2.5, 3.5',
  liveSec: 120,
  watchMin: 30,
  dailyCap: 1500
};

export const tabOf = k => {
  for (const t in SPORTS) if (SPORTS[t].some(l => l.k === k)) return t;
  return 'soc';
};
export const leagueName = k => {
  for (const t in SPORTS) for (const l of SPORTS[t]) if (l.k === k) return l.n;
  return k;
};
export function trackedKeys(cfg, tab) {
  const out = [];
  for (const t of ['nfl', 'ncaaf', 'nba', 'nhl']) if (cfg.sports[t] && (!tab || tab === t)) out.push(...SPORTS[t].map(l => l.k));
  if (cfg.sports.soc && (!tab || tab === 'soc')) out.push(...SPORTS.soc.filter(l => cfg.leagues.includes(l.k) && isActive(l.k)).map(l => l.k));
  return out;
}

export const DAY = 864e5;
export const dayKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
export const hhmm = ts => new Date(ts).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
