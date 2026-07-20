// The daemon and its MCP clients must run the SAME code: tsx does not
// hot-reload, so a long-lived daemon would keep serving old commands while a
// freshly launched client advertises new tools ("unknown command: …"), or lay
// out with constants the code on disk has since fixed. Both sides stamp the
// source tree identically — max mtime across src/*.ts — the daemon captures
// its stamp at startup and reports it in /health, and ensureDaemon() retires
// a daemon whose stamp no longer matches the disk.
import fs from "node:fs";
import path from "node:path";

export function buildStamp(): string {
  let max = 0;
  for (const f of fs.readdirSync(import.meta.dirname)) {
    if (!f.endsWith(".ts")) continue;
    try {
      const m = fs.statSync(path.join(import.meta.dirname, f)).mtimeMs;
      if (m > max) max = m;
    } catch {
      /* file vanished mid-scan */
    }
  }
  return String(Math.round(max));
}
