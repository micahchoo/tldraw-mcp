// The canvas daemon: a single self-contained process that hosts MANY tldraw
// planning boards ("rooms") behind one port. Agents working on different projects
// get different boards and never see each other; agents in the same project share
// one board. It serves the board pages, relays operations per room, and manages
// lifecycle.
//
// Lifecycle (socket-activated singleton, tmux-style, now multi-room):
//   - Started on demand by whichever MCP server first needs it (see index.ts).
//   - Each room reference-counts leases. An empty room's backlog is dropped after
//     a grace period; the whole daemon shuts down once NO room has any lease.
//   - Leases have a TTL so a crashed agent can't pin a room open.
//
// Local only: binds 127.0.0.1. The port bind is the lock — if another daemon
// already holds it, this one exits (race-safe when two start at once).

import { createServer } from "http";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import type { TldrawOperation } from "./eventBus.js";
import { renderCanvasPage, renderIndexPage } from "./canvasPage.js";
import { newGraph, applyCommand, layout, renderOps, serialize, deserialize, type Graph, type GraphCommand } from "./graph.js";
import { buildStamp } from "./buildStamp.js";

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const PORT = num("TLDRAW_PORT", 3002);
const HOST = "127.0.0.1";
const LEASE_TTL_MS = num("TLDRAW_LEASE_TTL_MS", 45_000); // lease expires if not renewed
const IDLE_GRACE_MS = num("TLDRAW_IDLE_GRACE_MS", 60_000); // daemon exits this long after last lease anywhere
const ROOM_GRACE_MS = num("TLDRAW_ROOM_GRACE_MS", 60_000); // empty room's backlog kept this long
const SWEEP_INTERVAL_MS = num("TLDRAW_SWEEP_MS", 10_000);
const SNAPSHOT_TIMEOUT_MS = num("TLDRAW_SNAPSHOT_TIMEOUT_MS", 5_000);
const BACKLOG_CAP = num("TLDRAW_BACKLOG_CAP", 2_000);

const logFile = fs.createWriteStream(
  path.join(import.meta.dirname, "daemon.log"),
  { flags: "a" }
);
function log(message: string) {
  logFile.write(`${new Date().toISOString()} - ${message}\n`);
}

const startedAt = Date.now();
// Stamp of the source this process actually loaded (tsx reads the tree once,
// at spawn). /health reports it; a client whose disk stamp differs retires us.
const BUILD = buildStamp();

// One board = one room. Created lazily; dropped when empty for a while.
// Compact descriptor of a free-form (low-level) shape, so read-back covers what
// createShape/addText/etc drew — not just the graph model.
interface FreeformShape {
  kind: string; // "rectangle" | "ellipse" | ... | "text" | "step" | "arrow"
  label?: string;
  x?: number;
  y?: number;
  from?: string;
  to?: string;
}

interface Room {
  id: string;
  bus: EventEmitter; // browser SSE subscribers for this board
  backlog: TldrawOperation[]; // free-form ops, replayed to a browser that joins late
  freeform: FreeformShape[]; // read-back summary of the free-form ops
  stepIds: Set<string>; // "step-N" ids created so far, for connectShapes validation
  graph: Graph; // named node/edge model (the high-level plan)
  leases: Map<string, number>; // agentId -> expiry timestamp
  dropTimer: NodeJS.Timeout | null;
  saveTimer: NodeJS.Timeout | null; // debounced persistence
}

// --- Persistence: a board's plan survives daemon restart & agent compaction. ---
const PERSIST = process.env.TLDRAW_PERSIST !== "0";
const BOARDS_DIR = path.join(import.meta.dirname, "..", "boards");
if (PERSIST) fs.mkdirSync(BOARDS_DIR, { recursive: true });
const boardFile = (id: string) => path.join(BOARDS_DIR, `${encodeURIComponent(id)}.json`);

function loadRoom(room: Room) {
  if (!PERSIST) return;
  try {
    const raw = fs.readFileSync(boardFile(room.id), "utf8");
    const d = JSON.parse(raw);
    room.graph = deserialize(d.graph);
    room.freeform = d.freeform ?? [];
    room.stepIds = new Set(d.stepIds ?? []);
    log(`[persist] loaded board ${room.id} (${room.graph.nodes.size} nodes)`);
  } catch {
    /* no saved board yet */
  }
}
function saveRoomNow(room: Room) {
  try {
    fs.writeFileSync(
      boardFile(room.id),
      JSON.stringify({ graph: serialize(room.graph), freeform: room.freeform, stepIds: [...room.stepIds] })
    );
  } catch (e) {
    log(`[persist] save failed for ${room.id}: ${e}`);
  }
}
function scheduleSave(room: Room) {
  if (!PERSIST) return;
  if (room.saveTimer) return; // already scheduled
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    saveRoomNow(room);
  }, 500);
  room.saveTimer.unref();
}
// On any shutdown path, write out boards whose debounced save hasn't fired yet
// — otherwise the last ~500ms of edits die with the process.
function flushPendingSaves() {
  if (!PERSIST) return;
  for (const room of rooms.values()) {
    if (!room.saveTimer) continue;
    clearTimeout(room.saveTimer);
    room.saveTimer = null;
    saveRoomNow(room);
    log(`[persist] flushed pending save for ${room.id} on shutdown`);
  }
}

// Turn a free-form operation into a read-back descriptor (null if it isn't a
// shape-creating op, e.g. requestSnapshot).
function freeformDescriptor(op: TldrawOperation): FreeformShape | null {
  const p = (op.payload || {}) as Record<string, any>;
  switch (op.type) {
    case "createShape":
      return { kind: String(p.shapeType), label: p.text || undefined, x: p.x, y: p.y };
    case "addText":
      return { kind: "text", label: p.text, x: p.x, y: p.y };
    case "createFlowchartStep":
      return { kind: "step", label: p.title, x: p.x, y: p.y };
    case "connectShapes":
      return { kind: "arrow", from: p.fromId, to: p.toId };
    default:
      return null;
  }
}
const rooms = new Map<string, Room>();

// getSnapshot requests parked until the browser posts the snapshot back. Keyed by
// globally-unique requestId, so it needs no board scoping.
const pendingSnapshots = new Map<
  string,
  (snapshot: Record<string, unknown> | null) => void
>();

let daemonIdleTimer: NodeJS.Timeout | null = null;

function getRoom(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = { id, bus: new EventEmitter(), backlog: [], freeform: [], stepIds: new Set(), graph: newGraph(), leases: new Map(), dropTimer: null, saveTimer: null };
    room.bus.setMaxListeners(0);
    rooms.set(id, room);
    loadRoom(room); // rehydrate a persisted plan, if any
    log(`[room ${id}] created`);
  }
  if (room.dropTimer) {
    clearTimeout(room.dropTimer);
    room.dropTimer = null;
  }
  return room;
}

function totalLeases(): number {
  let n = 0;
  for (const room of rooms.values()) n += room.leases.size;
  return n;
}

function cancelDaemonIdle() {
  if (daemonIdleTimer) {
    clearTimeout(daemonIdleTimer);
    daemonIdleTimer = null;
  }
}

// After a room empties, keep its backlog briefly (quick reconnects still see the
// plan), then drop the room to bound memory.
function scheduleRoomDrop(room: Room) {
  if (room.leases.size > 0 || room.dropTimer) return;
  room.dropTimer = setTimeout(() => {
    if (room.leases.size === 0) {
      rooms.delete(room.id);
      log(`[room ${room.id}] dropped (idle)`);
    }
  }, ROOM_GRACE_MS);
}

// Shut the whole daemon down once nothing is leased anywhere.
function armDaemonIdleIfEmpty() {
  if (totalLeases() > 0) {
    cancelDaemonIdle();
    return;
  }
  if (daemonIdleTimer) return;
  log(`[daemon] no leases in any room; exiting in ${IDLE_GRACE_MS}ms unless one arrives`);
  daemonIdleTimer = setTimeout(() => {
    if (totalLeases() === 0) shutdown("idle (no leases)");
  }, IDLE_GRACE_MS);
}

// Expire leases whose holder died without releasing.
setInterval(() => {
  const now = Date.now();
  let expired = 0;
  for (const room of rooms.values()) {
    for (const [id, expiry] of room.leases) {
      if (expiry <= now) {
        room.leases.delete(id);
        expired++;
      }
    }
    if (room.leases.size === 0) scheduleRoomDrop(room);
  }
  if (expired > 0) log(`[lease] expired ${expired} stale lease(s)`);
  armDaemonIdleIfEmpty();
}, SWEEP_INTERVAL_MS).unref();

function readBody(req: import("http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
async function readJson(req: import("http").IncomingMessage): Promise<any> {
  const body = await readBody(req);
  return body ? JSON.parse(body) : {};
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const JSON_HEAD = { "Content-Type": "application/json", ...CORS };

function normalizeBoard(id: unknown): string {
  const s = String(id ?? "default").trim();
  return s.length ? s.slice(0, 128) : "default";
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const parsed = new URL(req.url || "/", "http://localhost");
  const pathname = parsed.pathname;

  // --- Board index (no ?board) or the canvas page (?board=<id>) ---
  if ((pathname === "/" || pathname === "/index.html") && req.method === "GET") {
    const boardParam = parsed.searchParams.get("board");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS });
    if (boardParam) {
      res.end(renderCanvasPage(normalizeBoard(boardParam)));
    } else {
      const list = [...rooms.values()].map((r) => ({
        id: r.id,
        agents: r.leases.size,
        shapes: r.backlog.length,
      }));
      res.end(renderIndexPage(list));
    }
    return;
  }

  // --- Liveness / introspection ---
  if (pathname === "/health" && req.method === "GET") {
    res.writeHead(200, JSON_HEAD);
    res.end(
      JSON.stringify({
        status: "ok",
        rooms: rooms.size,
        leases: totalLeases(),
        boards: [...rooms.values()].map((r) => ({ id: r.id, leases: r.leases.size, backlog: r.backlog.length })),
        uptimeMs: Date.now() - startedAt,
        build: BUILD,
      })
    );
    return;
  }

  // --- Retire a stale daemon: a client whose src/*.ts stamp differs from ours
  // asks us to exit so it can respawn the current code (see buildStamp.ts).
  if (pathname === "/shutdown" && req.method === "POST") {
    const { stamp } = await readJson(req).catch(() => ({} as any));
    res.writeHead(200, JSON_HEAD);
    res.end(JSON.stringify({ ok: true, build: BUILD }));
    shutdown(`superseded (our build ${BUILD}, disk ${stamp ?? "?"})`);
    return;
  }

  // --- Lease management (called by MCP servers), scoped to a board ---
  if (pathname === "/lease/acquire" && req.method === "POST") {
    const { agentId, board } = await readJson(req);
    const room = getRoom(normalizeBoard(board));
    room.leases.set(agentId, Date.now() + LEASE_TTL_MS);
    cancelDaemonIdle();
    log(`[lease] acquire ${agentId} on ${room.id}; room=${room.leases.size} total=${totalLeases()}`);
    res.writeHead(200, JSON_HEAD);
    res.end(JSON.stringify({ ok: true, ttlMs: LEASE_TTL_MS, board: room.id }));
    return;
  }
  if (pathname === "/lease/renew" && req.method === "POST") {
    const { agentId, board } = await readJson(req);
    const room = getRoom(normalizeBoard(board));
    room.leases.set(agentId, Date.now() + LEASE_TTL_MS);
    cancelDaemonIdle();
    res.writeHead(200, JSON_HEAD);
    res.end(JSON.stringify({ ok: true, ttlMs: LEASE_TTL_MS }));
    return;
  }
  if (pathname === "/lease/release" && req.method === "POST") {
    const { agentId, board } = await readJson(req);
    const room = rooms.get(normalizeBoard(board));
    if (room) {
      room.leases.delete(agentId);
      log(`[lease] release ${agentId} on ${room.id}; room=${room.leases.size} total=${totalLeases()}`);
      if (room.leases.size === 0) scheduleRoomDrop(room);
    }
    armDaemonIdleIfEmpty();
    res.writeHead(200, JSON_HEAD);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Browser SSE stream for one board ---
  if (pathname === "/api/tldraw-events" && req.method === "GET") {
    const room = getRoom(normalizeBoard(parsed.searchParams.get("board")));
    log(`[sse] browser connected to ${room.id}`);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS,
    });
    const send = (event: string, data: Record<string, unknown>) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send("connected", { message: `Connected to board ${room.id}` });
    // Rebuild this browser's view: free-form ops, then the current graph.
    for (const op of room.backlog) {
      send("tldraw-operation", op as unknown as Record<string, unknown>);
    }
    for (const op of renderOps(room.graph)) {
      send("tldraw-operation", op as unknown as Record<string, unknown>);
    }

    const heartbeat = setInterval(() => res.write("event: heartbeat\ndata: ping\n\n"), 30_000);
    const onOperation = (op: TldrawOperation) =>
      send("tldraw-operation", op as unknown as Record<string, unknown>);
    room.bus.on("tldraw-operation", onOperation);

    req.on("close", () => {
      clearInterval(heartbeat);
      room.bus.off("tldraw-operation", onOperation);
      log(`[sse] browser left ${room.id}`);
    });
    return;
  }

  // --- MCP server publishes an operation to a board ---
  if (pathname === "/api/operation" && req.method === "POST") {
    try {
      const { board, operation } = await readJson(req);
      const room = getRoom(normalizeBoard(board));
      room.backlog.push(operation);
      if (room.backlog.length > BACKLOG_CAP) room.backlog.shift();
      const desc = freeformDescriptor(operation);
      if (desc) {
        room.freeform.push(desc);
        if (room.freeform.length > BACKLOG_CAP) room.freeform.shift();
      }
      // Track step ids so connectShapes can tell the model when a reference is
      // unknown instead of reporting a false success on a no-op.
      const p = (operation.payload || {}) as Record<string, any>;
      if (operation.type === "createFlowchartStep" || (operation.type === "createShape" && "stepNumber" in p)) {
        room.stepIds.add(`step-${p.stepNumber}`);
      }
      let extra: Record<string, unknown> = {};
      if (operation.type === "connectShapes") {
        const unknown = [p.fromId, p.toId].filter((id) => !room.stepIds.has(String(id)));
        extra = { resolved: unknown.length === 0, unknown };
      }
      if (desc) scheduleSave(room);
      room.bus.emit("tldraw-operation", operation);
      res.writeHead(200, JSON_HEAD);
      res.end(JSON.stringify({ success: true, ...extra }));
    } catch (error) {
      log(`[operation] error: ${error}`);
      res.writeHead(400, JSON_HEAD);
      res.end(JSON.stringify({ success: false }));
    }
    return;
  }

  // --- High-level graph commands (named nodes/edges, layout, status, ...) ---
  // Body: { board, command, ...args }  OR  { board, commands: [ {command, ...}, ... ] }
  // The daemon mutates its per-board graph, re-runs auto-layout, and broadcasts
  // idempotent render ops to browsers. `list` returns the compact model.
  if (pathname === "/api/graph" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const boardId = normalizeBoard(body.board);

      // deleteBoard is a daemon-level op (drops the room + its file), not a graph
      // mutation — clearBoard only empties the in-memory graph, which the persisted
      // file would resurrect on next load.
      if (body.command === "deleteBoard") {
        const room = rooms.get(boardId);
        if (room) {
          if (room.saveTimer) clearTimeout(room.saveTimer);
          room.bus.emit("tldraw-operation", { type: "clearGraph", payload: {} });
          rooms.delete(boardId);
        }
        try { if (PERSIST) fs.rmSync(boardFile(boardId), { force: true }); } catch {}
        log(`[persist] deleted board ${boardId}`);
        res.writeHead(200, JSON_HEAD);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const room = getRoom(boardId);
      const cmds: GraphCommand[] = Array.isArray(body.commands)
        ? body.commands
        : [{ command: body.command, ...body }];

      const removed: string[] = [];
      let cleared = false;
      let structural = false;
      let focus: string | undefined;
      let data: unknown;
      const errors: string[] = [];
      for (const c of cmds) {
        const r = applyCommand(room.graph, c);
        removed.push(...r.removed);
        cleared = cleared || r.cleared;
        structural = structural || r.structural;
        if (r.focus) focus = r.focus;
        if (r.data !== undefined) data = r.data;
        if (r.error) errors.push(r.error);
      }

      // Broadcast: clears/deletes first, then the relaid-out graph, then focus.
      if (cleared) room.bus.emit("tldraw-operation", { type: "clearGraph", payload: {} });
      if (removed.length)
        room.bus.emit("tldraw-operation", { type: "deleteNodes", payload: { ids: removed } });
      if (structural) {
        layout(room.graph);
        for (const op of renderOps(room.graph)) room.bus.emit("tldraw-operation", op);
      }
      if (focus) room.bus.emit("tldraw-operation", { type: "focus", payload: { id: focus } });
      if (structural || cleared || removed.length) scheduleSave(room);

      // `list` returns the graph (has a `nodes` field); augment it with the board
      // name and free-form shapes so read-back covers the whole write surface.
      // Guarded so other commands' data (e.g. addEdge's {created}) isn't wrapped.
      if (data && typeof data === "object" && "nodes" in data) {
        data = { board: room.id, ...(data as object), freeform: room.freeform };
      }

      res.writeHead(200, JSON_HEAD);
      res.end(JSON.stringify({ ok: errors.length === 0, errors, data }));
    } catch (error) {
      log(`[graph] error: ${error}`);
      res.writeHead(400, JSON_HEAD);
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
    return;
  }

  // --- MCP server requests a snapshot of a board (long-poll) ---
  if (pathname === "/api/request-snapshot" && req.method === "POST") {
    const { board, requestId } = await readJson(req);
    const room = getRoom(normalizeBoard(board));
    let settled = false;
    const finish = (snapshot: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      pendingSnapshots.delete(requestId);
      res.writeHead(200, JSON_HEAD);
      res.end(JSON.stringify({ requestId, snapshot }));
    };
    pendingSnapshots.set(requestId, finish);
    room.bus.emit("tldraw-operation", {
      type: "requestSnapshot",
      payload: { requestId },
    } as TldrawOperation);
    setTimeout(() => finish(null), SNAPSHOT_TIMEOUT_MS);
    return;
  }

  // --- Browser returns a snapshot ---
  if (pathname === "/api/snapshot" && req.method === "POST") {
    try {
      const { requestId, snapshot } = await readJson(req);
      pendingSnapshots.get(requestId)?.(snapshot);
      res.writeHead(200, JSON_HEAD);
      res.end(JSON.stringify({ success: true }));
    } catch {
      res.writeHead(500, JSON_HEAD);
      res.end(JSON.stringify({ success: false }));
    }
    return;
  }

  res.writeHead(404, CORS);
  res.end("Not found");
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log(`[daemon] port ${PORT} already held; another daemon is running. Exiting.`);
    process.stderr.write(`[daemon] port ${PORT} already in use — another daemon is running.\n`);
    process.exit(0);
  }
  log(`[daemon] fatal: ${err.message}`);
  throw err;
});

server.listen(PORT, HOST, () => {
  log(`[daemon] listening on ${HOST}:${PORT}`);
  process.stderr.write(`[daemon] canvas on http://localhost:${PORT}\n`);
  armDaemonIdleIfEmpty();
});

let shuttingDown = false;
function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[daemon] shutting down (${reason})`);
  flushPendingSaves();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
