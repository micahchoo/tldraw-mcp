# DARKDATA ledger — D2: graph fields stored but dropped from read-back

Direction loop (classify only — no build). Done-when: every field classified and every dark row
holds its intent. Evidence from graph.ts (GraphNode/GraphEdge/GraphFrame) and describe().
Status: done 2026-07-11 — ledger: ledgers/DARKDATA.md

| value | written at | surfaced at (describe) | class | intent | verdict | commissioned as |
|---|---|---|---|---|---|---|
| node.id | addNode | describe.nodes.id | surfaced | — | — | — |
| node.label | addNode | describe.nodes.label | surfaced | — | — | — |
| node.status | setStatus/addNode | describe.nodes.status | surfaced | — | — | — |
| node.group | addNode | describe.nodes.group (conditional) | surfaced | — | — | — |
| node.shape | addNode | — DROPPED | **dark** | forgotten-latent — describe() written compact before shape mattered; a blind model can't read what shape a node is | — | — |
| node.x, node.y | layout() (dagre) | — DROPPED | **dark** | forgotten-latent — computed every relayout, never surfaced; the model can't reason about position | — | — |
| node.color | addNode/status | — DROPPED | internal — derivable from status (STATUS_COLOR) | designed — derived, not primary | — | — |
| node.w, node.h | defaults/layout | — DROPPED | internal — fixed sizing, no model meaning | designed | — | — |
| edge.from/to/label | addEdge | describe.edges | surfaced | — | — | — |
| frame.id/name | createFrame | describe.frames | surfaced | — | — | — |
| frame.x/y/w/h | layout() | — DROPPED | internal — layout geometry | designed | — | — |

Reading: `shape` and `x/y` are genuinely dark and model-relevant (a blind model should be able to
read a node's shape and where it landed); `color/w/h` and frame geometry are internal/derived.

Follow-on (applied, beyond the classify-only loop, to serve the stated non-vision goal): `describe()`
now surfaces `shape` and rounded `x/y` per node. Verified: describeBoard returns
`{id, label, shape, status, x, y}`. `color/w/h` left internal (derivable/fixed).
