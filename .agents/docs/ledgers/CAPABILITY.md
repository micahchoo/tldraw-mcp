# CAPABILITY ledger — D1: operations with no non-vision consumer

Direction loop (classify only — no build, nothing removed). Done-when: every tool classified and
each human-only/machine-only row holds its intent.
Status: done 2026-07-11 — ledger: ledgers/CAPABILITY.md

| operation | defined at | non-vision path | consumer | class | intent | verdict | commissioned as |
|---|---|---|---|---|---|---|---|
| getSnapshot | index.ts:294 | returns a raw tldraw snapshot blob | machine (nothing imports/restores it) | machine-only | forgotten-latent — present in bf5a9f0, predates the describeBoard read-back; an export with no import | — | — |
| focusOn | index.ts:500 | none — pans a human's browser via SSE | human viewer | human-only | designed-latent — added this session for human watchers (absent from bf5a9f0) | — | — |
| createShape, addText, connectShapes, createFlowchartStep | index.ts | returns text; effect now in describeBoard | blind model | reachable | — (baseline, not flagged) | — | — |
| drawGraph, addNode, addEdge, updateNode, setStatus, removeNode, removeEdge, createFrame, clearBoard, batch | index.ts | returns text; effect in describeBoard | blind model | reachable | — | — | — |
| describeBoard, getBoardUrl, useBoard | index.ts | returns text/state | blind model | reachable | — | — | — |

Reading: only 2 of 19 tools have no path a non-vision model can use. `getSnapshot` is superseded by
`describeBoard` for the model (its remaining honest use is board persistence/restore — but no
restore tool consumes it). `focusOn` legitimately serves a human watching the shared board.
Verdicts (deprecate getSnapshot? add a restore consumer?) come after this run, per direction discipline.
