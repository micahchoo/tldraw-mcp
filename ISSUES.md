# ISSUES.md — tend backlog

Provenance: generated 2026-07-11, commit `bf5a9f0` + uncommitted graph-tools build.
Scope: the MCP tool surface (`server/src/index.ts`, `graph.ts`, `canvasPage.ts`) judged by
one lens — **usefulness to a small model that cannot see the canvas**. A blind model lives on
tool-result text and read-back; a small model needs few, consistent, forgiving tools.

Ladder observations (evidence):
- **L1 friction**: README frames purpose as "Claude creates/manipulates diagrams" — assumes a
  vision-in-the-loop human; nothing provides the blind driver a way to *verify*. **L1 surplus**:
  the daemon models a full plan (nodes/edges/status/frames/layout) — a queryable domain richer
  than "diagrams."
- **L2 friction**: read-back (`describeBoard`→`graph.describe`) reports only the graph registry;
  `createShape`/`addText`/`connectShapes`/`createFlowchartStep` write to the backlog
  (`index.ts` postOperation @183/205/227/255) and are invisible to it. **L2 surplus**:
  `getSnapshot` captures everything but returns raw tldraw JSON — no small-model consumer.
- **L3 friction**: three ways to make connected boxes (createShape+connectShapes /
  createFlowchartStep / addNode+addEdge+drawGraph). **L3 surplus**: low-level geometric tools now
  superseded by the graph tools, kept as an "escape hatch" (README).
- **L4 friction**: `connectShapes` returns success while the browser silently no-ops on unknown
  ids (`canvasPage.ts` `if (a && b)`); daemon catch-path returns `{error}` but tools read
  `r.errors` → "Error: undefined" (`daemon.ts:335` vs `index.ts:393`); `addEdge` auto-creates
  phantom nodes on a typo with no feedback (`graph.ts` addEdge). **L4 surplus**: `GraphNode` holds
  shape/group/color/x/y but `describe()` drops shape/x/y/color and there's no `getNode(id)`.

---

## Issues

### 1. Read-back doesn't cover the write surface — a blind model can't confirm low-level draws
- **Evidence** — `graph.describe()` iterates only `g.nodes/edges/frames`; `createShape`, `addText`,
  `connectShapes`, `createFlowchartStep` post to `/api/operation` (backlog), never the registry
  (`index.ts:183,205,227,255`). So `describeBoard` cannot see anything drawn with the low-level
  tools. `describeBoard` also omits the board id, so the model doesn't know which board it's on.
- **Rungs** — L2↔L1: behavior (partial read-back) fails the purpose of a *blind* driver.
- **Why high-leverage** — read-back is the blind model's only sense; a write it can't observe is a
  write it can't trust or build on. Fixing this makes every low-level tool safe to use blind.
  **Lesson**: characterization for agents — the read surface must cover the write surface, or the
  agent is flying blind on its own actions.
- **Loop** —
  ```
  Go over every MCP tool in server/src/index.ts. Ledger ledgers/READBACK.md: tool | what it writes |
  can a non-vision model confirm the effect via describeBoard or the tool's own result text? | gap |
  fix commit | retest. First pass: for each tool record whether its effect is observable to a blind
  model — no fixing; a second full pass must add no rows. Then fix so every write is reflected in
  describeBoard (unify free-form writes into the graph model, or have describeBoard also report
  free-form shapes) and describeBoard names the current board; commit per row. Retest each by
  calling the tool then describeBoard in a headless run and confirming the effect shows. Done when
  every tool's effect is confirmable without seeing the canvas.
  ```
- **Strength** — Strong (two signals: `describe()` omission + `describeBoard` has no board id).
- **Status** — done 2026-07-11 — ledgers/READBACK.md (daemon tracks free-form; describeBoard reports board+graph+free-form)

### 2. Silent and false confirmations — tools report success when nothing happened
- **Evidence** — `connectShapes` browser handler `if (a && b) drawArrow(...)` no-ops on unknown
  ids, but `index.ts` connectShapes always returns "Connected shape X to Y". `addEdge` auto-creates
  missing endpoints (`graph.ts`) so a typo becomes a phantom node, unreported. Daemon catch-path
  returns `{ok:false, error}` (`daemon.ts:335`) while tools read `r.errors?.join` (`index.ts:393`)
  → "Error: undefined". Mutations echo no resulting state, forcing a follow-up `describeBoard`.
- **Rungs** — L4↔L2: implementation feedback undermines observable behavior.
- **Why high-leverage** — a false "success" is worse than an error: a blind model builds on a state
  that doesn't exist. Every tool result is this model's only ground truth. **Lesson**: observability
  — a swallowed or falsified failure still happened; you've agreed to learn about it from the model's
  next wrong move.
- **Loop** —
  ```
  Find every MCP tool path in server/src/index.ts and server/src/canvasPage.ts where a failure or
  no-op can occur without the calling model being told: connectShapes to an unknown id (browser
  no-ops, tool returns success), addEdge auto-creating a phantom node on a typo, daemon catch-path
  {error} read as r.errors (→ "Error: undefined"), mutations that echo no resulting state. Ledger
  ledgers/SILENCE.md: site | trigger | what the model is told today | should be told | fix commit |
  forced check. Classify each unhandled/false-positive/undefined/thin, fixing nothing; then fix so
  every failure or no-op returns actionable text (connectShapes reports which ids were unknown;
  addEdge says it created endpoints; error text never empty; mutations echo the resulting node/edge
  count). Force each once in a headless dev run and confirm the message. Done when no tool reports
  success for a no-op and no error text is empty or "undefined".
  ```
- **Strength** — Strong (three verified sites: connectShapes, undefined-error, phantom node).
- **Status** — done 2026-07-11 — ledgers/SILENCE.md

### 3. Three overlapping ways to make connected boxes — canonicalize for a small model
- **Evidence** — `index.ts` exposes createShape+connectShapes, createFlowchartStep, and
  addNode+addEdge+drawGraph, all for "boxes with arrows." `connectShapes` uses an obscure "step-N"
  convention that only resolves flowchart-step ids. 19 tools total; a small model must choose among
  redundant, inconsistent surfaces.
- **Rungs** — L3↔L1: structure (three implementations) taxes the small-model purpose (few, clear
  tools).
- **Why high-leverage** — every second way to do the same job doubles the ways a small model picks
  wrong. Collapsing to the graph model (addressable, auto-laid-out, queryable) shrinks and
  regularizes the surface. **Lesson**: canonicalization, one way to do each thing.
- **Loop** —
  ```
  This server offers three ways to make connected boxes: createShape+connectShapes,
  createFlowchartStep, and addNode/addEdge/drawGraph. Pick the graph tools as canonical. Ledger
  ledgers/CANON.md: losing tool/path | file | deprecated or wrapped | tests green. Enumerate every
  low-level draw tool first; then per row either remove it from the tool list, or re-express it as a
  thin wrapper over the graph registry so its output is addressable and shows in describeBoard.
  Migrate under the headless graph tests, commit per row. At one canonical node/edge path, record in
  CLAUDE.md: new drawing goes through the graph model. Done at one canonical path and the rule locked.
  ```
- **Strength** — Worth exploring (one structural signal; "fewer tools" partly a judgment call).
- **Status** — queued

---

## Directions

### D1. `getSnapshot` and `focusOn` — operations with no non-vision consumer
- **Surplus** — `getSnapshot` returns a raw tldraw snapshot (machine JSON, no small-model use);
  `focusOn` pans a human's browser (no effect a blind model can observe). Both are built and reachable
  but serve no blind-driver path.
- **Rungs** — L2 over-provides (operations exist) → L1 under-delivers for a non-vision user.
- **Who feels it** — a blind model that calls `getSnapshot` gets an unreadable blob; a small model
  that calls `focusOn` gets a no-op it can't perceive.
- **Intent** — `getSnapshot` predates the graph read-back (git: original tool set); `focusOn`
  designed-latent for human viewers. Read from git/comments in the loop.
- **Loop** —
  ```
  List every MCP tool a non-vision model can call and record its usefulness to a blind driver. Ledger
  ledgers/CAPABILITY.md: operation | defined at | non-vision user path | consumer | class
  (reachable / human-only / machine-only) | intent | verdict | commissioned as. Focus on operations
  whose only consumer is a human viewer (focusOn) or a raw machine blob (getSnapshot): class them,
  read intent from comments and git. Build nothing, remove nothing. Done when every tool is classified
  and each human-only/machine-only row holds its intent.
  ```
- **Strength** — Worth exploring.
- **Status** — done 2026-07-11 (classified) — ledgers/CAPABILITY.md

### D2. Dark node fields — the graph stores shape/position/color but read-back drops them
- **Surplus** — `GraphNode` carries `shape`, `group`, `color`, `w`, `h`, `x`, `y`; `graph.describe()`
  returns only id/label/status/group. There is no `getNode(id)` for targeted read-back. The layout
  the daemon computes is never legible to the model.
- **Rungs** — L4 over-provides (fields written) → L2 under-delivers (read-back surfaces a subset).
- **Who feels it** — a blind model can't ask "what shape is node X, where did it land, what colour" —
  it must re-assert rather than read.
- **Intent** — likely forgotten-latent: `describe()` was written compact before shape/color mattered.
  Confirm in the loop from git.
- **Loop** —
  ```
  Inventory every value the graph model stores or computes (graph.ts GraphNode: shape, status, group,
  color, w, h, x, y; GraphEdge; GraphFrame) and trace which reach the model through describeBoard.
  Ledger ledgers/DARKDATA.md: value | written at | surfaced at | class (surfaced/internal/dark) |
  intent | verdict | commissioned as. describe() drops shape/color/x/y — class them dark; read intent
  from git and comments. Query no live state, build nothing. Done when every field is classified and
  every dark row holds its intent.
  ```
- **Strength** — Worth exploring.
- **Status** — done 2026-07-11 (classified + shape/position surfaced) — ledgers/DARKDATA.md

---

## Top recommendation
Issues 1, 2 done; directions D1, D2 done. **Only Issue 3 remains — canonicalize the three ways to
make connected boxes.** Worth-exploring (not Strong), so no gate pressure; run it when you want to
shrink the tool surface for a small model.

## Decided
- readback-write-surface — done — 2026-07-11 — ledgers/READBACK.md
- silent-false-confirmations — done — 2026-07-11 — ledgers/SILENCE.md
- D1-capability-reach — done(classified) — 2026-07-11 — ledgers/CAPABILITY.md
- D2-dark-node-fields — done(classified+surfaced) — 2026-07-11 — ledgers/DARKDATA.md
