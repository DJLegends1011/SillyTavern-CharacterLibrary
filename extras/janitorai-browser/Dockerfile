# A JanitorAI-capable browser in a container, publishing its DevTools port for Character Library
# on another machine to drive (Settings > Online > JanitorAI, browser mode "endpoint").
#
# Debian's chromium is linked against system ffmpeg, so it carries H.264 and AAC. Playwright's
# Linux arm64 Chromium is built ffmpeg_branding="Chromium" and has neither, which fails the codecs
# check. run-browser.mjs needs node 22 for its built-in WebSocket.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates tzdata \
        libgl1-mesa-dri libglx-mesa0 libegl1 libgles2 mesa-vulkan-drivers \
        libnss3 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
        libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY run-browser.mjs /app/run-browser.mjs

# Runs non-root; override the ids at build time if yours differ. HOME has to be writable for
# whichever uid you land on: without a passwd entry HOME is "/", and chromium's crashpad dies
# trying to mkdir there, surfacing only as "browser exited 1".
ARG UID=1000
ARG GID=1000
RUN mkdir -p /home/cl && chown ${UID}:${GID} /home/cl
ENV HOME=/home/cl

# The profile carries the JanitorAI login, so keep it on a volume; without that every redeploy
# signs the browser out, which fails in a way that reads like a Cloudflare problem.
ENV PROFILE=/profile \
    PORT=9222 \
    BIND=0.0.0.0 \
    BROWSER=/usr/bin/chromium

USER ${UID}:${GID}
EXPOSE 9222
CMD ["node", "/app/run-browser.mjs"]
