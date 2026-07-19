# syntax=docker/dockerfile:1.7
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts && \
    npm rebuild argon2 && \
    npm cache clean --force

FROM dependencies AS build
COPY architrave.config.json ./
COPY contracts ./contracts
COPY migrations ./migrations
COPY plugins/lib ./plugins/lib
COPY plugins/public-inventory.json ./plugins/public-inventory.json
COPY plugins/google-books ./plugins/google-books
COPY plugins/google-gmail ./plugins/google-gmail
COPY plugins/internet-archive ./plugins/internet-archive
COPY plugins/login-with-amazon ./plugins/login-with-amazon
COPY plugins/project-gutenberg ./plugins/project-gutenberg
COPY plugins/standard-ebooks ./plugins/standard-ebooks
COPY scripts ./scripts
COPY src ./src
COPY tokens ./tokens
COPY tsconfig.json ./
RUN npm run tokens && npm run build:server && npm prune --omit=dev

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS runtime
ARG OCI_SOURCE=https://example.invalid/k-core
ARG OCI_REVISION=uncommitted
ARG OCI_VERSION=0.0.0
ARG OCI_LICENSES=Apache-2.0
LABEL org.opencontainers.image.source="$OCI_SOURCE" \
      org.opencontainers.image.revision="$OCI_REVISION" \
      org.opencontainers.image.version="$OCI_VERSION" \
      org.opencontainers.image.licenses="$OCI_LICENSES"
ENV NODE_ENV=production \
    HOME=/tmp \
    PUBLIC_PLUGIN_DIR=/app/plugins
WORKDIR /app
RUN groupadd --system --gid 10001 k && \
    useradd --system --uid 10001 --gid k --home-dir /tmp --shell /usr/sbin/nologin k
COPY --from=build --chown=k:k /app/node_modules ./node_modules
COPY --from=build --chown=k:k /app/build/server ./build/server
COPY --from=build --chown=k:k /app/architrave.config.json ./architrave.config.json
COPY --from=build --chown=k:k /app/migrations ./migrations
COPY --from=build --chown=k:k /app/plugins/lib ./plugins/lib
COPY --from=build --chown=k:k /app/plugins/public-inventory.json ./plugins/public-inventory.json
COPY --from=build --chown=k:k /app/plugins/google-books ./plugins/google-books
COPY --from=build --chown=k:k /app/plugins/google-gmail ./plugins/google-gmail
COPY --from=build --chown=k:k /app/plugins/internet-archive ./plugins/internet-archive
COPY --from=build --chown=k:k /app/plugins/login-with-amazon ./plugins/login-with-amazon
COPY --from=build --chown=k:k /app/plugins/project-gutenberg ./plugins/project-gutenberg
COPY --from=build --chown=k:k /app/plugins/standard-ebooks ./plugins/standard-ebooks
COPY --from=build --chown=k:k /app/src/ui/tokens.css ./src/ui/tokens.css
COPY --from=build --chown=k:k /app/src/ui/styles.css ./src/ui/styles.css
USER 10001:10001
EXPOSE 3000
CMD ["node", "build/server/hosts/web/main.js"]
