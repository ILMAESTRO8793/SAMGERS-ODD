# SAMGERS ODDS — servidor

App privada para 2 usuarios que guarda las cuotas de FanDuel en tres momentos:

- **Apertura:** la cuota del primer día en que FanDuel publica el partido.
- **Día antes:** la última cuota del día anterior al partido (se guarda a las 6:00 pm y a las 11:50 pm, hora de Panamá).
- **Día del partido:** la cuota actual, antes del inicio y en vivo, con marcador y comparación entre casas de apuestas.

Deportes: NFL, NCAAF, NBA y fútbol europeo (con BTTS y líneas de goles 0.5–3.5).

El servidor trabaja solo las 24 horas. Abrir la app, cambiar de pestaña o mirar partidos no gasta créditos; solo el en vivo gasta mientras alguno de los dos tenga la app abierta en pantalla.

---

## Lo que necesitas

1. Cuenta en **GitHub** (github.com)
2. Cuenta en **Railway** (railway.com), con un plan de pago (Hobby, unos 5 dólares al mes)
3. Tu clave de **The Odds API** (the-odds-api.com) con el plan de 20.000 créditos

---

## Paso 1 — Subir el código a GitHub

1. Entra a github.com y crea un repositorio nuevo llamado `samgers-odds`. Márcalo como **Private**.
2. En el repositorio, toca **Add file → Upload files**.
3. Arrastra **todo el contenido** de esta carpeta (las carpetas `src` y `public` y los archivos `package.json`, `package-lock.json`, `.gitignore`, `.env.example` y este `LEEME.md`).
4. Toca **Commit changes**.

## Paso 2 — Crear el proyecto en Railway

1. Entra a railway.com e inicia sesión con tu cuenta de GitHub.
2. Toca **New Project → Deploy from GitHub repo** y elige `samgers-odds`.
3. Dentro del proyecto, toca **+ Create → Database → PostgreSQL**. Railway crea la base de datos.

> Uso la base de datos de Railway y no Neon porque el servidor la consulta cada 30 segundos, todo el día; en el plan gratis de Neon eso consumiría las horas incluidas.

## Paso 3 — Variables (la configuración secreta)

Abre el servicio `samgers-odds` (no la base de datos) → pestaña **Variables** → **Raw Editor**, pega esto y cambia los valores:

```
ODDS_API_KEY=tu_clave_de_the_odds_api
DATABASE_URL=${{Postgres.DATABASE_URL}}
USERS=salem:una-contraseña-larga,invitado:otra-contraseña-larga
SESSION_SECRET=escribe-aqui-una-frase-larga-y-aleatoria-de-40-caracteres-o-mas
APP_TZ=America/Panama
```

- `DATABASE_URL` se escribe **exactamente así**: Railway la conecta sola con la base de datos.
- `USERS`: los dos usuarios, separados por coma, con el formato `usuario:contraseña`. Usa contraseñas largas.
- `SESSION_SECRET`: cualquier frase larga que nadie conozca. Si la cambias, los dos tendrán que volver a entrar.

Toca **Deploy** para aplicar los cambios.

## Paso 4 — Dirección web

1. En el servicio `samgers-odds` → **Settings → Networking → Generate Domain**.
2. Railway te da una dirección como `samgers-odds-production.up.railway.app`.
3. Ábrela, entra con tu usuario y listo.

En los primeros minutos las pestañas pueden estar vacías: el servidor hace su primera revisión de FanDuel al arrancar y los partidos aparecen solos.

## Paso 5 — Instalar en el celular

**iPhone**
1. Abre la dirección en **Safari** (no en Chrome).
2. Toca **Compartir** (el cuadro con la flecha hacia arriba).
3. Toca **Agregar a pantalla de inicio** → **Agregar**.

**Android**
1. Abre la dirección en **Chrome**.
2. Toca el menú **⋮** (arriba a la derecha).
3. Toca **Instalar app** (en algunos teléfonos dice **Agregar a la pantalla principal**) → **Instalar**.

En los dos queda un ícono de SAMGERS ODDS que abre la app a pantalla completa, sin la barra del navegador. También funciona en computadora: en Chrome o Edge aparece un botón de instalar en la barra de direcciones.

---

## Cómo se gastan los créditos

| Qué hace el servidor | Cuándo | Costo |
|---|---|---|
| Revisar la lista de partidos | Cada 30 min | Gratis |
| Guardar aperturas nuevas | Solo cuando hay partidos sin apertura | 3 por liga (+2 por partido de fútbol) |
| Día antes | 6:00 pm y 11:50 pm | 3 por liga con partidos mañana (+2 por partido de fútbol) |
| Cierre | Justo antes de cada partido | 3 por liga |
| En vivo | Solo con la app abierta en pantalla | 3 por liga cada 2 min, +2 del marcador |
| Rellenar día antes / Buscar apertura | Solo si tocas el botón | 30 / unos 150 |

En **Ajustes** de la app ves los créditos restantes y en qué se gastaron en las últimas 24 horas. El **tope diario** (1.500 por defecto) pausa el en vivo si se pasa; lo demás sigue funcionando.

## Si algo falla

- **Railway → servicio → Deployments → View logs** muestra los mensajes del servidor.
- `Falta DATABASE_URL`: revisa que la variable diga exactamente `${{Postgres.DATABASE_URL}}` y que la base de datos esté en el mismo proyecto.
- `Falta ODDS_API_KEY` o error 401: la clave de The Odds API está mal copiada o el plan venció.
- No puedes entrar: revisa `USERS`. El usuario no distingue mayúsculas; la contraseña sí.
