// Activity feed (F5): card and job events from activity.jsonl merged with the project's git log, newest first.
import { execFile } from 'node:child_process';
import { readActivity } from './activity.js';

function gitLog(dir, limit) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'log', `-n${limit}`, '--pretty=format:%h%x1f%cI%x1f%an%x1f%s'], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]); // not a git repo, or git missing: the feed still works
      resolve(out.split('\n').filter(Boolean).map((l) => {
        const [hash, ts, author, subject] = l.split('\x1f');
        return { ts, type: 'git.commit', ref: hash, by: author, detail: subject };
      }));
    });
  });
}

export async function readFeed(project, limit = 100) {
  const events = readActivity(project, limit).map((e) => ({ ...e, project: e.project ?? project.key }));
  const commits = (await gitLog(project.path, limit)).map((c) => ({ ...c, project: project.key }));
  const time = (e) => Date.parse(e.ts) || 0;
  return [...events, ...commits].sort((a, b) => time(b) - time(a)).slice(0, limit);
}

// Combined view across projects ("per proyek atau gabungan").
export async function readCombinedFeed(projects, limit = 100) {
  const lists = await Promise.all(projects.map((p) => readFeed(p, limit)));
  const time = (e) => Date.parse(e.ts) || 0;
  return lists.flat().sort((a, b) => time(b) - time(a)).slice(0, limit);
}
