# Prompt para Claude — App de transcripción de audio a texto (español)

> Copia todo lo que está debajo de la línea y pégalo en Claude Code como primer mensaje.

---

Construye una aplicación web de transcripción de audio a texto en español, desplegada íntegramente en **Railway** (base de datos, backend y frontend). Sin autenticación de usuarios, pero con protección antibots. Quiero código completo y funcional, no pseudocódigo.

Dos requisitos duros que condicionan todo el diseño:

1. **Audios de cualquier duración, sin límite.** Una hora o tres horas tienen que funcionar.
2. **El resultado debe poder consumirse en tres formas**: transcripción cruda, versión editada legible, y resumen condensado.

## 1. Stack técnico

| Capa | Elección |
|---|---|
| Lenguaje | TypeScript en estricto (`"strict": true`), sin `any` salvo justificación en comentario |
| Framework | Next.js 15, App Router, React Server Components donde tenga sentido |
| Estilos | Tailwind CSS |
| Componentes | shadcn/ui, **solo** los primitivos listados en §7 |
| ORM | **Drizzle ORM** + `drizzle-kit` para migraciones, driver `postgres` (postgres.js) |
| Base de datos | PostgreSQL (plugin de Railway) |
| Audio | **ffmpeg nativo** en el servidor, instalado en la imagen |
| Speech-to-text | Whisper vía adaptador intercambiable. Por defecto **Groq** (`whisper-large-v3-turbo`); alternativa **OpenAI** (`whisper-1`) |
| LLM | `@anthropic-ai/sdk` — `claude-haiku-4-5` para edición, `claude-sonnet-5` para resumen |
| Antibot | Cloudflare Turnstile |
| Cola de trabajos | Tabla en Postgres con `SELECT ... FOR UPDATE SKIP LOCKED`. Sin Redis, sin BullMQ |
| Hosting | Railway: **dos servicios** — `web` (esta app) y `postgres` |

**No uses Drizzle y Prisma a la vez, ni migres a Prisma.** La elección de Drizzle es deliberada: el esquema es pequeño y Prisma añade un motor binario que engorda la imagen y complica el arranque en Railway.

## 2. Arquitectura

```
navegador
  │  POST /api/transcriptions   (multipart, archivo completo, sin límite de tamaño)
  ▼
servicio web (Next.js en Railway)
  │  1. Verifica Turnstile + rate limit
  │  2. Escribe el archivo en streaming a /data/uploads/<id>.<ext>
  │  3. INSERT en `transcriptions` con status='queued'
  │  4. Responde 202 con el id
  │
  │  ── en el mismo contenedor, proceso de worker en bucle ──
  │     5. Reclama el trabajo (FOR UPDATE SKIP LOCKED)
  │     6. ffprobe → duración; ffmpeg silencedetect → puntos de corte
  │     7. Por cada fragmento: extraer → STT → INSERT en `chunks` → borrar el fragmento
  │     8. Concatenar → status='transcribed'
  │     9. Si procede: edición con Haiku por fragmento; resumen con Sonnet
  │    10. Borrar el audio original del disco
  │
  ▼
navegador ← GET /api/transcriptions/:id/stream  (SSE con el progreso en vivo)
```

El servicio `web` arranca **dos procesos**: el servidor de Next.js y el bucle del worker. Usa un `start` script que lance ambos (por ejemplo con `concurrently`, o un pequeño supervisor propio). Documenta la decisión en el README.

> **Vía de escalado, no la implementes ahora**: separar el worker en un servicio Railway propio exige almacenamiento de objetos compartido (R2 o S3), porque un volumen de Railway solo puede montarse en un servicio. Déjalo anotado en el README como trabajo futuro.

### Troceado — sigue siendo necesario

Ya no por límites de la plataforma (Railway no tiene ni tope de body ni timeout), sino porque:
- Los proveedores de Whisper limitan el tamaño por archivo (~25 MB).
- Permite mostrar progreso real y reintentar solo la parte que falló.
- Permite editar con Claude en paralelo, fragmento a fragmento.

Reglas:
- **Normaliza siempre**: `-ac 1 -ar 16000 -c:a libmp3lame -b:a 32k`. Whisper trabaja internamente a 16 kHz mono, así que no se pierde calidad de reconocimiento y el peso baja ~25×.
- **Objetivo por fragmento: 10 minutos** (`CHUNK_SECONDS`). Con `STT_PROVIDER=openai` baja a 5 minutos.
- **Corta en silencios.** Primera pasada con `-af silencedetect=noise=-30dB:d=0.4`, parsea la salida y elige el silencio más cercano al objetivo dentro de ±30 s. Si no hay ninguno en esa ventana, corta en el punto exacto y añade 1,5 s de solape.
- Extrae cada fragmento con `-ss`/`-t`, **súbelo, guarda el texto y bórralo del disco antes de extraer el siguiente.** No materialices los N fragmentos a la vez.
- Si un fragmento supera 20 MB después de normalizar, pártelo por la mitad.
- **Reintentos**: hasta 3 por fragmento con backoff exponencial. Si agota los intentos, marca ese fragmento como `failed`, escribe `[fragmento N no transcrito]` en el texto final y **continúa con el resto**. Nunca abortes el trabajo entero por un fragmento.
- Los fragmentos se unen con `\n\n`. Si hubo solape, elimina la duplicación comparando las últimas ~10 palabras de uno con las primeras del siguiente.

## 3. Esquema de base de datos (Drizzle)

```
transcriptions
  id              uuid pk
  session_id      text        -- cookie anónima, para el historial por navegador
  filename        text
  size_bytes      bigint
  duration_sec    integer
  status          enum('queued','processing','transcribed','editing','done','failed')
  stt_provider    text
  chunk_count     integer
  raw_text        text
  clean_text      text
  summary_text    text
  word_count      integer
  cost_usd        numeric(10,5)   -- coste acumulado estimado
  error           text
  created_at      timestamptz
  started_at      timestamptz
  completed_at    timestamptz

chunks
  id                uuid pk
  transcription_id  uuid fk -> transcriptions.id on delete cascade
  idx               integer
  start_sec         numeric
  end_sec           numeric
  status            enum('pending','done','failed')
  raw_text          text
  clean_text        text
  attempts          integer default 0
  error             text

rate_limits
  ip           text
  window_start  timestamptz
  count         integer
  pk (ip, window_start)
```

Índices en `transcriptions(status, created_at)` para que el worker reclame trabajos eficientemente, y en `chunks(transcription_id, idx)`.

Migraciones con `drizzle-kit generate`, aplicadas automáticamente al arrancar el contenedor antes de levantar el servidor.

## 4. El papel de Claude — tres modos de salida

La interfaz ofrece un selector de tres estados: **CRUDO · EDITADO · RESUMEN**.

**CRUDO** — la salida literal de Whisper. Siempre se conserva en la base de datos. Es el fallback: si la edición o el resumen fallan, no se pierde nada.

**EDITADO** — `claude-haiku-4-5`, aplicado **por fragmento** (peticiones pequeñas, resultado progresivo, paralelizable). Whisper ya devuelve puntuación razonable en español; lo que aporta esta pasada es dividir en párrafos (Whisper devuelve un muro de texto continuo, insoportable en audios largos), eliminar muletillas, repeticiones y arranques en falso, y corregir nombres propios y tecnicismos.

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const response = await client.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 8000,
  system:
    'Eres un editor de transcripciones en español. Recibes un fragmento de ' +
    'texto crudo producido por un sistema de reconocimiento de voz. Devuelves ' +
    'EXCLUSIVAMENTE ese mismo texto editado: divídelo en párrafos coherentes, ' +
    'corrige puntuación y mayúsculas, arregla errores evidentes de ' +
    'reconocimiento, y elimina muletillas, repeticiones y arranques en falso ' +
    'cuando no aporten nada. No resumas, no parafrasees, no traduzcas, no ' +
    'añadas encabezados ni comentarios tuyos. Conserva el significado y el ' +
    'registro del hablante. El fragmento puede empezar o acabar a mitad de ' +
    'una frase: déjalo así, no lo completes.',
  messages: [{ role: 'user', content: chunkRawText }],
});
```

**RESUMEN** — `claude-sonnet-5`, una sola vez sobre el texto editado completo. Aquí sí se pide criterio, y la diferencia de modelo se nota.

Para audios largos, hazlo en **dos etapas (map-reduce)**: si el texto editado supera ~40.000 palabras, resume primero cada fragmento y luego combina esos resúmenes parciales en el final. Por debajo de ese umbral, una sola llamada sobre el texto completo.

```ts
const response = await client.messages.create({
  model: 'claude-sonnet-5',
  max_tokens: 4000,
  system:
    'Resumes transcripciones en español. Devuelves, en este orden y sin ' +
    'ningún preámbulo: (1) un párrafo de 3-4 frases con la idea central; ' +
    '(2) una lista de los puntos tratados, en el orden en que aparecen; ' +
    '(3) si los hay, una lista de decisiones tomadas y tareas pendientes con ' +
    'su responsable cuando se mencione. Omite por completo cualquier sección ' +
    'que no aplique al contenido, sin anunciarlo. No inventes nada que no ' +
    'esté en el texto. Escribe en el mismo registro del original.',
  messages: [{ role: 'user', content: fullCleanText }],
});
```

Usa los IDs `claude-haiku-4-5` y `claude-sonnet-5` tal cual — están completos, no les añadas sufijos de fecha.

La edición se lanza automáticamente al terminar la transcripción si `ENABLE_CLEANUP=true` (valor por defecto). **El resumen se genera bajo demanda**, al pulsar la pestaña RESUMEN por primera vez, y se cachea en la base de datos: no tiene sentido pagarlo en transcripciones que nadie va a resumir.

## 5. API

Todas las rutas con `export const runtime = 'nodejs'`.

| Ruta | Función |
|---|---|
| `POST /api/transcriptions` | Verifica Turnstile → rate limit → escribe el archivo **en streaming a disco** (nunca en memoria: pueden ser cientos de MB) → encola → `202 { id }` |
| `GET /api/transcriptions/:id` | Estado completo + textos disponibles |
| `GET /api/transcriptions/:id/stream` | **SSE** con eventos de progreso: `chunk_done`, `status_change`, `done`, `error`. Sin timeout de plataforma, así que es la vía principal |
| `POST /api/transcriptions/:id/summary` | Genera el resumen si no existe; devuelve el cacheado si ya está |
| `GET /api/transcriptions` | Historial de la sesión (cookie `session_id`), últimas 20 |
| `DELETE /api/transcriptions/:id` | Borra registro y ficheros asociados |
| `GET /api/health` | Comprueba conexión a Postgres, presencia de `ffmpeg` en el PATH, y qué variables de entorno están definidas (booleanos, **jamás** los valores) |

Reglas de seguridad en `POST /api/transcriptions`:
- Turnstile: verificar contra `https://challenges.cloudflare.com/turnstile/v0/siteverify`. Fallo → `403`.
- Rate limit por IP (`x-forwarded-for`), contra la tabla `rate_limits`: **10 transcripciones y 6 horas de audio por hora**. Exceso → `429` con header `Retry-After`.
- Allowlist explícita de extensiones y MIME types: `.ogg .opus .mp3 .m4a .wav .webm .aac .flac`. Rechaza lo demás con `400`.
- Valida el archivo con `ffprobe` **antes** de encolarlo. Si ffprobe no reconoce un stream de audio, rechaza con `400` y un mensaje claro. Esto también te protege de archivos maliciosos disfrazados de audio.
- Nombres de archivo en disco siempre generados por el servidor (uuid + extensión validada). **Nunca** uses el nombre que envía el cliente para construir una ruta.

## 6. Historial sin autenticación

Cookie `session_id` (uuid, `httpOnly`, `sameSite=lax`, 90 días) generada en el primer acceso. El historial y el borrado se filtran siempre por ese `session_id`. Deja escrito en el README que esto no es un mecanismo de seguridad: quien conozca un `id` de transcripción puede consultarlo. Si en el futuro se necesita privacidad real, ahí es donde entra la autenticación.

**Retención**: un barrido diario dentro del worker borra transcripciones con más de 30 días y sus ficheros. El audio original se borra siempre en cuanto termina la transcripción, con éxito o sin él.

## 7. Uso de shadcn/ui — acotado

Instala shadcn e importa **solo** estos primitivos, por la accesibilidad de Radix que traen de serie: `Dialog`, `Sonner` (toasts), `Progress`, `Switch`, `Tooltip`, `ScrollArea`, `Tabs` (para el selector CRUDO/EDITADO/RESUMEN).

**No uses shadcn para nada más.** Ni `Card`, ni `Button` por defecto, ni el sistema de layout ni la tipografía: ahí sus valores por defecto empujan hacia un aspecto genérico que choca de frente con la estética descrita abajo. Reescribe las variables CSS del tema de shadcn para que sus primitivos hereden los colores de §8, en vez de dejar el tema por defecto.

## 8. Diseño visual

Estética **terminal / brutalista técnico**, oscura y de alto contraste.

- **Fondo** negro casi puro `#0A0A0A`; superficies elevadas `#121212`.
- **Bordes** de 1 px en `rgba(255,255,255,0.08)`. Sin sombras difusas. Radio máximo 4 px, o cero.
- **Tipografía**:
  - Titulares: sans-serif grotesca, peso 700–800, tracking `-0.03em`, `clamp(40px, 6vw, 72px)`, interlineado ~1.05.
  - Micro-etiquetas: monoespaciada, MAYÚSCULAS, 11 px, `letter-spacing: 0.2em`, gris `#6B6B6B`. Ejemplos: `ENTRADA`, `FRAGMENTOS`, `TRANSCRIPCIÓN`, `HISTORIAL`, `ESTADO`.
  - Cuerpo: `#A3A3A3` secundario, `#EDEDED` principal.
- **Acento**: un único gradiente naranja→rojo (`#FF6B35` → `#D62828`), usado solo en la barra de progreso y el borde del panel activo. En ningún sitio más.
- **Paneles**: caja con borde de 1 px y barra superior tipo ventana de terminal — tres puntos grises de 12 px sin color a la izquierda, micro-etiqueta monoespaciada a la derecha.
- **Progreso por fragmentos**: una fila de rectángulos, uno por fragmento, que se rellenan conforme se completan, alimentada por SSE. Es el elemento visual central de la app; dale peso.
- **Retícula** de líneas verticales sutilísimas (`rgba(255,255,255,0.03)`) al fondo de la zona superior.
- **Carga**: barras rectangulares grises que pulsan. Nunca spinners circulares.
- Sin emojis en la interfaz. Sin ilustraciones. Sin degradados morados.
- **Responsive**: una columna en móvil; dos (entrada+historial | resultado) desde 1024 px.
- **Accesibilidad**: contraste AA mínimo, foco visible, `aria-live="polite"` en la zona de estado, todo operable con teclado.

Layout:
1. Barra superior fija: logotipo en texto a la izquierda, `USOS RESTANTES: n` a la derecha.
2. Hero corto: titular grande + una línea de descripción.
3. Panel de entrada: zona de drag & drop + **pegado con Ctrl+V** (evento `paste` en `window`, leyendo `e.clipboardData.files`) + selector de archivo + reproductor nativo + metadatos.
4. Panel de progreso: fila de fragmentos, estado, tiempo transcurrido.
5. Panel de resultado: `Tabs` CRUDO/EDITADO/RESUMEN + texto + **Copiar** (con feedback "Copiado ✓" 2 s) + **Descargar .txt**.
6. Barra lateral o sección de historial de la sesión.
7. Pie mínimo: nota de retención de datos + widget de Turnstile.

## 9. Despliegue en Railway

- **`Dockerfile`** (preferible a nixpacks aquí, porque necesitas ffmpeg): base `node:22-slim`, `apt-get install -y ffmpeg`, build de Next.js en modo `standalone`, imagen final mínima.
- **Volumen** de Railway montado en `/data`, con subdirectorios `uploads/` y `chunks/`. Configurable vía `DATA_DIR`.
- **Servicios**: `web` (esta app, con el volumen) y `postgres` (plugin de Railway). `DATABASE_URL` se inyecta por variable de referencia.
- Migraciones de Drizzle aplicadas en el arranque, antes de levantar el servidor.
- **Healthcheck** de Railway apuntando a `/api/health`.
- Apagado limpio: al recibir `SIGTERM`, el worker termina el fragmento en curso, marca el trabajo como `queued` de nuevo y sale. Nada debe quedarse colgado en `processing` tras un redespliegue. Añade también un barrido al arrancar que devuelva a `queued` los trabajos que lleven más de 30 minutos en `processing`.

### Presupuesto: plan Hobby de $5/mes

Railway factura memoria y CPU **durante todo el tiempo que el contenedor está vivo**, no por petición. El objetivo es que los dos servicios en reposo quepan dentro del crédito incluido, así que el consumo de memoria es un requisito, no un detalle:

- **Next.js en modo `standalone`** (`output: 'standalone'` en `next.config`), imagen base `node:22-slim`, y solo las dependencias de producción en la imagen final. Nada de `node_modules` completo en la capa final.
- `NODE_OPTIONS=--max-old-space-size=384` en el contenedor, para que el heap de Node no crezca por inercia.
- **El bucle del worker sondea la cola cada 5 segundos**, no en un bucle apretado. Cuando hay trabajo en curso itera sin esperar; cuando la cola está vacía, duerme. Un `while(true)` sin pausa dispara la factura de CPU sin hacer nada útil.
- El barrido de retención se ejecuta **una vez al día**, comparando contra una marca de tiempo persistida; no lo cuelgues de un `setInterval` que se reinicie con cada deploy.
- Registra en la columna `cost_usd` el coste estimado de cada transcripción (segundos de audio × tarifa de STT + tokens × tarifa de Claude) y muéstralo en el historial. Es la única forma de que el gasto no sea una sorpresa a fin de mes.

**No actives el modo serverless / scale-to-zero de Railway en esta versión**, y deja anotado el motivo en el README: si el contenedor duerme, el bucle del worker se detiene y un trabajo encolado puede quedarse esperando a la siguiente visita. La lógica de rescate al arrancar lo recupera, pero con retraso. Es una optimización válida más adelante, una vez medido el consumo real, y exige mover el procesado a un disparo explícito en lugar de un bucle continuo.

## 10. Variables de entorno

`.env.example` documentado con exactamente estas claves:

```
DATABASE_URL=                      # la inyecta Railway
DATA_DIR=/data

STT_PROVIDER=groq                  # groq | openai
GROQ_API_KEY=
OPENAI_API_KEY=

ANTHROPIC_API_KEY=
CLEANUP_MODEL=claude-haiku-4-5
SUMMARY_MODEL=claude-sonnet-5
ENABLE_CLEANUP=true

CHUNK_SECONDS=600                  # 600 con groq, 300 con openai
MAX_UPLOAD_MB=500

NEXT_PUBLIC_TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
```

Ninguna clave secreta puede acabar en el bundle del cliente: solo `NEXT_PUBLIC_TURNSTILE_SITE_KEY` es pública.

## 11. Entregables

- Proyecto completo y funcional. `docker compose up` debe levantar app + Postgres en local sin tocar nada más; incluye el `docker-compose.yml`.
- `README.md` con: arquitectura, cómo obtener cada API key (incluidas site key y secret key de Turnstile), pasos exactos de despliegue en Railway, explicación del troceado, tabla de costes por hora de audio, y la nota sobre el historial sin autenticación.
- `.env.example` y `Dockerfile`.
- Sin errores ni advertencias de TypeScript ni de ESLint.
- Tests unitarios de las dos piezas con lógica no trivial: el cálculo de puntos de corte a partir de la salida de `silencedetect`, y la eliminación de duplicados en los solapes.

## 12. Restricciones

- No añadas login, roles ni panel de administración.
- No metas Redis, BullMQ ni ningún otro broker: la cola es Postgres.
- No uses ffmpeg.wasm ni proceses audio en el navegador. El servidor tiene ffmpeg nativo y no tiene timeout; aprovéchalo.
- No truncues silenciosamente nada. Si algo falla o no cabe, tiene que verse en la interfaz y quedar registrado en la columna `error`.
- No cargues archivos completos en memoria en ningún punto: streaming a disco en la subida, y fragmento a fragmento en el worker.

## 13. Antes de escribir código

Dime en 5 líneas el plan: servicios, archivos y el orden en que los vas a crear. Empieza por el esquema de Drizzle y el bucle del worker, que son las piezas de las que depende todo lo demás. Luego impleméntalo entero.

Si algo de este documento es ambiguo o choca con un límite real de Railway, de Next.js o de los proveedores de STT, señálalo y sigue adelante con la decisión que consideres correcta, dejándola anotada en el README.
