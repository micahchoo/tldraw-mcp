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
import type { TldrawOperation } from "./eventBus.js";

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

// Forward an operation to the daemon, tagged with the current board and this
// agent's id (the daemon routes by board; the browser tints/namespaces by agent).
// Fire-and-forget: a tool call still succeeds even if the canvas isn't up.
async function postOperation(operation: TldrawOperation): Promise<any> {
  try {
    const res = await fetch(`${DAEMON_URL}/api/operation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        board: currentBoard,
        operation: { ...operation, agentId },
      }),
    });
    return await res.json();
  } catch (error) {
    logToFile(`[Server] Could not reach canvas daemon at ${DAEMON_URL}: ${error}`);
    return null;
  }
}

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

const server = new McpServer({
  name: "TldrawServer",
  version: "1.0.0",
});

server.tool(
  "createShape",
  "Draw a rectangle, ellipse, triangle, or diamond at (x, y) on the current board, sized width×height, with optional label text. Each agent's shapes get a distinct colour.",
  {
    type: z.enum(["rectangle", "ellipse", "triangle", "diamond"]),
    x: z.number().describe("Top-left x in canvas coordinates"),
    y: z.number().describe("Top-left y in canvas coordinates"),
    width: z.number(),
    height: z.number(),
    text: z.string().optional().describe("Optional label shown inside the shape"),
  },
  async ({ type, x, y, width, height, text }) => {
    logToFile(
      `Creating shape: type=${type}, x=${x}, y=${y}, width=${width}, height=${height}, text=${text || ""}`
    );
    await postOperation({
      type: "createShape",
      payload: { shapeType: type, x, y, width, height, text: text || "" },
    });

    return {
      content: [
        { type: "text", text: `Created a ${type} at position (${x}, ${y})` },
      ],
    };
  }
);

server.tool(
  "connectShapes",
  "Draw an arrow between two flowchart steps created with createFlowchartStep. Reference them by step id, e.g. fromId \"step-1\", toId \"step-3\".",
  {
    fromId: z.string().describe('Source step id, e.g. "step-1"'),
    toId: z.string().describe('Target step id, e.g. "step-2"'),
    arrowType: z.enum(["straight", "curved", "orthogonal"]).optional(),
  },
  async ({ fromId, toId, arrowType }) => {
    const r = await postOperation({
      type: "connectShapes",
      payload: { fromId, toId, arrowType: arrowType || "straight" },
    });

    // Honest feedback: the arrow only renders if both are existing step ids.
    if (r && r.resolved === false) {
      return {
        content: [
          {
            type: "text",
            text: `Could not connect: unknown step id(s) ${r.unknown.join(", ")}. Create them with createFlowchartStep first, or use addEdge for graph nodes.`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: `Connected ${fromId} → ${toId}.` }],
    };
  }
);

server.tool(
  "addText",
  "Add a free-standing text label at (x, y) on the current board.",
  {
    x: z.number(),
    y: z.number(),
    text: z.string(),
  },
  async ({ x, y, text }) => {
    await postOperation({
      type: "addText",
      payload: { x, y, text },
    });

    return {
      content: [
        { type: "text", text: `Added text "${text}" at position (${x}, ${y})` },
      ],
    };
  }
);

server.tool(
  "createFlowchartStep",
  "Create a numbered step box (referenceable as \"step-<n>\"). Auto-lays-out horizontally if x/y are omitted; set connectToPrevious to draw an arrow from the previous step.",
  {
    stepNumber: z.number().describe("Sequential step number; also its reference id \"step-<n>\""),
    title: z.string(),
    description: z.string().optional().describe("Optional second line inside the box"),
    x: z.number().optional(),
    y: z.number().optional(),
    connectToPrevious: z.boolean().optional().describe("Draw an arrow from step-(n-1) to this step"),
  },
  async ({ stepNumber, title, description, x, y, connectToPrevious }) => {
    const posX = x || stepNumber * 200;
    const posY = y || 200;

    await postOperation({
      type: "createFlowchartStep",
      payload: {
        stepNumber,
        title,
        description: description || "",
        x: posX,
        y: posY,
        connectToPrevious: connectToPrevious !== false,
      },
    });

    return {
      content: [
        { type: "text", text: `Created flowchart step ${stepNumber}: ${title}` },
      ],
    };
  }
);

server.tool("getSnapshot", "Capture the current board's full contents as a tldraw snapshot (JSON).", {}, async () => {
  const requestId = `snapshot-${Date.now()}`;
  try {
    const res = await fetch(`${DAEMON_URL}/api/request-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: currentBoard, requestId }),
    });
    const { snapshot } = (await res.json()) as {
      snapshot: Record<string, unknown> | null;
    };

    if (snapshot) {
      return {
        content: [{ type: "text", text: `Diagram snapshot captured` }],
        snapshot,
      };
    }
    return {
      content: [
        { type: "text", text: `Failed to capture diagram snapshot (timeout)` },
      ],
    };
  } catch (error) {
    logToFile(`[Server] getSnapshot could not reach daemon: ${error}`);
    return {
      content: [
        {
          type: "text",
          text: `Failed to capture snapshot: canvas at ${DAEMON_URL} is not reachable`,
        },
      ],
    };
  }
});

server.tool(
  "useBoard",
  "Switch which board (project) you draw on. Each board is a separate canvas; agents on the same board share it. Defaults to your working directory.",
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

server.tool("getBoardUrl", "Return the browser URL for the board you're currently drawing on.", {}, async () => ({
  content: [
    { type: "text", text: `Current board "${currentBoard}" — view at ${boardUrl()}` },
  ],
}));

// ---- High-level graph tools (preferred for plans of any size) ----
// These let you describe a plan by NAME and STRUCTURE; the server auto-lays it
// out. No coordinates, no id bookkeeping. Use these instead of createShape for
// anything with connections or more than a few boxes.

const NODE_SHAPE = z.enum(["rectangle", "ellipse", "diamond", "triangle"]);
const NODE_STATUS = z.enum(["none", "todo", "doing", "done", "blocked"]);
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

server.tool(
  "drawGraph",
  "Draw or extend a whole diagram in ONE call: give nodes (by id) and edges (by node id). The server auto-lays it out — no coordinates needed. This is the best tool for plans, flowcharts, and dependency graphs of any size. Set replace:true to redraw the board from scratch.",
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
  "Add or update one node by id. The server places it automatically. Re-calling with the same id updates it (no duplicates).",
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
  "Connect two nodes with an arrow, by their ids. Missing nodes are created automatically.",
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
  "describeBoard",
  "Read back everything on the current board: its name, graph nodes (with status), edges, frames, AND any free-form shapes (from createShape/addText/etc). Use this to see what exists before adding, to confirm what you drew, or to resume a plan — compact, unlike getSnapshot.",
  {},
  async () => {
    const r = await graph({ command: "list" });
    return ok(JSON.stringify(r.data ?? {}, null, 2));
  }
);

server.tool(
  "updateNode",
  "Change a node's label, shape, status, colour, or group by id.",
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
  "setStatus",
  "Set a node's status (none/todo/doing/done/blocked). Colours the node so the board reads as a live tracker (done=green, doing=orange, blocked=red, todo=grey).",
  { id: z.string(), status: NODE_STATUS },
  async ({ id, status }) => {
    const r = await graph({ command: "setStatus", id, status });
    return ok(r.ok ? `${id} → ${status}.` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "removeNode",
  "Delete a node (and its edges) by id.",
  { id: z.string() },
  async ({ id }) => {
    const r = await graph({ command: "removeNode", id });
    return ok(r.ok ? `Removed "${id}".` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "removeEdge",
  "Delete the arrow between two node ids.",
  { from: z.string(), to: z.string() },
  async ({ from, to }) => {
    const r = await graph({ command: "removeEdge", from, to });
    return ok(r.ok ? `Disconnected ${from} → ${to}.` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "createFrame",
  "Create a titled section/swimlane that nodes can be grouped into (via a node's group id).",
  { id: z.string(), name: z.string().optional() },
  async ({ id, name }) => {
    const r = await graph({ command: "createFrame", id, name });
    return ok(r.ok ? `Created frame "${id}".` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "focusOn",
  "Pan and zoom every viewer's browser to a node, by id.",
  { id: z.string() },
  async ({ id }) => {
    await graph({ command: "focus", id });
    return ok(`Focused on "${id}".`);
  }
);

server.tool(
  "clearBoard",
  "Remove all graph nodes and edges from the current board (start over).",
  {},
  async () => {
    const r = await graph({ command: "clear" });
    return ok(r.ok ? `Cleared the board.` : `Error: ${errText(r)}`);
  }
);

server.tool(
  "batch",
  "Apply many graph commands in one call, with a single layout at the end — efficient for large plans. Each item is an object like {command:\"addNode\", id:\"x\"} or {command:\"addEdge\", from:\"x\", to:\"y\"}.",
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
