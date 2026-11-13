# Security policy / Kebijakan keamanan

## Supported versions

Only the latest tagged release (`kit-vX.Y.Z`) receives fixes. Install from a tag, not from `main`.

## Reporting a vulnerability

Do not open a public issue with exploit details. Use GitHub's private vulnerability reporting for this repository
(Security tab, "Report a vulnerability"). Include the affected version or tag, the skill or script involved, and the
steps to reproduce. A fix ships as a new tag with a note in `CHANGELOG.md`.

## What to keep in mind when using the kit

- Skills are instructions that an AI agent runs with your account's permissions. Read a skill before installing it.
- `install.py` copies skills and adds one import line to your Claude Code `CLAUDE.md`. It never deletes anything; a
  skill that already exists with different content is reported and left alone.
- Never put keys, tokens, `.env` files, or private addresses in the kit, in `artrios/profile.md`, or in notes.
- Client packs live in separate private repositories; install a pack only from a source you trust.

## Versi yang didukung

Hanya rilis bertag terbaru (`kit-vX.Y.Z`) yang mendapat perbaikan. Pasang dari tag, bukan dari `main`.

## Melaporkan celah

Jangan membuka issue publik berisi detail eksploit. Gunakan pelaporan celah privat GitHub untuk repositori ini
(tab Security, "Report a vulnerability"). Sertakan versi atau tag, skill atau skrip yang terkait, dan langkah
mereproduksi. Perbaikan dirilis sebagai tag baru dengan catatan di `CHANGELOG.md`.
