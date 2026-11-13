# Artrios profile

Filled by `/onboard`. Kit skills read this file instead of assuming names, language, or tools. Edit by hand any time.

| Field | Value |
|---|---|
| Owner name | [name] |
| Kit root | [absolute path of the folder holding `artrios/core.md`] |
| Reply language | [for example: English, Bahasa Indonesia] |
| Task tracker | Artrios board (kanban in the Artrios UI; task cards are files). Change only if you already run another tracker |
| Tracker wrapper | the kit's `artrios-task` command (`ui/bin/artrios-task.js`: list, add, move, done, note) |
| Tracker rules file | [path to the file describing task states and keys; optional] |
| Decision log | [path, for example `decisions/log.md`] |
| Priorities file | [path, for example `context/priorities.md`] |
| Wiki | [path of the knowledge vault, or "none"] |
| Client pack paths | [only for a client pack that needs them, for example the folder of a client project]|

## Notes

- Task states the kit expects: Backlog, Todo, In Progress, Done, Cancelled. Map your tracker's names here if they differ.
- The default tracker is the Artrios board; `/onboard` does not offer or ask for an external tracker. Only if the owner names one on their own does this file name it. With the field set to "none", `/task-sync` and `/task-review` report "no tracker configured" and stop.
