---
name: ask-me
description: Use when the user runs /ask-me, with or without a topic, to get Claude's pending questions as a clickable question window (AskUserQuestion) instead of numbered questions typed in chat. Claude collects the open questions from the conversation or the given topic, turns each into a short multiple-choice question with a recommended option, and acts on the answers. Global skill; works from any folder.
disable-model-invocation: true
argument-hint: "[optional: topic or question; empty = take the questions still open in the conversation]"
---

# /ask-me

Show the user the questions in a question window so the answer is a click (or a short typed line), not a manual chat reply. Input: `$ARGUMENTS`.

## 1. Collect the questions

- **With text:** that topic or question is the subject. Turn it into window questions.
- **Empty (normal case):** do not ask "what should I ask". Take the questions that are open in the conversation: choices you were about to type as a numbered list, `[CEK]` items waiting for the user, commit questions, approvals you need, and decisions the next step depends on.
- **Drop** any question you can answer yourself from code, files, the task tracker, the wiki, or sensible defaults. Say what you decided in one line ("I decided on my own: ...") so the user can overrule.
- Nothing open: say so in one line and stop. Do not invent questions.

## 2. Build the window

Call the question tool (`AskUserQuestion`) with 1 to 4 questions per call:

- `question`: complete, specific, ends with `?`, in the user's language (`artrios/profile.md`). Name the thing (repo, file, task key), not "that".
- `header`: at most 12 characters (for example "Commit repo", "Audit account", "Skill").
- `options`: 2 to 4, each mutually exclusive unless `multiSelect` is true. Label 1 to 5 words; description says what happens if chosen, including cost or risk. Put the recommended option first and end its label with "(Recommended)". Do not add an "Other" option; the window adds it for free text.
- Use `preview` only when options are concrete things to compare (layouts, code, config).
- Open-ended questions (names, paths, dates): offer your best guesses as options; the free-text "Other" covers the rest.
- Commit questions use the standard form: `Commit in <repo>?` with the in-scope files in the question text, options "Yes, commit" and "Not yet" (in the user's language). Never pushing is implied.
- More than 4 open questions: ask the 4 that block the next step first, then a second window with the rest after acting on the first answers.

## 3. Act on the answers

- Treat each answer as the user's decision for that question only. Approval for one item does not extend to another.
- Carry out what the answers unblock right away. Do not repeat the questions in chat.
- Save decisions the usual way (the project's decision log, the task tracker, project docs) when they are real decisions, not preferences for this one step.
- A free-text answer that contradicts all options: follow it and say how you read it in one line.
- If the window is unavailable (tool missing, another harness, or the user dismissed it), fall back to the same questions as a numbered list in chat, in the same wording.

## Guardrails

- Never ask for secrets, tokens, or `.env` values in the window; ask where they live.
- Do not use the window for questions the user already answered in this session.
- Do not use it for a plain "continue?" when the next step was clearly requested.
- If the project or context is unclear, that is a question for the window, never a guess.
