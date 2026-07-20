// Pages served by the daemon:
//   renderIndexPage(boards) -> the board index at "/"  (lists active projects)
//   renderCanvasPage(board) -> the tldraw board at "/?board=<id>"
//
// The canvas page loads tldraw + React from a CDN via an import map (which keeps a
// single shared React instance — a duplicate silently breaks hooks) and talks to
// the daemon on the same origin. Operations carry an `agentId`, so shapes are
// namespaced and colour-tinted per agent: multiple agents on the SAME board don't
// clobber each other's shape references, and you can see who drew what.
//
// Versions are pinned; bump alongside server/package.json's @tldraw/tldraw.

const REACT = "19.0.0";
const TLDRAW = "3.13.1";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

export function renderIndexPage(
  boards: Array<{ id: string; agents: number; shapes: number }>
): string {
  const rows = boards.length
    ? boards
        .map(
          (b) =>
            `<li><a href="/?board=${encodeURIComponent(b.id)}">${esc(b.id)}</a>` +
            ` <span class="meta">${b.agents} agent(s), ${b.shapes} shape(s)</span></li>`
        )
        .join("\n")
    : `<li class="empty">No active boards. Ask an agent to draw something, then refresh.</li>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tldraw Planning Boards</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 20px; } ul { list-style: none; padding: 0; }
  li { padding: 10px 12px; border: 1px solid #eee; border-radius: 8px; margin: 8px 0; }
  a { font-weight: 600; text-decoration: none; color: #1558d6; }
  .meta { color: #888; font-size: 13px; margin-left: 8px; }
  .empty { color: #888; border-style: dashed; }
</style></head>
<body>
  <h1>Tldraw Planning Boards</h1>
  <p>Each board is a separate project. Open one to watch agents draw.</p>
  <ul>${rows}</ul>
</body></html>`;
}

export function renderCanvasPage(boardId: string): string {
  const board = JSON.stringify(boardId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Board: ${esc(boardId)}</title>
<link rel="stylesheet" href="https://esm.sh/@tldraw/tldraw@${TLDRAW}/tldraw.css" />
<style>
  html, body, #root { height: 100%; margin: 0; }
  #status {
    position: fixed; top: 8px; right: 8px; z-index: 1000;
    font: 12px/1.4 system-ui, sans-serif; padding: 4px 10px; border-radius: 999px;
    background: #eee; color: #444; box-shadow: 0 1px 3px rgba(0,0,0,.2);
  }
  #status.ok { background: #d5f5e3; color: #1e7e45; }
  #status.err { background: #fdecea; color: #b3261e; }
  #board { position: fixed; top: 8px; left: 8px; z-index: 1000;
    font: 12px/1.4 system-ui, sans-serif; padding: 4px 10px; border-radius: 999px;
    background: #222; color: #fff; }
</style>
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@${REACT}",
    "react/jsx-runtime": "https://esm.sh/react@${REACT}/jsx-runtime",
    "react/jsx-dev-runtime": "https://esm.sh/react@${REACT}/jsx-dev-runtime",
    "react-dom": "https://esm.sh/react-dom@${REACT}",
    "react-dom/client": "https://esm.sh/react-dom@${REACT}/client",
    "@tldraw/tldraw": "https://esm.sh/@tldraw/tldraw@${TLDRAW}?external=react,react-dom"
  }
}
</script>
</head>
<body>
<div id="board">board: ${esc(boardId)}</div>
<div id="status">connecting…</div>
<div id="root"></div>
<script type="module">
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Tldraw, createShapeId, toRichText } from "@tldraw/tldraw";

const BOARD = ${board};
const statusEl = document.getElementById("status");
const setStatus = (t, c) => { statusEl.textContent = t; statusEl.className = c || ""; };

// Per-agent shape-id namespace, so two agents' "step-1" don't collide.
const shapeIds = {};
const ns = (agentId, key) => (agentId || "anon") + ":" + key;

// Stable per-agent colour so you can see who drew what.
const PALETTE = ["blue","green","red","violet","orange","light-blue","yellow","light-green"];
function colorFor(agentId) {
  let h = 0; for (const ch of (agentId || "anon")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Graph model shapes: the daemon addresses everything by a stable logical id
// (node, frame, wireframe screen or part); we map each id to its tldraw shape
// id in ONE registry and UPSERT (move/relabel existing) so a relayout just
// repositions shapes rather than duplicating them. Arrows bind to any target.
const targets = {};     // logical id -> tldraw shape id
const edgeShapes = {};  // edgeId -> { sid, from, to }
const GEOS = ["rectangle","ellipse","diamond","triangle"];

// Upsert helper: reuse the existing tldraw shape for a logical id, else create.
function upsert(editor, id, type, x, y, props, onCreate) {
  let sid = targets[id];
  if (sid && editor.getShape(sid)) {
    editor.updateShape({ id: sid, type, x, y, props });
  } else {
    sid = createShapeId(); targets[id] = sid;
    editor.createShape({ id: sid, type, x, y, props });
    if (onCreate) onCreate(sid);
  }
  return sid;
}

// tldraw v3: createShape returns the editor (not an id), so we pre-generate ids;
// shape labels use richText (not a plain 'text' prop); arrows connect via
// bindings (not inline start/end shape refs).
function drawArrow(editor, fromShapeId, toShapeId, color, arrowType) {
  const arrowId = createShapeId();
  editor.createShape({ id: arrowId, type: "arrow", props: { color, bend: arrowType === "curved" ? 30 : 0 } });
  editor.createBindings([
    { fromId: arrowId, toId: fromShapeId, type: "arrow", props: { terminal: "start" } },
    { fromId: arrowId, toId: toShapeId, type: "arrow", props: { terminal: "end" } },
  ]);
}

function applyOperation(editor, op) {
  const agentId = op.agentId;
  const color = colorFor(agentId);
  switch (op.type) {
    case "createShape": {
      const { shapeType, x, y, width, height, text } = op.payload;
      const geo = ["rectangle","ellipse","triangle","diamond"].includes(shapeType) ? shapeType : "rectangle";
      const id = createShapeId();
      const props = { w: width, h: height, geo, color };
      if (text) props.richText = toRichText(text);
      editor.createShape({ id, type: "geo", x, y, props });
      if ("stepNumber" in op.payload) shapeIds[ns(agentId, "step-" + op.payload.stepNumber)] = id;
      break;
    }
    case "connectShapes": {
      const { fromId, toId, arrowType } = op.payload;
      const a = shapeIds[ns(agentId, fromId)], b = shapeIds[ns(agentId, toId)];
      if (a && b) drawArrow(editor, a, b, color, arrowType);
      break;
    }
    case "addText": {
      const { x, y, text } = op.payload;
      editor.createShape({ id: createShapeId(), type: "text", x, y, props: { richText: toRichText(text), color } });
      break;
    }
    case "createFlowchartStep": {
      const { stepNumber, title, description, x, y, connectToPrevious } = op.payload;
      const id = createShapeId();
      const label = title + (description ? "\\n" + description : "");
      editor.createShape({ id, type: "geo", x, y, props: { w: 160, h: 80, geo: "rectangle", color, richText: toRichText(label) } });
      shapeIds[ns(agentId, "step-" + stepNumber)] = id;
      if (connectToPrevious && stepNumber > 1) {
        const prev = shapeIds[ns(agentId, "step-" + (stepNumber - 1))];
        if (prev) drawArrow(editor, prev, id, color);
      }
      break;
    }
    case "requestSnapshot": {
      const { requestId } = op.payload;
      const snapshot = editor.store.getSnapshot();
      fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, snapshot }),
      }).catch(() => {});
      break;
    }

    // ---- graph model render ops (daemon-driven, addressed by id) ----
    case "node": {
      const { id, label, shape, color, x, y, w, h } = op.payload;
      const geo = GEOS.includes(shape) ? shape : "rectangle";
      // fill "solid" so status colours read at a glance and crossing arrows
      // don't show through the box
      upsert(editor, id, "geo", x, y, { w, h, geo, color, fill: "solid", richText: toRichText(label || id) });
      break;
    }
    case "shape": {
      // generic geo part (wireframes): the daemon decides geometry and style
      const { id, x, y, w, h, geo, color, fill, size, font, align, label, labelColor } = op.payload;
      const props = { w, h, geo: geo || "rectangle" };
      if (color) props.color = color;
      if (fill) props.fill = fill;
      if (size) props.size = size;
      if (font) props.font = font;
      if (align) props.align = align;
      if (labelColor) props.labelColor = labelColor;
      if (label) props.richText = toRichText(label);
      upsert(editor, id, "geo", x, y, props);
      break;
    }
    case "text": {
      const { id, x, y, w, size, font, color, align, label } = op.payload;
      const props = { richText: toRichText(label || ""), autoSize: false, w };
      if (size) props.size = size;
      if (font) props.font = font;
      if (color) props.color = color;
      if (align) props.textAlign = align;
      upsert(editor, id, "text", x, y, props);
      break;
    }
    case "edge": {
      const { id, from, to, label, kind } = op.payload;
      const a = targets[from], b = targets[to];
      if (!a || !b) break;
      const props = { color: "grey", kind: kind === "arc" ? "arc" : "elbow", ...(label ? { text: label } : {}) };
      const existing = edgeShapes[id];
      if (existing && editor.getShape(existing.sid)) {
        // bound arrow already follows the shapes; refresh label/kind only
        editor.updateShape({ id: existing.sid, type: "arrow", props });
        break;
      }
      const sid = createShapeId(); edgeShapes[id] = { sid, from, to };
      editor.createShape({ id: sid, type: "arrow", props });
      editor.createBindings([
        { fromId: sid, toId: a, type: "arrow", props: { terminal: "start" } },
        { fromId: sid, toId: b, type: "arrow", props: { terminal: "end" } },
      ]);
      break;
    }
    case "frame": {
      const { id, name, x, y, w, h } = op.payload;
      if (!(w > 0 && h > 0)) break;
      upsert(editor, id, "frame", x, y, { w, h, name }, (sid) => editor.sendToBack([sid]));
      break;
    }
    case "deleteNodes": {
      const ids = op.payload.ids || [];
      const kill = [];
      for (const nid of ids) {
        if (targets[nid]) { kill.push(targets[nid]); delete targets[nid]; }
      }
      for (const eid of Object.keys(edgeShapes)) {
        const e = edgeShapes[eid];
        if (ids.includes(e.from) || ids.includes(e.to)) { kill.push(e.sid); delete edgeShapes[eid]; }
      }
      if (kill.length) editor.deleteShapes(kill);
      break;
    }
    case "clearGraph": {
      const kill = [];
      for (const k of Object.keys(targets)) { kill.push(targets[k]); delete targets[k]; }
      for (const k of Object.keys(edgeShapes)) { kill.push(edgeShapes[k].sid); delete edgeShapes[k]; }
      if (kill.length) editor.deleteShapes(kill);
      break;
    }
    case "focus": {
      const sid = targets[op.payload.id];
      if (sid && editor.getShape(sid)) { editor.select(sid); editor.zoomToSelection(); }
      break;
    }

    default:
      console.warn("Unknown operation type:", op.type);
  }
}

function connect(editor) {
  const es = new EventSource("/api/tldraw-events?board=" + encodeURIComponent(BOARD));
  es.addEventListener("connected", () => setStatus("● connected", "ok"));
  es.addEventListener("tldraw-operation", (e) => {
    try { applyOperation(editor, JSON.parse(e.data)); }
    catch (err) { console.error("apply failed", err); }
  });
  es.onerror = () => setStatus("● reconnecting…", "err");
  // EventSource auto-reconnects; if the daemon restarts, the browser rejoins this
  // board and the daemon replays its backlog.
}

createRoot(document.getElementById("root")).render(
  createElement(Tldraw, { onMount: (editor) => { window.__editor = editor; connect(editor); } })
);
</script>
</body>
</html>`;
}
