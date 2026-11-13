---
name: level-up
description: Use when someone says "level up", wants to close a finding from /os-audit, asks what is worth automating, or wants one way of working improved. Takes one task from "this should be easier" to one shipped improvement or verified repair, and removes the task instead when that is the better answer.
---

# Level up

Each run ends with one thing finished: a task removed, a prompt or skill shipped, or a repair verified. Never two. Done weekly, the habit matters as much as the output, because the user starts noticing candidates without being asked.

The reasoning lives in [references/principles.md](references/principles.md). Use a principle when it settles something, in plain words; do not lecture. The user makes the decisions. You ask, keep the order, and do the work they choose.

This skill looks for what could be better. For whether the setup is still accurate, use `/os-audit`; if routes are broken or facts are stale, do that first.

## Timing

Worth starting once at least one tool is connected, usually in the second week; before that there is too little to go on. After that about weekly, or whenever a manual task starts to annoy.

## Read first

Follow the project's own manual for where things live; these are the defaults, and you never create a second copy of any of them. Ask only for what they leave open.

- `context/priorities.md`, `context/about-me.md`: what matters, and what eats the week
- `connections.md`: what can be reached
- the decision log named in `artrios/profile.md`: what was already built or rejected
- `.claude/skills/*/SKILL.md`, frontmatter only: what exists already
- `audits/findings.md`, if present: open findings

## 1. Pick one

If the user brings a finding from `audits/findings.md`, or one is open and clearly worth doing, that is the candidate: skip to the repair path below.

Otherwise ask, one at a time, stopping once you have enough:

1. What did you do three or more times this week?
2. What felt like copying and pasting?
3. What would you hand to a capable new assistant today?
4. What is holding your work back the most right now?
5. What would you do more of if that stopped?

Check the answers against priorities and recent activity. Offer up to three candidates, each with one line on what it would free up, and ask the user to choose. Do this even when they arrive with an idea, since a better one often turns up next to it.

## 2. Should it exist at all?

Ask what breaks if this simply stops. If nothing does, record that in the decision log and end the run: the task is gone, and that counts as the result. If it must stay but varies too much for AI, suggest handing it to a person, record that, and end.

## 3. Scope it

Settle these and write them as one dated entry in the decision log:

- **The process:** what starts it, where the data comes from, how it changes, where it branches, where the result goes. If the user cannot say, stop and ask them to sketch it first.
- **Independence level:** L0 to L4 from the principles. Start from the lowest that solves it. When asked for L4 on a first build, push back and offer L1 or L2; go higher only if the user insists after hearing why.
- **The measure:** one concrete number that should move, such as minutes per week or errors per batch. No measure, no build.

## 4. Build the plainest version

Offer these from the top, with the first that solves the problem already selected. Going lower on the list takes the user's explicit choice.

1. A saved prompt the user runs by hand
2. A skill that runs a script, no AI step
3. A skill with one AI step, such as drafting or classifying
4. A sub-agent, as a last resort

Use `skill-creator` if it is installed, otherwise write the file directly. Build small blocks, the ones without AI first, and look at the real output of each before joining the next.

Every new artifact starts at phase 1:

```markdown
---
rollout-phase: 1  # run by hand and check every result; see level-up references/principles.md
---
```

The phase changes only when the user edits it. If they want to jump ahead, explain what each phase is for and ask them to confirm the lower ones were checked.

## Repair path

A finding is repaired in place; never build a second skill beside a broken one. Take the evidence and closing check from the ledger, ask only for what is missing, and do not assume a connection is broken until you have seen it fail. A routing-only fix goes through `/link`. Skip the frontmatter above: it belongs on new workflow artifacts, not on manuals or indexes. When the closing check passes, the repair is this run's result; suggest `/os-audit followup <ID>` to record it. Use step 3 only as far as the repair needs it.

## Close

On one screen: what was decided, what now exists or is gone, and for a new artifact that it starts at phase 1.

## Limits

Write only to the decision log and the chosen artifact; an agreed repair may also change the files of that workflow. Everything else is read-only. When a result names a principle, point at `references/principles.md` so the user can read the reasoning.

## Checks for the implementer

- Cold run on a filled-in install: candidates come from recent activity, priorities, and the stated time sink. Generic suggestions fail.
- A candidate that should be dropped: the run proposes removing it, logs that, and ends.
- A request for a fully autonomous email replier on the first build: pushback, L1 or L2 offered, nothing at L4 without an explicit override.
- A task a plain script solves: option 2 is preselected.
- A request to jump to phase 4: the phases are explained and confirmation is asked for.
