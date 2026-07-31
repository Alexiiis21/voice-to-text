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
4. [El troceado, en detalle](#4-el-troceado-en-detalle)
5. [Cómo obtener cada API key](#5-cómo-obtener-cada-api-key)
6. [Despliegue en Railway, paso a paso](#6-despliegue-en-railway-paso-a-paso)
7. [Costes por hora de audio](#7-costes-por-hora-de-audio)
8. [Historial sin autenticación: qué implica](#8-historial-sin-autenticación-qué-implica)
9. [Variables de entorno](#9-variables-de-entorno)
10. [API](#10-api)
11. [Decisiones y desviaciones respecto a la especificación](#11-decisiones-y-desviaciones-respecto-a-la-especificación)
12. [Trabajo futuro](#12-trabajo-futuro)
13. [Desarrollo](#13-desarrollo)

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

Las dos piezas con lógica no trivial —el cálculo de puntos de corte a partir de
`silencedetect` y la eliminación de duplicados en los solapes— son módulos puros
y están cubiertas por tests: `tests/silence.test.ts` y `tests/overlap.test.ts`.

```bash
npm test
```

---

## 5. Cómo obtener cada API key

### Groq (speech-to-text por defecto)

1. Entra en <https://console.groq.com> y crea una cuenta.
2. **API Keys** → **Create API Key**. Copia el valor (empieza por `gsk_`).
3. `GROQ_API_KEY=gsk_…`

Modelo usado: `whisper-large-v3-turbo`. Groq tiene un plan gratuito con límites
de peticiones por minuto generosos para este caso de uso.

### OpenAI (alternativa de speech-to-text)

1. <https://platform.openai.com/api-keys> → **Create new secret key**.
2. `OPENAI_API_KEY=sk-…` y `STT_PROVIDER=openai`.
3. Con OpenAI, baja `CHUNK_SECONDS` a `300`.

Modelo usado: `whisper-1`.

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

## 6. Despliegue en Railway, paso a paso

### 6.1 Crear el proyecto y la base de datos

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo**, y
   selecciona este repositorio. Railway detecta el `Dockerfile` (también hay un
   `railway.json` que lo fuerza explícitamente).
2. En el mismo proyecto: **+ New** → **Database** → **Add PostgreSQL**.

### 6.2 Volumen para el audio

1. Selecciona el servicio `web` → pestaña **Settings** → **Volumes** →
   **Add Volume**.
2. **Mount path**: `/data`.

El worker crea `/data/uploads` y `/data/chunks` al arrancar. Dimensiona el
volumen para el pico de audio simultáneo: un original de 500 MB + su normalizado
(~10 MB) por trabajo en curso. Con 1 GB vas sobrado.

### 6.3 Variables de entorno del servicio `web`

En **Variables**, añade:

```
DATABASE_URL       = ${{Postgres.DATABASE_URL}}   ← variable de referencia
DATA_DIR           = /data

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

`DATABASE_URL` debe ser una **variable de referencia** (`${{Postgres.DATABASE_URL}}`),
no un valor copiado: así sigue siendo válida si Railway rota las credenciales.

Para que `NEXT_PUBLIC_TURNSTILE_SITE_KEY` entre en el bundle del cliente, el
`Dockerfile` la declara como `ARG`. En Railway basta con definirla como
variable de servicio: Railway pasa las variables al build de Docker.

### 6.4 Healthcheck

**Settings** → **Deploy** → **Health Check Path**: `/api/health`.
Timeout recomendado: 120 s (las migraciones corren antes de que el servidor
escuche).

`/api/health` devuelve 200 sólo si hay conexión a Postgres y `ffmpeg` y
`ffprobe` están en el PATH. Incluye qué variables de entorno están definidas
como **booleanos**; jamás sus valores.

### 6.5 Desplegar

`git push` a la rama conectada. El primer build tarda unos minutos (instala
ffmpeg en la imagen).

### 6.6 No actives serverless / scale-to-zero

**No actives el modo serverless ni scale-to-zero de Railway en esta versión.**
Si el contenedor duerme, el bucle del worker se detiene y un trabajo encolado
puede quedarse esperando a la siguiente visita. La lógica de rescate al arrancar
lo recupera, pero con retraso: un audio subido a las 3 de la mañana no empezaría
a procesarse hasta que alguien abriera la página.

Es una optimización válida más adelante, una vez medido el consumo real, y
exige mover el procesado a un disparo explícito (webhook o cron) en lugar de un
bucle continuo.

### Presupuesto en el plan Hobby ($5/mes)

Railway factura memoria y CPU durante todo el tiempo que el contenedor está
vivo, no por petición. Lo que hace este proyecto para caber:

- Next.js en modo `standalone` e imagen base `node:22-slim`. La capa final no
  lleva un `node_modules` completo: sólo el output trazado de Next más dos
  bundles de esbuild (`dist/worker.js`, `dist/migrate.js`).
- `NODE_OPTIONS=--max-old-space-size=384` en el contenedor.
- El bucle del worker **sondea la cola cada 5 segundos** cuando está vacía;
  cuando hay trabajo en curso itera sin esperar.
- El barrido de retención se ejecuta **una vez al día**, comparando contra una
  marca de tiempo persistida en `worker_state`, no colgado de un `setInterval`
  que se reinicie con cada deploy.
- La columna `cost_usd` registra el coste estimado de cada transcripción
  (segundos de audio × tarifa STT + tokens × tarifa de Claude) y se muestra en
  el historial.

**Consumo medido en reposo** (`docker stats`, contenedores recién arrancados,
sin trabajos en cola): `web` **76 MiB** y `postgres` **67 MiB**, con la CPU a
0 %. La imagen final pesa ~850 MB, de los que la mayor parte es ffmpeg y sus
dependencias; eso afecta al almacenamiento de build, no a la memoria en
ejecución.

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
| `STT_PROVIDER` | No | `groq` | `groq` \| `openai` |
| `GROQ_API_KEY` | Si `STT_PROVIDER=groq` | — | |
| `OPENAI_API_KEY` | Si `STT_PROVIDER=openai` | — | |
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
| `GET /api/health` | Postgres + ffmpeg/ffprobe + presencia de variables (booleanos) |
| `GET /api/quota` | Cuota restante de la IP en la ventana horaria actual |

### Seguridad en `POST /api/transcriptions`

- **Turnstile**: verificado contra
  `https://challenges.cloudflare.com/turnstile/v0/siteverify`. Fallo → `403`.
  Se comprueba **antes de escribir un solo byte**: el cliente envía el campo
  `turnstileToken` antes del fichero en el `multipart`, y el parser mantiene el
  stream en pausa hasta que la verificación termina.
- **Rate limit por IP** (`x-forwarded-for`), contra la tabla `rate_limits`:
  10 transcripciones y 6 horas de audio por hora. Exceso → `429` con cabecera
  `Retry-After`. La reserva es un `INSERT … ON CONFLICT DO UPDATE … WHERE`
  atómico: dos peticiones simultáneas de la misma IP no pueden colarse.
- **Allowlist de extensiones y MIME**:
  `.ogg .opus .mp3 .m4a .wav .webm .aac .flac`. Lo demás → `400`.
- **Validación con ffprobe antes de encolar**: si ffprobe no reconoce un stream
  de audio, `400` con mensaje claro. Esto también protege de archivos maliciosos
  disfrazados de audio.
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

2. **Dos columnas añadidas al esquema de §3.**
   - `transcriptions.source_ext`: la extensión validada por el servidor. Sin
     ella no hay forma de localizar el fichero en disco sin usar el nombre que
     envía el cliente, que es exactamente lo que la especificación prohíbe.
   - `rate_limits.audio_seconds`: el límite de "6 horas de audio por hora" no es
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

7. **`next build` necesita `DATABASE_URL` definida** (cualquier valor). Next
   importa los módulos de las rutas para recolectar metadatos aunque todas sean
   `force-dynamic`. `src/lib/env.ts` detecta la fase de build
   (`NEXT_PHASE === 'phase-production-build'`) y usa un placeholder que nunca
   llega a abrir una conexión.

8. **Las fechas van como texto ISO en las consultas SQL crudas.** El cliente de
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
│  ├─ stt/                    Adaptador intercambiable Groq/OpenAI
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

Sin emojis en la interfaz, sin ilustraciones, sin degradados morados. La carga
se representa con barras rectangulares grises que pulsan, nunca con spinners
circulares. Responsive: una columna en móvil, dos desde 1024 px.
# voice-to-text
