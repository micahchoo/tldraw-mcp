# HANDOFF — tldraw-mcp

_Checkpoint 2026-07-11, ahead of possible compaction._

## What this is
An MCP server that gives an AI agent a live tldraw canvas as a **planning board**. Architecture
(all built this session, see memory `tldraw-mcp-launch`):
- `server/src/daemon.ts` — always-on-demand canvas daemon on 127.0.0.1:3002. Multi-board (rooms),
  socket-activated singleton + lease lifecycle (auto-start on first agent, idle-shutdown after last).
  Serves the canvas page, relays ops via SSE, owns the **graph model** per board.
- `server/src/graph.ts` — named node/edge/frame graph + dagre auto-layout + `describe()` read-back.
- `server/src/canvasPage.ts` — tldraw page via esm.sh CDN (import map MUST include react/jsx-runtime);
  v3 API: pre-gen ids w/ createShapeId, labels use richText(toRichText), arrows via createBindings.
- `server/src/index.ts` — thin ephemeral MCP server, 19 tools. Board = cwd-derived (or TLDRAW_BOARD).
- Setup: `npm run setup` writes machine-local `.mcp.json` (absolute paths — harnesses ignore cwd).

## State
- **Everything is uncommitted** (working tree on `bf5a9f0`). One commit pass still owed (no AI
  attribution per user convention). tsc clean throughout. Verified headless; live browser/agent
  render confirmed once (fixed v3 richText/createShapeId/bindings + jsx-runtime import).
- **Daemon**: not currently running (auto-spawns on next MCP use). Connected Claude session has the
  PRE-graph tool list cached — needs `/mcp` reconnect to see the 19 tools.

## Done this session
- Built: multi-board daemon, graph tools (drawGraph/addNode/addEdge/describeBoard/setStatus/
  updateNode/removeNode/removeEdge/createFrame/focusOn/clearBoard/batch), auto-layout, attribution.
- `/tend` run: ISSUES.md + ledgers/. Issues 1 (read-back covers writes) & 2 (no false/undefined
  confirmations) fixed+verified; directions D1 (capability-reach) & D2 (dark fields → surfaced
  shape/x/y in describeBoard) classified. **Only Issue 3 open** (Worth-exploring): 3 redundant ways
  to make connected boxes → canonicalize to graph tools.

## Wayfinder map — COMPLETE (2026-07-11)
All 4 tickets in `.seeds/` closed: nextActionable, durable-plans (persist to server/boards/), deleteBoard,
node-ownership (owner=agentId, assignNode, nextActionable(owner)). 22 tools now, tsc clean, all
headless-verified against kill criteria. Deviation: node colour stays status-driven (owner in read-back,
not colour). Still uncommitted — commit pass owed. Live use needs `/mcp` reconnect (tool list cached).

## History (earlier)
- `/graft` done → `DIVERGENCES.md` (4 divergences, top bet nextActionable + durable plans).
- `/wayfinder` charted the map: `.wayfinder/map.md` + 3 tickets in `.wayfinder/tickets/`
  (local-markdown tracker; no GitHub issues created — would need user OK). Frontier (takeable now):
  **nextactionable** and **durable-plans** (both unblocked/unclaimed); **node-ownership** blocked by
  nextactionable; checklist parked in Fog.
- NEXT (a "work through the map" session, ONE ticket): resolve **nextactionable** — add graph command
  + MCP tool returning nodes whose every predecessor is `done` (not itself done/blocked). Kill: wrong
  ready-set on diamond A→B,A→C,B→D,C→D with A done (expect B,C). Then claim it (set Assignee), build
  in graph.ts + index.ts, verify headless, close ticket + append to map Decisions-so-far.
