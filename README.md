# TRANSCRIPTOR

Transcripción de audio a texto en español, sin límite de duración, desplegada
íntegramente en Railway. Sin autenticación de usuarios; protección antibot con
Cloudflare Turnstile.

El resultado se consume en tres formas: **CRUDO** (salida literal de Whisper),
**EDITADO** (Claude Haiku 4.5, por fragmento) y **RESUMEN** (Claude Sonnet 5,
bajo demanda).

---

## Índice

1. [Arranque rápido en local](#1-arranque-rápido-en-local)
2. [Arquitectura](#2-arquitectura)
3. [Dos procesos en un servicio](#3-dos-procesos-en-un-servicio)
   · [Cuotas: desbordamiento y reanudación](#3bis-cuotas-del-proveedor-desbordamiento-y-reanudación)
4. [El troceado, en detalle](#4-el-troceado-en-detalle)
5. [Cómo obtener cada API key](#5-cómo-obtener-cada-api-key)
6. [Despliegue en Vercel, paso a paso](#6-despliegue-en-vercel-paso-a-paso)
7. [Costes por hora de audio](#7-costes-por-hora-de-audio)
8. [Historial sin autenticación: qué implica](#8-historial-sin-autenticación-qué-implica)
9. [Variables de entorno](#9-variables-de-entorno)
10. [API](#10-api)
11. [Decisiones y desviaciones respecto a la especificación](#11-decisiones-y-desviaciones-respecto-a-la-especificación)
12. [Trabajo futuro](#12-trabajo-futuro)
13. [Desarrollo](#13-desarrollo)
14. [Problemas frecuentes](#14-problemas-frecuentes)

---

## 1. Arranque rápido en local

```bash
cp .env.example .env      # rellena GROQ_API_KEY y ANTHROPIC_API_KEY
docker compose up --build
```

Abre <http://localhost:3000>. `docker compose` levanta dos contenedores:
`postgres` y `web` (Next.js + worker + ffmpeg). Las migraciones se aplican solas
al arrancar.

En local **Turnstile es opcional**: si `TURNSTILE_SECRET_KEY` no está definida,
el servidor salta la verificación y el widget no se renderiza. En Railway la
variable es obligatoria.

Sin `GROQ_API_KEY` la app arranca y sube archivos, pero el worker fallará al
llegar al proveedor STT y la transcripción quedará en `failed` con el motivo
visible en la interfaz.

---

## 2. Arquitectura

```
navegador
  │  POST /api/transcriptions   (multipart, archivo completo, sin límite de tamaño)
  ▼
servicio web (Next.js en Railway)
  │  1. Verifica Turnstile + rate limit
  │  2. Escribe el archivo en streaming a /data/uploads/<id>.<ext>
  │  3. Valida con ffprobe
  │  4. INSERT en `transcriptions` con status='queued'
  │  5. Responde 202 con el id
  │
  │  ── en el mismo contenedor, proceso de worker en bucle ──
  │     6. Reclama el trabajo (FOR UPDATE SKIP LOCKED)
  │     7. Normaliza → ffprobe duración → silencedetect → puntos de corte
  │     8. Por cada fragmento: extraer → STT → INSERT en `chunks` → borrar el fragmento
  │     9. Concatenar → status='transcribed'
  │    10. Si procede: edición con Haiku por fragmento; status='done'
  │    11. Borrar el audio original del disco
  │
  ▼
navegador ← GET /api/transcriptions/:id/stream  (SSE con el progreso en vivo)
```

| Capa | Elección |
|---|---|
| Lenguaje | TypeScript estricto, sin `any` |
| Framework | Next.js 15, App Router |
| Estilos | Tailwind CSS 3 |
| Componentes | shadcn/ui, sólo `Dialog`, `Sonner`, `Progress`, `Switch`, `Tooltip`, `ScrollArea`, `Tabs` |
| ORM | Drizzle ORM + drizzle-kit, driver `postgres` (postgres.js) |
| Base de datos | PostgreSQL (plugin de Railway) |
| Audio | ffmpeg nativo instalado en la imagen |
| Speech-to-text | Whisper vía adaptador intercambiable: Groq `whisper-large-v3-turbo` (por defecto) u OpenAI `whisper-1` |
| LLM | `@anthropic-ai/sdk` — `claude-haiku-4-5` (edición), `claude-sonnet-5` (resumen) |
| Antibot | Cloudflare Turnstile |
| Cola | Tabla en Postgres con `SELECT … FOR UPDATE SKIP LOCKED`. Sin Redis, sin BullMQ |
| Hosting | Railway: dos servicios, `web` y `postgres` |

### Esquema de base de datos

`transcriptions`, `chunks`, `rate_limits` según §3 de la especificación, más
`worker_state` (una fila: marca de tiempo del último barrido de retención).

Índices: `transcriptions(status, created_at)` para que el worker reclame
trabajos eficientemente, `transcriptions(session_id, created_at)` para el
historial, y un único `chunks(transcription_id, idx)`.

---

## 3. Dos procesos en un servicio

El servicio `web` arranca **dos procesos** desde `scripts/start.mjs`:

1. `node dist/migrate.js` — migraciones de Drizzle, **antes** que nada.
2. `node .next/standalone/server.js` — servidor de Next.js.
3. `node dist/worker.js` — bucle del worker.

**Por qué un supervisor propio y no `concurrently`**: una dependencia menos en
la imagen final, control explícito del orden (las migraciones tienen que
terminar antes de que el servidor acepte tráfico) y control explícito del
apagado. Al recibir `SIGTERM`, el supervisor lo propaga a los dos hijos y espera
hasta 130 s: el worker necesita ese margen para terminar el fragmento en curso.
Si cualquiera de los dos procesos muere, el supervisor mata al otro y sale con
código distinto de cero, para que Railway reinicie el contenedor.

**Consecuencia sobre el SSE**: el worker y el servidor son procesos separados,
así que no comparten un `EventEmitter`. La ruta `/api/transcriptions/:id/stream`
sondea Postgres cada segundo y emite sólo los cambios. Es la decisión correcta
para este despliegue: una consulta indexada por clave primaria cada segundo, y
sólo mientras hay un cliente conectado. La alternativa (`LISTEN`/`NOTIFY` de
Postgres) exige una conexión dedicada por proceso y sólo compensa cuando el
worker se separe en su propio servicio.

**Apagado limpio**: al recibir `SIGTERM`, el worker termina el fragmento en
curso, devuelve el trabajo a `queued` y sale. Nada queda colgado en `processing`
tras un redespliegue. Además, al arrancar, el worker devuelve a `queued` todo lo
que encuentre en `processing` o `editing`.

---

## 3.bis Cuotas del proveedor: desbordamiento y reanudación

El tier gratuito de Groq admite **7.200 segundos de audio por hora** (2 h) y
**28.800 al día** (8 h). Un audio de tres horas son 10.800 segundos: **no cabe
en una sola ventana horaria**. La app está construida para que eso no sea un
problema, con dos mecanismos que se combinan.

### Desbordamiento entre proveedores

`STT_PROVIDER` acepta una lista ordenada: `groq,openai`. El primero es el motor
por defecto; los siguientes absorben lo que el anterior no puede.

Cuando un fragmento recibe un `429` por cuota, **no se gastan reintentos**: se
salta de inmediato al siguiente proveedor de la cadena. Solo si todos están sin
cuota se pasa al segundo mecanismo.

> **La presencia de la clave es el interruptor.** Si defines `OPENAI_API_KEY`,
> OpenAI entra en la cadena aunque no lo añadas a `STT_PROVIDER`. Si no la
> defines, Groq trabaja solo. No hay que tocar código para cambiar de modo.

El usuario puede elegir el motor por transcripción desde el **selector del panel
de entrada** (`MOTOR DE TRANSCRIPCIÓN`). Ese motor pasa a la cabeza de la cadena;
los demás quedan detrás como desbordamiento. Los proveedores sin clave en el
servidor se muestran desactivados: la interfaz no puede forzar uno sin
credencial. El proveedor que transcribió realmente cada fragmento se guarda en
`chunks.stt_provider`, así que el coste se calcula con la tarifa correcta aunque
un mismo audio se haya repartido entre dos motores.

### Reanudación automática

Si toda la cadena está sin cuota, el trabajo **no falla**: vuelve a `queued` con
una marca `resume_after` y el worker sigue atendiendo otros. La consulta de
reclamo lo ignora hasta que llega la hora:

```sql
WHERE status = 'queued' AND (resume_after IS NULL OR resume_after <= now())
```

Los fragmentos ya transcritos están en `chunks`, así que al reanudarse continúa
donde lo dejó y **no se vuelve a pagar** lo ya hecho. El audio tampoco se borra
mientras el trabajo está aparcado. Un audio de tres horas se completa solo a lo
largo de dos ventanas horarias, sin que el usuario intervenga.

La espera sale de la cabecera `Retry-After`; Groq a veces la manda en el cuerpo
del error (`"try again in 2m59.56s"`) y también se parsea. Si no viene ninguna,
se asume un cuarto de hora. Todo esto vive en `src/lib/stt/retry.ts`, que es
puro y está cubierto por tests.

En la interfaz el estado se muestra como **ESPERANDO CUOTA**, con la hora
estimada de reanudación y cuántos fragmentos van hechos. No es un error y no se
presenta como tal.

### Clasificación de errores

Distinguir "espera" de "fallo" es lo que hace que todo esto funcione:

| Respuesta | Clase | Reacción |
|---|---|---|
| 5xx, 408, timeout, red caída | `transient` | Reintentar con el mismo proveedor: backoff exponencial 1 s → 2 s → 4 s, con tope de 30 s |
| `429` | `quota` | Saltar al siguiente proveedor sin gastar intentos; si no hay más, aparcar el trabajo |
| 401, 400, 413 y demás 4xx | `fatal` | No reintentar: no se arregla solo. Se pasa al siguiente proveedor por si el problema es de credenciales de uno solo |

---

## 4. El troceado, en detalle

El troceado ya no es necesario por límites de plataforma —Railway no tiene tope
de body ni timeout—, sino por tres motivos:

- Los proveedores de Whisper limitan el tamaño por archivo (~25 MB).
- Permite mostrar progreso real y reintentar sólo la parte que falló.
- Permite editar con Claude en paralelo, fragmento a fragmento.

### El procedimiento

1. **Normalizar siempre**: `-ac 1 -ar 16000 -c:a libmp3lame -b:a 32k`. Whisper
   trabaja internamente a 16 kHz mono, así que no se pierde calidad de
   reconocimiento y el peso baja unas 25×. Tres horas de audio quedan en ~43 MB.
2. **ffprobe** sobre el normalizado para la duración exacta.
3. **Detectar silencios**: `-af silencedetect=noise=-30dB:d=0.4`, primera pasada
   completa. La salida se parsea en `src/lib/silence.ts`.
4. **Calcular puntos de corte** (`computeCutPoints`): objetivo 10 minutos
   (`CHUNK_SECONDS`, 5 minutos con `STT_PROVIDER=openai`). Se busca el silencio
   cuyo punto medio esté más cerca del objetivo dentro de ±30 s. Si no hay
   ninguno en esa ventana, se corta en el punto exacto y el siguiente fragmento
   arranca **1,5 s antes** (solape). Si lo que queda al final no llega a un
   cuarto del objetivo, se absorbe en el último fragmento en lugar de generar un
   residuo de dos segundos.
5. **Extraer, subir, guardar, borrar** — en ese orden, uno a uno. Nunca se
   materializan los N fragmentos a la vez.
6. **Si un fragmento supera 20 MB** tras normalizar (o el límite del proveedor),
   se parte por la mitad, recursivamente hasta 4 niveles, y los textos se
   concatenan. Con 32 kbps esto no se dispara nunca en la práctica: 20 MB son
   83 minutos de audio.
7. **Reintentos**: hasta 3 por fragmento con backoff exponencial (1 s, 2 s, 4 s).
   Si agota los intentos, el fragmento se marca `failed`, se escribe
   `[fragmento N no transcrito]` en el texto final y **se continúa con el resto**.
   Nunca se aborta el trabajo entero por un fragmento.
8. **Unión**: los fragmentos se unen con `\n\n`. Si hubo solape, se elimina la
   duplicación comparando las últimas ~10 palabras de uno con las primeras del
   siguiente (`src/lib/overlap.ts`). Se exige coincidencia de al menos dos
   palabras: una sola palabra repetida es demasiado común en español para
   servir de evidencia.

Las piezas con lógica no trivial son módulos puros y están cubiertas por tests:
el cálculo de puntos de corte a partir de `silencedetect`
(`tests/silence.test.ts`), la eliminación de duplicados en los solapes
(`tests/overlap.test.ts`) y la política de espera frente a las cuotas del
proveedor (`tests/stt-retry.test.ts`).

```bash
npm test
```

---

## 5. Cómo obtener cada API key

### Groq (speech-to-text por defecto)

1. Entra en <https://console.groq.com> y crea una cuenta.
2. **API Keys** → **Create API Key**. Copia el valor (empieza por `gsk_`).
3. `GROQ_API_KEY=gsk_…`

Modelo usado: `whisper-large-v3-turbo`.

**El tier gratuito basta para un uso normal** y no hace falta el plan Developer:

| Límite (free tier) | Valor | Qué significa aquí |
|---|---|---|
| Peticiones/minuto | 20 | Irrelevante: un fragmento de 10 min es 1 petición |
| Peticiones/día | 2.000 | Irrelevante |
| **Audio seg/hora** | **7.200** | 2 h de audio por hora |
| **Audio seg/día** | **28.800** | 8 h de audio por día |

Si el upgrade al plan Developer aparece como *temporarily unavailable*, no es un
bloqueo: la app está diseñada para trabajar dentro de estos límites y reanudarse
sola cuando se agotan. Ver [§3.bis](#3bis-cuotas-del-proveedor-desbordamiento-y-reanudación).

### OpenAI (desbordamiento, o alternativa completa)

1. <https://platform.openai.com/api-keys> → **Create new secret key**.
2. `OPENAI_API_KEY=sk-…`

Modelo usado: `whisper-1`. Con solo definir la clave, OpenAI entra en la cadena
como desbordamiento: absorbe los fragmentos que Groq no puede transcribir por
falta de cuota, y **solo se paga por esos**. Para usarlo como motor principal,
pon `STT_PROVIDER=openai,groq` o elígelo en el selector de la interfaz.

### Anthropic (edición y resumen)

1. <https://console.anthropic.com> → **Settings** → **API Keys** → **Create Key**.
2. `ANTHROPIC_API_KEY=sk-ant-…`

Si esta variable no está definida, la app sigue funcionando: transcribe y
muestra la salida CRUDA. Las pestañas EDITADO y RESUMEN quedan sin contenido y
lo dicen explícitamente.

### Cloudflare Turnstile (antibot)

1. Entra en el panel de Cloudflare → **Turnstile** → **Add widget**.
2. **Widget name**: el que quieras. **Hostnames**: el dominio de Railway
   (`tu-proyecto.up.railway.app`) y, si vas a probar en local, `localhost`.
3. **Widget mode**: *Managed* es lo adecuado aquí.
4. Al crearlo obtienes dos valores:
   - **Site Key** → `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (es **pública**, viaja al
     navegador; es la única variable `NEXT_PUBLIC_*` del proyecto).
   - **Secret Key** → `TURNSTILE_SECRET_KEY` (secreta, sólo servidor).

> ⚠️ `NEXT_PUBLIC_TURNSTILE_SITE_KEY` se inyecta **en tiempo de build**. En
> Railway hay que definirla antes del despliegue para que entre en el bundle;
> si la añades después, hay que redesplegar.

---

## 6. Despliegue en Vercel, paso a paso

> El despliegue original era un contenedor en Railway: dos procesos vivos y un
> volumen. El `Dockerfile` y `railway.json` siguen en el repo y siguen
> funcionando, pero el camino soportado es Vercel. Lo que cambia y por qué está
> en [§6.6](#66-qué-cambia-respecto-al-contenedor).

### 6.1 Base de datos

Postgres gestionado, desde **Storage** en el panel de Vercel (Neon) o desde
<https://neon.tech> directamente. Copia la cadena de conexión.

> ⚠️ **Quita `channel_binding=require` de la cadena que copies.** Neon la incluye
> por defecto. `postgres.js` manda al servidor todo parámetro de la URL que no
> reconoce, y `channel_binding` no es un parámetro de servidor: Postgres cierra
> la conexión con `unrecognized configuration parameter "channel_binding"`.
> Deja `sslmode=require`, que sí lo entiende.
>
> Usa además la URL **directa**, no la del pooler (la que *no* lleva `-pooler`
> en el host): el techo de conexiones de esta app es bajo y las migraciones van
> más tranquilas sin PgBouncer por medio.

### 6.2 Almacenamiento del audio

**Storage** → **Create** → **Blob**, y conéctalo al proyecto. Vercel inyecta
`BLOB_READ_WRITE_TOKEN` solo.

No hay volumen que dimensionar: el audio se borra en cuanto termina la
transcripción, así que el almacén sólo aguanta lo que haya en vuelo.

> **Nota de privacidad:** Vercel Blob sólo ofrece `access: 'public'`. Las URLs
> llevan un sufijo aleatorio y son inadivinable, pero mientras el audio existe,
> cualquiera con la URL puede descargarlo. Es una ventana de minutos y sólo para
> quien ya tenga el enlace, pero es una diferencia real respecto al volumen de
> Railway, que no era accesible desde fuera.

### 6.3 Variables de entorno

En **Settings** → **Environment Variables** (ver [`.env.example`](.env.example)
para la lista completa y comentada):

```
DATABASE_URL       = postgresql://…@ep-….neon.tech/neondb?sslmode=require
PROCESS_SECRET     = <openssl rand -hex 32>

STT_PROVIDER       = groq
GROQ_API_KEY       = gsk_…

ANTHROPIC_API_KEY  = sk-ant-…
CLEANUP_MODEL      = claude-haiku-4-5
SUMMARY_MODEL      = claude-sonnet-5
ENABLE_CLEANUP     = true

CHUNK_SECONDS      = 600
MAX_UPLOAD_MB      = 500

NEXT_PUBLIC_TURNSTILE_SITE_KEY = 0x4AAA…
TURNSTILE_SECRET_KEY           = 0x4AAA…
```

`BLOB_READ_WRITE_TOKEN` y `CRON_SECRET` los pone Vercel; `DATA_DIR` se deja sin
definir (por defecto usa el tmp del sistema, que es lo único escribible).

**`PROCESS_SECRET` no es opcional en producción.** Sin él ni `CRON_SECRET`,
`/api/process` queda abierta y cualquiera puede disparar la cola y quemar tu
cuota de Groq. `/api/health` avisa con `processProtected: false`.

### 6.4 Migraciones

**Este es el paso que Vercel no hace por ti.** En el contenedor, las migraciones
corrían al arrancar (`scripts/start.mjs`). Vercel no ejecuta ese script: sólo
empaqueta las rutas. Así que se aplican a mano, una vez, y luego sólo cuando
cambie el esquema:

```bash
DATABASE_URL="postgresql://…?sslmode=require" npm run db:migrate
```

### 6.5 Desplegar

`git push` a la rama conectada. Comprueba `/api/health`:

```json
{ "status": "ok", "database": true, "blob": true, "processProtected": true }
```

`ffmpeg: false` **es lo esperado ahí**: el binario sólo viaja en el bundle de
las rutas que lo ejecutan (ver `outputFileTracingIncludes` en
`next.config.ts`), y `/api/health` no es una de ellas.

### 6.6 Qué cambia respecto al contenedor

| | Railway | Vercel |
|---|---|---|
| Ficheros | volumen `/data` | Vercel Blob + `/tmp` como scratch |
| Subida | multipart a la ruta | del navegador directo a Blob |
| Procesado | bucle infinito | `/api/process`, a plazos |
| ffmpeg | `apt-get` en la imagen | `@ffmpeg-installer`, en el bundle |
| Migraciones | al arrancar | `npm run db:migrate` a mano |

Las tres consecuencias que conviene tener presentes:

1. **El procesado va a plazos.** Una función tiene `maxDuration` (300 s), y un
   audio de tres horas no cabe. `processJob` levanta `JobInterrupted` entre
   fragmentos cuando se agota el presupuesto —el mismo mecanismo que usaba
   SIGTERM—, el trabajo vuelve a `queued` con lo transcrito guardado, y la
   invocación encadena la siguiente antes de responder. O sea: la señal
   cooperativa de apagado que ya existía es exactamente lo que hacía falta,
   sólo que disparada por un reloj en vez de por una señal del sistema.

2. **Nadie sondea la cola.** Sin proceso vivo hay que despertar el procesado:
   lo hace la confirmación de la subida, lo hace el SSE mientras el usuario
   espera con la pestaña abierta, y como última red lo hace el cron.

3. **El cron del plan Hobby corre una vez al día.** Suficiente para la limpieza
   (rescatar trabajos atascados, barrido de retención), pero inservible como
   planificador. Por eso el camino normal es el disparo directo. Con plan Pro se
   puede bajar `schedule` en `vercel.json` a `*/5 * * * *` y el cron pasa a ser
   también un planificador decente.

### Coste

Vercel no factura por tiempo vivo sino por invocación, así que la app en reposo
no cuesta nada — al revés que el contenedor, que se pagaba las 24 h. Lo que sí
hay que vigilar:

- **Duración de función.** Transcribir es esperar a un proveedor externo, no
  quemar CPU, pero se factura igual. Un audio largo son varias invocaciones de
  hasta 300 s.
- **Blob.** Sólo el audio en vuelo, y se borra al terminar.
- **Neon.** Aquí sí se ahorra respecto a Railway: sin worker sondeando cada 5 s,
  la base se suspende sola cuando no hay trabajo.
- La columna `cost_usd` sigue registrando el coste de STT + Claude por
  transcripción, que es el grueso de la factura real.

---

## 7. Costes por hora de audio

Estimación para **1 hora de audio en español**, ~9.000 palabras (~13.000 tokens).

| Concepto | Modelo | Tarifa | Coste / hora de audio |
|---|---|---|---|
| Transcripción | Groq `whisper-large-v3-turbo` | $0,04 / hora | **$0,040** |
| Transcripción (alt.) | OpenAI `whisper-1` | $0,006 / minuto | $0,360 |
| Edición | `claude-haiku-4-5` | $1 / $5 por MTok | **$0,078** |
| Resumen (bajo demanda) | `claude-sonnet-5` | $3 / $15 por MTok | **$0,051** |

**Total por hora de audio con la configuración por defecto: ≈ $0,12**
(≈ $0,07 si nadie pide el resumen).

Desglose de la edición: ~13.000 tokens de entrada + ~13.000 de salida por hora,
troceados en 6 llamadas de 10 minutos → 13.000 × $1/M + 13.000 × $5/M ≈ $0,078.
Desglose del resumen: ~13.000 tokens de entrada + ~800 de salida →
13.000 × $3/M + 800 × $15/M ≈ $0,051.

Con OpenAI como proveedor STT el coste se multiplica por ~4. Groq es la opción
por defecto por eso.

A esto hay que sumar el coste fijo de Railway (los dos servicios vivos), que en
reposo cabe dentro del crédito de $5 del plan Hobby.

Las tarifas están en `src/lib/config.ts` (`PRICING`). Si cambian, se ajustan ahí.

---

## 8. Historial sin autenticación: qué implica

El historial se asocia a una cookie `session_id` (uuid, `httpOnly`,
`sameSite=lax`, 90 días) que genera el middleware en el primer acceso. El
listado y el borrado se filtran **siempre** por ese `session_id`.

**Esto no es un mecanismo de seguridad.** `GET /api/transcriptions/:id` y el SSE
no filtran por sesión: quien conozca un `id` de transcripción puede consultarlo.
Los identificadores son UUID v4, así que no son adivinables, pero un enlace
compartido da acceso al contenido.

Si en el futuro se necesita privacidad real, ahí es donde entra la
autenticación: añadir un `user_id` a `transcriptions` y filtrar por él en todas
las rutas de lectura.

**Retención**: un barrido diario dentro del worker borra las transcripciones con
más de 30 días y sus ficheros. El audio original se borra siempre en cuanto
termina la transcripción, con éxito o sin él.

---

## 9. Variables de entorno

Ver `.env.example`. Ninguna clave secreta acaba en el bundle del cliente: la
única variable pública es `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.

| Variable | Obligatoria | Por defecto | Notas |
|---|---|---|---|
| `DATABASE_URL` | Sí | — | La inyecta Railway |
| `DATA_DIR` | No | `/data` | Punto de montaje del volumen |
| `STT_PROVIDER` | No | `groq` | Lista ordenada: primario y desbordamientos (`groq,openai`) |
| `GROQ_API_KEY` | Al menos una de las dos | — | Define la clave y el proveedor entra en la cadena |
| `OPENAI_API_KEY` | Al menos una de las dos | — | Idem; sin ella no hay desbordamiento |
| `ANTHROPIC_API_KEY` | No | — | Sin ella sólo hay salida CRUDA |
| `CLEANUP_MODEL` | No | `claude-haiku-4-5` | |
| `SUMMARY_MODEL` | No | `claude-sonnet-5` | |
| `ENABLE_CLEANUP` | No | `true` | |
| `CHUNK_SECONDS` | No | `600` (groq) / `300` (openai) | |
| `MAX_UPLOAD_MB` | No | `500` | |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | En producción | — | Pública, en tiempo de build |
| `TURNSTILE_SECRET_KEY` | En producción | — | Sin ella la verificación se salta |

---

## 10. API

Todas las rutas corren en `runtime = 'nodejs'`.

| Ruta | Función |
|---|---|
| `POST /api/transcriptions` | Turnstile → rate limit → escritura en streaming a disco → ffprobe → encola → `202 { id }` |
| `GET /api/transcriptions/:id` | Estado completo + textos disponibles + fragmentos |
| `GET /api/transcriptions/:id/stream` | SSE: `open`, `chunk_done`, `status_change`, `done`, `error`, `ping` |
| `POST /api/transcriptions/:id/summary` | Genera el resumen si no existe; devuelve el cacheado si ya está |
| `GET /api/transcriptions` | Historial de la sesión (cookie `session_id`), últimas 20 |
| `DELETE /api/transcriptions/:id` | Borra registro y ficheros asociados |
| `GET /api/health` | Postgres + Blob + presencia de variables (booleanos) |
| `GET /api/quota` | Cuota restante de la IP en la ventana horaria actual |
| `POST /api/blob/upload` | Emite el token de subida directa a Blob (Turnstile + rate limit) |
| `POST /api/process` | Procesa la cola. Protegida por `PROCESS_SECRET`/`CRON_SECRET` |
| `GET /api/cron` | Rescate de trabajos atascados y retención. Invocada por Vercel Cron |

### La subida, en dos pasos

El audio **no pasa por ninguna función**. El cuerpo de una petición a una
función serverless está limitado a 4,5 MB y aquí se suben cientos:

1. `POST /api/blob/upload` emite un token de subida. Aquí es donde se hacen
   todas las comprobaciones, **antes de que se escriba un solo byte**.
2. El navegador sube el fichero directo a Vercel Blob con ese token.
3. `POST /api/transcriptions` recibe sólo la URL resultante, comprueba que es
   nuestra y encola.

### Seguridad

- **Turnstile**: verificado contra
  `https://challenges.cloudflare.com/turnstile/v0/siteverify` al emitir el
  token. Sin token no hay subida posible.
- **Rate limit por IP** (`x-forwarded-for`), contra la tabla `rate_limits`:
  10 transcripciones y 2 horas de audio por hora. La reserva es un
  `INSERT … ON CONFLICT DO UPDATE … WHERE` atómico: dos peticiones simultáneas
  de la misma IP no pueden colarse. El contador de transcripciones se reserva al
  emitir el token; los **segundos de audio** se contabilizan al procesar, que es
  cuando se conoce la duración real (ver la columna `client_ip` del esquema).
- **Allowlist de extensiones y MIME**:
  `.ogg .opus .mp3 .m4a .wav .webm .aac .flac`. Lo demás → `400`.
- **Tamaño máximo**: lo impone Blob al emitir el token (`maximumSizeInBytes`),
  no el cliente.
- **La URL del blob es entrada no confiable.** Se valida el host y después se
  confirma con un `head()` firmado con nuestro token: sin eso, la ruta de
  encolado sería un SSRF.
- **Validación de que es audio de verdad**: `probeAudio` lanza si ffmpeg no
  encuentra ningún stream de audio. A diferencia del despliegue en contenedor,
  esta comprobación ocurre **al procesar**, no al encolar: la ruta de encolado
  ya no tiene el fichero. Un fichero disfrazado se rechaza igual, pero en forma
  de transcripción `failed` con el motivo, no de `400` inmediato.
- **Nombres de archivo generados por el servidor**: uuid + extensión validada.
  El nombre que envía el cliente **nunca** se usa para construir una ruta.

---

## 11. Decisiones y desviaciones respecto a la especificación

La especificación pedía señalar lo ambiguo o lo que chocara con un límite real
y seguir adelante dejándolo anotado. Esto es lo que hay:

1. **`max_tokens` del resumen: 8000 en vez de 4000.** En Claude Sonnet 5 el
   pensamiento adaptativo está activo por defecto y consume el mismo presupuesto
   de `max_tokens` que la respuesta. Con 4000 el resumen de un audio largo
   corría riesgo real de truncarse a mitad. Se desactiva el pensamiento
   explícitamente (`thinking: { type: 'disabled' }`) y se sube el techo a 8000.
   El prompt de sistema es literalmente el de la especificación.

2. **Cuatro columnas añadidas al esquema de §3.**
   - `transcriptions.source_ext`: la extensión validada por el servidor. Sin
     ella no hay forma de localizar el fichero en disco sin usar el nombre que
     envía el cliente, que es exactamente lo que la especificación prohíbe.
   - `transcriptions.resume_after`: marca hasta la que no se reclama el trabajo.
     Es lo que permite aparcar y reanudar cuando el proveedor STT se queda sin
     cuota, en vez de fallar.
   - `chunks.stt_provider`: qué proveedor transcribió realmente cada fragmento.
     Con desbordamiento, un mismo audio puede repartirse entre dos motores con
     tarifas distintas, y `cost_usd` tiene que reflejarlo.
   - `rate_limits.audio_seconds`: el límite de "N horas de audio por hora" no es
     computable con las columnas de §3, que sólo tienen `count`.

   También hay una tabla `worker_state` (una fila) para la marca de tiempo del
   barrido de retención, que §9 pide persistir.

3. **Barrido de arranque: se requeuean todos los trabajos en vuelo, no sólo los
   de más de 30 minutos.** §9 pide requeue de lo que lleve más de 30 minutos en
   `processing`. Con un único worker por contenedor, en el momento del arranque
   no puede haber ningún trabajo legítimamente en curso, así que esperar 30
   minutos sólo retrasaría la recuperación de un audio de tres horas. Se
   requeuean todos. Cuando el worker se separe en su propio servicio (ver
   [Trabajo futuro](#12-trabajo-futuro)) habrá que volver al criterio temporal,
   con un heartbeat por trabajo.

4. **`GET /api/quota` no está en la tabla de §5.** La barra superior muestra
   "USOS RESTANTES: n" y no hay forma de calcularlo en el cliente. Es una ruta
   de sólo lectura que devuelve el consumo de la IP en la ventana actual.

5. **El SSE sondea la base de datos** en lugar de escuchar eventos en proceso.
   Es consecuencia directa de tener el worker en otro proceso; está explicado en
   [Dos procesos en un servicio](#3-dos-procesos-en-un-servicio).

6. **El fragmento se lee del disco como `Blob` perezoso** (`fs.openAsBlob`) para
   subirlo al proveedor STT, no como `Buffer`. Es lo más cerca del "no cargues
   archivos completos en memoria" que permite `fetch` con `FormData`.

7. **El build ignora `DATABASE_URL`, esté ausente o mal formada.** Next importa
   los módulos de las rutas para recolectar metadatos aunque todas sean
   `force-dynamic`. `src/lib/env.ts` detecta la fase de build
   (`NEXT_PHASE === 'phase-production-build'`) y usa un placeholder que nunca
   llega a abrir una conexión.

   Se ignora también cuando es **inválida**, no sólo cuando falta: Railway
   inyecta las variables del servicio en el build, así que una URL rota tumbaría
   la compilación además del arranque, y el mensaje llegaría en los Build Logs,
   donde despista más. El build no consulta la base de datos; la validación vive
   en `src/db/index.ts` y `src/db/migrate.ts`, ya en ejecución.

8. **El rate limit por IP baja de 6 h a 2 h de audio por hora.** §5 pedía 6 h,
   pero el tier gratuito de Groq admite 7.200 s (2 h) de audio por hora **en
   total**, no por IP. Aceptar 6 h/hora significaba admitir trabajo que el
   proveedor no puede completar dentro de la ventana. Si configuras
   desbordamiento a OpenAI, se puede volver a subir en
   `RATE_LIMIT.maxAudioSeconds` (`src/lib/config.ts`).

9. **Un 429 de cuota no es un fallo.** El backoff exponencial original
   (1 s / 2 s / 4 s) agotaba los tres intentos en segundos contra una cuota
   **horaria**, y marcaba el fragmento como fallido. Ahora los errores se
   clasifican en `transient` / `quota` / `fatal` y cada clase tiene su reacción.
   Ver [§3.bis](#3bis-cuotas-del-proveedor-desbordamiento-y-reanudación).

10. **Las fechas van como texto ISO en las consultas SQL crudas.** El cliente de
   postgres.js se configura con `prepare: false` para ser compatible con
   poolers en modo *transaction*. En ese modo postgres.js delega la inferencia
   de tipos al servidor y **no sabe serializar un objeto `Date`**: revienta con
   `ERR_INVALID_ARG_TYPE`. Las consultas construidas por Drizzle no se ven
   afectadas (Drizzle convierte a ISO por su cuenta); las de `src/lib/rate-limit.ts`,
   que son SQL crudo, pasan `.toISOString()` explícitamente.

---

## 12. Trabajo futuro

### Separar el worker en su propio servicio de Railway

**No implementado a propósito.** Exige almacenamiento de objetos compartido (R2
o S3), porque un volumen de Railway sólo puede montarse en un servicio: hoy el
servidor escribe el audio en `/data/uploads` y el worker lo lee del mismo disco.

El camino sería:

1. Sustituir la escritura a disco por una subida en streaming a R2/S3.
2. El worker descarga el objeto, lo normalizada en su disco efímero y sube los
   textos a Postgres como ahora.
3. Añadir un `heartbeat_at` por trabajo y volver al barrido temporal (requeue de
   lo que lleve más de N minutos sin latido), porque con varios workers el
   criterio de "todo lo que esté en `processing` al arrancar" deja de valer.
4. Cambiar el SSE a `LISTEN`/`NOTIFY` de Postgres, que ya sí compensa.

### Otras

- **Scale-to-zero**: viable una vez medido el consumo real, moviendo el
  procesado a un disparo explícito. Ver
  [6.6](#66-no-actives-serverless--scale-to-zero).
- **Diarización de hablantes**: ni Groq ni OpenAI la ofrecen en el endpoint de
  transcripción; requeriría un modelo aparte.

---

## 13. Desarrollo

```bash
npm install

# Postgres en local (o usa el del docker-compose)
docker compose up postgres -d

cp .env.example .env
# DATABASE_URL=postgres://postgres:postgres@localhost:5432/transcriptor
# DATA_DIR=./data

npm run db:migrate     # aplica migraciones
npm run dev            # servidor de Next.js en :3000
npm run dev:worker     # bucle del worker, en otra terminal
```

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run dev:worker` | Worker con TypeScript directo (Node 22 `--experimental-strip-types`) |
| `npm run build` | `next build` + bundles del worker y las migraciones |
| `npm start` | Supervisor de producción (migraciones + Next + worker) |
| `npm test` | Tests unitarios (Vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:generate` | Genera una migración a partir del esquema |
| `npm run db:migrate` | Aplica migraciones |

### Estructura

```
src/
├─ app/                       Rutas de Next (App Router)
│  ├─ api/                    Route handlers, todos runtime='nodejs'
│  ├─ layout.tsx  page.tsx
│  └─ globals.css             Paleta y primitivas visuales de §8
├─ components/
│  ├─ ui/                     Primitivos de shadcn (sólo los 7 permitidos)
│  ├─ transcriber.tsx         Orquestador de cliente: subida, SSE, estado
│  ├─ upload-panel.tsx        Drag&drop + Ctrl+V + selector + reproductor
│  ├─ progress-panel.tsx      Fila de fragmentos alimentada por SSE
│  ├─ result-panel.tsx        Tabs CRUDO/EDITADO/RESUMEN + copiar + descargar
│  └─ history-panel.tsx       Historial de la sesión + borrado
├─ db/                        Esquema de Drizzle, cliente y runner de migraciones
├─ lib/
│  ├─ silence.ts              Puntos de corte (puro, testeado)
│  ├─ overlap.ts              Dedupe de solapes (puro, testeado)
│  ├─ ffmpeg.ts               ffprobe, silencedetect, normalización, extracción
│  ├─ stt/                    Cadena de proveedores Groq/OpenAI
│  │  ├─ retry.ts             Política de espera ante cuotas (puro, testeado)
│  │  ├─ whisper-http.ts      Cliente común + clasificación de errores
│  │  └─ index.ts             Registro, disponibilidad y resolución de cadena
│  ├─ claude.ts               Edición y resumen
│  ├─ upload.ts               Multipart en streaming a disco (busboy)
│  ├─ rate-limit.ts turnstile.ts session.ts cost.ts files.ts
│  └─ config.ts env.ts        Constantes y variables de entorno
├─ worker/                    Bucle, procesamiento, retención, repositorio
└─ middleware.ts              Cookie anónima session_id
```

### Diseño visual

Estética terminal / brutalista técnico, oscura y de alto contraste. Fondo
`#0A0A0A`, superficies `#121212`, bordes de 1 px en `rgba(255,255,255,0.08)`,
radio máximo 4 px, sin sombras difusas. Un único gradiente de acento
(`#FF6B35` → `#D62828`) usado sólo en la barra de progreso, los fragmentos
completados y el borde del panel activo.

Los primitivos de shadcn heredan estos colores porque las variables CSS del tema
están reescritas en `src/app/globals.css`; no se usa el tema por defecto.

---

## 14. Problemas frecuentes

### `Healthcheck failed! 1/1 replicas never became healthy`

El healthcheck es la víctima, no la causa: el contenedor está reiniciándose antes
de llegar a escuchar. Mira los **Deploy Logs**, no los de Build. Casi siempre es
`DATABASE_URL`.

### `DATABASE_URL no es válida … Falta el host`

```
[migrate] DATABASE_URL no es válida.
  URL recibida (contraseña oculta): postgresql://postgres:***@:/railway
  - Falta el host. …
```

`DATABASE_URL` se compuso a mano con referencias que no resuelven. Sustitúyela por
la referencia completa `${{Postgres.DATABASE_URL}}`. Ver [§6.3](#63-variables-de-entorno-del-servicio-web).

Los mensajes salen de `src/lib/db-url.ts`, que valida la URL **antes** de pasarla
a postgres.js. El motivo de que exista: postgres.js respondía con un escueto
`TypeError: Invalid URL` **y volcaba la cadena de conexión completa, con la
contraseña, en los logs de despliegue**. La validación propia falla rápido, dice
qué falta y redacta siempre la credencial.

> Si alguna vez ves una contraseña en tus logs, **rótala**: Railway → servicio
> Postgres → Variables → regenerar. Los logs de despliegue se conservan.

### `flag '--mount=type=cache' is missing an id argument`

Es el builder Metal de Railway rechazando una caché de BuildKit. El `Dockerfile`
de este repo ya no usa ninguna extensión de BuildKit. Ver [§6.5](#65-desplegar).

### El deploy sube pero un audio se queda en `queued` con "ESPERANDO CUOTA"

No es un error: el proveedor STT se quedó sin cuota horaria y el trabajo se
reanuda solo. Ver [§3.bis](#3bis-cuotas-del-proveedor-desbordamiento-y-reanudación).

### `Request body exceeded 10MB` / `Unexpected end of form` al subir

Next.js limita a **10 MB** el cuerpo de toda petición que atraviese el
`middleware`. Si el matcher de `src/middleware.ts` captura `/api/transcriptions`,
cualquier audio mayor se trunca a 10 MB y el parser multipart muere con
`Unexpected end of form`.

Por eso el matcher **excluye `/api/`**:

```ts
matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)']
```

No subas `middlewareClientMaxBodySize` para arreglarlo: obligaría a bufferizar el
audio entero en memoria, contra un heap de 384 MB. El middleware sólo crea la
cookie `session_id`, que ya se genera al cargar la página; las rutas de API se
limitan a leerla.

### `invalid header value` con una clave de API

```
Headers.append: "sk-ant-…
CLEANUP_MODEL=claude-haiku-4-5" is an invalid header value.
```

El valor de la variable lleva pegada la línea siguiente: pasa al copiar varias
líneas del `.env` en el campo de una sola variable. Vuelve a pegar sólo la clave.

`src/lib/env.ts` ahora recorta los espacios de los bordes y **rechaza al arrancar**
cualquier variable con un salto de línea en medio, en vez de dejar que reviente a
mitad de un trabajo. Y todo error de terceros pasa por `src/lib/redact.ts` antes
de llegar a consola: el SDK de Anthropic incluía la clave entera en ese mensaje y
acabó en los logs de despliegue.

> Si ves una credencial en tus logs, **revócala**. Anthropic: console → Settings →
> API Keys. Groq: console → API Keys. Railway/Postgres: Variables → regenerar.

### `403` al subir el segundo audio seguido

El token de Turnstile es de un solo uso y caduca a los 300 s. El cliente pide uno
nuevo tras cada subida; si aun así ocurre, recarga la página. Si `TURNSTILE_SECRET_KEY`
está definida pero `NEXT_PUBLIC_TURNSTILE_SITE_KEY` no entró en el build, el
widget no se renderiza y no hay token: **redespliega** tras añadirla.

### Las migraciones reintentan al arrancar

```
[migrate] Postgres todavía no acepta conexiones (ECONNREFUSED); reintento 1/5 en 2 s
```

Normal en el primer despliegue: el plugin de Postgres tarda en aceptar conexiones.
Se reintenta 5 veces con backoff. Si agota los intentos, revisa que ambos servicios
estén en el mismo proyecto de Railway.

Sin emojis en la interfaz, sin ilustraciones, sin degradados morados. La carga
se representa con barras rectangulares grises que pulsan, nunca con spinners
circulares. Responsive: una columna en móvil, dos desde 1024 px.
# voice-to-text
