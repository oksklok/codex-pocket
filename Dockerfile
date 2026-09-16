FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY gateway.ts ./
# gateway.ts imports deepseek.ts; the catalog and supervisor stay inert because DeepSeek
# is macOS-only and disabled on Linux. No provider credentials are added to the image.
COPY deepseek.ts deepseek-server.mjs deepseek-models.json ./
COPY public ./public
USER node
EXPOSE 4173
CMD ["node", "--experimental-strip-types", "gateway.ts"]
