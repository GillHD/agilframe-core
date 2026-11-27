<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./agil/websdk/demo/public/branding/agil-logo-on-dark.png">
    <img alt="AgilFrame" width="360" src="./agil/websdk/demo/public/branding/agil-logo-on-light.png">
  </picture>
</p>

# AgilFrame Core

[Русский](README.md) · **English**

**The server for embedded WebRTC video calls, live streams, and voice rooms.** Core manages rooms, access, and organization settings. This repository also contains the administration dashboard, visual call editor, and shared platform packages.

[Quick start](#quick-start) · [Documentation](docs/README.en.md) · [Web SDK guide (Russian)](agil/core/docs/sdk.md) · [GitHub project](https://github.com/users/GillHD/projects/1) · [Contributing](CONTRIBUTING.en.md)

## What you can build

- **Embed calls.** Add the browser widget to an intranet, learning platform, or customer-facing application. Use the Web SDK and API to build a custom call interface. [Integration (Russian)](docs/integration/README.md)
- **Manage access and branding.** Your application server requests short-lived participant tokens from Core. Core checks permissions and tenant membership. Administrators manage themes, available features, and integrations for each tenant. [Configure roles (Russian)](agil/core/docs/roles.md)
- **Host AgilFrame on your own infrastructure.** One Core instance works for local development and basic calls. Add TURN, LiveKit SFU, server-side recording, and SIP as needed. [Deployment guide (Russian)](agil/core/docs/deployment.md)
- **Broadcast live events.** Participants communicate over WebRTC. Viewers can watch over HLS once streaming is configured. [Media routing (Russian)](agil/core/docs/routing.md) · [HLS player (Russian)](agil/core/docs/hls-viewer.md)

## Quick start

Install Node.js 22.12 or later and npm. Build the project and bind Core to the loopback interface.

```sh
git clone https://github.com/GillHD/agilframe-core.git
cd agilframe-core
npm ci
npm run build
HOST=127.0.0.1 npm start
```

In PowerShell, replace the last line with these commands.

```powershell
$env:HOST = '127.0.0.1'
npm start
```

Core is available at `http://127.0.0.1:8787`.

| Interface | Path |
| --- | --- |
| Administration dashboard | `/dashboard/` |
| Visual call editor | `/editor/` |
| Wiki and API reference | `/wiki/` and `/docs` |
| Custom call interface example | `/custom-ui.html` |
| Health check | `/v1/health` |

Open the dashboard and sign in with the local development key `dev-key`. Create a room, issue a separate token for each of two participants, and open their invitation links in separate tabs. For a network deployment, configure your own secrets, TLS, and allowed origins. [Quick start guide (Russian)](docs/getting-started/README.md) · [REST integration walkthrough (Russian)](agil/core/docs/api-guide.md) · [Docker quick start (Russian)](agil/core/docs/deployment-quickstart.md)

## Project structure

An application calls Core to create a room and issue tokens. Clients use Core to join the room, exchange signaling messages, and receive events. Audio, video, and screen sharing travel over WebRTC, either directly or through an SFU. Media nodes and workers can handle inputs, recording, and streaming. [Architecture (Russian)](agil/core/docs/architecture.md)

### Applications and shared packages

Each application and package has its own `package.json`. The root build uses npm workspaces.

| Workspace | Purpose |
| --- | --- |
| [Core server](agil/core/apps/server/) | REST control API, WebSocket signaling, room management, and access checks |
| [Administration dashboard](agil/core/apps/dashboard/) | Organizations, rooms, participant links, monitoring, security, and audit |
| [Visual call editor](agil/core/apps/editor/) | Theme and feature configuration with a live preview and JSON export |
| [`@agil/protocol`](agil/core/packages/protocol/) | Shared contracts for tenant configuration, themes, signaling, and quality policy |
| [`@agil/security`](agil/core/packages/security/) | Security services, audit logging, and storage for files and recordings |
| [`@agil/ai`](agil/core/packages/ai/) | Signed HTTPS integration for transcript compliance analysis |
| [`@agil/mcp`](agil/core/packages/mcp/) | Model Context Protocol tools for inspecting and validating call integrations |

### Integration and infrastructure

| Directory | Purpose |
| --- | --- |
| [`agil/websdk/`](agil/websdk/) | Browser widget, iframe, Web Component, Web SDK, and local examples |
| [`agil/mobile/`](agil/mobile/) | SDKs and modules for Android, iOS, Flutter, Capacitor, and React Native |
| [`agil/core/nodes/`](agil/core/nodes/) | Media node image and speech-to-text worker |
| [`agil/infra/`](agil/infra/) | Node Agent, Helm, Terraform, and configuration examples |
| [`agil/edge/`](agil/edge/README.en.md) | End-to-end test for Edge publishing through LiveKit |
| [`docs/`](docs/README.en.md) | Setup, integration, operations, and release guides |

### Media nodes and workers

Node Agent registers a host with Core, reports readiness, and receives commands. Clients use the route Core assigns.

| Module | Location |
| --- | --- |
| Media node image and Compose | [`agil/core/nodes/all-in-one/`](agil/core/nodes/all-in-one/) |
| Speech-to-text worker | [`agil/core/nodes/stt/`](agil/core/nodes/stt/) |
| Node Agent and metrics | [`agil/infra/node-agent/`](agil/infra/node-agent/) |
| Helm charts for Core and nodes | [`agil/infra/helm/`](agil/infra/helm/) |

[Install a node (Russian)](agil/core/docs/node-image.md) · [Multiple SFU nodes (Russian)](agil/core/docs/sfu-multinode.md)

### Repositories

| Repository | Purpose |
| --- | --- |
| [agilframe](https://github.com/GillHD/agilframe/blob/main/README.en.md) | Project overview, submodules, and pinned component revisions |
| [agilframe-core](https://github.com/GillHD/agilframe-core) | Core, administration tools, documentation, and the integration workspace |
| [agilframe-websdk](https://github.com/GillHD/agilframe-websdk/blob/main/README.en.md) | Browser widget, Web SDK, Web Component, and demo |
| [agilframe-mobile](https://github.com/GillHD/agilframe-mobile/blob/main/README.en.md) | Android, iOS, Flutter, Capacitor, and React Native integrations |
| [agilframe-nodes](https://github.com/GillHD/agilframe-nodes/blob/main/README.en.md) | Media nodes, TURN, SFU, and workers |
| [agilframe-edge](https://github.com/GillHD/agilframe-edge/blob/main/README.en.md) | Media publishing agent for embedded Linux |
| [agilframe-deploy](https://github.com/GillHD/agilframe-deploy/blob/main/README.en.md) | Docker Compose setup and operations instructions |
| [agilframe-examples](https://github.com/GillHD/agilframe-examples/blob/main/README.en.md) | Standalone example of embedding a call |

This repository contains integration snapshots of the Web SDK, mobile components, and media node code. The end-to-end test runs Edge from its own repository. The umbrella repository pins the component versions. [Release manifest](https://github.com/GillHD/agilframe/blob/main/versions.json) · [Release workflow (Russian)](docs/release/repositories.md)

## Next steps

- **Development and review.** Run the checks in the contribution guide before submitting changes. [Contributing](CONTRIBUTING.en.md)
- **Bugs and feature requests.** Use the GitHub issue forms. Report vulnerabilities through the private channel. [Open an issue](https://github.com/GillHD/agilframe-core/issues/new/choose) · [Security](SECURITY.en.md)

## License

AgilFrame source code is available under PolyForm Noncommercial 1.0.0. Commercial use requires a separate agreement. Third-party models, dependencies, and media are subject to their own terms. [License](LICENSE) · [Commercial licensing (Russian)](agil/core/docs/commercial-license.md) · [Notices](NOTICE)
