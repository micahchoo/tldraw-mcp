// Thin MCP server. It exposes the tldraw tools over stdio and forwards each
// operation to the canvas daemon (server/src/daemon.ts) over HTTP. It binds NO
// port of its own. On startup it AUTO-STARTS the daemon if none is running and
// holds a lease for as long as it's connected; the daemon shuts itself down once
// the last agent's lease is gone. So the canvas is up exactly when an agent needs
// it, shared across all agents, and off otherwise — no manual server management.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { randomUUID, createHash } from "crypto";

const DAEMON_PORT = Number(process.env.TLDRAW_PORT) || 3002;
const DAEMON_URL = `http://localhost:${DAEMON_PORT}`;
const HEARTBEAT_MS = 15_000;
const agentId = randomUUID();

const sanitizeBoard = (s: string): string =>
  s.trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128) || "default";

// A board = a project. By default it's derived from the client's working
// directory — which the harness sets to the user's open project — so different
// projects get different boards and the same project shares one. TLDRAW_BOARD
// overrides it, and the useBoard tool switches it at runtime.
function deriveBoard(): string {
  if (process.env.TLDRAW_BOARD) return sanitizeBoard(process.env.TLDRAW_BOARD);
  const cwd = process.cwd();
  const base = sanitizeBoard(cwd.split(/[/\\]/).pop() || "board");
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 6);
  return `${base}-${hash}`;
}

let currentBoard = deriveBoard();
const boardUrl = () => `${DAEMON_URL}/?board=${encodeURIComponent(currentBoard)}`;

const mcpLogFile = fs.createWriteStream(
  path.join(import.meta.dirname, "mcp-server.log"),
  { flags: "a" }
);
function logToFile(message: string) {
  mcpLogFile.write(`${new Date().toISOString()} - ${message}\n`);
}

logToFile(`[Server] Starting MCP server (agent ${agentId})...`);

// Actionable error text for a blind model: the daemon returns {errors:[]} on the
// happy path but {error} on its catch path — never surface "undefined".
function errText(r: any): string {
  if (r?.errors?.length) return r.errors.join("; ");
  if (r?.error) return String(r.error);
  return "unknown error (canvas daemon unreachable?)";
}

// Send a high-level graph command (or batch) to the daemon for the current
// board. Returns the daemon's JSON result ({ ok, errors, data }).
async function graph(payload: Record<string, unknown>): Promise<any> {
  try {
    const res = await fetch(`${DAEMON_URL}/api/graph`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: currentBoard, ...payload }),
    });
    return await res.json();
  } catch (error) {
    logToFile(`[Server] graph command failed: ${error}`);
    return { ok: false, error: String(error) };
  }
}

async function daemonHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_URL}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Ensure the shared canvas daemon is running, starting it detached if not.
// Detached (own session, unref'd, stdio ignored) so it OUTLIVES this ephemeral
// MCP process and is shared by every agent. If two agents race to start it, only
// one wins port 3002 — the loser exits cleanly — and both then attach.
async function ensureDaemon(): Promise<boolean> {
  if (await daemonHealthy()) {
    logToFile("[Server] Canvas daemon already running");
    return true;
  }
  logToFile("[Server] No canvas daemon; starting it detached");
  try {
    const tsxBin = path.join(
      import.meta.dirname,
      "..",
      "node_modules",
      ".bin",
      "tsx"
    );
    const daemonPath = path.join(import.meta.dirname, "daemon.ts");
    const child = spawn(tsxBin, [daemonPath], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (error) {
    logToFile(`[Server] Failed to spawn daemon: ${error}`);
    return false;
  }
  // Poll until it answers (or give up after ~8s).
  for (let i = 0; i < 40; i++) {
    if (await daemonHealthy()) {
      logToFile("[Server] Canvas daemon is up");
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  logToFile("[Server] Canvas daemon did not come up in time");
  return false;
}

async function lease(
  action: "acquire" | "renew" | "release",
  board: string = currentBoard
): Promise<void> {
  try {
    await fetch(`${DAEMON_URL}/lease/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, board }),
      signal: AbortSignal.timeout(1500),
    });
  } catch (error) {
    logToFile(`[Server] lease ${action} failed: ${error}`);
  }
}

let heartbeat: NodeJS.Timeout | null = null;
let releasing = false;
async function releaseAndExit(reason: string): Promise<void> {
  if (releasing) return;
  releasing = true;
  logToFile(`[Server] Shutting down (${reason}); releasing lease`);
  if (heartbeat) clearInterval(heartbeat);
  await lease("release");
  process.exit(0);
}

const server = new McpServer(
  {
    name: "TldrawServer",
    version: "1.0.0",
  },
  {
    // Orients the model once, up front — leading words: plan, board, ready-set.
    instructions:
      "A shared tldraw planning board. Build a plan as a graph of named nodes and edges — " +
      "drawGraph (bulk) or addNode/addEdge; there are no coordinates, the server auto-lays it out. " +
      "Track progress with setStatus; ask nextActionable for what to work on now; read the plan " +
      "back with describeBoard. Each project has its own board (getBoardUrl to view it); plans persist " +
      "across sessions.",
  }
);

server.tool(
  "useBoard",
  "Switch to a named board (a separate canvas per project). Same-name boards are shared. Defaults to your working directory.",
  { name: z.string().describe("Board/project name to draw on") },
  async ({ name }) => {
    const next = sanitizeBoard(name);
    if (next !== currentBoard) {
      await lease("release"); // release the old board
      currentBoard = next;
      await lease("acquire"); // hold the new one
      logToFile(`[Server] Switched to board ${currentBoard}`);
    }
    return {
      content: [
        { type: "text", text: `Now drawing on board "${currentBoard}". View it at ${boardUrl()}` },
      ],
    };
  }
);

server.tool("getBoardUrl", "The browser URL of your current board.", {}, async () => ({
  content: [
    { type: "text", text: `Current board "${currentBoard}" — view at ${boardUrl()}` },
  ],
}));

// ---- Graph tools: describe a plan by NAME and STRUCTURE; the server auto-lays
// it out. No coordinates, no id bookkeeping. ----

const NODE_SHAPE = z.enum(["rectangle", "ellipse", "diamond", "triangle"]);
const NODE_STATUS = z.enum(["none", "todo", "doing", "done", "blocked"]);
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

server.tool(
  "drawGraph",
  "Draw or extend a whole plan in one call from nodes (by id) and edges (by node id) — auto-laid-out, no coordinates. Best for anything with connections or more than a few boxes. replace:true redraws from scratch.",
  {
    nodes: z
      .array(
        z.object({
          id: z.string().describe("Stable id you'll reference in edges, e.g. \"auth\""),
          label: z.string().optional().describe("Display text (defaults to id)"),
          shape: NODE_SHAPE.optional(),
          status: NODE_STATUS.optional(),
          group: z.string().optional().describe("Frame/section id to place this node in"),
        })
      )
      .describe("The boxes in the diagram"),
    edges: z
      .array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() }))
      .optional()
      .describe("Arrows between node ids"),
    frames: z
      .array(z.object({ id: z.string(), name: z.string().optional() }))
      .optional()
      .describe("Optional sections/swimlanes to group nodes"),
    replace: z.boolean().optional().describe("Clear the board first"),
  },
  async ({ nodes, edges, frames, replace }) => {
    const r = await graph({ command: "drawGraph", nodes, edges, frames, replace });
    return ok(
      r.ok
        ? `Drew ${nodes.length} node(s), ${edges?.length ?? 0} edge(s). View: ${boardUrl()}`
        : `Errors: ${errText(r)}`
    );
  }
);

server.tool(
  "addNode",
  "Add or update one plan node by id (auto-placed). The same id updates in place, never duplicates.",
  {
    id: z.string(),
    label: z.string().optional(),
    shape: NODE_SHAPE.optional(),
    status: NODE_STATUS.optional(),
    group: z.string().optional(),
  },
  async (args) => {
    const r = await graph({ command: "addNode", ...args });
    return ok(r.ok ? `Added node "${args.id}".` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "addEdge",
  "Connect two nodes with an arrow by id. Missing endpoints are created and reported, so a typo shows up.",
  { from: z.string(), to: z.string(), label: z.string().optional() },
  async (args) => {
    const r = await graph({ command: "addEdge", ...args });
    const created = r?.data?.created as string[] | undefined;
    return ok(
      r.ok
        ? `Connected ${args.from} → ${args.to}.` +
            (created?.length ? ` Created new node(s): ${created.join(", ")}.` : "")
        : `Error: ${errText(r)}`
    );
  }
);

server.tool(
  "nextActionable",
  "The ready-set: nodes whose dependencies are all done and that aren't done or blocked — what to work on next. Prefer this over re-reading the plan. owner ('me' for yourself) filters to yours plus unowned.",
  { owner: z.string().optional().describe("Filter to this owner's ready nodes (+ unowned). Use 'me' for yourself.") },
  async ({ owner }) => {
    const resolved = owner === "me" ? agentId : owner;
    const r = await graph({ command: "nextActionable", owner: resolved });
    const ready = (r?.data?.ready ?? []) as Array<{ id: string; label: string }>;
    return ok(
      ready.length
        ? `Ready to work on: ${ready.map((n) => `${n.id} (${n.label})`).join(", ")}`
        : `Nothing actionable — every node is done, blocked, or waiting on a dependency.`
    );
  }
);

server.tool(
  "describeBoard",
  "Read back the plan as compact text: board name, nodes (status, shape, owner, position), edges, and frames. Use it to see what exists before adding, confirm a change, or resume a plan across sessions.",
  {},
  async () => {
    const r = await graph({ command: "list" });
    return ok(JSON.stringify(r.data ?? {}, null, 2));
  }
);

server.tool(
  "updateNode",
  "Change a node's label, shape, status, colour, group, or owner by id.",
  {
    id: z.string(),
    label: z.string().optional(),
    shape: NODE_SHAPE.optional(),
    status: NODE_STATUS.optional(),
    color: z.string().optional(),
    group: z.string().optional(),
  },
  async (args) => {
    const r = await graph({ command: "updateNode", ...args });
    return ok(r.ok ? `Updated "${args.id}".` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "assignNode",
  "Assign a node to an agent (defaults to you). Pass owner for someone else, or unassign:true to clear. nextActionable(owner) then partitions the work across agents.",
  {
    id: z.string(),
    owner: z.string().optional().describe("Owner id to assign to; defaults to you"),
    unassign: z.boolean().optional().describe("Clear the owner instead"),
  },
  async ({ id, owner, unassign }) => {
    const r = await graph({ command: "assignNode", id, owner: unassign ? undefined : owner ?? agentId });
    return ok(r.ok ? `${unassign ? "Unassigned" : "Assigned"} "${id}"${unassign ? "" : ` to ${owner ?? "you"}`}.` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "setStatus",
  "Set a node's status — none/todo/doing/done/blocked. Colours it so the board reads as a live tracker: done=green, doing=orange, blocked=red, todo=grey.",
  { id: z.string(), status: NODE_STATUS },
  async ({ id, status }) => {
    const r = await graph({ command: "setStatus", id, status });
    return ok(r.ok ? `${id} → ${status}.` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "removeNode",
  "Delete a node and its edges, by id.",
  { id: z.string() },
  async ({ id }) => {
    const r = await graph({ command: "removeNode", id });
    return ok(r.ok ? `Removed "${id}".` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "removeEdge",
  "Delete the arrow between two nodes.",
  { from: z.string(), to: z.string() },
  async ({ from, to }) => {
    const r = await graph({ command: "removeEdge", from, to });
    return ok(r.ok ? `Disconnected ${from} → ${to}.` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "createFrame",
  "Create a titled section (swimlane); nodes join it via their group id.",
  { id: z.string(), name: z.string().optional() },
  async ({ id, name }) => {
    const r = await graph({ command: "createFrame", id, name });
    return ok(r.ok ? `Created frame "${id}".` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "focusOn",
  "Pan and zoom every viewer's browser to a node.",
  { id: z.string() },
  async ({ id }) => {
    await graph({ command: "focus", id });
    return ok(`Focused on "${id}".`);
  }
);

server.tool(
  "clearBoard",
  "Empty the current board — remove all nodes and edges. The board and its saved file remain; use deleteBoard to remove those.",
  {},
  async () => {
    const r = await graph({ command: "clear" });
    return ok(r.ok ? `Cleared the board.` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "deleteBoard",
  "Delete the current board and its saved file, so it won't reload on restart. (clearBoard only empties it.)",
  {},
  async () => {
    const r = await graph({ command: "deleteBoard" });
    return ok(r.ok ? `Deleted board "${currentBoard}".` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "batch",
  "Apply many graph commands in one call with a single layout at the end — efficient for large plans. Each item is like {command:'addNode', id:'x'} or {command:'addEdge', from:'x', to:'y'}.",
  {
    commands: z
      .array(z.object({ command: z.string() }).passthrough())
      .describe("List of graph command objects to apply in order"),
  },
  async ({ commands }) => {
    const r = await graph({ commands });
    return ok(
      r.ok ? `Applied ${commands.length} command(s). View: ${boardUrl()}` : `Errors: ${errText(r)}`
    );
  }
);

// Connect over stdio FIRST so the MCP handshake completes promptly (never blocked
// on the canvas coming up). No HTTP server here, so when the client disconnects
// and stdin closes we release our lease and exit — nothing to orphan.
const transport = new StdioServerTransport();
await server.connect(transport);
logToFile("[Server] MCP stdio transport connected");

// Then bring up the shared canvas and register our lease on this board.
await ensureDaemon();
await lease("acquire");
heartbeat = setInterval(() => void lease("renew"), HEARTBEAT_MS);
logToFile(`[Server] On board "${currentBoard}" — ${boardUrl()}`);

// Release the lease and exit when the client goes away (stdin EOF covers a clean
// disconnect, a crash, or SIGKILL of the parent). The daemon's lease TTL is the
// backstop if release never lands.
process.stdin.on("end", () => void releaseAndExit("stdin EOF"));
process.stdin.on("close", () => void releaseAndExit("stdin closed"));
process.on("SIGTERM", () => void releaseAndExit("SIGTERM"));
process.on("SIGINT", () => void releaseAndExit("SIGINT"));
