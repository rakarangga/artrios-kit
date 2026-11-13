// Brain screen back end. Read-only: builds the knowledge graph from the sources in brain.config.json and serves single
// notes by id. A client can only name a note the scan found, never a path.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildGraph } from './graph.js';
import { MAX_NOTE_BYTES, splitFrontMatter } from './scan.js';
import { TaskError } from '../task-service.js';

export function createBrain({ config, dataDir, pulse = null }) {
  const file = path.resolve(config.brainConfigFile ?? path.join(dataDir, 'brain.config.json'));
  let building = null;

  const load = async (rebuild = false) => {
    try { await fs.access(file); } catch { throw new TaskError('not_found', `brain not configured: create ${file}`); }
    if (!building || rebuild) building = buildGraph(file, Date.now(), pulse).catch((e) => { building = null; throw new TaskError('invalid', e.message); });
    return building;
  };

  // The file must still be the one the scan saw: a path swapped for a link afterwards is refused.
  async function locate(id) {
    const { records } = await load();
    const note = records.get(String(id));
    if (!note) throw new TaskError('not_found', 'unknown note');
    if (await fs.realpath(note.file) !== note.file) throw new TaskError('forbidden', 'this file changed; rebuild the graph first');
    return note;
  }

  return {
    async graph(rebuild) { return (await load(rebuild)).graph; },
    async node(id) {
      const note = await locate(id);
      if ((await fs.stat(note.file)).size > MAX_NOTE_BYTES) throw new TaskError('invalid', 'this note is over 1 MB');
      return { id: String(id), path: note.meta.path, file: note.file, markdown: splitFrontMatter(await fs.readFile(note.file, 'utf8')).body };
    },
    async reveal(id) {
      const { file: target } = await locate(id);
      const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [`/select,${target}`]]
        : process.platform === 'darwin' ? ['open', ['-R', target]]
        : ['xdg-open', [path.dirname(target)]];
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
      return { ok: true };
    },
  };
}
