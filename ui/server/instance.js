// Where one instance keeps its shared files. The UI and the scheduler are two processes and must agree on these paths.
import path from 'node:path';

// Inbox (Putusan screen): one queue file per instance; PC default sits next to the Artrios layer file.
export function inboxFileOf(config, dataDir) {
  if (config.inboxFile) return path.resolve(config.inboxFile);
  if (config.projectLayerFile) return path.join(path.dirname(path.resolve(config.projectLayerFile)), 'putusan.jsonl');
  return path.join(dataDir, 'inbox', 'events.jsonl');
}

// The Artrios home folder (Cognition home): where a schedule with location "artrios" runs.
export function artriosHome(config) {
  const h = config.cognitionHome;
  if (h?.path) return { key: h.key ?? 'artrios', name: h.name ?? 'Artrios', path: path.resolve(h.path), home: true };
  const root = config.artriosRoot ?? (config.projectLayerFile ? path.dirname(path.dirname(path.resolve(config.projectLayerFile))) : null);
  return root ? { key: 'artrios', name: 'Artrios', path: path.resolve(root), home: true } : null;
}

// Where schedules run: "artrios" = the home folder, anything else = a registered workspace key.
export function createLocations({ config, projects }) {
  const home = () => artriosHome(config);
  const locate = (key) => (key === 'artrios' ? home() : projects.find(key));
  const allLocations = () => {
    const out = [];
    const h = home();
    if (h) out.push(h);
    for (const p of projects.all()) if (!out.some((x) => x.key === p.key || path.resolve(x.path) === path.resolve(p.path))) out.push(p);
    return out;
  };
  return { locate, allLocations, home };
}

export const schedulesDirOf = (config, dataDir) => (config.schedulesDir ? path.resolve(config.schedulesDir) : path.join(dataDir, 'schedules'));
export const agentsDirOf = (config, dataDir) => (config.agentsDir ? path.resolve(config.agentsDir) : path.join(dataDir, 'agents'));
export const schedulerDirOf = (dataDir) => path.join(dataDir, 'scheduler');
