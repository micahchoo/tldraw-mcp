// Headless tests for the two board qualities that matter:
//   flowcharts — nodes sized to their labels, laid out without overlap;
//   wireframes — every element inside its screen, screens never colliding.
// Run: npm test (tsx --test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newGraph,
  applyCommand,
  layout,
  renderOps,
  describe,
  serialize,
  deserialize,
  measureNode,
  wrapLabel,
} from "../src/graph.js";
import { layoutScreen, normalizeScreen } from "../src/wireframe.js";

interface Rect { x: number; y: number; w: number; h: number }
const overlaps = (a: Rect, b: Rect, slack = 0) =>
  a.x + slack < b.x + b.w && b.x + slack < a.x + a.w && a.y + slack < b.y + b.h && b.y + slack < a.y + a.h;

// ---- node sizing ----

test("measureNode grows with the label and never shrinks below the default", () => {
  const short = measureNode("Auth", "rectangle");
  assert.ok(short.w >= 170 && short.h >= 90);
  const long = measureNode(
    "Reconcile the invoice ledger against the payment provider export and flag mismatches",
    "rectangle"
  );
  assert.ok(long.w > short.w, "long labels need wider boxes");
  assert.ok(long.h > short.h, "wrapped labels need taller boxes");
  // sanity: the estimated box must hold the wrapped text at 22px/1.35
  const lines = wrapLabel("Reconcile the invoice ledger against the payment provider export and flag mismatches");
  assert.ok(long.h >= lines.length * 30, "one 30px line-height row per wrapped line");
});

test("diamonds inflate beyond rectangles for the same label", () => {
  const rect = measureNode("Is the user already registered?", "rectangle");
  const diamond = measureNode("Is the user already registered?", "diamond");
  assert.ok(diamond.w > rect.w && diamond.h > rect.h);
});

// ---- flowchart layout ----

test("layout produces no overlapping nodes, even with long labels and skip edges", () => {
  const g = newGraph();
  const labels = [
    "Start",
    "Validate the uploaded CSV file against the schema and reject rows with missing columns",
    "Is the file valid?",
    "Show a detailed validation error report to the user",
    "Import rows into the staging table",
    "Deduplicate against existing records using fuzzy name matching",
    "Any conflicts detected?",
    "Open the manual conflict resolution queue",
    "Commit the batch",
    "Notify subscribers via webhook and email digest",
    "Done",
  ];
  labels.forEach((label, i) =>
    applyCommand(g, {
      command: "addNode",
      id: `n${i}`,
      label,
      shape: label.endsWith("?") ? "diamond" : "rectangle",
    })
  );
  for (let i = 0; i + 1 < labels.length; i++)
    applyCommand(g, { command: "addEdge", from: `n${i}`, to: `n${i + 1}` });
  // skip edges and a back edge — the classic sources of tangled arrows
  applyCommand(g, { command: "addEdge", from: "n2", to: "n0", label: "retry" });
  applyCommand(g, { command: "addEdge", from: "n2", to: "n8", label: "fast path" });
  applyCommand(g, { command: "addEdge", from: "n6", to: "n8", label: "no" });

  layout(g);
  const nodes = [...g.nodes.values()];
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      assert.ok(
        !overlaps(nodes[i], nodes[j]),
        `${nodes[i].id} overlaps ${nodes[j].id}`
      );
  // every node box actually fits its measured label
  for (const n of nodes) {
    const m = measureNode(n.label, n.shape);
    assert.equal(n.w, m.w);
    assert.equal(n.h, m.h);
  }
});

test("edges render as elbow arrows", () => {
  const g = newGraph();
  applyCommand(g, { command: "addEdge", from: "a", to: "b" });
  layout(g);
  const edge = renderOps(g).find((op) => op.type === "edge") as any;
  assert.equal(edge.payload.kind, "elbow");
});

test("drawGraph honors direction and persists it", () => {
  const g = newGraph();
  applyCommand(g, { command: "drawGraph", nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }], direction: "LR" });
  layout(g);
  const a = g.nodes.get("a")!;
  const b = g.nodes.get("b")!;
  assert.ok(b.x > a.x + a.w - 1, "LR puts the successor to the right");
  const round = deserialize(serialize(g));
  assert.equal(round.direction, "LR");
});

// ---- wireframes ----

const LOGIN_ELEMENTS = [
  { type: "navbar", label: "Welcome" },
  { type: "heading", label: "Sign in to your account" },
  { type: "text", label: "Use the email address you registered with." },
  { type: "input", label: "Email" },
  { type: "input", label: "Password" },
  [{ type: "checkbox", label: "Remember me" }, { type: "button", id: "login-btn", label: "Sign in" }],
  { type: "divider" },
  { type: "image", h: 120 },
  { type: "list", items: ["Continue with Google", "Continue with GitHub"] },
  { type: "tabbar", items: ["Home", "Search", "Profile"] },
];

test("every wireframe part stays inside its screen", () => {
  const { screen, error } = normalizeScreen("login", "Login", "phone", LOGIN_ELEMENTS);
  assert.equal(error, undefined);
  const l = layoutScreen(screen);
  for (const p of l.parts) {
    assert.ok(p.x >= 0 && p.y >= 0, `${p.id} above/left of the screen`);
    assert.ok(p.x + p.w <= l.w + 0.5, `${p.id} sticks out right (${p.x + p.w} > ${l.w})`);
    assert.ok(p.y + p.h <= l.h + 0.5, `${p.id} sticks out below (${p.y + p.h} > ${l.h})`);
  }
});

test("wireframe elements do not overlap each other", () => {
  const { screen } = normalizeScreen("login", "Login", "phone", LOGIN_ELEMENTS);
  const l = layoutScreen(screen);
  // main parts only — sub-parts (#suffix) sit inside their element by design
  const mains = l.parts.filter((p) => !p.id.includes("#"));
  for (let i = 0; i < mains.length; i++)
    for (let j = i + 1; j < mains.length; j++)
      assert.ok(!overlaps(mains[i], mains[j]), `${mains[i].id} overlaps ${mains[j].id}`);
});

test("tabbar pins to the bottom edge of the screen", () => {
  const { screen } = normalizeScreen("s", undefined, "phone", [
    { type: "heading", label: "Hi" },
    { type: "tabbar", id: "tabs" },
  ]);
  const l = layoutScreen(screen);
  const tabbar = l.parts.find((p) => p.id === "tabs")!;
  assert.ok(tabbar.y + tabbar.h >= l.h - 30, "tabbar sits at the bottom");
});

test("a screen grows to fit tall content instead of clipping", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ type: "input", label: `Field ${i}` }));
  const { screen } = normalizeScreen("form", undefined, "phone", many);
  const l = layoutScreen(screen);
  const bottom = Math.max(...l.parts.map((p) => p.y + p.h));
  assert.ok(l.h >= bottom, "screen height covers the last element");
  assert.ok(l.h > 700, "grew past the phone's default height");
});

test("screens lay out without colliding, and flows connect elements to screens", () => {
  const g = newGraph();
  const r = applyCommand(g, {
    command: "drawWireframe",
    screens: [
      { id: "login", name: "Login", elements: LOGIN_ELEMENTS },
      { id: "home", name: "Home", elements: [{ type: "navbar" }, { type: "list" }] },
    ],
    flows: [{ from: "login-btn", to: "home", label: "on success" }],
  });
  assert.equal(r.error, undefined);
  layout(g);
  const screens = [...g.screens.values()];
  assert.ok(!overlaps(screens[0], screens[1]), "screens overlap");
  const ops = renderOps(g);
  const edge = ops.find((op) => op.type === "edge") as any;
  assert.equal(edge.payload.from, "login-btn");
  assert.equal(edge.payload.to, "home");
  // parts are emitted in absolute coordinates inside their screen's frame
  const frames = ops.filter((op) => op.type === "frame") as any[];
  const login = frames.find((f) => f.payload.id === "login")!.payload;
  const part = ops.find((op) => (op as any).payload.id === "login-btn") as any;
  assert.ok(part.payload.x >= login.x && part.payload.x + part.payload.w <= login.x + login.w + 0.5);
});

test("flows to unknown ids error instead of creating phantom nodes", () => {
  const g = newGraph();
  const r = applyCommand(g, {
    command: "drawWireframe",
    screens: [{ id: "a", elements: [{ type: "button", id: "go" }] }],
    flows: [{ from: "go", to: "nowhere" }],
  });
  assert.ok(r.error?.includes("nowhere"));
  assert.ok(!g.nodes.has("nowhere"), "no phantom node");
});

test("addEdge between a wireframe element and a node creates no shadow node", () => {
  const g = newGraph();
  applyCommand(g, {
    command: "drawWireframe",
    screens: [{ id: "s", elements: [{ type: "button", id: "cta" }] }],
  });
  const r = applyCommand(g, { command: "addEdge", from: "cta", to: "task-1" });
  assert.ok(!g.nodes.has("cta"), "element id must not become a node");
  assert.deepEqual((r.data as any)?.created, ["task-1"]);
});

test("redrawing a screen removes vanished elements and their flows", () => {
  const g = newGraph();
  applyCommand(g, {
    command: "drawWireframe",
    screens: [{ id: "s", elements: [{ type: "button", id: "old-btn" }, { type: "input", id: "keep" }] }],
    flows: [{ from: "old-btn", to: "keep" }],
  });
  const r = applyCommand(g, {
    command: "drawWireframe",
    screens: [{ id: "s", elements: [{ type: "input", id: "keep" }] }],
  });
  assert.ok(r.removed.includes("old-btn"), "vanished element reported for deletion");
  assert.equal(g.edges.size, 0, "its flow went with it");
});

test("removeNode on a screen id removes the screen, its parts, and its flows", () => {
  const g = newGraph();
  applyCommand(g, {
    command: "drawWireframe",
    screens: [
      { id: "a", elements: [{ type: "button", id: "go" }] },
      { id: "b", elements: [{ type: "navbar" }] },
    ],
    flows: [{ from: "go", to: "b" }],
  });
  const r = applyCommand(g, { command: "removeNode", id: "a" });
  assert.ok(r.removed.includes("a") && r.removed.includes("go"));
  assert.ok(!g.screens.has("a"));
  assert.equal(g.edges.size, 0);
});

test("describe covers screens and serialize round-trips them", () => {
  const g = newGraph();
  applyCommand(g, {
    command: "drawWireframe",
    screens: [{ id: "login", name: "Login", device: "desktop", elements: LOGIN_ELEMENTS }],
  });
  layout(g);
  const d = describe(g) as any;
  assert.equal(d.screens.length, 1);
  assert.equal(d.screens[0].device, "desktop");
  assert.ok(d.screens[0].elements.flat().some((el: any) => el.id === "login-btn"));

  const round = deserialize(serialize(g));
  assert.equal(round.screens.size, 1);
  layout(round);
  assert.deepEqual(describe(round), d);
});

test("bad element types are rejected with the valid vocabulary", () => {
  const g = newGraph();
  const r = applyCommand(g, {
    command: "drawWireframe",
    screens: [{ id: "s", elements: [{ type: "carousel" }] }],
  });
  assert.ok(r.error?.includes("carousel") && r.error?.includes("navbar"));
});
