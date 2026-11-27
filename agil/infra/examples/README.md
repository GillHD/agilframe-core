# Reverse-proxy examples

Editable snippets for terminating TLS and forwarding to AGIL Core. **None of
these are dependencies.** Core works behind any HTTP proxy, load balancer or
ingress that supports WebSocket upgrades; these files exist so a deployment
does not start from a blank page.

| Proxy | File | Notes |
|---|---|---|
| nginx | [`nginx/agil.conf`](nginx/agil.conf) | `map` for `Connection`, `/ws` block, 1 h timeouts, ACME webroot, body limit |
| HAProxy | [`haproxy/haproxy.cfg`](haproxy/haproxy.cfg) | TLS termination, `timeout tunnel 1h`, health check, optional SFU backend |
| Caddy | [`caddy/Caddyfile`](caddy/Caddyfile) | automatic ACME, WebSocket built-in, `read_timeout/write_timeout 1h` |
| Traefik | [`traefik/dynamic.yml`](traefik/dynamic.yml) | file provider, TLS certResolver, forwarding timeouts, optional docs allowlist |

Placeholders to replace: `calls.example.com`, `admin@example.com`, certificate
paths and backend ports (`127.0.0.1:8787` unless you changed
`AGIL_HTTP_PORT`).

## Requirements every proxy must satisfy

1. **WebSocket upgrade on `/ws`**
   - HTTP/1.1 to the backend;
   - forward `Upgrade` and `Connection: Upgrade`;
   - forward `Sec-WebSocket-Protocol` (the widget may put the join token there);
   - do not buffer the upgrade response.
2. **Idle timeout ≥ 1 hour** (read/send/tunnel). A 60 s default reconnects live
   calls and looks like a network bug.
3. **Request body limit ≥ 30 MiB** to cover `AGIL_MAX_UPLOAD_MB=25` plus
   multipart overhead.
4. **Forwarded headers**: `Host`, `X-Real-IP`, `X-Forwarded-For`,
   `X-Forwarded-Proto`. Keep `AGIL_TRUST_PROXY=1` only when the proxy
   overwrites them (otherwise a client can spoof its IP/geo).
5. **TLS 1.2+**, HSTS after you are sure HTTPS works, and a certificate the
   browser trusts (no self-signed for participants).
6. **Core stays on `127.0.0.1:8787`**; only the proxy listens on 443. Do not
   publish 8787 to the internet.

## Validate before reloading

```bash
# nginx
sudo nginx -t && sudo systemctl reload nginx

# HAProxy
sudo haproxy -c -f /etc/haproxy/haproxy.cfg && sudo systemctl reload haproxy

# Caddy
caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy

# Traefik: restart and check the log
sudo systemctl restart traefik && journalctl -u traefik -n 50 --no-pager
```

End-to-end checks (after the stack is up):

```bash
curl -fsS https://calls.example.com/v1/health
curl -fsS https://calls.example.com/v1/ready
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://calls.example.com/ws
# 101 = upgrade works, 400/401 = upgrade reached core but no valid join token
```

TLS expiry and DNS are covered by `agil/infra/quickstart/doctor.sh`.

## Traefik with Docker labels (alternative)

Instead of a file provider, the same routing can be attached to the core
container:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.agil.rule=Host(`calls.example.com`)
  - traefik.http.routers.agil.entrypoints=websecure
  - traefik.http.routers.agil.tls.certresolver=letsencrypt
  - traefik.http.services.agil.loadbalancer.server.port=8787
```

The file in this directory is the portable variant; use whichever your
platform already standardises on. If you terminate TLS on an external load
balancer (AWS ALB/NLB), keep the same timeouts/headers there and disable the
local proxy — core still only needs HTTP on 8787.

## When something breaks

| Symptom | Likely proxy cause |
|---|---|
| Calls drop every ~60 s | read/tunnel timeout too low |
| `400` on `/ws` | missing `Upgrade`/`Connection`, or HTTP/1.0 to the backend |
| Login works, room join fails | `Sec-WebSocket-Protocol` stripped |
| Everyone appears from one IP | `X-Forwarded-For` not forwarded/rewritten |
| Upload returns 413 | body size limit below 30 MiB |
| Mixed-content errors | page over https but `AGIL_PUBLIC_ORIGIN` still `http://` |
| Certificate warnings | self-signed/expired cert or hostname not in SAN |

See [`../README.md`](../README.md) for topology, ports and the full security
model.
