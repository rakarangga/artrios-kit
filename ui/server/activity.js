// Append-only activity log per project: <project>/.artrios/activity.jsonl (PRD section 8a).
// Every line carries `project`. Failures to log never break the action that caused them.
import fs from 'node:fs';
import path from 'node:path';

export function activityFile(project) {
  return path.join(project.path, '.artrios', 'activity.jsonl');
}

export function appendActivity(project, event) {
  try {
    const file = activityFile(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: event.ts, project: project.key, type: event.type, ref: event.ref, by: event.by, detail: event.detail })}\n`);
  } catch { /* logging is best effort */ }
}

export function readActivity(project, limit = 100) {
  try {
    const lines = fs.readFileSync(activityFile(project), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch {
    return [];
  }
}
