// The graph model that makes the board useful for a small model + large plans.
//
// The daemon owns a per-board graph of named nodes and edges. A model works in
// *names and structure* ("connect auth to db"), never coordinates — this module
// runs dagre auto-layout to place everything, and turns the current graph into
// idempotent render operations the browser applies (upsert by node id). Status,
// grouping (frames), read-back, and bulk drawGraph all live here.

import dagre from "@dagrejs/dagre";
import type { TldrawOperation } from "./eventBus.js";

export type NodeShape = "rectangle" | "ellipse" | "diamond" | "triangle";
export type NodeStatus = "none" | "todo" | "doing" | "done" | "blocked";

export interface GraphNode {
  id: string;
  label: string;
  shape: NodeShape;
  status: NodeStatus;
  group?: string;
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
}

export function newGraph(): Graph {
  return { nodes: new Map(), edges: new Map(), frames: new Map() };
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
      const created: string[] = [];
      if (!g.nodes.has(from)) { applyCommand(g, { command: "addNode", id: from }); created.push(from); }
      if (!g.nodes.has(to)) { applyCommand(g, { command: "addNode", id: to }); created.push(to); }
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
      for (const f of (cmd.frames as Record<string, unknown>[]) ?? [])
        applyCommand(g, { ...f, command: "createFrame" });
      for (const n of (cmd.nodes as Record<string, unknown>[]) ?? [])
        applyCommand(g, { ...n, command: "addNode" });
      for (const e of (cmd.edges as Record<string, unknown>[]) ?? [])
        applyCommand(g, { ...e, command: "addEdge" });
      return R({ removed, cleared, structural: true });
    }
    case "updateNode": {
      const n = g.nodes.get(String(cmd.id));
      if (!n) return R({ error: `no such node: ${cmd.id}` });
      if (cmd.label != null) n.label = String(cmd.label);
      if (cmd.status != null) n.status = cmd.status as NodeStatus;
      if (cmd.color != null) n.color = String(cmd.color);
      if (cmd.shape != null) n.shape = cmd.shape as NodeShape;
      if (cmd.group != null) n.group = String(cmd.group);
      return R({ structural: true });
    }
    case "setStatus": {
      const n = g.nodes.get(String(cmd.id));
      if (!n) return R({ error: `no such node: ${cmd.id}` });
      n.status = cmd.status as NodeStatus;
      return R({ structural: true });
    }
    case "removeNode": {
      const id = String(cmd.id);
      if (!g.nodes.delete(id)) return R({ error: `no such node: ${id}` });
      for (const [k, e] of g.edges) if (e.from === id || e.to === id) g.edges.delete(k);
      return R({ removed: [id], structural: true });
    }
    case "removeEdge": {
      g.edges.delete(edgeKey(String(cmd.from), String(cmd.to)));
      return R({ structural: true });
    }
    case "clear": {
      const removed = [...g.nodes.keys()];
      g.nodes.clear();
      g.edges.clear();
      g.frames.clear();
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
    default:
      return R({ error: `unknown command: ${cmd.command}` });
  }
}

// Compact, model-friendly read-back — not the giant tldraw snapshot.
export function describe(g: Graph) {
  return {
    nodes: [...g.nodes.values()].map((n) => ({
      id: n.id,
      label: n.label,
      shape: n.shape,
      status: n.status,
      ...(n.group ? { group: n.group } : {}),
      x: Math.round(n.x),
      y: Math.round(n.y),
    })),
    edges: [...g.edges.values()].map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.label ? { label: e.label } : {}),
    })),
    frames: [...g.frames.values()].map((f) => ({ id: f.id, name: f.name })),
  };
}

// Auto-layout with dagre. Nodes get non-overlapping positions; frames are sized
// to their contained nodes (dagre compound clusters).
export function layout(g: Graph): void {
  if (g.nodes.size === 0) return;
  const G = new dagre.graphlib.Graph({ compound: true });
  G.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 90, marginx: 40, marginy: 40 });
  G.setDefaultEdgeLabel(() => ({}));
  for (const f of g.frames.values()) G.setNode(`frame:${f.id}`, { label: f.name } as any);
  for (const n of g.nodes.values()) {
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
  }
  for (const f of g.frames.values()) {
    const p = G.node(`frame:${f.id}`) as { x: number; y: number; width: number; height: number } | undefined;
    if (p) {
      f.x = p.x - p.width / 2;
      f.y = p.y - p.height / 2;
      f.w = p.width;
      f.h = p.height;
    }
  }
}

const nodeColor = (n: GraphNode) => n.color || STATUS_COLOR[n.status] || "blue";

// The current graph as idempotent render ops (frames behind, then nodes, then
// edges). The browser upserts by id, so re-sending after a relayout just moves
// shapes to their new positions.
export function renderOps(g: Graph): TldrawOperation[] {
  const ops: TldrawOperation[] = [];
  for (const f of g.frames.values())
    ops.push({ type: "frame", payload: { id: f.id, name: f.name, x: f.x, y: f.y, w: f.w, h: f.h } });
  for (const n of g.nodes.values())
    ops.push({
      type: "node",
      payload: { id: n.id, label: n.label, shape: n.shape, status: n.status, color: nodeColor(n), x: n.x, y: n.y, w: n.w, h: n.h },
    });
  for (const e of g.edges.values())
    ops.push({ type: "edge", payload: { id: e.id, from: e.from, to: e.to, label: e.label || "" } });
  return ops;
}
