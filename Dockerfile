FROM oven/bun:1.2.21 AS deps

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.2.21 AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV SINGBOX_BIN=src/sing-box/sing-box-linux

RUN set -eux; \
    if command -v apt-get >/dev/null 2>&1; then \
      apt-get update; \
      apt-get install -y --no-install-recommends ca-certificates; \
      update-ca-certificates; \
      rm -rf /var/lib/apt/lists/*; \
    elif command -v apk >/dev/null 2>&1; then \
      apk add --no-cache ca-certificates; \
      update-ca-certificates; \
    else \
      echo "No supported package manager found to install CA certificates" >&2; \
      exit 1; \
    fi

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src

RUN chmod +x /app/src/sing-box/sing-box-linux

EXPOSE 3000 8080 9090
CMD ["bun", "run", "src/index.ts"]