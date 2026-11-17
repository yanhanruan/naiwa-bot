FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
COPY migrations ./migrations
RUN chmod +x bin/*.mjs
ENV FISH_TICK_MS=60000
CMD ["node", "bin/fish-daemon.mjs"]
