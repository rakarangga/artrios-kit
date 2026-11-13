# artrios-kit

**English** | [Bahasa Indonesia](#bahasa-indonesia)

Work-context kit for Artrios, an AI operating system layer for Claude Code and Codex. Every client gets the same core; client-specific skills live in separate private pack repositories and are installed with `--pack`.

## Contents

| Path | What |
|---|---|
| `artrios/core.md` | Shared rules loaded in every session |
| `artrios/project.md` | Rules for registered project folders |
| `artrios/profile.md` | Owner name, language, task tracker, paths (fill in; `/onboard` does it) |
| `artrios/registry.md`, `inbox.md`, `activity.md` | Working files, start empty |
| `skills/` | 20 core skills |
| `ui/` | The local web UI: workspaces, task board, skills, terminal, Settings > Model |
| `LICENSE`, `NOTICE` | Apache-2.0 license and third-party notices |
| `SECURITY.md`, `CHANGELOG.md` | How to report a problem; release notes |
| `install.sh`, `install.ps1` | One-line bootstrap: clones a tag, starts the wizard |
| `install.py` | The wizard, plain install, and uninstall |

## Requirements

- Python 3.9+ and git.
- A model: the Claude Code CLI signed in with your own account, or an API key for an OpenAI-compatible endpoint (OpenRouter, OpenAI, a local Ollama). Without one, core and skills are still installed and you can run the wizard later.
- For the UI: Node.js 20+ and npm.
- Optional: Codex CLI, `gh` (GitHub CLI), a task tracker with a command-line wrapper, an Obsidian-style wiki folder.

## Quick install

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/rakarangga/artrios-kit/kit-v0.2.0/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rakarangga/artrios-kit/kit-v0.2.0/install.ps1 | iex
```

This clones the kit to `~/artrios-kit` (set `ARTRIOS_KIT_DIR` to change it) and starts the wizard: it checks the machine, sets up a provider, installs core and skills, builds the UI, and asks the seven onboarding questions. Run it again any time with `python install.py --wizard`; it keeps what is set. It never installs `claude` or `codex` for you: it shows the command and you run it.

Provider settings go to `artrios/providers.yaml`, keys to `~/.artrios/.env`. Change them later in the UI under Settings. Signing in to the claude command happens in that command only; this kit never asks for or stores that login.

Remove it with `python install.py --uninstall --apply` (without `--apply` it only shows what would go). It removes the skills identical to the kit's copy and the core import, and asks before removing `.env`. The kit folder and your profile stay.

## Install by hand (Windows, macOS, Linux)

1. Clone the kit where it will stay (the core is read from this folder, so do not move it later):

   ```bash
   git clone https://github.com/<owner>/artrios-kit.git
   cd artrios-kit
   git checkout kit-v0.1.3        # install from a tag, not from main
   ```

2. Dry run, then install. Add `--pack <path>` only for a client pack kept in its own repository:

   ```bash
   python install.py                             # shows what would change
   python install.py --apply                     # core skills
   python install.py --apply --pack <path>      # core plus the skills/ of that pack
   ```

   This copies the skills into `~/.claude/skills` and `~/.codex/skills`, and adds one line importing `artrios/core.md` to `~/.claude/CLAUDE.md`.

3. Start a new Claude Code session in any folder and run `/onboard`. It asks 7 questions and writes `artrios/profile.md` plus your context files. If you prefer, edit `artrios/profile.md` by hand: owner name, `Kit root` (the absolute path of this folder), reply language, task tracker, decision log, wiki.
4. Check it works: ask "who are you?" in a new session (the answer must be Artrios, in your language), or run `/codex-check` if you use Codex.

## Install on a self-hosted server (VPS, Linux)

Same kit, headless. Assumes a Linux VPS with SSH access and a non-root user.

1. Install the tools:

   ```bash
   sudo apt update && sudo apt install -y git python3 nodejs npm
   npm install -g @anthropic-ai/claude-code     # and/or the Codex CLI
   ```

2. Sign in once on the server (`claude`, follow the prompt). Use the account that is allowed to run the agent on this server; do not copy credential files from another machine.
3. Clone the kit with a read-only deploy key or a token limited to this repo (never a personal token with wider access), then install from a tag:

   ```bash
   git clone git@github.com:<owner>/artrios-kit.git ~/artrios-kit
   cd ~/artrios-kit && git checkout kit-v0.1.3
   python3 install.py --apply --pack <path>   # drop --pack for the core only
   ```

4. Edit `artrios/profile.md` by hand (no interview needed on a server): `Kit root` = `/home/<user>/artrios-kit`, language, tracker, paths. Keep `.env` files and secrets out of the kit folder.
5. Verify headless: `cd ~ && claude -p "Who are you and which language do you reply in?"` must answer as Artrios in the profile language.
6. Register project folders on the server with `/link-me` inside each folder, or add rows to `artrios/registry.md`.

## Update

```bash
cd artrios-kit && git fetch --tags && git checkout kit-vX.Y.Z
```

`install.py` never overwrites: a skill folder that already exists with different content is reported as `SKIP`. Remove that skill folder from `~/.claude/skills` and `~/.codex/skills`, then run `python install.py --apply` again. `artrios/core.md` is read straight from the kit folder, so it updates with the checkout. Your own files (`profile.md`, `registry.md`, `inbox.md`, `activity.md`) change by use; keep a copy or `git stash` before switching tags.

## Skills (core, 20)

Run a skill by typing its name in Claude Code (`/name`) or asking Codex to use it (`$name`). Skills marked "manual" run only when you type them; the others can also trigger from a matching request.

| Skill | What it does | How to use |
|---|---|---|
| `/onboard` | Day-1 wizard: 7 questions, then writes `profile.md`, context files, voice file, connections | `/onboard`. Re-run after editing `aios-intake.md`; answered questions are skipped |
| `/os-audit` | Read-only check that routes, indexes, data, connections, and scheduled jobs still match reality; tracks each finding in `audits/findings.md` until it is closed | `/os-audit [subfolder]` monthly and after a reorganization; `/os-audit followup <ID>` after fixing something |
| `/level-up` | Takes one task to one finished result: removed, automated, or repaired | `/level-up` once a week |
| `/grill-me` | Interviews you about a plan or design, saving every answer to `brainstorms/` | `/grill-me <topic>` |
| `/ask-me` | Turns Claude's open questions into a clickable question window (manual) | `/ask-me [topic]` |
| `/commit-this` | Safe checkpoint commit: explicit files only, Conventional Commit, never pushes | `/commit-this [message or scope]` |
| `/git-sync-after-merge` | After a PR is merged: fast-forward main, delete merged branches (local and fork) | "my PR was merged" or `/git-sync-after-merge [repo-path]` |
| `/analisa-trace-playwright` | Finds why Playwright specs failed from `trace.zip` and `error-context.md`: test bug, test stack, or app bug, then fix and re-run | "why did the Playwright tests fail" or `/analisa-trace-playwright [test-results]`; needs Python 3 |
| `/gl` | Last 10 commits of a repo as a graph, with ahead/behind and uncommitted count (manual) | `/gl [project-name]` |
| `/link` | Adds one route to the operating manual so a file, folder, or project is findable (manual) | `/link <path or URL> [when to use it]` |
| `/link-me` | Registers the current folder as an Artrios project (manual) | Run `/link-me [name] [tracker-project]` inside the folder, then start a new session there |
| `/remember` | Saves decisions, facts, and follow-ups to their durable homes (manual) | `/remember [text]`; empty means Claude picks from the conversation |
| `/compact-project` | End-of-session checkpoint: tracker, docs, decision log, wiki, memory pointers, then asks before committing (manual) | `/compact-project <project>` or `/compact-project cross` |
| `/ingest-wiki` | Turns a raw source into connected wiki pages | "ingest ..." or drop a file in `<wiki>/raw/` |
| `/task-sync` | Aligns the task tracker with what is already known; applies after approval (manual) | `/task-sync [project-key]` |
| `/task-review` | Walks tasks per status with reason and proposal; read-only until approved (manual) | `/task-review [backlog\|todo\|progress\|cancelled\|all] [project-key]` |
| `/codex-check` | Asks Codex, read-only, who it is in each registered folder and compares with the registry (manual) | `/codex-check [folder ...]` after changing `core.md` or the registry |
| `/artrios-health` | Checks the Artrios layers: installed core, registry, inbox age, orphaned memory (manual) | `/artrios-health` |
| `/excalidraw` | Builds `.excalidraw` diagrams or decks, renders PNG, fixes what the render shows | "make an architecture diagram"; needs Node, Python, Chromium (`pip install -r skills/excalidraw/requirements.txt`, `python -m playwright install chromium`) |

Skills that need a task tracker (`/task-sync`, `/task-review`) report "no tracker configured" and stop until `artrios/profile.md` names one. Skills that need a wiki (`/ingest-wiki`, the wiki step of `/compact-project`) skip it when the `Wiki` field says "none".

## Release

Tagged `kit-vX.Y.Z`; instances install from a tag. The kit holds work context only: no personal content, no personal paths, and nothing client-specific in `skills/`. The release checker lives in the maintainer's repo, not here.

Parts adapted from the Excalidraw-Deck skill by Brennan Wells (MIT); ideas credited to AIS-OS by Nate Herk. See NOTICE.

Licensed under Apache-2.0; see `LICENSE` and `NOTICE`.

---

# Bahasa Indonesia

[English](#artrios-kit) | **Bahasa Indonesia**

Kit konteks kerja untuk Artrios, lapisan sistem operasi AI untuk Claude Code dan Codex. Semua klien menerima inti yang sama; skill khusus klien ada di repo paket privat terpisah dan dipasang dengan `--pack`.

## Isi

| Jalur | Isi |
|---|---|
| `artrios/core.md` | Aturan bersama yang dimuat di setiap sesi |
| `artrios/project.md` | Aturan untuk folder proyek terdaftar |
| `artrios/profile.md` | Nama pemilik, bahasa, pelacak tugas, jalur (isi sendiri; `/onboard` mengisinya) |
| `artrios/registry.md`, `inbox.md`, `activity.md` | Berkas kerja, awalnya kosong |
| `skills/` | 20 skill inti |
| `ui/` | UI web lokal: workspace, papan tugas, skill, terminal, Settings > Model |
| `LICENSE`, `NOTICE` | Lisensi Apache-2.0 dan catatan pihak ketiga |
| `SECURITY.md`, `CHANGELOG.md` | Cara melaporkan masalah; catatan rilis |
| `install.sh`, `install.ps1` | Bootstrap satu baris: klon tag, jalankan wizard |
| `install.py` | Wizard, pemasangan biasa, dan uninstall |

## Kebutuhan

- Python 3.9+ dan git.
- Satu model: CLI Claude Code yang sudah login dengan akun Anda sendiri, atau API key endpoint OpenAI-compatible (OpenRouter, OpenAI, Ollama lokal). Tanpa itu, inti dan skill tetap terpasang dan wizard bisa dijalankan nanti.
- Untuk UI: Node.js 20+ dan npm.
- Opsional: Codex CLI, `gh` (GitHub CLI), pelacak tugas dengan pembungkus baris perintah, folder wiki gaya Obsidian.

## Pasang cepat

macOS dan Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/rakarangga/artrios-kit/kit-v0.2.0/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rakarangga/artrios-kit/kit-v0.2.0/install.ps1 | iex
```

Perintah ini mengklon kit ke `~/artrios-kit` (ubah dengan `ARTRIOS_KIT_DIR`) lalu menjalankan wizard: mengecek mesin, menyiapkan provider, memasang inti dan skill, membangun UI, dan mengajukan tujuh pertanyaan onboarding. Jalankan lagi kapan saja dengan `python install.py --wizard`; yang sudah terisi tetap dipakai. Wizard tidak memasang `claude` atau `codex`: ia menampilkan perintahnya dan Anda yang menjalankan.

Pengaturan provider masuk ke `artrios/providers.yaml`, key ke `~/.artrios/.env`. Ubah nanti di UI lewat menu Settings. Login ke perintah claude hanya terjadi di perintah itu; kit ini tidak pernah meminta atau menyimpan login tersebut.

Copot dengan `python install.py --uninstall --apply` (tanpa `--apply` hanya menampilkan rencananya). Yang dihapus: skill yang sama persis dengan salinan kit dan impor inti; `.env` ditanyakan dulu. Folder kit dan profil tetap ada.

## Pasang manual (Windows, macOS, Linux)

1. Klon kit ke tempat yang tetap (inti dibaca langsung dari folder ini, jadi jangan dipindah nanti):

   ```bash
   git clone https://github.com/<pemilik>/artrios-kit.git
   cd artrios-kit
   git checkout kit-v0.1.3        # pasang dari tag, bukan dari main
   ```

2. Jalankan uji coba dulu, lalu pasang. Tambahkan `--pack <path>` hanya untuk paket klien yang disimpan di repo sendiri:

   ```bash
   python install.py                             # menampilkan apa yang akan berubah
   python install.py --apply                     # skill inti
   python install.py --apply --pack <path>       # inti ditambah skills/ paket itu
   ```

   Ini menyalin skill ke `~/.claude/skills` dan `~/.codex/skills`, dan menambah satu baris yang mengimpor `artrios/core.md` ke `~/.claude/CLAUDE.md`.

3. Mulai sesi Claude Code baru di folder mana pun dan jalankan `/onboard`. Skill ini mengajukan 7 pertanyaan lalu menulis `artrios/profile.md` dan berkas konteks Anda. Atau isi `artrios/profile.md` manual: nama pemilik, `Kit root` (jalur absolut folder ini), bahasa balasan, pelacak tugas, decision log, wiki.
4. Cek berfungsi: tanya "siapa kamu?" di sesi baru (jawabannya harus Artrios, dalam bahasa Anda), atau jalankan `/codex-check` kalau memakai Codex.

## Pasang di server self-host (VPS, Linux)

Kit yang sama, tanpa antarmuka. Asumsinya VPS Linux dengan akses SSH dan pengguna non-root.

1. Pasang alat:

   ```bash
   sudo apt update && sudo apt install -y git python3 nodejs npm
   npm install -g @anthropic-ai/claude-code     # dan/atau Codex CLI
   ```

2. Login sekali di server (`claude`, ikuti petunjuk). Pakai akun yang boleh menjalankan agen di server ini; jangan menyalin berkas kredensial dari mesin lain.
3. Klon kit dengan deploy key baca-saja atau token yang dibatasi ke repo ini (jangan token pribadi berizin luas), lalu pasang dari tag:

   ```bash
   git clone git@github.com:<pemilik>/artrios-kit.git ~/artrios-kit
   cd ~/artrios-kit && git checkout kit-v0.1.3
   python3 install.py --apply --pack <path>      # hilangkan --pack untuk inti saja
   ```

4. Edit `artrios/profile.md` manual (di server tidak perlu wawancara): `Kit root` = `/home/<user>/artrios-kit`, bahasa, pelacak, jalur. Jauhkan berkas `.env` dan rahasia dari folder kit.
5. Uji tanpa antarmuka: `cd ~ && claude -p "Siapa kamu dan membalas dalam bahasa apa?"` harus menjawab sebagai Artrios dalam bahasa di profil.
6. Daftarkan folder proyek di server dengan `/link-me` di tiap folder, atau tambah baris di `artrios/registry.md`.

## Pembaruan

```bash
cd artrios-kit && git fetch --tags && git checkout kit-vX.Y.Z
```

`install.py` tidak pernah menimpa: folder skill yang sudah ada dengan isi berbeda dilaporkan sebagai `SKIP`. Hapus folder skill itu dari `~/.claude/skills` dan `~/.codex/skills`, lalu jalankan `python install.py --apply` lagi. `artrios/core.md` dibaca langsung dari folder kit, jadi ikut berubah saat checkout. Berkas milik Anda (`profile.md`, `registry.md`, `inbox.md`, `activity.md`) berubah karena dipakai; simpan salinannya atau pakai `git stash` sebelum pindah tag.

## Skill (inti, 20)

Jalankan skill dengan mengetik namanya di Claude Code (`/nama`) atau meminta Codex memakainya (`$nama`). Skill bertanda "manual" hanya jalan saat Anda mengetiknya; sisanya juga bisa terpicu oleh permintaan yang cocok.

| Skill | Fungsi | Cara pakai |
|---|---|---|
| `/onboard` | Wizard hari pertama: 7 pertanyaan, lalu menulis `profile.md`, berkas konteks, berkas suara, koneksi | `/onboard`. Jalankan ulang setelah mengubah `aios-intake.md`; pertanyaan yang sudah dijawab dilewati |
| `/os-audit` | Cek baca-saja bahwa rute, indeks, data, koneksi, dan job terjadwal masih sesuai kenyataan; melacak tiap temuan di `audits/findings.md` sampai ditutup | `/os-audit [subfolder]` bulanan dan setelah reorganisasi; `/os-audit followup <ID>` setelah memperbaiki sesuatu |
| `/level-up` | Membawa satu tugas sampai satu hasil selesai: dihapus, diotomasi, atau diperbaiki | `/level-up` seminggu sekali |
| `/grill-me` | Mewawancarai Anda tentang rencana atau desain, tiap jawaban disimpan ke `brainstorms/` | `/grill-me <topik>` |
| `/ask-me` | Mengubah pertanyaan Claude yang masih terbuka menjadi jendela pilihan yang bisa diklik (manual) | `/ask-me [topik]` |
| `/commit-this` | Commit checkpoint aman: berkas eksplisit saja, Conventional Commit, tidak pernah push | `/commit-this [pesan atau lingkup]` |
| `/git-sync-after-merge` | Setelah PR di-merge: fast-forward main, hapus branch yang sudah merge (lokal dan fork) | "PR saya sudah di-merge" atau `/git-sync-after-merge [jalur-repo]` |
| `/analisa-trace-playwright` | Mencari sebab spec Playwright gagal dari `trace.zip` dan `error-context.md`: bug tes, lingkungan tes, atau bug aplikasi, lalu perbaiki dan jalankan ulang | "kenapa tes Playwright gagal" atau `/analisa-trace-playwright [test-results]`; butuh Python 3 |
| `/gl` | 10 commit terakhir sebuah repo sebagai grafik, lengkap dengan ahead/behind dan jumlah berkas belum di-commit (manual) | `/gl [nama-proyek]` |
| `/link` | Menambah satu rute ke manual operasi agar berkas, folder, atau proyek mudah ditemukan (manual) | `/link <jalur atau URL> [kapan dipakai]` |
| `/link-me` | Mendaftarkan folder saat ini sebagai proyek Artrios (manual) | Jalankan `/link-me [nama] [proyek-pelacak]` di dalam folder itu, lalu mulai sesi baru di sana |
| `/remember` | Menyimpan keputusan, fakta, dan tindak lanjut ke tempat tetapnya (manual) | `/remember [teks]`; kosong berarti Claude memilih dari percakapan |
| `/compact-project` | Checkpoint akhir sesi: pelacak, dokumen, decision log, wiki, penunjuk memori, lalu bertanya sebelum commit (manual) | `/compact-project <proyek>` atau `/compact-project cross` |
| `/ingest-wiki` | Mengubah sumber mentah menjadi halaman wiki yang saling terhubung | "ingest ..." atau taruh berkas di `<wiki>/raw/` |
| `/task-sync` | Menyelaraskan pelacak tugas dengan yang sudah diketahui; diterapkan setelah persetujuan (manual) | `/task-sync [kunci-proyek]` |
| `/task-review` | Menelusuri tugas per status dengan alasan dan usulan; hanya baca sampai disetujui (manual) | `/task-review [backlog\|todo\|progress\|cancelled\|all] [kunci-proyek]` |
| `/codex-check` | Menanyai Codex (baca-saja) siapa dirinya di tiap folder terdaftar dan membandingkan dengan registry (manual) | `/codex-check [folder ...]` setelah mengubah `core.md` atau registry |
| `/artrios-health` | Mengecek lapisan Artrios: core terpasang, registry, usia inbox, memori yatim (manual) | `/artrios-health` |
| `/excalidraw` | Membuat diagram atau deck `.excalidraw`, merender PNG, memperbaiki yang tampak di render | "buat diagram arsitektur"; butuh Node, Python, Chromium (`pip install -r skills/excalidraw/requirements.txt`, `python -m playwright install chromium`) |

Skill yang butuh pelacak tugas (`/task-sync`, `/task-review`) melapor "no tracker configured" lalu berhenti sampai `artrios/profile.md` menyebut satu. Skill yang butuh wiki (`/ingest-wiki`, langkah wiki di `/compact-project`) melewatinya bila field `Wiki` berisi "none".

## Rilis

Bertag `kit-vX.Y.Z`; instance memasang dari tag. Kit hanya berisi konteks kerja: tanpa isi pribadi, tanpa jalur pribadi, dan tanpa apa pun yang khusus klien di `skills/`. Pemeriksa rilis ada di repo pemelihara, bukan di sini.

Sebagian diadaptasi dari skill Excalidraw-Deck oleh Brennan Wells (MIT); ide dikreditkan ke AIS-OS oleh Nate Herk. Lihat NOTICE.

Berlisensi Apache-2.0; lihat `LICENSE` dan `NOTICE`.
