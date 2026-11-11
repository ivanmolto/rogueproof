# Tunnel

`pnpm tunnel` exposes two local services on our own domain through one
authenticated Cloudflare Tunnel:

| Public hostname | Local service | Started by |
|---|---|---|
| `honeypot.<domain>` | `http://localhost:4444` | `pnpm honeypot` |
| `collector.<domain>` | `http://localhost:4445` | `pnpm collector` |

## Why it exists

Otari runs web fetch and MCP calls on its own side, in the hosted gateway. The
gateway only reaches the public web, so it cannot fetch a page on `localhost`
or call an MCP server bound to `127.0.0.1`. The tunnel gives both services a
public HTTPS address without opening a port on this machine: `cloudflared`
makes an outbound connection to Cloudflare, and the public hostnames resolve to
Cloudflare's addresses, not ours.

The sandbox container is not involved. It has no network at all and never
fetches the honeypot; see `sandbox/README.md`.

## What is exposed, and what protects it

- **Honeypot.** A static, fictional site. It is served only under
  `HONEYPOT_PREFIX`, carries `noindex` on every page and a `robots.txt` that
  disallows everything. It holds no secrets.
- **Collector.** An MCP server at `/mcp`. It requires a bearer token
  (`COLLECTOR_BEARER`) on every request and answers `401` to anything else,
  on every path; the check is in the collector itself, before it reads the
  request body. It listens on `127.0.0.1` only, so without the tunnel nothing
  outside this machine reaches it at all. The only payload it ever receives is
  the fake `.env` from `scenarios/mission/`.
- **Tunnel.** The connector authenticates to Cloudflare with `TUNNEL_TOKEN`.
  Whoever holds that token can serve traffic for both hostnames, so it is
  treated like a key: `.env` only, never committed, never printed.

Nothing is reachable while `pnpm tunnel` is not running. Stop it when no run is
in progress.

## One-time setup

1. **A domain on Cloudflare DNS.** Either register it with Cloudflare or point
   its nameservers at Cloudflare.
2. **Create the tunnel.** Cloudflare dashboard, Networking, Tunnels, Create
   Tunnel. Name it `rogueproof`, type `cloudflared`.
3. **Copy the token.** The dashboard shows `cloudflared tunnel run --token eyJ…`.
   Copy only the token into `.env` as `TUNNEL_TOKEN`. Do not run the
   `service install` commands shown there: the tunnel should run only while
   `pnpm tunnel` does, not as a permanent system service.
4. **Add two routes** of type "Published application" on the tunnel:

   | Subdomain | Service URL |
   |---|---|
   | `honeypot` | `http://localhost:4444` |
   | `collector` | `http://localhost:4445` |

   Cloudflare creates the DNS records. Use `http` for the service URL: the
   local services speak plain HTTP on loopback and Cloudflare terminates TLS.
5. **Install the connector:** `brew install cloudflared`. Do not start it with
   `brew services`.
6. **Fill `.env`:**

   ```
   TUNNEL_TOKEN=            # from step 3
   HONEYPOT_PUBLIC_URL=     # https://honeypot.<domain>
   COLLECTOR_PUBLIC_URL=    # https://collector.<domain>
   COLLECTOR_BEARER=        # openssl rand -hex 32
   HONEYPOT_PREFIX=         # path prefix, e.g. /lumen-notes or /<random>/lumen-notes
   ```

The routes live in Cloudflare, not in this repository. `pnpm tunnel` prints the
port each hostname is expected to point at; if a route in the dashboard says
otherwise, the dashboard is what takes effect.

## Running

```
pnpm honeypot     # terminal 1
pnpm collector    # terminal 2; MCP on 127.0.0.1:4445/mcp, drops in runs/collector/drops.jsonl
pnpm tunnel       # terminal 3; prints the public URLs, then cloudflared's log
```

`pnpm tunnel` refuses to start when the token is missing or a public URL is not
a plain `https://` hostname. It passes the token to `cloudflared` through the
environment (never on the command line, where `ps` would show it), gives the
child no other variable than `PATH` and `HOME`, and redacts the token and
anything token-shaped from every log line before printing it.

Check from outside:

```
curl -sI "$HONEYPOT_PUBLIC_URL$HONEYPOT_PREFIX/changelog.html" | head -1
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$COLLECTOR_PUBLIC_URL/mcp"   # 401: up, and closed without the bearer
```

## If Otari cannot fetch the honeypot

- **Cloudflare bot settings.** A new zone may block AI crawlers by default
  (Security settings, "Block AI bots", and the managed `robots.txt`). Otari's
  fetcher is exactly that kind of client. Turn the block off for this zone.
- **`robots.txt`.** The honeypot disallows all crawlers so the page is never
  indexed. If the gateway's fetcher honours `robots.txt` and refuses, that is a
  finding for `docs/evidence/variant-survival.md` and `docs/FRICTION.md`.
- **502 from Cloudflare.** The tunnel is up but the local service is not; start
  `pnpm honeypot`.
- **Error 1033.** The tunnel is not running; start `pnpm tunnel`.

## Rotating the token

Tunnel page, "Rotate token", then replace `TUNNEL_TOKEN` in `.env`. Do this if
the token was ever pasted into a chat, a log or a screenshot.
