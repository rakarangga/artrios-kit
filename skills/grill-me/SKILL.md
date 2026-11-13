---
name: grill-me
description: Interview the user hard about a plan, design, or topic, saving every answer to a brainstorm file as you go. Use when the user wants a plan stress-tested, a design questioned, a brainstorm or discovery session run, or what is in their head written down, or says "grill me".
---

# Grill me

Question the user until the two of you understand the topic the same way, and leave a file that holds all of it. The file matters more than the conversation: a long interview outlasts your memory of it, and a session can end at any moment.

## Before the first question

1. Read the project's `AGENTS.md` and `CLAUDE.md`, then only the pages and earlier captures that touch this topic. Use what they already say, so you ask about gaps, changes, and trade-offs rather than known facts. Follow the project's routes instead of starting a second knowledge store.
2. Create `brainstorms/{YYYY-MM-DD}-{topic-slug}.md`, with today's real date from the clock or shell. All captures live in this folder; a polished result can move to a project folder later, but the capture stays. Never overwrite one: a second session on the same day and topic gets a suffix. Continue an old capture only when the user asks, and continue its numbering. With no topic, use `untitled-discovery`, ask what to explore, and record the answer there.
3. Say where you are saving, in one line, and ask Q1.

## After every answer

In this order, before asking anything else:

1. Add the answer to the file, one entry per answer, never several in one write.
2. If it changes something earlier, update the summary and mark the earlier entry as replaced, with a pointer to the new one. Keep the old entry, so the reasoning can still be followed.
3. Read the entry back. If saving failed, say so, keep the answer visible in chat, and do not go on collecting answers as if it had worked.

## How to ask

- One question at a time, and settle what other decisions depend on first.
- If a file or the code can answer it, look instead of asking. When handed a document, read it and raise only what is new.
- For a decision, offer a suggested answer based on what you know, and call it a suggestion. For a fact about the person or the business, ask neutrally. Never feed them a guess and record it as their answer.
- When they cannot answer, write it down as an open flag with who could answer, and move on.
- Stop when they say so, without slipping in one more question. Otherwise continue until the useful branches are covered, and ask near the end whether anything was left out.

## What the file looks like

Keep what the user confirmed, what is only tentative, your own suggestions, and what is unresolved visibly apart.

```
# {Topic}
Date: {date} · Goal: {one line}
Status: in progress | paused | complete
Sources: {pages read, if any}

## Decisions so far
(kept current as answers come in)

## Questions
### Q1 - {topic}
- Asked: {question}
- Answer: {what they confirmed, in their words where the wording matters}
- Suggested, not confirmed: {your ideas or their tentative ones}
- Open: {item -> who can answer}

## Open flags
- {item -> who can answer}
```

## Finishing or pausing

- Read the file through for contradictions and gaps. Mark conflicts as open; never pick a fact on the user's behalf. Set the status, and say where to resume.
- If the session was about building their context, move confirmed facts into the existing context pages with a dated link back, and confirmed decisions into the decision log without duplicates. Leave unknowns and suggestions in the capture.
- If it was only about a plan or design, the capture is the result. Mention `/link` for making it findable and `/level-up` for turning one idea into an improvement, without running either.
- If the manual does not lead to `brainstorms/`, add one route to the folder, following the project's conventions. Single captures need no route. A capture records a dated conversation; it is not current truth.
- Close with a short recap: the file path, the pages you updated, what is still open, and the next step.

## Limits

Only the capture and any context updates the user asked for. No global memory, no publishing, no messages, no changes in outside systems. Do not ask for credentials or save them; refer to them by name.

## Checks for the implementer

Try a fresh session, a same-day name collision, a resume, an answer that corrects an earlier one, a request to stop, and a failed write. Only confirmed facts reach the context pages, and earlier answers stay traceable.
