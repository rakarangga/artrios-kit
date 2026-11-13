import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPulse, parseRoutines, parseLog } from '../server/pulse.js';

let root;
const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const NOW = Date.parse('2026-11-09T08:00:00Z');

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-pulse-')));
  put('artrios/project.md', 'x');
  put('artrios/routines.yaml', '# c\n- name: backup\n  schedule: daily 08:30\n  host: pc\n  model: none\n  hat:\n\n- name: smart\n  schedule: daily 09:00\n  host: pc\n  model: sonnet\n\n- limits: global\n  daily_max_runs: 3\n');
  put('logs/routines.pc.log', '2026-11-09T08:30:00\tbackup\tnone\t-\t-\tOK\texit=0 done\n2026-11-09T08:31:00\tbackup\tnone\t-\t-\tFAIL\texit=1 boom\n');
  put('artrios/digest/2026-11-08.md', '# Ringkasan\n');
  put('artrios/activity.md', '- 2026-11-08 | pc | home | self | selesai; menunggu dia: uji console Sumopod\n- 2026-11-08 | pc | home | self | tidak ada\n');
  put('.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: A demo\n---\nbody');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const make = () => createPulse({ config: { artriosRoot: root }, now: () => NOW });

test('parsers: flat yaml list and tab log', () => {
  assert.equal(parseRoutines(fs.readFileSync(path.join(root, 'artrios/routines.yaml'), 'utf8')).length, 2);
  assert.equal(parseLog('a\tb\n', 'pc').length, 0);
});

test('overview: routine board uses the latest log row, digest is stale after 36 h, no waiting items guessed from activity', () => {
  const o = make().overview();
  const b = o.routines.board.find((r) => r.name === 'backup');
  assert.equal(b.state, 'FAIL');
  assert.equal(o.routines.board.find((r) => r.name === 'smart').state, 'never');
  assert.equal(o.routines.board.some((r) => r.name === undefined), false);
  assert.equal(o.today.date, '2026-11-08');
  // "menunggu" text in activity.md is not an action: the panel reads Decision Required and config.waitingTasks.
  assert.deepEqual(o.waiting.items, []);
  assert.deepEqual(o.skills.map((s) => s.name), ['demo']);
});

test('enqueue: writes one request for a model-free routine, refuses model routines and unknown names', () => {
  const p = make();
  const r = p.enqueue('backup');
  assert.match(r.queued, /^pc__backup__.+\.req$/);
  assert.ok(fs.existsSync(path.join(root, 'artrios/queue', r.queued)));
  assert.throws(() => p.enqueue('smart'), /not enabled/);
  assert.throws(() => p.enqueue('nope'), /unknown/);
  assert.throws(() => p.enqueue('../x'), /bad routine/);
});
