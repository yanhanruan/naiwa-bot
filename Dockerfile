FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin
RUN chmod +x bin/*.mjs
ENV FISH_HOME=/data \
    FISH_TICK_MS=60000
VOLUME /data
CMD ["node", "bin/fish-daemon.mjs"]
