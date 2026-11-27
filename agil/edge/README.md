# Интеграционная проверка Edge

[Исходный код и запуск на встраиваемых системах](https://github.com/GillHD/agilframe-edge)

В Core находится сквозной сценарий с временными Redis, LiveKit, Ingress и
браузером. Из корня общего репозитория с подмодулями выполните:

```bash
export AGILFRAME_EDGE_ENTRY="$PWD/edge/agent/rtmp-publisher.mjs"
export AGILFRAME_NODE_ENTRY="$PWD/nodes/agil/infra/node-agent/agent.mjs"
cd core
npm ci
npm run build
docker pull redis:7-alpine
docker pull livekit/livekit-server:v1.13.11
docker pull livekit/ingress:v1.6.0
CHROME_PATH="$(command -v google-chrome || command -v chromium)" \
  node --import tsx agil/edge/test/rtmp-livekit-e2e.mjs
```

Нужен Linux-стенд с Docker, Chrome или Chromium, FFmpeg и FFprobe. Сценарий
использует локальные порты 39541–39547 и удаляет свои временные контейнеры.
