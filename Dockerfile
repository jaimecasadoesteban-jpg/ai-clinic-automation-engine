# syntax=docker/dockerfile:1

# ------------------------------------------------------------------------------
# 1. Dependencias completas y compilación
# ------------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Primero los manifiestos: si no cambian, la capa de `npm ci` se reutiliza y la
# construcción no vuelve a descargar nada.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ------------------------------------------------------------------------------
# 2. Sólo las dependencias de producción
# ------------------------------------------------------------------------------
# En una etapa aparte para que la imagen final no herede nunca `drizzle-kit`,
# `vitest` ni `tsx`, ni el árbol completo de node_modules que dejó `npm ci`.
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ------------------------------------------------------------------------------
# 3. Imagen final
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# `dumb-init` para que el PID 1 reparta las señales: sin él, un SIGTERM de
# la plataforma de despliegue no llega al proceso y el apagado ordenado —cerrar el pool, terminar
# la petición en curso— no ocurre.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Los YAML de las clínicas se leen EN EJECUCIÓN desde `config/clientes`, no se
# compilan. Sin esta copia el proceso arranca y no encuentra ninguna clínica.
COPY --chown=node:node config ./config

# El SQL de las migraciones no lo genera `tsc`. Va aquí para que la misma imagen
# pueda migrarse a sí misma con `node dist/db/migrar.js`, sin drizzle-kit.
COPY --chown=node:node src/db/migrations ./src/db/migrations

# Sin privilegios. La imagen de Node ya trae el usuario `node`.
USER node

EXPOSE 3000

# Vida, no preparación: `/salud` no toca la base a propósito.
#
# Un contenedor que se reinicia porque Postgres está caído no arregla nada —
# vuelve, tampoco la encuentra, y se reinicia otra vez, añadiendo una tormenta
# de arranques a un problema que no es suyo. Para saber si PUEDE trabajar está
# `/listo`, que sí la toca y devuelve 503; ése es el que debe mirar el
# balanceador y el monitor externo, no el que decide matar el proceso.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]

# Producción, no `dev`: nada de `tsx watch` ni de recarga en caliente.
# `--env-file-if-exists` no se usa aquí a propósito: en el servidor las variables
# las pone la plataforma de despliegue, y leer un `.env` que se hubiera colado en la imagen sería
# la peor forma de descubrir que se coló.
CMD ["node", "dist/index.js"]
