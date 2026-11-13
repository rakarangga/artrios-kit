// Registered projects (data/projects.json) and their task services (PRD F1, section 8a).
import fs from 'node:fs';
import path from 'node:path';
import { createTaskService } from './task-service.js';
import { STATUSES, ownerClient } from './card.js';
import { appendActivity } from './activity.js';

export function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

// Client of a workspace row (PRD AIOS-61 v2.1 S12): `client`, else the legacy `hat` (work -> config.legacyWorkClient).
export const clientOfProject = (config, project) => ownerClient(project, config?.legacyWorkClient);

// tasksRoot: central layout "/path/to/tasks" holds tasks/<KEY>/; default is <project>/.artrios/tasks.
// The old placeholder {hat} still resolves (work when the workspace has a client, else self) for older configs.
export function resolveTasksRoot(config, project) {
  const t = project.tasksRoot ?? config.tasksRoot;
  const hat = project.hat ?? (clientOfProject(config, project) ? 'work' : 'self');
  return t ? path.resolve(t.replaceAll('{hat}', hat)) : path.join(project.path, '.artrios', 'tasks');
}

export function createProjects({ dataDir, config = {}, onActivity = () => {} }) {
  const file = path.join(dataDir, 'projects.json');
  const services = new Map();

  const all = () => loadJson(file, { projects: [] }).projects ?? [];
  const find = (key) => all().find((p) => p.key === key) ?? null;

  function service(project) {
    const root = resolveTasksRoot(config, project);
    const cached = services.get(project.key);
    if (cached?.tasksRoot === root) return cached;
    const svc = createTaskService({
      tasksRoot: root,
      projectDir: project.path,
      client: clientOfProject(config, project),
      workClient: config.legacyWorkClient,
      emit: (e) => { appendActivity(project, e); onActivity(project, e); },
    });
    services.set(project.key, svc);
    return svc;
  }

  function summary(project) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    let broken = 0;
    try {
      const r = service(project).list({ project: project.key });
      for (const c of r.cards) counts[c.status] += 1;
      broken = r.broken.length;
    } catch { /* unreadable tasks root: show zero counts */ }
    return { key: project.key, name: project.name ?? project.key, client: clientOfProject(config, project), path: project.path, counts, broken };
  }

  return { all, find, service, summary, list: () => all().map(summary) };
}
