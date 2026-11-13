---
name: onboard
description: Use on the first day after installing the Artrios kit, or when someone says "set me up", "onboard me", or wants their AIOS context filled in. Fills in the seven-question intake and writes the first-day files in one go. Safe to re-run after editing aios-intake.md.
---

# Onboard

Everything starts from one file, `aios-intake.md`. This skill fills in what is missing, then writes the first-day files from it. The installer wizard's form fills in the same file, so a user who answered there lands straight on the writing step.

Installing the skill does not run it. A project that already has its own context, voice, or connection files keeps them: read `AGENTS.md` and `CLAUDE.md` first, update the source the project already uses, and leave unrelated rules and routes alone.

If `aios-intake.md` does not exist, start it from [the template](assets/aios-intake.md). Fill in only what existing sources clearly say, and note where it came from.

## Read the intake

A question is unanswered while its block still holds a bracketed placeholder.

- All answered: go to "Write the files".
- Some answered: say which, and let the user choose between finishing now or building from what is there.
- None: ask them all.

## Ask (seven questions, never an eighth)

One at a time. Save each answer to `aios-intake.md` as soon as you have it, so an interrupted run picks up where it stopped.

| # | Ask about | Feeds |
|---|---|---|
| Q1 | Who they are, what they offer, who it is for | about-me, about-business, profile |
| Q2 | Two pieces of their own recent writing | voice |
| Q3 | Two or three priorities for the next 90 days | priorities |
| Q4 | Where revenue lands and where it is tracked | connections: revenue and finance |
| Q5 | Where they talk to customers, team, and outsiders | connections: customers, calendar, team |
| Q6 | Where recordings, notes, and documents live | connections: meetings, documents |
| Q7 | The task that eats their week, and where work is tracked | about-me, connections: tasks |

Two of these need care:

- **Q2 is pasted, never written.** If the user starts composing a sample in the chat, stop them politely and ask for a real email or post. Text written for this conversation takes on its tone and teaches the wrong voice.
- **Q3 needs something checkable.** "Grow the business" gets one follow-up asking for a number, a date, or a deliverable.

The calendar usually follows from Q5 (Gmail, Google Calendar; Outlook, Outlook Calendar). Confirm it when you write the files instead of asking separately.

## Write the files

Write all of these at once, without asking file by file. The user changes answers in `aios-intake.md` and re-runs. If a file exists and would change, first copy it to `archives/intake-{YYYY-MM-DD-HHMM}/`; files that would not change are left alone.

| File | Content |
|---|---|
| `context/about-me.md` | Who they are, and their biggest time sink (Q1, Q7) |
| `context/about-business.md` | What they offer, for whom, and where revenue goes (Q1, Q4) |
| `context/priorities.md` | Q3, numbered, one line each |
| `references/voice.md` | Q2 unchanged, under a note: match this register when drafting, and show the owner anything external before it goes out |
| `connections.md` | One row each: revenue and finance, customer communication, calendar, team and outside communication, tasks, meetings, documents. Every row starts as not yet connected, no auth, never checked |
| `artrios/profile.md` | Owner name, reply language (ask once if unclear), decision log location. Task tracker and wrapper keep the default (the Artrios board and the kit's `artrios-task` command); never offer or ask about an external tracker, change it only if the owner names one unprompted. Other skills read this file instead of assuming names or tools |
| `AGENTS.md` / `CLAUDE.md` | Fill any `{{...}}` placeholders: name, top priority, voice and connection summaries. In an established manual, change only the route to the chosen context |

Connecting tools comes later, so nothing here writes `.env` or asks for a key. Do not create other skills during onboarding; new ones come through `/level-up`.

## Close

Three lines at most:

```
Done. Your AIOS now knows who you are, what you offer, this quarter's priorities, and how you write.
Now: ask me "What should I focus on this week?"
Next: connect one tool from connections.md. After a week, run /os-audit.
```

When they ask that question, answer only from the new files: three bullets in the register of their own samples, each tied to one priority, then the one thing to start with on Monday and why. Offer to draft the first message, and ask how far AI could carry that task. An answer that could fit anyone has failed.

## Re-running

Answered questions are skipped unless the user wants to change them. Only files whose content changes get rewritten and backed up.

## Checks for the implementer

- Fresh install: seven answers, files written, and the closing answer cites their actual role, priorities, and time sink.
- Change one priority and re-run: only `context/priorities.md` changes (plus the manual's priority line, if any), and a backup appears.
- Compose a sample in the chat: refused, and a pasted one is requested.
