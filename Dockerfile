# qsyy container: QR login + online play + imported libraries.
# No 汽水 desktop client inside — LunaCacheV2 / mssdk / cronet are unavailable.
# Persist /data across restarts for web-session and incremental stores.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 make g++

WORKDIR /app

COPY package.json ./
COPY desktop/package.json desktop/package.json
COPY app ./app

RUN npm install --prefix app/bridge --omit=dev \
  && apt-get purge -y python3 make g++ \
  && apt-get autoremove -y --purge \
  && rm -rf /var/lib/apt/lists/* /root/.npm

ENV HOME=/data \
    XDG_CACHE_HOME=/data/.cache \
    XDG_CONFIG_HOME=/data/.config \
    QSYY_HOST=0.0.0.0 \
    QSYY_PORT=18790 \
    QSYY_DOWNLOAD_DIR=/data/Downloads

RUN mkdir -p /data/.cache /data/.config /data/Downloads

EXPOSE 18790
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:18790/api/version',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node","--max-semi-space-size=8","--max-old-space-size=256","--optimize-for-size","app/standalone/server.mjs"]
