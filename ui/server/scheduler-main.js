#!/usr/bin/env node
// artrios-scheduler: node server/scheduler-main.js [--data DIR] [--tick-ms N]. Its own process, no port (PRD AIOS-61
// v2.0 S2, R3): reads agents/<id>.md, runs them through the same job runner as the UI, logs to <project>/.artrios/jobs/,
// writes data/scheduler/heartbeat.json. The UI may stop and start again without stopping it or its jobs (AC 6).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadJson, createProjects } from './projects.js';
import { createJobRunner } from './job-runner.js';
import { createClaudeHeadlessEngine } from './engine.js';
import { createProviderLayer } from './providers/index.js';
import { createInboxService } from './inbox-service.js';
import { createAgentService } from './agents.js';
import { createScheduler } from './scheduler.js';
import { appendActivity } from './activity.js';
import { localTimestamp } from './task-service.js';
import { createScheduleService } from './schedules.js';
import { inboxFileOf, agentsDirOf, schedulerDirOf, schedulesDirOf, createLocations } from './instance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { data: { type: 'string' }, 'tick-ms': { type: 'string' }, log: { type: 'string' } } });
const dataDir = path.resolve(values.data ?? path.join(root, 'data'));
const config = loadJson(path.join(dataDir, 'config.json'), {});
const tickMs = Math.max(1000, Number(values['tick-ms'] ?? config.schedulerTickMs ?? 10000));
const stamp = () => localTimestamp(new Date()).slice(0, 16).replace('T', ' ');
// --log FILE also appends every line to a file (for a run without a console, e.g. a Windows logon task).
const logFile = values.log ? path.resolve(values.log) : null;
const log = (line) => {
  const text = `[scheduler ${stamp()}] ${line}`;
  console.log(text);
  if (logFile) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${text}\n`); } catch { /* console only */ } }
};

const inboxFile = inboxFileOf(config, dataDir);
fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
const inbox = createInboxService({ file: inboxFile });
const projects = createProjects({ dataDir, config });
const agents = createAgentService({ dir: agentsDirOf(config, dataDir) });
const cliEngine = createClaudeHeadlessEngine({ command: config.claudePath ?? 'claude', baseArgs: config.claudeBaseArgs ?? [] });
const providers = createProviderLayer({ config, cliEngine });
let scheduler = null;
const jobs = createJobRunner({
  engine: providers.engine,
  config: { ...config, maxJobs: config.schedulerMaxJobs ?? config.maxJobs ?? 2 },
  onEvent: (e) => {
    if (e.type === 'activity') {
      const project = locations.allLocations().find((l) => l.key === e.project);
      if (project) { try { appendActivity(project, e.event); } catch { /* activity is best effort */ } }
    }
    try { scheduler?.onJobEvent(e); } catch (err) { log(`job event: ${err.message}`); }
  },
});
const locations = createLocations({ config, projects });
const schedules = createScheduleService({ dir: schedulesDirOf(config, dataDir) });
scheduler = createScheduler({ dir: schedulerDirOf(dataDir), schedules, agents, locate: locations.locate, allLocations: locations.allLocations, jobs, inbox, log });

// Another scheduler already runs this instance (e.g. the logon task while `npm start` is used): that is fine, exit quietly.
try { scheduler.claim(); } catch (e) { log(`${e.message}; this one exits and leaves it running`); process.exit(0); }
log(`started (pid ${process.pid}), schedules in ${schedulesDirOf(config, dataDir)}, tick ${tickMs} ms`);

let busy = false;
const run = () => {
  if (busy) return;
  busy = true;
  try { scheduler.tick(); } catch (e) { log(`tick failed: ${e.message}`); } finally { busy = false; }
};
run();
const timer = setInterval(run, tickMs);
// "Jalankan sekarang" from the UI should not wait for the next tick: a new request file triggers one at once.
try { fs.watch(scheduler.requestsDir, () => setTimeout(run, 150)); } catch { /* the interval still picks it up */ }

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  jobs.stopAll();
  scheduler.stop();
  log('stopped');
  setTimeout(() => process.exit(0), 300); // let killTree finish
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, shutdown);
// The launcher on Windows cannot send a signal; it closes our stdin instead (bin/start.js).
if (process.env.ARTRIOS_STOP_ON_STDIN_END === '1') { process.stdin.resume(); process.stdin.on('end', shutdown); }
