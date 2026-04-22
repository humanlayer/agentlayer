# Yjs FS Transport Lab

Small React/Vite lab for comparing the `single-stream` and `per-document` durable transport topologies in `@humanlayer/yjs-fs`.

## Run the app

```bash
bun --bun --cwd packages/yjs-fs-transport-lab run dev
```

Open the plain Vite dev server at `http://127.0.0.1:4173`.

## Run behind local HTTPS with Caddy

```bash
caddy run --config packages/yjs-fs-transport-lab/Caddyfile
```

Then use:

- `https://localhost:3443` for the HTTPS/HTTP2-friendly path
- `http://localhost:3080` for a plain HTTP comparison path

The lab still uses in-memory transports today, but it exposes the channel topology and per-replica channel counts you would care about once the transport is backed by real browser connections.
