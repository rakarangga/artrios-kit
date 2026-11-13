# Working principles

How this kit decides what to hand to AI, and how to hand it over safely. `/level-up` quotes these; read them once and come back when a decision feels unclear.

Most of them say the same thing from different sides: start from the task, take the plainest route, and check before you trust.

## Choosing the work

**Ask how far AI can carry it.** Before doing a task the usual way, estimate a share rather than a yes or no. If it cannot carry all of it, what about the first part? An answer from months ago may be out of date, because models change. Try again later.

**Work on tasks, not on jobs.** "Automate my reporting" is too big to start. Fetching the numbers, cleaning them, writing the first paragraph, and sending it are four tasks, and each can be done on its own.

**Find what holds things up the most.** Ask what is holding the work back right now, and what would you do more of if it stopped. Start with the answer that hurts the most. An improvement anywhere else leaves the real limit where it was.

**Remove before you automate.** Ask what breaks if this simply stops. Plenty of work survives on habit alone. Automating it makes the waste faster and harder to notice, so removing it is a full success, not a consolation. If it must stay but varies too much for AI, give it to a person.

**Decide how you will know it worked.** Name one measure before building: minutes spent, errors per week, days to turnaround. Without one, you cannot tell a useful automation from a pleasant one, so do not build it yet.

## Designing it

**Write the process down first.** Five things: what starts it, where the data comes from, how it is changed, where it branches, where the result goes. If you cannot explain it to a colleague, you cannot explain it to a model.

**Give each step the lowest level of independence that works.** Raise a level only after the one below has proven itself.

| Level | What happens | Who is responsible for each result |
|---|---|---|
| L0 | A person does it, no AI | The person |
| L1 | AI suggests, a person decides | The person, every time |
| L2 | AI drafts, a person edits and releases | The person, every time |
| L3 | AI runs inside set rules, a person checks samples | The person, on review |
| L4 | AI runs end to end | Whoever set the rules |

A decision that does not need a model should not go to one. Fixed steps are predictable; a free-roaming agent is the last resort.

**Take the plainest route that works.** New tools arrive every few months and most of them are not needed. A short script you understand beats a clever system you do not.

## Building it

**Small blocks, the ones without AI first.** One input and one output each, the output of one feeding the next. Fetching, formatting, and routing rarely need a model. Where a model is needed, give it one job per step, so it is easy to test, to rewrite, and to move to another model. Ship a small version and let real use decide what comes next. A script can be finished; a step that depends on a model keeps needing attention as models and data change.

**Test each block before joining the next.** Look at its real output. A chain tested only at the end fails without telling you where.

**Ask why.** Do not accept a result you could not defend. Ask for the alternatives and the reasoning, and push back. If you build something you cannot explain, you will not know where to start when it breaks.

## Running it

**Roll out in phases, and record the phase.** Every new artifact carries `rollout-phase` in its frontmatter, and it moves only by a deliberate edit.

| `rollout-phase` | How it runs |
|---|---|
| 1 | By hand. You look at every result |
| 2 | It runs, nothing goes out until you approve it |
| 3 | It runs alone, you read alerts and review batches |
| 4 | It runs alone, you check on it now and then |

When volume is high, start each phase on a small part of it.

**Treat it like a new colleague.** Its own accounts, never yours. Read access until write access has a reason. Keys limited to what it needs. It says it is an assistant and never signs as you. Keep a record of what it did and what it cost.

**Retire what does not pay.** If it keeps needing repairs, gives poor results, or costs more than it saves, take it down. The effort already spent is no reason to keep it.

**One thing at a time, and regularly.** One run, one result, about once a week. A small improvement you finish is worth more than a large one you plan.
