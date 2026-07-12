# Agent-facing docs

Documentation for AI agents and their tooling working *on* this repo — as opposed to
[`/README.md`](../../README.md), which is for people *using* the MCP server.

- **[HANDOFF.md](HANDOFF.md)** — session checkpoint: current state, what's built, what's in flight.
- **[ISSUES.md](ISSUES.md)** — tend backlog (health/friction issues + directions). Ledgers below.
- **[DIVERGENCES.md](DIVERGENCES.md)** — graft backlog (proposed growth, with probes + kill criteria).
- **[ledgers/](ledgers/)** — per-loop tend/graft ledgers (READBACK, SILENCE, CAPABILITY, DARKDATA, …).
- **[TLDRAW-SHAPE-TYPES.md](TLDRAW-SHAPE-TYPES.md)** — tldraw v3 shape-type integration reference.

The issue tracker (wayfinder map + tickets) lives separately in [`/.seeds/`](../../.seeds) — it's
structured tracker data (`issues.jsonl`), not prose, so it stays at the repo root by convention.

Note for future tend/graft/wayfinder runs: these skills default backlogs/ledgers to the repo root.
They now live here instead; point runs at `.agents/docs/` (and `.seeds/` for the tracker).
