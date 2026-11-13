// Project skills for the headless button (F3). A skill runs only when config lists its tool permissions (B4).
import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_ARGS = 2000;

export class SkillError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid | not_found | forbidden
  }
}

export function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (k) meta[k[1]] = k[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

const skillDirs = (project, config) => (config.skillDirs ?? ['.claude/skills']).map((d) => path.resolve(project.path, d));

function findSkillFile(project, config, name) {
  if (!NAME_RE.test(name ?? '')) throw new SkillError('invalid', `bad skill name: ${name}`);
  for (const dir of skillDirs(project, config)) {
    const file = path.join(dir, name, 'SKILL.md');
    if (fs.existsSync(file)) return file;
  }
  throw new SkillError('not_found', `skill not found in project: ${name}`);
}

export function listSkills(project, config = {}) {
  const found = new Map();
  for (const dir of skillDirs(project, config)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.sort()) {
      if (found.has(name) || !NAME_RE.test(name)) continue;
      try {
        const { meta } = splitFrontmatter(fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8'));
        const allowedTools = config.skills?.[name]?.allowedTools ?? null;
        found.set(name, {
          name,
          description: meta.description ?? '',
          argumentHint: meta['argument-hint'] ?? '',
          runnable: Array.isArray(allowedTools),
          allowedTools: allowedTools ?? [],
        });
      } catch { /* folder without a readable SKILL.md is not a skill */ }
    }
  }
  return [...found.values()];
}

// Builds the prompt the engine sends: SKILL.md without frontmatter, $ARGUMENTS filled in.
// An agent passes its own allowedTools (agents/<id>.md); a button run takes them from config.skills.
export function buildSkillPrompt(project, config, name, args = '', { allowedTools } = {}) {
  const a = String(args ?? '').trim();
  if (a.length > MAX_ARGS) throw new SkillError('invalid', `arguments longer than ${MAX_ARGS} characters`);
  const allowed = allowedTools ?? config.skills?.[name]?.allowedTools;
  const file = findSkillFile(project, config, name);
  if (!Array.isArray(allowed)) throw new SkillError('forbidden', `skill "${name}" has no tool permissions in config.skills (B4)`);
  const { body } = splitFrontmatter(fs.readFileSync(file, 'utf8'));
  const hasPlaceholder = body.includes('$ARGUMENTS');
  const prompt = hasPlaceholder ? body.replaceAll('$ARGUMENTS', a) : (a ? `${body.trimEnd()}\n\nArguments: ${a}\n` : body);
  return { prompt, allowedTools: allowed, args: a };
}
