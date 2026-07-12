# READBACK ledger — Issue 1: read-back covers the write surface

Loop: inventory–story–test–fix over every MCP tool. Done-when: every tool's effect is
confirmable by a non-vision model via describeBoard or the tool's own result text.
Status: done 2026-07-11 — ledger: ledgers/READBACK.md

Fix: daemon tracks per-room `freeform` descriptors (`FreeformShape`, `freeformDescriptor`);
`/api/graph list` augments the result with `board` id + `freeform`; describeBoard description
updated. Applied (uncommitted — whole working tree is the uncommitted graph build; commit pass
deferred to a single commit, not per-row, since none of this is committed yet).
Retest (headless): free-form rectangle/text/step/arrow + board id all appear in `list`; graph
nodes still present. PASS.

Phase 1 (inventory — no fixing): does a blind model observe this tool's effect today?

| tool | what it writes | confirmable blind today? | gap | fix commit | retest |
|---|---|---|---|---|---|
| createShape | free-form geo → backlog | NO → now in describeBoard.freeform | surface free-form in read-back | applied | pass |
| addText | free-form text → backlog | NO → now in describeBoard.freeform | surface free-form in read-back | applied | pass |
| connectShapes | free-form arrow → backlog | NO → intent now in freeform (false-success still Issue 2) | surface + (false-success → Issue 2) | applied | pass |
| createFlowchartStep | free-form step box → backlog | NO → now in describeBoard.freeform | surface free-form in read-back | applied | pass |
| drawGraph | graph nodes/edges | YES — in describeBoard | — | n/a | pass |
| addNode | graph node | YES | — | n/a | pass |
| addEdge | graph edge | YES (phantom-node silence → Issue 2) | — | n/a | pass |
| updateNode | graph node fields | YES | — | n/a | pass |
| setStatus | graph node status | YES | — | n/a | pass |
| removeNode | removes node+edges | YES — absent from list | — | n/a | pass |
| removeEdge | removes edge | YES — absent from list | — | n/a | pass |
| createFrame | graph frame | YES — in describeBoard.frames | — | n/a | pass |
| clearBoard | clears graph | YES — empty list; free-form persists (accurate: tool is graph-only by design) | resolved: describeBoard reports both truthfully | applied | pass |
| batch | many graph cmds | YES | — | n/a | pass |
| describeBoard | (read) | PARTIAL → now reports board id + graph + free-form | add board id + free-form | applied | pass |
| getSnapshot | (read) raw JSON | marginal — blob, not model-legible | Direction D1 (out of scope) | n/a | n/a |
| useBoard | switches board | YES — returns URL text | — | n/a | pass |
| getBoardUrl | (read) URL | YES — returns text | — | n/a | pass |
| focusOn | pans human browser | N/A — no blind-observable effect | Direction D1 (out of scope) | n/a | n/a |

Second full pass: adds no rows. Inventory complete.

Fix set: surface free-form shapes + board id in describeBoard (covers createShape, addText,
connectShapes, createFlowchartStep, describeBoard, clearBoard-note). connectShapes false-success
and addEdge phantom-node are Issue 2 (silence audit) — logged, not fixed here.
