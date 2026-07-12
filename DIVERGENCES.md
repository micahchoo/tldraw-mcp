# DIVERGENCES.md — graft backlog

Provenance: generated 2026-07-11, commit `bf5a9f0` + uncommitted graph-tools build.
Scope: make the MCP server easier to use as a **planning tool for an agent**. Gate: clear (no Strong
tend issue open; Issues 1–2 done, D1–D2 done, only Worth-exploring Issue 3 remains).

Field read (outward from the agent's planning loop — make plan → track → decide next → resume):
the tool now makes plans (drawGraph), tracks them (setStatus), and reads them back (describeBoard,
post-tend). Two moves in the loop are unserved: **decide what's next** and **survive the long task**.

Frontier: the capability shift is agents doing long, multi-step autonomous tasks whose in-context
plan is lost at compaction (the /tend compaction hook literally fired during this session —
`artifact`, dated 2026-07-11). That makes an external, durable, queryable plan-of-record valuable in
a way a passive diagram never was. V1 (job) and V6 (frontier) agree from opposite directions.

---

## Divergences

### 1. `nextActionable` — the plan drives the work, not just depicts it
- **Evidence** — repo: `graph.ts` already stores `status` and `edges` (dependencies); no verb returns
  the unblocked set. An agent must re-read the whole plan and reason about it to pick a next step.
- **Vantage** — V4 (reactive→proactive), V7 (analogue: the topological **ready-set** / build-system
  "what can compile now" — a solved shape), V1 (plan→execution). Field vantages converging.
- **Leverage** — L3 (new verb turns a picture into a work queue). Blast radius: tiny — one graph
  traversal (`nodes whose every predecessor is done`) + one MCP tool. Reshapes: the agent asks the
  board "what now?" instead of holding the whole plan in context.
- **Who feels it** — the agent re-scans the full plan each step to find unblocked work; today's
  workaround is re-reading describeBoard and reasoning manually.
- **Shape** — feature (tool + graph query).
- **Cheapest probe & kill** — add `nextActionable` returning nodes with all predecessors `done` (and
  not themselves done/blocked). Kill if it can't compute the correct ready-set on a diamond graph
  (A→B, A→C, B→D, C→D with A done).
- **Strength** — Strong (repo: data already present).
- **Status** — queued

### 2. Durable plans — the board is external memory that survives restart & compaction
- **Evidence** — repo: `daemon.ts` `Room.graph` is an in-memory Map; nothing serializes it; idle-
  shutdown (60s after last agent) and any restart drop the whole plan. artifact (2026-07-11): the
  compaction hook fired this session — the agent's in-context plan is exactly what evaporates.
- **Vantage** — V1 (the job continues past the session — a plan is memory, not a snapshot), V4
  (ephemeral→persistent), V6 (long-autonomous-task capability shift makes durable external plans pay).
  Field + frontier agree.
- **Leverage** — L3→L4 (tool→system-of-record for the agent's plan). Blast radius: small — serialize
  each board's graph to a JSON file on mutation (debounced), load in `getRoom`. Wedge/beachhead:
  persist+load one board behind a flag; the reframe rides that one slice.
- **Who feels it** — after compaction or a daemon restart the agent re-derives the plan from scratch;
  the human watching loses the board. Workaround: re-draw.
- **Shape** — business-logic change (add a persistence layer).
- **Cheapest probe & kill** — write graph JSON to `boards/<id>.json` on change, load on room create.
  Kill if a board doesn't come back identical after a daemon restart.
- **Strength** — Strong (repo evidence direct).
- **Status** — queued

### 3. Node ownership / assignment for multi-agent planning
- **Evidence** — repo: concurrent agents are supported (per-agent colour) but `GraphNode` has no
  owner and there's no assign/handoff verb; a plan several agents share can't express "you take this."
  User has repeatedly cited concurrent multi-agent use.
- **Vantage** — V3 (actors: the other agent, unserved by any screen/verb), V4 (single→coordinated).
- **Leverage** — L3 (new actor dimension). Blast radius: small — an `owner` field + `assignNode` +
  owner-filtering in describeBoard/nextActionable.
- **Who feels it** — concurrent agents pick the same node or can't hand off; today they coordinate out
  of band (in chat) or collide.
- **Shape** — feature.
- **Cheapest probe & kill** — add `owner` + `assignNode(id, owner)` + `nextActionable(owner)`. Kill if
  ready-set-by-owner doesn't partition correctly.
- **Strength** — Worth exploring (multi-agent demand user-stated but usage not yet observed).
- **Status** — queued

### 4. Plan export the agent's other tools consume (checklist / task-list view)
- **Evidence** — repo: describeBoard returns structured JSON (post-tend), but nothing renders the plan
  as an ordered actionable checklist the agent (or its todo tooling) drives. V2 downstream: the agent
  hand-transforms describeBoard into its own task list.
- **Vantage** — V2 (workflow after the app), V4 (consume→produce).
- **Leverage** — L2 (information reshaping). Blast radius: tiny — a formatter over the existing model.
  Largely subsumed by describeBoard + nextActionable; marginal once those exist.
- **Who feels it** — an agent bridging the board to its own todo list.
- **Shape** — UX/format.
- **Cheapest probe & kill** — a `planAsChecklist` tool ordering nodes by dependency + status. Kill if
  it adds nothing describeBoard+nextActionable don't already give.
- **Strength** — Speculative (probe likely to kill on redundancy).
- **Status** — parked (redundant once #1 lands)

---

## Top bet
**#1 `nextActionable`**, with **#2 durable plans** as its foundational companion. #1 is the cheapest
transformative verb — tiny blast radius, data already present — and it closes the one missing move in
the agent's planning loop (decide-next). It's the highest leverage-per-cost row. #2 raises the class
(tool→plan-of-record) at small cost and is timely given the compaction signal; run it right after.
#3 waits on observed multi-agent usage. #4 parks.
