# Tldraw MCP Server

The MCP server and canvas daemon that power the tldraw planning board.

## Architecture

| File | Role |
|---|---|
| `index.ts` | Thin MCP server over stdio. Exposes drawing/graph tools, auto-starts the daemon, forwards operations over HTTP. Binds no port. |
| `daemon.ts` | Shared HTTP singleton (port 3002). Serves board pages, relays operations to browsers over SSE, manages per-room graph state and leases. Idle-shuts-down when no agents are connected. |
| `graph.ts` | Graph model: named nodes, edges, status, frames, auto-layout (dagre), compact read-back, idempotent render ops. |
| `canvasPage.ts` | HTML pages: board index at `/` and the tldraw canvas at `/?board=<id>` (loads tldraw + React from CDN). |
| `eventBus.ts` | Type definitions for `TldrawOperation` payloads shared across the codebase. |

### Flow

```
MCP client (Claude/omp) ──stdio──> index.ts ──POST──> daemon.ts ──SSE──> browser (tldraw canvas)
                                                    daemon.ts <──POST── browser (snapshots)
```

`index.ts` never binds a port. It POSTs each tool call to the daemon as a `TldrawOperation` tagged with board+agent ids. The daemon routes by board — multiple agents on different projects draw on separate canvases; agents on the same project share one.

## Running

From the repo root:

```bash
npm run setup      # installs deps, writes .mcp.json
```

The daemon starts automatically when the first MCP client connects — no manual server management. To run it standalone for debugging:

```bash
npm run canvas     # from server/ or repo root
```

Env vars: `TLDRAW_PORT` (default 3002), `TLDRAW_LEASE_TTL_MS`, `TLDRAW_IDLE_GRACE_MS`, `TLDRAW_ROOM_GRACE_MS`, `TLDRAW_SWEEP_MS`, `TLDRAW_BACKLOG_CAP`.

## MCP Client Config

`npm run setup` prints a ready-to-paste snippet. For manual config, the server runs with `tsx` (not a compiled JS file):

```json
{
  "mcpServers": {
    "tldrawserver": {
      "command": "<absolute-path>/server/node_modules/.bin/tsx",
      "args": ["<absolute-path>/server/src/index.ts"]
    }
  }
}
```

Absolute paths are required — most MCP clients ignore `cwd`.

## Logs

- `server/src/mcp-server.log` — per-MCP-session logs
- `server/src/daemon.log` — daemon lifecycle and room activity
