#!/usr/bin/env node
// import-tasks: snapshot of an outside task tool (bridge JSON, e.g. `tracker.py export FILE`) -> card files.
// PRD AIOS-61 v2.1 S12: M4 dry run into a temporary root, M5 cutover into the real root. See server/task-import.js.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { importSnapshot, reportMarkdown } from '../server/task-import.js';

const HELP = `import-tasks --snapshot FILE --target DIR (--dry-run | --cutover) [options]

  --snapshot FILE     bridge JSON document (projects + tasks)
  --target DIR        tasks root to write: cards go to DIR/<KEY>/<KEY-N>.md
  --dry-run           target must be new or empty (a temporary folder); nothing else is touched
  --cutover           write into a real root; existing cards with other content are reported, not overwritten
  --overwrite         with --cutover: rewrite cards whose content differs
  --existing DIR      root holding card files today, scanned for key clashes (repeatable; never written)
  --client-of-work S  client name for legacy hat "work" with no client
  --report FILE       write the Markdown report here (default: print it)
  --json              print the raw result as JSON instead of the report
`;

const options = {
  snapshot: { type: 'string' }, target: { type: 'string' }, 'dry-run': { type: 'boolean' }, cutover: { type: 'boolean' },
  overwrite: { type: 'boolean' }, existing: { type: 'string', multiple: true }, 'client-of-work': { type: 'string' },
  report: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
};

function main(argv) {
  const { values: v } = parseArgs({ args: argv, options });
  if (v.help) { console.log(HELP); return 0; }
  if (!v.snapshot || !v.target || Boolean(v['dry-run']) === Boolean(v.cutover)) { console.error(HELP); return 2; }
  if (v.overwrite && !v.cutover) { console.error('--overwrite needs --cutover'); return 2; }
  const target = path.resolve(v.target);
  if (v['dry-run'] && fs.existsSync(target) && fs.readdirSync(target).length) {
    console.error(`dry run needs a new or empty target: ${target}`);
    return 2;
  }
  const r = importSnapshot({
    snapshotText: fs.readFileSync(v.snapshot, 'utf8'),
    tasksRoot: target,
    existingRoots: v.existing ?? [],
    clientOfWork: v['client-of-work'] ?? '',
    overwrite: Boolean(v.overwrite),
  });
  const text = v.json ? JSON.stringify(r, null, 2) : reportMarkdown(r, { title: v['dry-run'] ? 'Uji kering migrasi tugas' : 'Cutover migrasi tugas', snapshot: path.resolve(v.snapshot) });
  if (v.report) { fs.writeFileSync(v.report, text); console.log(`report -> ${v.report}`); } else process.stdout.write(text);
  const ok = !r.mismatch.length && !r.broken.length && !r.bad.length && !r.legacyFolders.length;
  return ok ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 2;
}
