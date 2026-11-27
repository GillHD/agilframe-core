# AGIL Core

Deployable core of the AgilFrame platform: the signaling/REST server, the two
operator panels, the shared contracts and the Node-side services.

```
core/
├─ apps/
│  ├─ server        @agil/calls-server    REST + WS + static + admin API (node:http, ws)
│  ├─ dashboard     @agil/dashboard       developer panel (/dashboard/)
│  └─ editor        @agil/editor          visual config editor (/editor/)
├─ packages/
│  ├─ protocol      @agil/protocol        shared contracts, zod schemas, theme tokens, JWT
│  ├─ security      @agil/security        passwords, geo, audit, files/recordings, STT
│  ├─ ai            @agil/ai              compliance rules, notes/excerpts, AI agent client
│  └─ mcp           @agil/mcp             MCP server (stdio/HTTP) for LLM tooling
├─ deploy/          egress, livekit and observability deployment examples
├─ docs/            product and engineering documentation
├─ qa/              QA runners, fixtures and captured evidence
├─ scripts/         dev/e2e/qa/perf/ops entry points
├─ seed/            generated seed data (gitignored artifacts)
├─ branding/         logos, icons, OG assets
├─ examples/         integration examples (Electron)
└─ skills/           reusable agent skills (ui-ux)
```

## Dependency direction

```
agil/core/packages/protocol  ->  core apps, websdk, mobile (via @agil/protocol)
agil/core/packages/security  ->  core/apps/server, core/packages/ai
agil/core/packages/ai        ->  core/apps/server, core/packages/mcp
```

`protocol` is browser-safe and must not import Node-only modules; `security` and
`ai` are Node-only.

## Commands (from the repository root)

```bash
npm run build:protocol      # build contracts first — everything else consumes dist/
npm run build:server
npm run build:dashboard
npm run build:editor
npm run dev                 # server + demo + editor + dashboard on 5173-5175/8787
npm test                    # contract/security/ai/server/widget/mcp/RN/embed/capacitor
npm run e2e                 # built server + headless Chrome round-trip
npm run audit               # security audit against the built server
```

Runtime state lives in the repository-root `.data/` directory (never moved into
this tree). `AGIL_DATA_DIR` defaults to `<repo>/.data`.

Static build defaults (overridable with env vars, see
`apps/server/src/env.ts`):

| Variable | Default |
| --- | --- |
| `AGIL_STATIC_DIR` | `agil/websdk/demo/dist` |
| `AGIL_EDITOR_DIR` | `agil/core/apps/editor/dist` |
| `AGIL_DASHBOARD_DIR` | `agil/core/apps/dashboard/dist` |
| `AGIL_SDK_DIR` | `agil/websdk/sdk/dist` |
| `AGIL_WIDGET_DIR` | `agil/websdk/widget/dist` |
| `AGIL_DOCS_DIR` | `agil/core/docs` |
