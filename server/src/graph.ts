// The graph model that makes the board useful for a small model + large plans.
//
// The daemon owns a per-board graph of named nodes and edges. A model works in
// *names and structure* ("connect auth to db"), never coordinates — this module
// runs dagre auto-layout to place everything, and turns the current graph into
// idempotent render operations the browser applies (upsert by node id). Status,
// grouping (frames), read-back, and bulk drawGraph all live here.

import dagre from "@dagrejs/dagre";
import type { TldrawOperation } from "./eventBus.js";
import {
  layoutScreen,
  normalizeScreen,
  screenShapeIds,
  screenTargetIds,
  type WireScreen,
} from "./wireframe.js";

export type NodeShape = "rectangle" | "ellipse" | "diamond" | "triangle";
export type NodeStatus = "none" | "todo" | "doing" | "done" | "blocked";
export type Direction = "TB" | "LR";

export interface GraphNode {
  id: string;
  label: string;
  shape: NodeShape;
  status: NodeStatus;
  group?: string;
  owner?: string; // which agent owns this node (an agentId), for multi-agent plans
  color?: string; // explicit override; otherwise derived from status
  w: number;
  h: number;
  x: number;
  y: number;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}
export interface GraphFrame {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  frames: Map<string, GraphFrame>;
  screens: Map<string, WireScreen>; // wireframe screens, laid out beside the graph
  direction?: Direction; // flow direction; defaults TB, or LR once screens exist
}

export function newGraph(): Graph {
  return { nodes: new Map(), edges: new Map(), frames: new Map(), screens: new Map() };
}

// Serialize/deserialize for persistence (Maps don't JSON round-trip on their own).
export function serialize(g: Graph) {
  return {
    nodes: [...g.nodes.values()],
    edges: [...g.edges.values()],
    frames: [...g.frames.values()],
    screens: [...g.screens.values()],
    ...(g.direction ? { direction: g.direction } : {}),
  };
}
export function deserialize(o: any): Graph {
  const g = newGraph();
  for (const n of o?.nodes ?? []) g.nodes.set(n.id, n);
  for (const e of o?.edges ?? []) g.edges.set(e.id, e);
  for (const f of o?.frames ?? []) g.frames.set(f.id, f);
  for (const s of o?.screens ?? []) g.screens.set(s.id, s);
  if (o?.direction === "TB" || o?.direction === "LR") g.direction = o.direction;
  return g;
}

// Every id an edge may reference: graph nodes, screens, and screen elements.
function allTargetIds(g: Graph): Set<string> {
  const ids = new Set<string>(g.nodes.keys());
  for (const s of g.screens.values()) for (const id of screenTargetIds(s)) ids.add(id);
  return ids;
}

const STATUS_COLOR: Record<NodeStatus, string> = {
  none: "blue",
  todo: "grey",
  doing: "orange",
  done: "green",
  blocked: "red",
};
const DEFAULT_W = 170;
const DEFAULT_H = 90;
const edgeKey = (from: string, to: string) => `${from}→${to}`;

// --- Label-aware node sizing ---
// tldraw renders geo labels at 22px ("m") with line-height 1.35 in the wide
// hand-drawn font, wraps them at the shape's width, and GROWS the shape (growY)
// when they don't fit — so if we lie to dagre about a node's size, the browser
// renders something bigger and shapes overlap. Instead we estimate the label's
// wrapped size here and hand dagre the truth. Estimates are deliberately
// generous; non-rectangles get inflated because their inscribed label area is
// smaller (a diamond's inner rectangle is ~half the bounding box).
const LABEL_LINE_H = 30; // 22px * 1.35, rounded up
const LABEL_CHAR_W = 13; // avg glyph width of the draw font at 22px
const WRAP_CHARS = 18; // target line length before wrapping
const SHAPE_INFLATE: Record<NodeShape, [number, number]> = {
  rectangle: [1, 1],
  ellipse: [1.3, 1.25],
  diamond: [1.5, 1.45],
  triangle: [1.6, 1.55],
};

// Greedy word-wrap: how tldraw will break the label, near enough.
export function wrapLabel(label: string, width = WRAP_CHARS): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines;
}

export function measureNode(label: string, shape: NodeShape): { w: number; h: number } {
  const lines = wrapLabel(label);
  const maxLine = Math.max(...lines.map((l) => l.length));
  const [fw, fh] = SHAPE_INFLATE[shape] ?? SHAPE_INFLATE.rectangle;
  const w = Math.max(DEFAULT_W, Math.ceil((maxLine * LABEL_CHAR_W + 44) * fw));
  const h = Math.max(DEFAULT_H, Math.ceil((lines.length * LABEL_LINE_H + 34) * fh));
  return { w, h };
}

export interface GraphCommand {
  command: string;
  [k: string]: unknown;
}

export interface CommandResult {
  removed: string[]; // node ids removed
  cleared: boolean;
  focus?: string;
  structural: boolean; // graph changed → relayout + re-render
  data?: unknown; // e.g. list output
  error?: string;
}

const R = (partial: Partial<CommandResult>): CommandResult => ({
  removed: [],
  cleared: false,
  structural: false,
  ...partial,
});

// Mutate the graph by one command. Unknown keys are ignored, so callers can
// spread request bodies straight in.
export function applyCommand(g: Graph, cmd: GraphCommand): CommandResult {
  switch (cmd.command) {
    case "addNode": {
      const id = String(cmd.id ?? cmd.label ?? "").trim();
      if (!id) return R({ error: "addNode requires id or label" });
      const prev = g.nodes.get(id);
      g.nodes.set(id, {
        id,
        label: String(cmd.label ?? prev?.label ?? id),
        shape: (cmd.shape as NodeShape) ?? prev?.shape ?? "rectangle",
        status: (cmd.status as NodeStatus) ?? prev?.status ?? "none",
        group: (cmd.group as string) ?? prev?.group,
        owner: (cmd.owner as string) ?? prev?.owner,
        color: (cmd.color as string) ?? prev?.color,
        w: prev?.w ?? DEFAULT_W,
        h: prev?.h ?? DEFAULT_H,
        x: prev?.x ?? 0,
        y: prev?.y ?? 0,
      });
      return R({ structural: true, data: { id } });
    }
    case "addEdge": {
      const from = String(cmd.from ?? "").trim();
      const to = String(cmd.to ?? "").trim();
      if (!from || !to) return R({ error: "addEdge requires from and to" });
      // auto-create endpoints so a model can connect freely — but REPORT it, so a
      // typo'd id surfaces as a surprise new node instead of a silent phantom.
      // Screen/element ids are already valid targets; never shadow them with nodes.
      const targets = allTargetIds(g);
      const created: string[] = [];
      if (!targets.has(from)) { applyCommand(g, { command: "addNode", id: from }); created.push(from); }
      if (!targets.has(to)) { applyCommand(g, { command: "addNode", id: to }); created.push(to); }
      g.edges.set(edgeKey(from, to), {
        id: edgeKey(from, to),
        from,
        to,
        label: cmd.label ? String(cmd.label) : undefined,
      });
      return R({ structural: true, data: created.length ? { created } : undefined });
    }
    case "drawGraph": {
      let removed: string[] = [];
      let cleared = false;
      if (cmd.replace) {
        removed = [...g.nodes.keys()];
        g.nodes.clear();
        g.edges.clear();
        g.frames.clear();
        cleared = true;
      }
      if (cmd.direction === "TB" || cmd.direction === "LR") g.direction = cmd.direction;
      for (const f of (cmd.frames as Record<string, unknown>[]) ?? [])
        applyCommand(g, { ...f, command: "createFrame" });
      for (const n of (cmd.nodes as Record<string, unknown>[]) ?? [])
        applyCommand(g, { ...n, command: "addNode" });
      for (const e of (cmd.edges as Record<string, unknown>[]) ?? [])
        applyCommand(g, { ...e, command: "addEdge" });
      return R({ removed, cleared, structural: true });
    }
    case "drawWireframe": {
      const removed: string[] = [];
      const errors: string[] = [];
      if (cmd.replace) {
        for (const s of g.screens.values()) {
          removed.push(...screenShapeIds(s));
          for (const t of screenTargetIds(s))
            for (const [k, e] of g.edges) if (e.from === t || e.to === t) g.edges.delete(k);
        }
        g.screens.clear();
      }
      for (const raw of (cmd.screens as Record<string, unknown>[]) ?? []) {
        const sid = String(raw.id ?? raw.name ?? "").trim();
        if (!sid) return R({ error: "each screen needs an id" });
        if (g.nodes.has(sid))
          return R({ error: `screen id "${sid}" collides with an existing graph node` });
        const { screen, error } = normalizeScreen(
          sid,
          raw.name as string | undefined,
          raw.device as string | undefined,
          (raw.elements as unknown[]) ?? []
        );
        if (error) return R({ error: `screen "${sid}": ${error}` });
        const prev = g.screens.get(sid);
        const next: WireScreen = { ...screen, x: prev?.x ?? 0, y: prev?.y ?? 0, w: 0, h: 0 };
        if (prev) {
          // element ids that vanished: delete their shapes and their edges
          const keep = new Set(screenShapeIds(next));
          const gone = screenShapeIds(prev).filter((id) => !keep.has(id));
          removed.push(...gone);
          const goneTargets = new Set(screenTargetIds(prev).filter((id) => !keep.has(id)));
          for (const [k, e] of g.edges)
            if (goneTargets.has(e.from) || goneTargets.has(e.to)) g.edges.delete(k);
        }
        g.screens.set(sid, next);
      }
      const targets = allTargetIds(g);
      for (const f of (cmd.flows as Record<string, unknown>[]) ?? []) {
        const from = String(f.from ?? "").trim();
        const to = String(f.to ?? "").trim();
        const missing = [from, to].filter((id) => !targets.has(id));
        if (missing.length) {
          errors.push(
            `flow ${from} → ${to}: unknown id(s) ${missing.join(", ")} — flows must reference a screen id, an element id, or a graph node`
          );
          continue;
        }
        g.edges.set(edgeKey(from, to), {
          id: edgeKey(from, to),
          from,
          to,
          label: f.label ? String(f.label) : undefined,
        });
      }
      return R({ removed, structural: true, error: errors.length ? errors.join("; ") : undefined });
    }
    case "updateNode": {
      const n = g.nodes.get(String(cmd.id));
      if (!n) return R({ error: `no such node: ${cmd.id}` });
      if (cmd.label != null) n.label = String(cmd.label);
      if (cmd.status != null) n.status = cmd.status as NodeStatus;
      if (cmd.color != null) n.color = String(cmd.color);
      if (cmd.shape != null) n.shape = cmd.shape as NodeShape;
      if (cmd.group != null) n.group = String(cmd.group);
      if (cmd.owner != null) n.owner = String(cmd.owner);
      return R({ structural: true });
    }
    case "setStatus": {
      const n = g.nodes.get(String(cmd.id));
      if (!n) return R({ error: `no such node: ${cmd.id}` });
      n.status = cmd.status as NodeStatus;
      return R({ structural: true });
    }
    case "assignNode": {
      const n = g.nodes.get(String(cmd.id));
      if (!n) return R({ error: `no such node: ${cmd.id}` });
      n.owner = cmd.owner ? String(cmd.owner) : undefined;
      return R({ structural: true });
    }
    case "removeNode": {
      const id = String(cmd.id);
      if (!g.nodes.delete(id)) {
        // not a node — maybe a wireframe screen: remove it whole (frame, parts, flows)
        const s = g.screens.get(id);
        if (!s) return R({ error: `no such node or screen: ${id}` });
        const removed = screenShapeIds(s);
        const targets = new Set(screenTargetIds(s));
        for (const [k, e] of g.edges) if (targets.has(e.from) || targets.has(e.to)) g.edges.delete(k);
        g.screens.delete(id);
        return R({ removed, structural: true });
      }
      for (const [k, e] of g.edges) if (e.from === id || e.to === id) g.edges.delete(k);
      return R({ removed: [id], structural: true });
    }
    case "removeEdge": {
      g.edges.delete(edgeKey(String(cmd.from), String(cmd.to)));
      return R({ structural: true });
    }
    case "clear": {
      const removed = [...g.nodes.keys()];
      for (const s of g.screens.values()) removed.push(...screenShapeIds(s));
      g.nodes.clear();
      g.edges.clear();
      g.frames.clear();
      g.screens.clear();
      return R({ removed, cleared: true });
    }
    case "createFrame": {
      const id = String(cmd.id ?? cmd.name ?? "").trim();
      if (!id) return R({ error: "createFrame requires id or name" });
      g.frames.set(id, { id, name: String(cmd.name ?? id), x: 0, y: 0, w: 0, h: 0 });
      return R({ structural: true });
    }
    case "focus":
      return R({ focus: String(cmd.id) });
    case "list":
      return R({ data: describe(g) });
    case "nextActionable":
      return R({ data: { ready: readySet(g, cmd.owner ? String(cmd.owner) : undefined) } });
    default:
      return R({ error: `unknown command: ${cmd.command}` });
  }
}

// The ready-set: nodes an agent can act on now — not done, not blocked, and every
// predecessor (incoming edge) is done. Roots (no predecessors) are ready. A node
// in a cycle simply never becomes ready (a predecessor stays not-done), so this
// can't hang. `owner` filters to one owner when node ownership exists.
export function readySet(g: Graph, owner?: string) {
  const preds = new Map<string, string[]>();
  for (const e of g.edges.values()) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to)!.push(e.from);
  }
  const ready: Array<{ id: string; label: string; status: NodeStatus }> = [];
  for (const n of g.nodes.values()) {
    if (n.status === "done" || n.status === "blocked") continue;
    // owner filter: show my nodes AND unowned ones (a shared pool anyone can grab)
    if (owner !== undefined && n.owner !== undefined && n.owner !== owner) continue;
    const ps = preds.get(n.id) ?? [];
    if (ps.every((from) => g.nodes.get(from)?.status === "done")) {
      ready.push({ id: n.id, label: n.label, status: n.status });
    }
  }
  return ready;
}

// Compact, model-friendly read-back — not the giant tldraw snapshot.
export function describe(g: Graph) {
  return {
    ...(g.direction ? { direction: g.direction } : {}),
    nodes: [...g.nodes.values()].map((n) => ({
      id: n.id,
      label: n.label,
      shape: n.shape,
      status: n.status,
      ...(n.group ? { group: n.group } : {}),
      ...(n.owner ? { owner: n.owner } : {}),
      x: Math.round(n.x),
      y: Math.round(n.y),
    })),
    edges: [...g.edges.values()].map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.label ? { label: e.label } : {}),
    })),
    frames: [...g.frames.values()].map((f) => ({ id: f.id, name: f.name })),
    ...(g.screens.size
      ? {
          screens: [...g.screens.values()].map((s) => ({
            id: s.id,
            name: s.name,
            device: s.device,
            x: Math.round(s.x),
            y: Math.round(s.y),
            elements: s.rows.map((row) =>
              row.map((el) => ({ id: el.id, type: el.type, ...(el.label ? { label: el.label } : {}) }))
            ),
          })),
        }
      : {}),
  };
}

// Which dagre node an edge endpoint belongs to: itself for nodes/screens, the
// owning screen for elements inside one (an arrow from a button pulls its
// whole screen into the flow).
function dagreAnchor(g: Graph, id: string, elementOwner: Map<string, string>): string | undefined {
  if (g.nodes.has(id) || g.screens.has(id)) return id;
  return elementOwner.get(id);
}

// Auto-layout with dagre, in TWO passes: one for the task graph (nodes/frames),
// one for wireframe screens. A single pass would put ~850px-tall screens in the
// same ranks as 90px nodes and blow the whole chart's spacing apart; instead the
// screen block is laid out on its own and stacked below the graph block. Node
// sizes come from their labels (see measureNode), screens from their stack
// layout — dagre always sees true sizes, so nothing overlaps.
export function layout(g: Graph): void {
  if (g.nodes.size === 0 && g.screens.size === 0) return;

  // Pass 1: the task graph.
  let graphBottom = 0;
  if (g.nodes.size > 0) {
    const G = new dagre.graphlib.Graph({ compound: true });
    G.setGraph({ rankdir: g.direction ?? "TB", nodesep: 60, ranksep: 90, marginx: 40, marginy: 40 });
    G.setDefaultEdgeLabel(() => ({}));
    for (const f of g.frames.values()) G.setNode(`frame:${f.id}`, { label: f.name } as any);
    for (const n of g.nodes.values()) {
      const size = measureNode(n.label, n.shape);
      n.w = size.w;
      n.h = size.h;
      G.setNode(n.id, { width: n.w, height: n.h });
      if (n.group && g.frames.has(n.group)) G.setParent(n.id, `frame:${n.group}`);
    }
    for (const e of g.edges.values())
      if (g.nodes.has(e.from) && g.nodes.has(e.to)) G.setEdge(e.from, e.to);
    dagre.layout(G);
    for (const n of g.nodes.values()) {
      const p = G.node(n.id);
      if (p) {
        n.x = p.x - n.w / 2; // dagre gives centers; tldraw wants top-left
        n.y = p.y - n.h / 2;
      }
      graphBottom = Math.max(graphBottom, n.y + n.h);
    }
    for (const f of g.frames.values()) {
      const p = G.node(`frame:${f.id}`) as { x: number; y: number; width: number; height: number } | undefined;
      if (p) {
        f.x = p.x - p.width / 2;
        f.y = p.y - p.height / 2;
        f.w = p.width;
        f.h = p.height;
        graphBottom = Math.max(graphBottom, f.y + f.h);
      }
    }
  }

  // Pass 2: the screens, flowing left-to-right (reading order for a user flow),
  // offset below the task graph if there is one.
  if (g.screens.size > 0) {
    const S = new dagre.graphlib.Graph();
    S.setGraph({ rankdir: g.direction ?? "LR", nodesep: 80, ranksep: 120, marginx: 40, marginy: 40 });
    S.setDefaultEdgeLabel(() => ({}));
    const elementOwner = new Map<string, string>();
    for (const s of g.screens.values()) {
      const l = layoutScreen(s);
      s.w = l.w;
      s.h = l.h;
      S.setNode(s.id, { width: s.w + 20, height: s.h + 40 }); // room for the frame title
      for (const id of screenTargetIds(s)) if (id !== s.id) elementOwner.set(id, s.id);
    }
    for (const e of g.edges.values()) {
      const a = dagreAnchor(g, e.from, elementOwner);
      const b = dagreAnchor(g, e.to, elementOwner);
      if (a && b && a !== b && g.screens.has(a) && g.screens.has(b)) S.setEdge(a, b);
    }
    dagre.layout(S);
    const offsetY = graphBottom > 0 ? graphBottom + 160 : 0;
    for (const s of g.screens.values()) {
      const p = S.node(s.id);
      if (p) {
        s.x = p.x - s.w / 2;
        s.y = p.y - s.h / 2 + offsetY;
      }
    }
  }
}

const nodeColor = (n: GraphNode) => n.color || STATUS_COLOR[n.status] || "blue";

// The current graph as idempotent render ops (frames behind, then screens and
// their parts, then nodes, then edges — endpoints always exist before an edge
// references them). The browser upserts by id, so re-sending after a relayout
// just moves shapes to their new positions.
export function renderOps(g: Graph): TldrawOperation[] {
  const ops: TldrawOperation[] = [];
  for (const f of g.frames.values())
    ops.push({ type: "frame", payload: { id: f.id, name: f.name, x: f.x, y: f.y, w: f.w, h: f.h } });
  for (const s of g.screens.values()) {
    ops.push({ type: "frame", payload: { id: s.id, name: s.name, x: s.x, y: s.y, w: s.w, h: s.h } });
    for (const p of layoutScreen(s).parts) {
      const payload = { ...p, x: s.x + p.x, y: s.y + p.y };
      ops.push({ type: p.kind === "text" ? "text" : "shape", payload });
    }
  }
  for (const n of g.nodes.values())
    ops.push({
      type: "node",
      payload: { id: n.id, label: n.label, shape: n.shape, status: n.status, color: nodeColor(n), x: n.x, y: n.y, w: n.w, h: n.h },
    });
  for (const e of g.edges.values())
    ops.push({ type: "edge", payload: { id: e.id, from: e.from, to: e.to, label: e.label || "", kind: "elbow" } });
  return ops;
}
