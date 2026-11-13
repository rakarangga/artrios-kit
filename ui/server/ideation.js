// Ideation (F8): the agent proposes improvement ideas; the user converts an idea into a card or dismisses it.
// Ideas live in <project>/.artrios/ideation/ideas.json. Nothing becomes a card without the user's click.
import fs from 'node:fs';
import path from 'node:path';
import { TaskError, localTimestamp } from './task-service.js';
import { atomicWrite } from './lock.js';
import { runOnce } from './oneshot.js';

export const CATEGORIES = ['code', 'ui', 'docs', 'security', 'performance'];
const EFFORTS = ['trivial', 'small', 'medium', 'large'];
const cut = (v, n) => String(v ?? '').trim().slice(0, n);

// Pulls the JSON array out of the model's answer, even when it is wrapped in prose or a code fence.
export function parseIdeas(text) {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b <= a) throw new TaskError('invalid', 'the agent did not return a JSON list of ideas');
  let arr;
  try { arr = JSON.parse(text.slice(a, b + 1)); } catch { throw new TaskError('invalid', 'the agent returned a list that is not valid JSON'); }
  if (!Array.isArray(arr)) throw new TaskError('invalid', 'the agent did not return a list');
  return arr.flatMap((x) => {
    if (!x || typeof x !== 'object' || !cut(x.title, 140)) return [];
    return [{
      category: CATEGORIES.includes(x.category) ? x.category : 'code',
      title: cut(x.title, 140),
      description: cut(x.description, 1200),
      rationale: cut(x.rationale, 1200),
      currentState: cut(x.currentState, 1200),
      proposedChange: cut(x.proposedChange, 1200),
      effort: EFFORTS.includes(x.effort) ? x.effort : 'small',
    }];
  }).slice(0, 12);
}

export function createIdeation({ engine, config = {}, onEvent = () => {}, now = () => new Date() }) {
  const running = new Set();
  const file = (project) => path.join(project.path, '.artrios', 'ideation', 'ideas.json');
  const read = (project) => { try { return JSON.parse(fs.readFileSync(file(project), 'utf8')); } catch { return { nextId: 1, ideas: [] }; } };
  const write = (project, data) => {
    fs.mkdirSync(path.dirname(file(project)), { recursive: true });
    atomicWrite(file(project), `${JSON.stringify(data, null, 2)}\n`);
  };

  const list = (project) => ({ ...read(project), running: running.has(project.key), categories: CATEGORIES });

  async function generate(project, { category = null } = {}) {
    if (running.has(project.key)) throw new TaskError('conflict', 'ideas are already being generated for this project');
    if (category && !CATEGORIES.includes(category)) throw new TaskError('invalid', `category must be one of ${CATEGORIES.join(', ')}`);
    running.add(project.key);
    onEvent({ type: 'ideation', project: project.key, status: 'running' });
    try {
      const existing = read(project).ideas.slice(-30).map((i) => `- ${i.title}`).join('\n');
      const prompt = [
        'You review the project in the current folder. Work read only: do not create, edit or delete files.',
        `Propose up to 8 concrete improvement ideas${category ? ` in the category "${category}"` : ''}. Skip ideas already listed below.`,
        'Return a JSON array of ideas and nothing else. Each item has these string fields:',
        `category (one of ${CATEGORIES.join(', ')}), title (short), description, rationale (why it matters), currentState (what exists now), proposedChange (what to do), effort (one of ${EFFORTS.join(', ')}).`,
        existing ? `Ideas already listed:\n${existing}` : '',
      ].filter(Boolean).join('\n');
      const r = await runOnce(engine, config, { prompt, cwd: project.path, allowedTools: config.ideation?.allowedTools ?? ['Read', 'Grep', 'Glob'], model: config.ideation?.model ?? config.model, noMcp: true });
      if (!r.ok) throw new TaskError('unavailable', `the agent failed: ${r.error}`);
      const fresh = parseIdeas(r.text);
      const data = read(project);
      const stamp = localTimestamp(now());
      for (const i of fresh) data.ideas.push({ id: `idea-${data.nextId++}`, ...i, status: 'new', card: null, created: stamp });
      write(project, data);
      return { added: fresh.length, ...list(project) };
    } finally {
      running.delete(project.key);
      onEvent({ type: 'ideation', project: project.key, status: 'idle' });
    }
  }

  function setStatus(project, id, status) {
    if (!['new', 'dismissed'].includes(status)) throw new TaskError('invalid', 'status must be new or dismissed');
    const data = read(project);
    const idea = data.ideas.find((i) => i.id === id);
    if (!idea) throw new TaskError('not_found', `unknown idea: ${id}`);
    if (idea.status === 'converted') throw new TaskError('conflict', 'this idea already became a card');
    idea.status = status;
    write(project, data);
    return idea;
  }

  function convert(project, id, svc) {
    const data = read(project);
    const idea = data.ideas.find((i) => i.id === id);
    if (!idea) throw new TaskError('not_found', `unknown idea: ${id}`);
    if (idea.status === 'converted') throw new TaskError('conflict', `already converted to ${idea.card}`);
    const body = [idea.description, '', '## Rationale', idea.rationale, '', '## Current state', idea.currentState, '', '## Proposed change', idea.proposedChange, '', `Effort: ${idea.effort}`].join('\n');
    const card = svc.create({ project: project.key, title: idea.title, body, status: 'backlog', labels: [idea.category] }, { by: 'ui' });
    idea.status = 'converted';
    idea.card = card.key;
    write(project, data);
    return { idea, card };
  }

  return { list, generate, setStatus, convert, isRunning: (p) => running.has(p.key) };
}
