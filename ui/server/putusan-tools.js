// Putusan tools (PRD Cognition T9-T10, §11), shared by the MCP server for claude (mcp-putusan.js) and the API chat
// engine (chat-api.js), so both engines follow the same rules: list before ask, one item per case key.
import { InboxError } from './inbox-service.js';

export const PUTUSAN_TOOLS = [
  {
    name: 'putusan_list',
    description: 'List the decision queue (Putusan) of this workspace: open cases and recent decisions, grouped by subject. Call this before putusan_ask; an open or decided case with the same subject and topic must not be asked again.',
    inputSchema: { type: 'object', properties: { subject: { type: 'string', description: 'Only this subject (task key, file, or PRD section)' }, status: { type: 'string', enum: ['pending', 'decided', 'all'] } } },
  },
  {
    name: 'putusan_ask',
    description: 'Put one question in the Putusan queue for the user to decide later (when they are away or the answer can wait). One item per case: key = workspace + subject + topic. Returns "reasked" for an open case, the old decision for a decided case (unless contextChanged), or the new item.',
    inputSchema: {
      type: 'object',
      required: ['subject', 'topic', 'question', 'why', 'options'],
      properties: {
        subject: { type: 'string', description: 'Task key, file path, or PRD section, without "/" (e.g. AIOS-25)' },
        topic: { type: 'string', description: 'Short slug of what is decided, without "/" (e.g. izin-tool)' },
        question: { type: 'string', description: 'The question, readable on its own' },
        why: { type: 'string', description: 'Why the user must decide this' },
        options: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Answer buttons, first = suggested' },
        links: { type: 'array', items: { type: 'string' }, description: 'Files or pages to read before deciding' },
        contextChanged: { type: 'boolean', description: 'True only when the case was decided before and the context has changed since' },
      },
    },
  },
];

const brief = (i) => ({ id: i.id, key: i.key ?? null, subject: i.subject ?? null, topic: i.topic ?? null, status: i.status, question: i.question, options: i.options, decision: i.decision, note: i.note || undefined, reasked: i.reasked ?? 0, supersedes: i.supersedes ?? null });

// One instance per chat process or session: it remembers whether putusan_list was called.
export function createPutusanTools({ inbox, workspace, session = null }) {
  let listed = false;
  function call(name, args = {}) {
    if (name === 'putusan_list') {
      listed = true;
      const status = args.status ?? 'all';
      const items = inbox.list({ kind: 'putusan' })
        .filter((i) => i.workspace === workspace && (!args.subject || i.subject === args.subject))
        .filter((i) => (status === 'all' ? i.status !== 'expired' : i.status === status));
      const groups = {};
      for (const i of items) (groups[i.subject] ??= []).push(brief(i));
      return { workspace, open: items.filter((i) => i.status === 'pending').length, subjects: groups };
    }
    if (name === 'putusan_ask') {
      if (!listed) throw new InboxError('invalid', 'call putusan_list first, then ask only for a case that is not already open or decided');
      const r = inbox.ask({ ...args, kind: 'putusan', from: 'claude', workspace, session, links: args.links ?? [], meta: { type: 'Putusan', title: String(args.question).slice(0, 200), description: String(args.why ?? '').slice(0, 600), related: `${workspace} / ${args.subject}` } });
      const note = { reasked: 'This case is already open; it was marked as asked again. Do not wait for it: continue or stop.', decided: 'This case was already decided. Use this decision.', created: 'Queued. The user decides it in the Putusan screen; continue with other work.' }[r.result];
      return { result: r.result, item: brief(r.item), note };
    }
    throw new InboxError('invalid', `unknown tool ${name}`);
  }
  return { call };
}
