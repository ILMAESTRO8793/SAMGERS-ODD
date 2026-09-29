import pg from 'pg';
import { DEFAULT_CONFIG, dayKey } from './config.js';

const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta DATABASE_URL'); process.exit(1); }

export const pool = new pg.Pool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'false' ? false
    : (process.env.DATABASE_SSL === 'true' || /sslmode=require|neon\.tech/.test(url)) ? { rejectUnauthorized: false } : false,
  max: 5
});
export const q = (text, params) => pool.query(text, params);

const SCHEMA = `
create table if not exists events (
  id text primary key,
  sport text not null,
  home text,
  away text,
  commence timestamptz not null,
  open_snap jsonb,
  before_snap jsonb,
  live_snap jsonb,
  books jsonb,
  score jsonb,
  xo jsonb,
  xt timestamptz,
  pub_at timestamptz,
  pub_from timestamptz,
  pub_hist boolean not null default false,
  last_check timestamptz,
  checks int not null default 0,
  close_done boolean not null default false,
  ended boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists events_commence_idx on events (commence);
create table if not exists snapshots (
  id bigserial primary key,
  event_id text not null references events(id) on delete cascade,
  kind text not null,
  taken_at timestamptz not null,
  source text not null default 'live',
  data jsonb not null
);
create index if not exists snapshots_event_idx on snapshots (event_id, taken_at);
create table if not exists credit_log (
  id bigserial primary key,
  ts timestamptz not null default now(),
  kind text not null,
  path text not null,
  cost int not null,
  remaining int
);
create index if not exists credit_log_ts_idx on credit_log (ts);
create table if not exists settings (
  key text primary key,
  value jsonb not null
);
`;

export async function migrate() { await q(SCHEMA); }

let cfgCache = null;
export async function getConfig() {
  if (cfgCache) return cfgCache;
  const r = await q(`select value from settings where key = 'config'`);
  const stored = r.rows[0] ? r.rows[0].value : {};
  cfgCache = { ...DEFAULT_CONFIG, ...stored, sports: { ...DEFAULT_CONFIG.sports, ...(stored.sports || {}) } };
  return cfgCache;
}
export async function setConfig(patch) {
  const cur = await getConfig();
  const next = { ...cur, ...patch, sports: { ...cur.sports, ...(patch.sports || {}) } };
  await q(`insert into settings (key, value) values ('config', $1) on conflict (key) do update set value = excluded.value`, [next]);
  cfgCache = next;
  return next;
}

export async function upsertEvent(ev, sport) {
  await q(`insert into events (id, sport, home, away, commence) values ($1,$2,$3,$4,$5)
           on conflict (id) do update set home = excluded.home, away = excluded.away, commence = excluded.commence`,
    [ev.id, sport, ev.home_team, ev.away_team, ev.commence_time]);
}

const JSON_COLS = new Set(['open_snap', 'before_snap', 'live_snap', 'books', 'score', 'xo']);
export async function updateEvent(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).concat('updated_at = now()');
  const vals = keys.map(k => (JSON_COLS.has(k) && fields[k] != null ? JSON.stringify(fields[k]) : fields[k]));
  await q(`update events set ${sets.join(', ')} where id = $1`, [id, ...vals]);
}

export async function addSnapshot(eventId, kind, snap) {
  await q(`insert into snapshots (event_id, kind, taken_at, source, data) values ($1,$2,$3,$4,$5)`,
    [eventId, kind, new Date(snap.t), snap.src || 'live', JSON.stringify(snap.o)]);
}

export async function eventsBySports(keys, fromTs, toTs) {
  const r = await q(`select * from events where sport = any($1) and commence >= $2 and commence <= $3 order by commence`,
    [keys, new Date(fromTs), new Date(toTs)]);
  return r.rows;
}

export async function creditsSummary() {
  const since = new Date(`${dayKey(Date.now())}T00:00:00`);
  const today = await q(`select kind, sum(cost)::int as cost, count(*)::int as calls from credit_log
                         where ts >= $1 group by kind order by cost desc`, [new Date(Date.now() - 24 * 3600e3)]);
  const last = await q(`select remaining from credit_log where remaining is not null order by ts desc limit 1`);
  const used24 = today.rows.reduce((s, r) => s + r.cost, 0);
  return { remaining: last.rows[0] ? last.rows[0].remaining : null, used24, byKind: today.rows, since };
}
export async function usedLast24() {
  const r = await q(`select coalesce(sum(cost), 0)::int as c from credit_log where ts >= now() - interval '24 hours'`);
  return r.rows[0].c;
}

export async function prune() {
  await q(`delete from events where commence < now() - interval '30 days'`);
  await q(`delete from snapshots where taken_at < now() - interval '60 days'`);
  await q(`delete from credit_log where ts < now() - interval '90 days'`);
}
