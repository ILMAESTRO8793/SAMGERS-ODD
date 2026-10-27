import { TZ, leagueName } from './config.js';

const KEY = process.env.ANTHROPIC_API_KEY || '';
const BASE = process.env.ANTHROPIC_BASE || 'https://api.anthropic.com';
const MODELS = [process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', 'claude-sonnet-4-6'];

const american = d => (d >= 2 ? '+' + Math.round((d - 1) * 100) : String(Math.round(-100 / (d - 1))));
function fair(h) {
  if (!h) return null;
  const ks = Object.keys(h).filter(k => h[k] && h[k].p > 1);
  if (ks.length < 2) return null;
  const inv = ks.map(k => 1 / h[k].p), sum = inv.reduce((a, b) => a + b, 0);
  return Object.fromEntries(ks.map((k, i) => [k, inv[i] / sum]));
}
function snapText(label, s) {
  if (!s || !s.o) return `${label}: sin lectura`;
  const o = s.o, parts = [];
  if (o.h2h) {
    const f = fair(o.h2h) || {};
    parts.push('Moneyline ' + Object.entries(o.h2h).map(([n, v]) => `${n} ${american(v.p)} (${f[n] != null ? (f[n] * 100).toFixed(1) + '% sin margen' : ''})`).join(', '));
  }
  if (o.spreads) parts.push('Handicap ' + Object.entries(o.spreads).map(([n, v]) => `${n} ${v.pt > 0 ? '+' : ''}${v.pt} ${american(v.p)}`).join(', '));
  if (o.tmain != null && o.totals) {
    const ov = o.totals['Over|' + o.tmain], un = o.totals['Under|' + o.tmain];
    parts.push(`Total ${o.tmain}: Más ${ov ? american(ov.p) : '—'} / Menos ${un ? american(un.p) : '—'}`);
  }
  if (o.btts && o.btts.Yes) parts.push(`Ambos anotan: Sí ${american(o.btts.Yes.p)}${o.btts.No ? ' / No ' + american(o.btts.No.p) : ''}`);
  return `${label} (${new Date(s.t).toISOString()}): ${parts.join(' | ') || 'sin mercados'}`;
}

function buildPrompt(e, lang) {
  const soc = e.sport.startsWith('soccer_');
  const kick = new Date(e.commence).toLocaleString('es-PA', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' });
  const latest = e.live_snap || e.cur_snap || e.before_snap || e.open_snap;
  const L = lang === 'en' ? 'English' : 'español';
  return `Eres un analista deportivo profesional. Analiza este partido y da un pronóstico honesto, basado en datos.

PARTIDO: ${soc ? `${e.home} (local) vs ${e.away} (visitante)` : `${e.away} (visitante) @ ${e.home} (local)`}
COMPETICIÓN: ${soc ? leagueName(e.sport) : 'NBA'}
FECHA Y HORA: ${kick} (hora de Panamá). Hoy es ${new Date().toISOString().slice(0, 10)}.

CUOTAS DE LAS CASAS DE APUESTAS (ya guardadas por la app):
${snapText('Apertura', e.open_snap)}
${snapText('Día antes', e.before_snap)}
${snapText('Más reciente', latest)}

INVESTIGA CON LA BÚSQUEDA WEB (información actual, de esta semana):
1. Lesiones, suspensiones, dudas y estado físico de los jugadores clave de ambos equipos${soc ? '' : ' (incluye descansos y si alguno juega en back-to-back)'}.
2. Forma reciente y trayectoria: resultados de los últimos 5 a 10 partidos, racha, posición en la tabla y motivación.
3. El lugar del partido: estadio o arena, rendimiento de local y de visitante, viajes y días de descanso.
4. Enfrentamientos directos recientes.

Luego compara tu análisis con las probabilidades sin margen de las casas de apuestas y di si el mercado parece sobrevalorar o infravalorar a algún lado.

RESPONDE EN ${L}. Al final de tu respuesta escribe SOLO este JSON (sin texto después):
{
  "pick": "${soc ? 'nombre del equipo o Empate' : 'nombre del equipo'}",
  "prob": { "home": 0.00, ${soc ? '"draw": 0.00, ' : '"draw": null, '}"away": 0.00 },
  "confidence": "baja | media | alta",
  "summary": "2 o 3 frases con la conclusión",
  "factors": [
    { "title": "Lesiones y estado físico", "text": "..." },
    { "title": "Forma reciente y trayectoria", "text": "..." },
    { "title": "Lugar del partido", "text": "..." },
    { "title": "Enfrentamientos directos", "text": "..." },
    { "title": "Lo que dicen las cuotas", "text": "..." }
  ],
  "value": "dónde ves diferencia entre tu probabilidad y la del mercado, o 'sin valor claro'"
}
Las probabilidades de "prob" deben sumar 1. "home" es ${e.home} y "away" es ${e.away}. Si no encuentras un dato, dilo en el texto en vez de inventarlo. Es una estimación, no una certeza.`;
}

function extractJson(text) {
  const clean = text.replace(/```json|```/g, '');
  const end = clean.lastIndexOf('}');
  for (let i = clean.indexOf('{'); i !== -1 && i < end; i = clean.indexOf('{', i + 1)) {
    try { const j = JSON.parse(clean.slice(i, end + 1)); if (j && j.prob) return j; } catch {}
  }
  return null;
}

export const aiReady = () => !!KEY;

export async function predict(e, lang = 'es') {
  if (!KEY) throw new Error('Falta ANTHROPIC_API_KEY en las variables de Railway');
  let lastErr = null;
  for (const model of MODELS) {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
        messages: [{ role: 'user', content: buildPrompt(e, lang) }]
      }),
      signal: AbortSignal.timeout(240000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      lastErr = new Error((data.error && data.error.message) || `Error ${r.status} de la API de Claude`);
      if (r.status === 404 || /model/i.test(lastErr.message)) continue; // probar el siguiente modelo
      throw lastErr;
    }
    const blocks = data.content || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const j = extractJson(text);
    if (!j) throw new Error('La IA no devolvió un pronóstico válido; intenta de nuevo');
    const sources = [];
    for (const b of blocks) {
      if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) continue;
      for (const s of b.content) if (s.url && !sources.some(x => x.url === s.url) && sources.length < 6) sources.push({ title: s.title || s.url, url: s.url });
    }
    return { ...j, sources, model, lang, t: Date.now() };
  }
  throw lastErr || new Error('No se pudo generar el pronóstico');
}
