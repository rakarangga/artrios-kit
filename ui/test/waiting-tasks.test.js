// Routines > Today > Waiting for you: tasks from config.waitingTasks commands, closed with Done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTaskLines, createWaitingTasks } from '../server/waiting-tasks.js';

test('parses task tool lines, with and without hat and due date', () => {
  const t = parseTaskLines('self\tAIOS-86 [In Progress|medium] Uji PC mati\nAIOS-92 [Todo] Uji console (due 2026-11-20)\nnoise line\n');
  assert.deepEqual(t.map((x) => [x.hat, x.key, x.state, x.priority, x.due]), [['self', 'AIOS-86', 'In Progress', 'medium', null], ['', 'AIOS-92', 'Todo', '', '2026-11-20']]);
  assert.equal(t[1].title, 'Uji console');
});

test('done runs the fixed command for a listed task only; bad keys and unknown tasks are refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-wt-'));
  const log = path.join(dir, 'done.log').replaceAll('\\', '/');
  const list = [process.execPath, '-e', "console.log('self\\tAIOS-86 [In Progress|medium] Uji PC mati')"];
  const done = [process.execPath, '-e', `require('fs').appendFileSync('${log}', process.argv.slice(1).join(' ') + '\\n')`, '{hat}', '{key}'];
  const w = createWaitingTasks({ config: { waitingTasks: { list, done } } });
  const l = await w.list();
  assert.equal(l.enabled, true);
  assert.equal(l.canDone, true);
  assert.equal(l.tasks[0].key, 'AIOS-86');
  const r = await w.done('AIOS-86');
  assert.equal(r.done, true);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'self AIOS-86');
  await assert.rejects(() => w.done('AIOS-99'), /not in the waiting list/);
  await assert.rejects(() => w.done('aios-86; rm'), /bad task key/);
  const off = createWaitingTasks({ config: {} });
  assert.deepEqual(await off.list(), { enabled: false, tasks: [] });
  const broken = createWaitingTasks({ config: { waitingTasks: { list: ['no-such-program-xyz'] } } });
  assert.match((await broken.list()).error, /failed/);
});
