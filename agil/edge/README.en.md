# Edge integration test

[Русский](README.md) · **English**

This Core end-to-end test verifies that Edge can publish audio and video to a browser through LiveKit Ingress. The test starts temporary Redis, LiveKit, and Ingress containers and launches a browser. For Edge source code and setup on embedded Linux, see the separate repository. [AgilFrame Edge](https://github.com/GillHD/agilframe-edge/blob/main/README.en.md)

Use a Linux test host with Docker, Chrome or Chromium, FFmpeg, and FFprobe. Run these commands from the root of the umbrella repository after checking out its submodules.

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

The test uses local ports 39541–39547 and removes the temporary containers it starts.
