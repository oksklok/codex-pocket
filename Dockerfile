FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY gateway.ts ./
COPY public ./public
USER node
EXPOSE 4173
CMD ["node", "--experimental-strip-types", "gateway.ts"]
