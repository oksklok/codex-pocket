FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY gateway.ts dsh.ts ./
# Remote DSH runs on the SSH execution machine; the image needs only the adapter.
# No DSH runtime dependency or provider credential is installed on the gateway.
COPY deepseek.ts deepseek-server.mjs deepseek-models.json ./
COPY public ./public
USER node
EXPOSE 4173
CMD ["node", "--experimental-strip-types", "gateway.ts"]
