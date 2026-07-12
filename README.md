# Tldraw MCP — a shared planning board for AI agents

Give Claude (or any MCP client) a live [tldraw](https://tldraw.com/) canvas it can
draw on. Ask for a flowchart, a diagram, boxes and arrows — and watch them appear in
your browser in real time. Multiple agents can draw on the **same board at once**, and
the board runs only when an agent is actually using it.

## Features

- **Zero-config.** `npm run setup` and it works. No server to start — the canvas daemon auto-launches on first use and idles down when done.
- **Graph tools with auto-layout.** Describe diagrams by *name and structure* (no coordinates). The server lays them out with dagre — works for plans of any size.
- **Multi-board.** One daemon hosts many isolated boards, keyed by project directory. Agents in different projects never see each other's shapes.
- **Status tracking.** Mark nodes `todo`/`doing`/`done`/`blocked` — the board reads as a live tracker.
- **Agent namespacing.** Each agent's shapes get a stable colour and namespaced ids — see who drew what on shared boards.
- **MCP-native.** Any MCP client can use it. Stdio transport, no port binding in the MCP server itself.

## Quickstart

```bash
git clone https://github.com/micahchoo/tldraw-mcp.git
cd tldraw-mcp
npm run setup        # installs deps + writes .mcp.json for this machine
```

That's it. Open this folder in **Claude Code** (or restart it) and the `tldrawserver`
MCP server is available. Ask it to draw something:

> "Draw a three-step flowchart: Plan → Build → Ship, connected with arrows."

Then open **http://localhost:3002** — you'll see an index of active boards; click yours
to watch it (or ask the agent for its board URL).

Requirements: Node 18+ and internet access (the canvas page loads tldraw from a CDN).

## How it works

Two kinds of process, deliberately decoupled:

```
        ┌──────── canvas daemon (port 3002) — ONE shared instance ────────┐
        │  serves the tldraw web page  +  relays operations  +  leases     │
        └───▲─────────────────▲────────────────────────▲──────────────────┘
            │ POST operations  │ POST operations        │ SSE
      ┌─────┴──────┐    ┌──────┴──────┐          ┌───────┴────────┐
      │ MCP (Claude)│   │  MCP (omp)  │   …       │ your browser   │
      │  ephemeral  │   │  ephemeral  │          │  (the board)   │
      └─────────────┘   └─────────────┘          └────────────────┘
```

- **The MCP server** (`server/src/index.ts`) is thin and ephemeral — your MCP client
  spawns one per connection. It binds no port. On startup it makes sure the daemon is
  running (starting it if not) and holds a **lease**; each tool call POSTs an operation
  to the daemon.
- **The canvas daemon** (`server/src/daemon.ts`) is the shared singleton. It serves the
  board page, fans operations out to the browser over SSE, and reference-counts leases:
  when the last agent's lease is gone it shuts down after a grace period. Leases have a
  TTL, so a crashed agent can't keep it alive forever.

Because every agent POSTs to the one daemon, concurrent edits from different agents and
different harnesses just work. Open the board late and the daemon replays the plan built
so far.

## Multiple projects & multiple agents

One daemon hosts **many boards** ("rooms"), one per project — agents working on different
things never see each other's shapes.

- **A board = a project, keyed automatically by the client's working directory.** Open
  Claude Code in `~/work/foo` and it draws on board `foo`; a second window in `~/work/foo`
  shares it; a window in `~/work/bar` gets its own board. Override with the `TLDRAW_BOARD`
  env var, or have the agent call `useBoard("name")` to switch mid-session.
- **See who drew what.** On a shared board, each agent's shapes get a stable colour and
  their shape references are namespaced, so two agents' flowcharts don't tangle.
- **Browse boards.** Open http://localhost:3002 for an index of active boards; click one,
  or go straight to `http://localhost:3002/?board=<name>`. The agent will also tell you
  its board URL (`getBoardUrl`).

Scope is local only — the daemon binds `127.0.0.1`. "Concurrent users" means multiple
agent sessions on your machine, separated by project.

## Tools the agent can call

**High-level graph tools (preferred — for plans of any size).** You describe a plan by
*name and structure*; the server auto-lays it out with [dagre](https://github.com/dagrejs/dagre).
No coordinates, no id bookkeeping — ideal for small models and large plans.

| Tool | What it does |
|------|--------------|
| `drawGraph` | draw a whole diagram in one call: nodes (by id) + edges (by node id), auto-laid-out |
| `addNode` / `addEdge` | add/update one node or connect two by id (missing nodes auto-created) |
| `describeBoard` | compact read-back of nodes (with status), edges, frames, and free-form shapes |
| `setStatus` | mark a node none/todo/doing/done/blocked — colours it (done=green, doing=orange, blocked=red) |
| `updateNode` | change a node's label, shape, colour, or group |
| `removeNode` / `removeEdge` / `clearBoard` | prune or reset |
| `createFrame` | a titled section/swimlane to group nodes into |
| `focusOn` | pan/zoom every viewer's browser to a node |
| `batch` | apply many graph commands with a single layout at the end |

**Low-level tools (manual coordinates — an escape hatch).**

| Tool | What it does |
|------|--------------|
| `createShape` | rectangle / ellipse / triangle / diamond at (x,y), with optional text |
| `connectShapes` | arrow between two flowchart steps (by "step-N" id) |
| `addText` | free text at a position |
| `createFlowchartStep` | numbered step box, auto-connected to the previous one |
| `getSnapshot` | capture the raw tldraw board state |

**Board control.** `useBoard` switches this agent to a named board (project); `getBoardUrl`
prints the current board's URL.

## Using it with other MCP clients

`npm run setup` prints a ready-to-paste config snippet with the absolute paths for your
machine. Add it under `"mcpServers"`:

- **Claude Code, globally** (any project, not just this repo): add the snippet to
  `~/.claude.json`.
- **omp**: add it to `~/.omp/agent/mcp.json`, then restart omp (it caches config at
  startup).
- **Any stdio MCP client**: `command` is the `tsx` binary, `args` is the path to
  `server/src/index.ts` — both absolute. Absolute paths matter: most clients ignore the
  config's `cwd` and spawn from their own directory.

## Troubleshooting

- **Board shows nothing / "reconnecting"**: no agent is connected yet, so the daemon
  isn't running. Ask an agent to draw, then reload http://localhost:3002.
- **`-32000` / "Transport closed" on connect**: the config isn't using absolute paths.
  Re-run `npm run setup`, or copy the printed snippet exactly.
- **Manual daemon run (debugging)**: `npm run canvas` (from the repo root) starts the
  daemon in the foreground. Env knobs: `TLDRAW_PORT`, `TLDRAW_IDLE_GRACE_MS`,
  `TLDRAW_LEASE_TTL_MS`.
- **Logs**: `server/src/daemon.log` and `server/src/mcp-server.log`.

## Note on the `app/` folder

The original Next.js app in `app/` is superseded — the daemon now serves the canvas
itself on port 3002, so a fresh clone doesn't need it. It's kept for reference; you can
ignore it (or delete it) for the MCP workflow.

## Contributing

Contributions welcome. For bugs or feature requests, open an issue. For code changes:

1. Fork the repo
2. Create a feature branch
3. Make your changes — follow the existing code style (TypeScript, ESM, no framework dependencies in `server/`)
4. Open a PR against `main`

The interesting work lives in `server/src/`. `app/` is legacy Next.js scaffolding and
can be ignored for MCP changes.

## License

MIT
