# SILENCE ledger — Issue 2: silent & false confirmations

Loop: silence audit over the MCP tool feedback surface. Done-when: no tool reports success for a
no-op, no error text is empty/undefined, silent auto-creation is reported.
Status: done 2026-07-11 — ledger: ledgers/SILENCE.md
Fixes applied (uncommitted): daemon tracks step ids + returns connectShapes {resolved,unknown};
graph.addEdge returns {created}; index.ts errText() handles both {errors} and {error}; connectShapes
& addEdge tools report honestly. Forced check (MCP tool text): unknown step → "Could not connect…";
phantom → "Created new node(s): auth, typodb"; missing node → "Error: no such node: ghost". PASS.

| site | trigger | told today | should be told | fix commit | forced check |
|---|---|---|---|---|---|
| connectShapes (index.ts + canvasPage.ts) | fromId/toId not an existing step | "Connected shape X to Y" (false success; browser no-ops) | "couldn't connect: unknown step id(s) …" | applied | pass |
| graph tool error text (index.ts ~393 etc.) | daemon catch-path returns {error}, tools read r.errors | "Error: undefined" | the actual error string | applied | pass |
| addEdge (graph.ts) | from/to typo → phantom node auto-created | "Connected X → Y." (creation hidden) | "…created new node(s): Y" | applied | pass |

Inventory complete (second pass adds no new silence sites in the tool layer).
