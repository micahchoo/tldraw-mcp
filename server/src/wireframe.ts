// Wireframes: screens with a typed element vocabulary, laid out deterministically.
//
// A model describes a screen as a vertical stack of elements ("navbar, heading,
// two inputs, a button") — never coordinates. This module turns each element into
// concrete tldraw parts (geo/text shapes with absolute rects) using a simple
// stack layout: full-width rows top to bottom, an entry that is an ARRAY becomes
// one row of side-by-side cells, and a tabbar is pulled out of the flow and
// pinned to the screen's bottom edge. The screen grows to fit its content, so
// nothing can clip; every part is inside the screen rect by construction.
//
// Sizing note: text parts use tldraw's "sans" font at size "s"/"m" (18/24 px,
// line-height 1.35 — see tldraw's default-shape-constants). Estimates here only
// need to be generous, not exact: parts reserve the estimated height, and
// overflow within a part is impossible for geo labels (they centre in the box).

export type WireElementType =
  | "navbar"
  | "heading"
  | "text"
  | "button"
  | "input"
  | "search"
  | "image"
  | "list"
  | "avatar"
  | "divider"
  | "tabbar"
  | "checkbox"
  | "spacer";

export const WIRE_ELEMENT_TYPES: WireElementType[] = [
  "navbar", "heading", "text", "button", "input", "search", "image",
  "list", "avatar", "divider", "tabbar", "checkbox", "spacer",
];

export interface WireElementSpec {
  id: string; // globally unique; flow arrows can target it
  type: WireElementType;
  label?: string; // display text (title, placeholder, button caption…)
  lines?: number; // text: placeholder bars; list: row count
  items?: string[]; // list row labels / tabbar tab names
  h?: number; // height override (image, spacer)
}

export type WireDevice = "phone" | "tablet" | "desktop";

export interface WireScreen {
  id: string;
  name: string;
  device: WireDevice;
  rows: WireElementSpec[][]; // normalized: every entry is a row of 1+ cells
  // computed by layout (top-left + size of the screen frame):
  x: number;
  y: number;
  w: number;
  h: number;
}

// One drawable piece of an element. `id` is stable so the browser upserts —
// an element's FIRST part carries the element id itself (flow arrows bind to it).
export interface WirePart {
  kind: "geo" | "text";
  id: string;
  x: number; // relative to the screen's top-left; caller offsets by screen x/y
  y: number;
  w: number;
  h: number;
  geo?: string; // rectangle | ellipse | oval | x-box | check-box …
  color?: string;
  fill?: string; // none | semi | solid | pattern
  size?: string; // s | m | l | xl (font / stroke size style)
  font?: string;
  align?: string; // label horizontal align
  label?: string; // geo label or text content
  labelColor?: string;
}

const DEVICES: Record<WireDevice, { w: number; minH: number }> = {
  phone: { w: 390, minH: 700 },
  tablet: { w: 820, minH: 640 },
  desktop: { w: 1200, minH: 720 },
};

const PAD = 24; // screen edge padding
const GAP = 16; // vertical gap between rows / horizontal between cells
const BAR_H = 56; // navbar / tabbar / list row baseline

// Greedy word-wrap height estimate for a text part (sans font).
function textLines(label: string, w: number, fontPx: number): number {
  const charW = fontPx * 0.55;
  const perLine = Math.max(4, Math.floor(w / charW));
  const words = label.split(/\s+/);
  let lines = 1;
  let len = 0;
  for (const word of words) {
    if (len > 0 && len + 1 + word.length > perLine) {
      lines++;
      len = word.length;
    } else {
      len += (len > 0 ? 1 : 0) + word.length;
    }
  }
  return lines;
}

// Render one element into parts at (x, y) with cell width w.
// Returns the element's height; pushes parts onto `out`.
function renderElement(el: WireElementSpec, x: number, y: number, w: number, out: WirePart[]): number {
  const grey = "grey";
  const sans = "sans";
  switch (el.type) {
    case "navbar": {
      out.push({ kind: "geo", id: el.id, x, y, w, h: BAR_H, geo: "rectangle", color: "black", fill: "none", size: "s", font: sans, label: el.label ?? "Screen title" });
      out.push({ kind: "text", id: `${el.id}#menu`, x: x + 12, y: y + BAR_H / 2 - 12, w: 24, h: 24, size: "s", font: sans, color: "black", label: "≡" });
      return BAR_H;
    }
    case "heading": {
      const lines = textLines(el.label ?? "Heading", w, 24);
      const h = lines * 33; // 24px * 1.35
      out.push({ kind: "text", id: el.id, x, y, w, h, size: "m", font: sans, color: "black", align: "start", label: el.label ?? "Heading" });
      return h;
    }
    case "text": {
      if (el.label) {
        const lines = textLines(el.label, w, 18);
        const h = lines * 25;
        out.push({ kind: "text", id: el.id, x, y, w, h, size: "s", font: sans, color: "black", align: "start", label: el.label });
        return h;
      }
      // no copy yet: the classic grey placeholder bars, last one short
      const n = el.lines ?? 3;
      const widths = Array.from({ length: n }, (_, i) => (i === n - 1 ? 0.6 : 1));
      widths.forEach((f, i) => {
        out.push({ kind: "geo", id: i === 0 ? el.id : `${el.id}#${i}`, x, y: y + i * 18, w: w * f, h: 10, geo: "rectangle", color: grey, fill: "solid", size: "s" });
      });
      return n * 18 - 8;
    }
    case "button": {
      out.push({ kind: "geo", id: el.id, x, y, w, h: 44, geo: "rectangle", color: "black", fill: "solid", size: "s", font: sans, label: el.label ?? "Button" });
      return 44;
    }
    case "input": {
      out.push({ kind: "geo", id: el.id, x, y, w, h: 44, geo: "rectangle", color: grey, fill: "none", size: "s", font: sans, align: "start", label: el.label ?? "Input", labelColor: grey });
      return 44;
    }
    case "search": {
      out.push({ kind: "geo", id: el.id, x, y, w, h: 44, geo: "oval", color: grey, fill: "none", size: "s", font: sans, align: "start", label: `⌕ ${el.label ?? "Search"}`, labelColor: grey });
      return 44;
    }
    case "image": {
      const h = el.h ?? 160;
      out.push({ kind: "geo", id: el.id, x, y, w, h, geo: "x-box", color: grey, fill: "none", size: "s", font: sans, label: el.label });
      return h;
    }
    case "list": {
      const items = el.items ?? Array.from({ length: el.lines ?? 3 }, (_, i) => `Item ${i + 1}`);
      items.forEach((item, i) => {
        out.push({ kind: "geo", id: i === 0 ? el.id : `${el.id}#${i}`, x, y: y + i * (BAR_H - 8), w, h: BAR_H - 8, geo: "rectangle", color: grey, fill: "none", size: "s", font: sans, align: "start", label: item });
      });
      return items.length * (BAR_H - 8);
    }
    case "avatar": {
      const d = el.h ?? 56;
      out.push({ kind: "geo", id: el.id, x, y, w: d, h: d, geo: "ellipse", color: grey, fill: "none", size: "s", font: sans, label: el.label });
      return d;
    }
    case "divider": {
      out.push({ kind: "geo", id: el.id, x, y: y + 4, w, h: 4, geo: "rectangle", color: grey, fill: "solid", size: "s" });
      return 12;
    }
    case "checkbox": {
      out.push({ kind: "geo", id: el.id, x, y, w: 28, h: 28, geo: "check-box", color: "black", fill: "none", size: "s" });
      if (el.label) out.push({ kind: "text", id: `${el.id}#label`, x: x + 40, y: y + 2, w: w - 40, h: 25, size: "s", font: sans, color: "black", align: "start", label: el.label });
      return 28;
    }
    case "spacer":
      return el.h ?? 24;
    case "tabbar": {
      // handled out of flow by layoutScreen; if it appears in a cell, render inline
      const items = el.items ?? ["Home", "Search", "Profile"];
      out.push({ kind: "geo", id: el.id, x, y, w, h: BAR_H, geo: "rectangle", color: "black", fill: "none", size: "s" });
      const cell = w / items.length;
      items.forEach((item, i) => {
        out.push({ kind: "text", id: `${el.id}#${i}`, x: x + i * cell + 8, y: y + BAR_H / 2 - 12, w: cell - 16, h: 24, size: "s", font: sans, color: "black", align: "middle", label: item });
      });
      return BAR_H;
    }
  }
}

export interface ScreenLayout {
  w: number;
  h: number;
  parts: WirePart[]; // rects relative to the screen's top-left
}

// Stack-lay-out one screen: rows top to bottom, tabbars pinned to the bottom.
// The screen height grows to fit content, so elements can never clip.
export function layoutScreen(screen: Pick<WireScreen, "device" | "rows">): ScreenLayout {
  const device = DEVICES[screen.device] ?? DEVICES.phone;
  const w = device.w;
  const contentW = w - 2 * PAD;
  const parts: WirePart[] = [];

  const flowRows = screen.rows.filter((r) => !(r.length === 1 && r[0].type === "tabbar"));
  const tabbars = screen.rows.filter((r) => r.length === 1 && r[0].type === "tabbar").map((r) => r[0]);

  let y = PAD;
  for (const row of flowRows) {
    const cellW = (contentW - GAP * (row.length - 1)) / row.length;
    let rowH = 0;
    row.forEach((el, i) => {
      const h = renderElement(el, PAD + i * (cellW + GAP), y, cellW, parts);
      rowH = Math.max(rowH, h);
    });
    y += rowH + GAP;
  }
  let contentBottom = y - GAP + PAD;

  const tabbarSpace = tabbars.length * (BAR_H + GAP);
  let h = Math.max(device.minH, contentBottom + tabbarSpace);
  let ty = h - PAD - BAR_H * tabbars.length - GAP * (tabbars.length - 1 > 0 ? tabbars.length - 1 : 0);
  for (const tb of tabbars) {
    renderElement(tb, PAD, ty, contentW, parts);
    ty += BAR_H + GAP;
  }
  return { w, h, parts };
}

// Normalize the wire-format input (entries are element-or-row, ids optional)
// into rows of fully-specified elements with stable, unique ids.
export function normalizeScreen(
  screenId: string,
  name: string | undefined,
  device: string | undefined,
  elements: unknown[]
): { screen: Omit<WireScreen, "x" | "y" | "w" | "h">; error?: string } {
  const rows: WireElementSpec[][] = [];
  const seen = new Set<string>();
  let idx = 0;
  const one = (raw: any): WireElementSpec | string => {
    const type = String(raw?.type ?? "") as WireElementType;
    if (!WIRE_ELEMENT_TYPES.includes(type))
      return `unknown element type "${raw?.type}" — valid: ${WIRE_ELEMENT_TYPES.join(", ")}`;
    let id = raw.id ? String(raw.id) : `${screenId}/${type}-${idx}`;
    idx++;
    while (seen.has(id)) id = `${id}+`;
    seen.add(id);
    return {
      id,
      type,
      label: raw.label != null ? String(raw.label) : undefined,
      lines: raw.lines != null ? Number(raw.lines) : undefined,
      items: Array.isArray(raw.items) ? raw.items.map(String) : undefined,
      h: raw.h != null ? Number(raw.h) : undefined,
    };
  };
  for (const entry of elements ?? []) {
    const row = Array.isArray(entry) ? entry : [entry];
    const cells: WireElementSpec[] = [];
    for (const raw of row) {
      const el = one(raw);
      if (typeof el === "string") return { screen: { id: screenId, name: name ?? screenId, device: "phone", rows: [] }, error: el };
      cells.push(el);
    }
    if (cells.length) rows.push(cells);
  }
  const dev = (["phone", "tablet", "desktop"] as const).includes(device as WireDevice)
    ? (device as WireDevice)
    : "phone";
  return { screen: { id: screenId, name: name ?? screenId, device: dev, rows } };
}

// Every id inside a screen that a flow arrow may target (screen + elements).
export function screenTargetIds(screen: Pick<WireScreen, "id" | "rows">): string[] {
  return [screen.id, ...screen.rows.flat().map((el) => el.id)];
}

// Every tldraw shape id a screen contributes (frame + all parts), for deletion.
export function screenShapeIds(screen: Pick<WireScreen, "id" | "device" | "rows">): string[] {
  return [screen.id, ...layoutScreen(screen).parts.map((p) => p.id)];
}
