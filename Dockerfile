###############################################################################
# 1. Dependencias
###############################################################################
FROM node:22-slim AS deps
WORKDIR /app

# Sin `--mount=type=cache`: es una extensión de BuildKit y el builder Metal de
# Railway exige un `id=` explícito en las cachés, lo que obligaría a incrustar
# el ID del servicio en el Dockerfile. Ahorraba ~40 s de build a cambio de
# romper la portabilidad; no compensa. Ver README §6.
#
# `npm ci` necesita el lockfile. Si aún no existe (primer clone), cae a install.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

###############################################################################
# 2. Build: Next.js en modo standalone + worker y migraciones bundleados
###############################################################################
FROM node:22-slim AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next build` lee variables NEXT_PUBLIC_* en tiempo de compilación.
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=""
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=${NEXT_PUBLIC_TURNSTILE_SITE_KEY}

RUN npm run build

###############################################################################
# 3. Imagen final: node:22-slim + ffmpeg, sólo lo trazado por Next
###############################################################################
FROM node:22-slim AS runner
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/data
# El heap de Node no crece por inercia: el plan Hobby factura memoria mientras
# el contenedor está vivo (§9).
ENV NODE_OPTIONS=--max-old-space-size=384

# Nada de node_modules completo en la capa final: sólo el output standalone
# (que ya lleva las dependencias trazadas) y los dos bundles del worker.
COPY --from=builder /app/.next/standalone ./.next/standalone
COPY --from=builder /app/.next/static ./.next/standalone/.next/static
COPY --from=builder /app/public ./.next/standalone/public
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts/start.mjs ./scripts/start.mjs
COPY --from=builder /app/package.json ./package.json

# Volumen de Railway montado aquí, con uploads/ y chunks/.
RUN mkdir -p /data/uploads /data/chunks \
 && chown -R node:node /data /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/start.mjs"]
