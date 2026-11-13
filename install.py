#!/usr/bin/env python3
"""Install the Artrios kit on this machine.

  python install.py [--pack PATH] [--home PATH] [--apply]     core and skills; dry run without --apply
  python install.py --wizard [--pack PATH] [--home PATH]      guided setup: provider, core and skills, UI, onboarding form
  python install.py --service start|stop|restart|status|remove   UI in the background (service.py)
  python install.py --autostart on|off|status                 start the UI when you log in
  python install.py --update kit-vX.Y.Z                       switch to a release tag, rebuild the UI, roll back on failure
  python install.py --uninstall [--home PATH] [--apply]       removes what the kit installed; dry run without --apply

Core and skills:
  1. copies skills/* (and PATH/skills/* with --pack) into <home>/.claude/skills and <home>/.codex/skills
     (--pack points at a client pack kept in its own repository; a pack with its own installer
     can filter per environment, run that installer instead)
  2. adds one import line for artrios/core.md to <home>/.claude/CLAUDE.md (created if missing)
A skill folder that already exists with different content is reported and left alone; remove it by hand to update.

Wizard: provider settings go to artrios/providers.yaml, keys to <home>/.artrios/.env (never to git, memory, or docs).
It never installs claude or codex: it shows the command and checks again. With no provider, core and skills are
still installed; run the wizard again later.

Uninstall: removes skills identical to the kit's copy and the core import line. Asks before removing .env
(--remove-env says yes in advance). The kit folder and your profile are not touched.
"""
import argparse
import filecmp
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

from service import HOST_ONLY, is_wsl, which
from datetime import datetime
from pathlib import Path

KIT = Path(__file__).resolve().parent
MARK = "<!-- artrios-kit -->"
ROOTS = (Path(".claude") / "skills", Path(".codex") / "skills")
PRESETS = [
    ("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    ("openai", "OpenAI", "https://api.openai.com/v1", "OPENAI_API_KEY"),
    ("ollama", "Ollama (local, no key)", "http://127.0.0.1:11434/v1", ""),
    ("custom", "Other OpenAI-compatible endpoint", "", ""),
]
# Checked against the vendors' docs on 2026-11-06. Installing stays the user's own step (decision: Q4).
CLI_HELP = {
    "claude": {
        "win32": "irm https://claude.ai/install.ps1 | iex",
        "other": "curl -fsSL https://claude.ai/install.sh | bash",
        "docs": "https://code.claude.com/docs/en/setup",
    },
    "codex": {
        "win32": None,
        "other": "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        "docs": "https://learn.chatgpt.com/docs/codex/cli",
    },
}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
ARGS_HOME = str(Path.home())
FIELDS = ("transport", "base_url", "key_env", "model")


# ---------------------------------------------------------------- core and skills


def write_file(path: Path, text: str) -> None:
    """Writes exactly these characters: text mode on Windows would turn every newline into CRLF."""
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def read_file(path: Path) -> str:
    """Reads without newline translation, so the user's own line endings survive an edit."""
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def same(a: Path, b: Path) -> bool:
    cmp = filecmp.dircmp(a, b)
    if cmp.left_only or cmp.right_only or cmp.diff_files:
        return False
    return all(same(a / d, b / d) for d in cmp.common_dirs)


def skill_sources(pack):
    sources = sorted((KIT / "skills").iterdir())
    if pack:
        folder = Path(pack).expanduser().resolve() / "skills"
        if not folder.is_dir():
            raise SystemExit(f"no skills/ folder in pack: {pack}")
        sources += sorted(folder.iterdir())
    return [s for s in sources if s.is_dir()]


def core_line() -> str:
    return f"@{(KIT / 'artrios' / 'core.md').as_posix()}"


def install_core(home: Path, pack, apply: bool) -> int:
    conflicts = 0
    sources = skill_sources(pack)
    for rel in ROOTS:
        target_root = home / rel
        for src in sources:
            dst = target_root / src.name
            if not dst.exists():
                print(f"{'COPY ' if apply else 'would copy '} {src.name} -> {dst}")
                if apply:
                    shutil.copytree(src, dst)
            elif same(src, dst):
                print(f"ok    {src.name} already installed in {target_root}")
            else:
                conflicts += 1
                print(f"SKIP  {src.name} differs in {target_root}; remove it by hand to update")

    claude_md = home / ".claude" / "CLAUDE.md"
    line = core_line()
    text = read_file(claude_md) if claude_md.exists() else ""
    if line in text:
        print("ok    core import already in", claude_md)
    else:
        print(f"{'ADD  ' if apply else 'would add'} core import to {claude_md}")
        if apply:
            claude_md.parent.mkdir(parents=True, exist_ok=True)
            eol = "\r\n" if "\r\n" in text else "\n"
            write_file(claude_md, text.rstrip("\r\n") + (eol * 2 if text.strip() else "") + MARK + eol + line + eol)
    return conflicts


# ---------------------------------------------------------------- UI rebuild after a version change
def ui_version(folder: Path):
    try:
        return json.loads(read_file(folder / "package.json")).get("version")
    except (OSError, ValueError):
        return None


def update_ui(home: Path, apply: bool) -> int:
    """After a tag switch: rebuilds apps/artrios-ui when its version differs from ui/ (scaffold keeps data/, port, password)."""
    target = KIT / "apps" / "artrios-ui"
    if not target.is_dir():
        return 0
    want, have = ui_version(KIT / "ui"), ui_version(target)
    if want == have and (target / "client" / "dist").exists():
        print(f"ok    UI {have} already current in {target}")
        return 0
    print(f"{'UPDATE' if apply else 'would update'} UI {have} -> {want} in {target}")
    if not apply:
        return 0
    node, npm = which("node"), which("npm")
    if not node or not npm:
        print("FAIL  UI not rebuilt: Node 20+ and npm are needed")
        return 1
    import service
    was_running = service.running_pid(home) is not None
    if was_running:
        service.stop(home)
    run = lambda cmd, cwd: subprocess.run(cmd, cwd=str(cwd), check=False).returncode == 0
    keys = home / ".artrios" / ".env"
    ok = run([node, str(KIT / "ui" / "bin" / "scaffold.js"), "--target", str(target), "--kit", str(KIT), "--keys-file", str(keys)], KIT)
    ok = ok and run([npm, "install"], target) and run([npm, "run", "build"], target)
    if was_running:
        service.start(home)
    if not ok:
        print("FAIL  the UI was not rebuilt; the error is above")
        return 1
    print(f"ok    UI rebuilt to {want}" + ("; service restarted" if was_running else ""))
    return 0


# ---------------------------------------------------------------- update to a release tag (UI Update button, AIOS-130)
TAG_RE = re.compile(r"^kit-v\d+\.\d+\.\d+$")
LOCAL_FILES = ("profile.md", "registry.md", "inbox.md", "activity.md")  # tracked templates that change by use


def git(*args: str):
    r = subprocess.run(["git", *args], cwd=str(KIT), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    return r.returncode, (r.stdout + r.stderr).rstrip()


def update_kit(home: Path, tag: str) -> int:
    """Switch the kit to a release tag: back up local files, stop the service, checkout, apply, rebuild UI, start.
    Any failure puts the previous version back. The result goes to <home>/.artrios/update-result.json and update.log."""
    import service
    state = home / ".artrios"
    state.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    logf = state / "update.log"

    def log(msg: str) -> None:
        print(msg)
        with open(logf, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n")

    result = {"tag": tag, "ok": False, "rolledBack": False, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "error": "", "backup": ""}

    def finish(code: int) -> int:
        write_file(state / "update-result.json", json.dumps(result, indent=2) + "\n")
        return code

    if not TAG_RE.match(tag):
        result["error"] = f"not a release tag: {tag}"
        log("FAIL  " + result["error"])
        return finish(2)
    git("fetch", "--tags", "--quiet", "origin")
    if git("rev-parse", "-q", "--verify", f"refs/tags/{tag}")[0] != 0:
        result["error"] = f"tag {tag} not found"
        log("FAIL  " + result["error"])
        return finish(1)
    code, out = git("status", "--porcelain", "--untracked-files=no")
    local = {f"artrios/{n}" for n in LOCAL_FILES}
    dirty = [ln[3:].strip().strip('"') for ln in out.splitlines() if ln.strip()]
    dirty = [f for f in dirty if f.replace("\\", "/") not in local]
    if code != 0 or dirty:
        result["error"] = "local changes in: " + ", ".join(dirty or ["(git status failed)"]) + ". Nothing was changed."
        log("FAIL  " + result["error"])
        return finish(1)

    prev_branch = git("symbolic-ref", "-q", "--short", "HEAD")[1]
    prev = prev_branch or (git("describe", "--tags", "--exact-match")[1] if git("describe", "--tags", "--exact-match")[0] == 0 else "") or git("rev-parse", "HEAD")[1]
    result["from"] = prev
    backup = state / "backup" / f"kit-update-{stamp}"
    backup.mkdir(parents=True, exist_ok=True)
    for n in LOCAL_FILES:
        f = KIT / "artrios" / n
        if f.exists():
            shutil.copy2(f, backup / n)
    result["backup"] = str(backup)
    log(f"ok    backed up local files to {backup}")

    def restore_local() -> None:
        for n in LOCAL_FILES:
            if (backup / n).exists():
                shutil.copy2(backup / n, KIT / "artrios" / n)

    was_running = service.running_pid(home) is not None
    if was_running:
        service.stop(home)

    def switch(ref: str) -> bool:
        c, o = git("checkout", "--force", ref)  # only the local files could be dirty, and they are backed up
        if c != 0:
            log("FAIL  git checkout " + ref + ": " + o[:300])
            return False
        restore_local()
        return True

    ok = switch(tag)
    if ok:
        log(f"ok    kit is at {tag}")
        install_core(home, None, True)
        ok = update_ui(home, True) == 0
        if not ok:
            result["error"] = "the UI did not rebuild (npm install or build failed)"
    if not ok:
        result["error"] = result["error"] or "the update failed; see update.log"
        log(f"ROLLBACK to {prev}")
        if switch(prev):
            update_ui(home, True)
        result["rolledBack"] = True
    else:
        result["ok"] = True
        log(f"ok    updated {prev} -> {tag}")
    if was_running:
        service.start(home)
    return finish(0 if result["ok"] else 1)


# ---------------------------------------------------------------- uninstall


def uninstall(home: Path, apply: bool, remove_env) -> int:
    kept = 0
    for rel in ROOTS:
        target_root = home / rel
        for src in skill_sources(None):
            dst = target_root / src.name
            if not dst.exists():
                continue
            if same(src, dst):
                print(f"{'REMOVE' if apply else 'would remove'} {dst}")
                if apply:
                    shutil.rmtree(dst)
            else:
                kept += 1
                print(f"KEEP  {dst} differs from the kit's copy (edited, or from another source); remove it by hand if you want")

    claude_md = home / ".claude" / "CLAUDE.md"
    if claude_md.exists():
        text = read_file(claude_md)
        line = core_line()
        if line in text:
            print(f"{'REMOVE' if apply else 'would remove'} core import from {claude_md}")
            if apply:
                eol = "\r\n" if "\r\n" in text else "\n"
                lines = [ln for ln in text.splitlines() if ln.strip() not in (MARK, line)]
                write_file(claude_md, eol.join(lines).strip("\r\n") + (eol if any(lines) else ""))

    env_file = home / ".artrios" / ".env"
    if env_file.exists():
        if not apply:
            print(f"would ask whether to remove {env_file}")
        else:
            answer = remove_env if remove_env is not None else ask_yes(f"Remove your keys file {env_file}?", False)
            if answer:
                env_file.unlink()
                print("REMOVE", env_file)
            else:
                print("KEEP ", env_file)
    print(f"Not touched: this kit folder ({KIT}), artrios/profile.md, your context files.")
    if not apply:
        print("\nDry run. Add --apply to remove.")
    return 0


# ---------------------------------------------------------------- prompts


def ask(question: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        answer = input(f"{T(question)}{suffix}: ").strip()
    except EOFError:
        return default
    return answer or default


def ask_yes(question: str, default: bool = True) -> bool:
    answer = ask(f"{question} ({'Y/n' if default else 'y/N'})").lower()
    return default if not answer else answer.startswith("y")


def ask_secret(question: str) -> str:
    # The key is not echoed. getpass needs a real console; a piped stdin (tests) is read as a plain line.
    if sys.stdin.isatty():
        import getpass
        return getpass.getpass(f"{question}: ").strip()
    return ask(question)


def ask_block(question: str) -> str:
    """Multi-line answer for pasted text: a line with a single dot ends it."""
    print(f"{T(question)}\n  {T('(paste or type; finish with a line holding only a dot)')}")
    lines = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip() == ".":
            break
        lines.append(line)
    return "\n".join(lines).strip()


# ---------------------------------------------------------------- wizard language (English or Bahasa Indonesia)

LANG = "en"
# English text -> Indonesian. A text without an entry shows in English. Keys are the exact English templates.
ID = {
    "(paste or type; finish with a line holding only a dot)": "(tempel atau ketik; akhiri dengan satu baris berisi titik saja)",
    "Choose": "Pilih",
    "Check again now?": "Cek lagi sekarang?",
    "Which one is the primary?": "Mana yang jadi provider utama?",
    "Install the UI?": "Pasang UI?",
    "Start the UI automatically when you log in?": "Jalankan UI otomatis saat Anda login?",
    "Start it now too?": "Jalankan sekarang juga?",
    "Fill it in now?": "Isi sekarang?",
    "Your name": "Nama Anda",
    "Reply language": "Bahasa balasan",
    "Base URL (ends in /v1 for most)": "Base URL (kebanyakan berakhir /v1)",
    "Name for the key variable, empty for no key": "Nama variabel kunci, kosongkan jika tanpa kunci",
    "Short name for this provider (lowercase, digits, dashes)": "Nama pendek provider ini (huruf kecil, angka, strip)",
    "Model name, as this endpoint spells it": "Nama model, seperti ditulis endpoint ini",
    "Start the UI now?": "Jalankan UI sekarang?",
    "\n== Checking this machine ==": "\n== Memeriksa komputer ini ==",
    "{flag} Node {out} (the UI needs 20 or newer)": "{flag} Node {out} (UI butuh versi 20 atau lebih baru)",
    "WARN  could not read the Node version": "WARN  versi Node tidak terbaca",
    "MISS  Node.js: the UI needs Node 20 or newer (https://nodejs.org); skills work without it": "MISS  Node.js: UI butuh Node 20 atau lebih baru (https://nodejs.org); skills tetap jalan tanpa Node",
    "WARN  {name} was found only as the Windows program ({path}). It cannot run a Linux install, so it counts as missing. Install it inside this Linux system{hint}.": "WARN  {name} hanya ditemukan sebagai program Windows ({path}). Itu tidak bisa dipakai untuk instalasi Linux, jadi dianggap belum ada. Pasang di dalam sistem Linux ini{hint}.",
    " (for example with nvm: https://github.com/nvm-sh/nvm, then `nvm install 22`)": " (misalnya dengan nvm: https://github.com/nvm-sh/nvm, lalu `nvm install 22`)",
    "  Install {name} yourself:\n    {cmd}": "  Pasang {name} sendiri:\n    {cmd}",
    "  Docs: {docs}": "  Dokumentasi: {docs}",
    "  Open a new terminal after installing so the PATH is fresh.": "  Buka terminal baru setelah memasang supaya PATH terbarui.",
    "\nEndpoint:": "\nEndpoint:",
    "  skipped": "  dilewati",
    "  A base URL must start with http:// or https://. Skipped.": "  Base URL harus diawali http:// atau https://. Dilewati.",
    "  A key variable uses uppercase letters, digits and underscores. Skipped.": "  Variabel kunci memakai huruf besar, angka, dan garis bawah. Dilewati.",
    "  A model name is required. Skipped.": "  Nama model wajib diisi. Dilewati.",
    "API key (stored in {env_file} as {key_env}; leave empty to keep the current one)": "API key (disimpan di {env_file} sebagai {key_env}; kosongkan untuk mempertahankan yang ada)",
    "  Testing with one short call...": "  Menguji dengan satu panggilan singkat...",
    "  ok: {reply}": "  ok: {reply}",
    "  The test failed: {err}\n  The provider is saved; fix it in Settings > Model or run the wizard again.": "  Tes gagal: {err}\n  Provider tersimpan; perbaiki di Settings > Model atau jalankan wizard lagi.",
    "\n== Model provider ==": "\n== Provider model ==",
    "Skills and the UI need a model. Use the claude command (your own sign-in), or an API key from an OpenAI-compatible endpoint.": "Skills dan UI butuh model. Pakai perintah claude (login Anda sendiri), atau API key dari endpoint yang kompatibel dengan OpenAI.",
    "Already set: {names} (primary: {primary})": "Sudah diatur: {names} (utama: {primary})",
    "\n  1. Claude Code CLI": "\n  1. Claude Code CLI",
    " (not found yet)": " (belum ditemukan)",
    "  2. API key or gateway (OpenRouter, OpenAI, Ollama, other)": "  2. API key atau gateway (OpenRouter, OpenAI, Ollama, lainnya)",
    "  3. Done / skip for now": "  3. Selesai / lewati dulu",
    "  Not found. Install it, open a new terminal, and run the wizard again.": "  Tidak ditemukan. Pasang, buka terminal baru, lalu jalankan wizard lagi.",
    "  Added. Sign in by running `claude` yourself; this kit never handles that login.": "  Ditambahkan. Login dengan menjalankan `claude` sendiri; kit ini tidak pernah menangani login itu.",
    "\nProviders: {names}": "\nProvider: {names}",
    "Primary provider: {primary}": "Provider utama: {primary}",
    "none": "belum ada",
    "Skills are installed. They run in a terminal once the claude command is installed and signed in, and the UI chat needs a provider: add one in the UI under Settings > Model, or run the wizard again.": "Skills sudah terpasang. Di terminal skills jalan setelah perintah claude terpasang dan login, dan chat UI butuh provider: tambahkan di UI lewat Settings > Model, atau jalankan wizard lagi.",
    "none yet": "belum ada",
    ". The skills in a terminal need the claude command, and the UI chat needs a provider: add one in the UI under Settings > Model, or run the wizard again.": ". Skills di terminal butuh perintah claude, dan chat UI butuh provider: tambahkan di UI lewat Settings > Model, atau jalankan wizard lagi.",
    "\n== Local web UI ==": "\n== UI web lokal ==",
    "Skipped: needs Node 20+ and npm. Install them, then run the wizard again.": "Dilewati: butuh Node 20+ dan npm. Pasang keduanya, lalu jalankan wizard lagi.",
    "The UI did not install; the error is above. On Windows a native module may need build tools. Everything else is in place.": "UI gagal terpasang; error ada di atas. Di Windows modul native mungkin butuh build tools. Yang lain sudah terpasang.",
    "\nThe UI asks for a password. Choose one now; you will set your own at the first sign-in.": "\nUI meminta password. Pilih satu sekarang; Anda akan menggantinya saat login pertama.",
    "No password was saved. Run `npm run password` in {target} before `npm start`.": "Password belum tersimpan. Jalankan `npm run password` di {target} sebelum `npm start`.",
    "UI is ready. Sign in as administrator; add or change providers there in Settings.": "UI siap. Login sebagai administrator; tambah atau ubah provider di Settings.",
    "Manual start any time:\n  cd \"{target}\"\n  npm start\nor in the background: python install.py --service start (also stop, restart, status, remove).": "Jalankan manual kapan saja:\n  cd \"{target}\"\n  npm start\natau di latar belakang: python install.py --service start (juga stop, restart, status, remove).",
    "The UI was built but did not answer on localhost. Try `npm start` in {target} and read the error.": "UI sudah dibangun tetapi tidak menjawab di localhost. Coba `npm start` di {target} dan baca errornya.",
    "\n== Start with the device ==": "\n== Jalan bersama perangkat ==",
    "Now: {status}.": "Sekarang: {status}.",
    "Manual: start it yourself with `npm start` or `python install.py --service start`.": "Manual: jalankan sendiri dengan `npm start` atau `python install.py --service start`.",
    "\n== Onboarding form ==": "\n== Form onboarding ==",
    "Seven questions, one minute each. Answers go to aios-intake.md and you can edit them there and run this again.": "Tujuh pertanyaan, satu menit tiap pertanyaan. Jawaban masuk ke aios-intake.md; Anda bisa mengeditnya di sana dan menjalankan ini lagi.",
    "Skipped. Later: run the wizard again, or /onboard in a session.": "Dilewati. Nanti: jalankan wizard lagi, atau /onboard di sebuah sesi.",
    "{key}: already answered, kept.": "{key}: sudah dijawab, dipertahankan.",
    "Written: {files}": "Tertulis: {files}",
    "nothing changed": "tidak ada yang berubah",
    "The summary waits for a provider: run the wizard again when you have one.": "Ringkasan menunggu provider: jalankan wizard lagi setelah Anda punya satu.",
    "Writing a short summary with your provider...": "Menulis ringkasan singkat dengan provider Anda...",
    "Written: context/summary.md": "Tertulis: context/summary.md",
    "No summary this time; the other files are complete. Run the wizard again to retry.": "Belum ada ringkasan kali ini; file lainnya lengkap. Jalankan wizard lagi untuk mencoba ulang.",
    "Artrios kit setup. Kit folder: {kit}": "Setup Artrios kit. Folder kit: {kit}",
    "Files outside the kit folder: skills in .claude and .codex, one import line in .claude/CLAUDE.md, keys in .artrios/.env.": "File di luar folder kit: skills di .claude dan .codex, satu baris import di .claude/CLAUDE.md, kunci di .artrios/.env.",
    "\n== Core and skills ==": "\n== Core dan skills ==",
    "\n== Done ==": "\n== Selesai ==",
    "Open the UI:  {url}": "Buka UI:  {url}",
    "Sign in as administrator with the password you just set (the UI asks for a new one at the first sign-in).": "Login sebagai administrator dengan password yang baru Anda buat (UI meminta password baru saat login pertama).",
    "The UI is not running. Start it: python install.py --service start   (or: cd \"{target}\" && npm start)": "UI belum jalan. Jalankan: python install.py --service start   (atau: cd \"{target}\" && npm start)",
    "WSL: open that address in the Windows browser; WSL forwards localhost.": "WSL: buka alamat itu di browser Windows; WSL meneruskan localhost.",
    "Next: no provider yet. In the UI go to Settings > Model and add one (or install the claude command and run the wizard again).": "Berikutnya: belum ada provider. Di UI buka Settings > Model dan tambahkan satu (atau pasang perintah claude lalu jalankan wizard lagi).",
    "Check it: start a new session with your CLI and ask \"who are you?\".": "Cek: mulai sesi baru dengan CLI Anda dan tanya \"who are you?\".",
    "The UI was not installed. Install Node 20+, then run the wizard again to get it.": "UI belum terpasang. Pasang Node 20+, lalu jalankan wizard lagi.",
    "Run this wizard again any time; it keeps what is already set.": "Jalankan wizard ini lagi kapan saja; yang sudah diatur dipertahankan.",
    "Language / Bahasa:\n  1. English\n  2. Bahasa Indonesia": "Language / Bahasa:\n  1. English\n  2. Bahasa Indonesia",
}
QUESTIONS_ID = {
    "Q1": "Q1. Siapa Anda, apa yang Anda tawarkan, dan untuk siapa?",
    "Q2a": "Q2. Tempel sesuatu yang baru-baru ini Anda tulis (email, postingan). Jangan menulis yang baru: teks yang ditulis untuk form ini menyesatkan.",
    "Q2b": "Q2. Tempel satu lagi, atau langsung akhiri untuk melewati.",
    "Q3": "Q3. 2-3 prioritas terbesar Anda untuk 90 hari ke depan, satu per baris, masing-masing dengan angka, tanggal, atau hasil akhir.",
    "Q4": "Q4. Ke mana pendapatan masuk, dan di mana dicatat?",
    "Q5": "Q5. Di mana Anda berbicara dengan pelanggan, tim, dan dunia luar sehari-hari?",
    "Q6": "Q6. Di mana rekaman rapat, catatan, dan dokumen penting disimpan?",
    "Q7": "Q7. Satu tugas apa yang menghabiskan minggu Anda, dan di mana Anda melacak pekerjaan sekarang?",
}


def T(en: str, **kw) -> str:
    s = ID.get(en, en) if LANG == "id" else en
    return s.format(**kw) if kw else s


def say(en: str, **kw) -> None:
    print(T(en, **kw))


def choose_language(arg) -> None:
    """--lang, then ARTRIOS_LANG, then a question when a person is at the keyboard. A piped run (tests) stays English."""
    global LANG
    pick = arg or os.environ.get("ARTRIOS_LANG", "")
    if not pick and sys.stdin.isatty():
        saved = profile_value("Reply language").lower()
        default = "2" if ("indonesia" in saved or saved == "id") else "1"
        print(ID["Language / Bahasa:\n  1. English\n  2. Bahasa Indonesia"])
        pick = "id" if ask("Choose / Pilih", default) == "2" else "en"
    LANG = "id" if pick.lower() in ("id", "indonesia", "bahasa", "2") else "en"


# ---------------------------------------------------------------- providers (same file format as ui/server/providers/config.js)


def parse_providers(text: str) -> dict:
    out = {"primary": None, "providers": {}}
    in_providers = False
    current = None

    def unquote(value):
        value = value.strip()
        if value.startswith('"'):
            try:
                return json.loads(value)
            except ValueError:
                return value.strip('"')
        return value

    for raw in text.splitlines():
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        m = re.match(r"^(\s*)([A-Za-z0-9_-]+):\s*(.*)$", raw)
        if not m:
            continue
        depth, key, value = len(m.group(1)), m.group(2), m.group(3)
        if depth == 0:
            in_providers = key == "providers"
            current = None
            if key == "primary":
                out["primary"] = unquote(value) or None
        elif in_providers and depth == 2:
            current = key
            out["providers"][current] = {}
        elif in_providers and current and depth >= 4 and key in FIELDS:
            out["providers"][current][key] = unquote(value)
    return out


def stringify_providers(data: dict) -> str:
    lines = ["# Written by the Artrios installer and Settings > Model. No secrets here: keys live in .env.", f"primary: {data.get('primary') or ''}".rstrip(), "providers:"]
    for pid, p in data["providers"].items():
        lines.append(f"  {pid}:")
        for f in FIELDS:
            if p.get(f):
                lines.append(f"    {f}: {json.dumps(p[f])}")
    return "\n".join(lines) + "\n"


def providers_file() -> Path:
    return KIT / "artrios" / "providers.yaml"


def load_providers() -> dict:
    f = providers_file()
    return parse_providers(f.read_text(encoding="utf-8")) if f.exists() else {"primary": None, "providers": {}}


def save_providers(data: dict) -> None:
    f = providers_file()
    tmp = f.with_suffix(".tmp")
    write_file(tmp, stringify_providers(data))
    tmp.replace(f)


def read_env(env_file: Path) -> dict:
    out = {}
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
            if m:
                out[m.group(1)] = m.group(2).strip().strip("\"'")
    return out


def set_env(env_file: Path, name: str, value: str) -> None:
    env_file.parent.mkdir(parents=True, exist_ok=True)
    lines = env_file.read_text(encoding="utf-8").splitlines() if env_file.exists() else []
    new = f"{name}={value}"
    for i, line in enumerate(lines):
        if re.match(rf"^\s*(export\s+)?{re.escape(name)}=", line):
            lines[i] = new
            break
    else:
        lines.append(new)
    tmp = env_file.with_suffix(".tmp")
    write_file(tmp, "\n".join(lines) + "\n")
    tmp.replace(env_file)
    try:
        env_file.chmod(0o600)
    except OSError:
        pass


def chat(provider: dict, key, prompt: str, timeout: int = 60) -> str:
    """One chat call. Raises RuntimeError with a message that never contains the key."""
    body = json.dumps({"model": provider["model"], "messages": [{"role": "user", "content": prompt}]}).encode()
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(provider["base_url"].rstrip("/") + "/chat/completions", data=body, headers=headers, method="POST")
    clean = lambda s: str(s).replace(key, "[redacted]") if key else str(s)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = json.loads(res.read().decode("utf-8"))
        return data["choices"][0]["message"].get("content") or ""
    except urllib.error.HTTPError as e:
        raise RuntimeError(clean(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")) from None
    except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError) as e:
        raise RuntimeError(clean(f"{type(e).__name__}: {e}")) from None


def ask_model(provider: dict, env: dict, prompt: str):
    """The wizard's only model use: a test call and the onboarding summary. None when it cannot answer."""
    try:
        if provider.get("transport") == "claude_cli":
            exe = which("claude")
            if not exe:
                return None
            r = subprocess.run([exe, "-p"], input=prompt, capture_output=True, text=True, encoding="utf-8", timeout=180)
            return r.stdout.strip() if r.returncode == 0 else None
        return chat(provider, env.get(provider.get("key_env", "")), prompt)
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        print(f"  model call failed: {e}")
        return None


def step_prereqs() -> dict:
    say("\n== Checking this machine ==")
    print(f"ok    Python {sys.version.split()[0]}")
    found = {name: which(name) for name in ("git", "node", "npm", "claude", "codex")}
    node_ok = False
    if found["node"]:
        try:
            out = subprocess.run([found["node"], "--version"], capture_output=True, text=True, timeout=20).stdout.strip()
            node_ok = int(out.lstrip("v").split(".")[0]) >= 20
            say("{flag} Node {out} (the UI needs 20 or newer)", flag="ok   " if node_ok else "OLD  ", out=out)
        except (OSError, ValueError, subprocess.SubprocessError):
            say("WARN  could not read the Node version")
    else:
        say("MISS  Node.js: the UI needs Node 20 or newer (https://nodejs.org); skills work without it")
    for name in ("git", "npm"):
        print(f"{'ok   ' if found[name] else 'MISS '} {name}")
    for name in ("claude", "codex"):
        print(f"{'ok   ' if found[name] else 'none '} {name}")
    for name, path in HOST_ONLY.items():
        say("WARN  {name} was found only as the Windows program ({path}). It cannot run a Linux install, so it counts as missing. Install it inside this Linux system{hint}.",
            name=name, path=path, hint=T(" (for example with nvm: https://github.com/nvm-sh/nvm, then `nvm install 22`)") if name in ("node", "npm") else "")
    found["node_ok"] = node_ok and bool(found["npm"])
    return found


def show_cli_help(name: str) -> None:
    h = CLI_HELP[name]
    cmd = h["win32"] if sys.platform == "win32" else h["other"]
    if cmd:
        say("  Install {name} yourself:\n    {cmd}", name=name, cmd=cmd)
    say("  Docs: {docs}", docs=h["docs"])
    say("  Open a new terminal after installing so the PATH is fresh.")


def add_api_provider(data: dict, env_file: Path) -> None:
    say("\nEndpoint:")
    for i, (_, label, _, _) in enumerate(PRESETS, 1):
        print(f"  {i}. {label}")
    choice = ask("Choose", "1")
    idx = int(choice) - 1 if choice.isdigit() and 0 < int(choice) <= len(PRESETS) else 0
    pid, _, base, key_env = PRESETS[idx]
    if pid == "custom":
        pid = ""
        base = ask("Base URL (ends in /v1 for most)")
        key_env = ask("Name for the key variable, empty for no key").upper()
    while not ID_RE.match(pid):
        pid = ask("Short name for this provider (lowercase, digits, dashes)").lower()
        if not pid:
            say("  skipped")
            return
    if not re.match(r"^https?://", base):
        say("  A base URL must start with http:// or https://. Skipped.")
        return
    if key_env and not KEY_RE.match(key_env):
        say("  A key variable uses uppercase letters, digits and underscores. Skipped.")
        return
    model = ask("Model name, as this endpoint spells it")
    if not model:
        say("  A model name is required. Skipped.")
        return
    if key_env:
        key = ask_secret(T("API key (stored in {env_file} as {key_env}; leave empty to keep the current one)", env_file=env_file, key_env=key_env))
        if key:
            set_env(env_file, key_env, key)
    provider = {"transport": "chat_completions", "base_url": base.rstrip("/"), "model": model}
    if key_env:
        provider["key_env"] = key_env
    data["providers"][pid] = provider
    say("  Testing with one short call...")
    try:
        say("  ok: {reply}", reply=chat(provider, read_env(env_file).get(key_env), "Reply with the single word OK.")[:80])
    except RuntimeError as e:
        say("  The test failed: {err}\n  The provider is saved; fix it in Settings > Model or run the wizard again.", err=e)


def step_provider(found: dict, env_file: Path) -> dict:
    say("\n== Model provider ==")
    say("Skills and the UI need a model. Use the claude command (your own sign-in), or an API key from an OpenAI-compatible endpoint.")
    data = load_providers()
    if data["providers"]:
        say("Already set: {names} (primary: {primary})", names=", ".join(data["providers"]), primary=data["primary"] or T("none"))
    while True:
        print("\n  1. Claude Code CLI" + ("" if found["claude"] else T(" (not found yet)")))
        say("  2. API key or gateway (OpenRouter, OpenAI, Ollama, other)")
        say("  3. Done / skip for now")
        choice = ask("Choose", "3")
        if choice == "1":
            found["claude"] = which("claude")
            if not found["claude"]:
                show_cli_help("claude")
                input_hint = ask_yes("Check again now?", False)
                found["claude"] = which("claude") if input_hint else None
                if not found["claude"]:
                    say("  Not found. Install it, open a new terminal, and run the wizard again.")
                    continue
            data["providers"]["claude"] = {"transport": "claude_cli"}
            say("  Added. Sign in by running `claude` yourself; this kit never handles that login.")
        elif choice == "2":
            add_api_provider(data, env_file)
        else:
            break
        save_providers(data)
    names = list(data["providers"])
    if len(names) == 1:
        data["primary"] = names[0]
    elif len(names) > 1:
        # No hidden default: the user picks.
        say("\nProviders: {names}", names=", ".join(names))
        pick = ""
        while pick not in names:
            pick = ask("Which one is the primary?", data["primary"] if data["primary"] in names else "")
            if not pick:
                break
        data["primary"] = pick or None
    else:
        data["primary"] = None
    if names:
        save_providers(data)
    say("Primary provider: {primary}", primary=data["primary"] or T("none"))
    if not data["primary"]:
        say("Skills are installed. They run in a terminal once the claude command is installed and signed in, and the UI chat needs a provider: add one in the UI under Settings > Model, or run the wizard again.")
    return data


def step_ui(found: dict, home: Path, env_file: Path):
    """Returns {"target": Path, "url": str} when the UI is built and answers, else None."""
    say("\n== Local web UI ==")
    if not found["node_ok"]:
        say("Skipped: needs Node 20+ and npm. Install them, then run the wizard again.")
        return None
    if not ask_yes("Install the UI?", True):
        return None
    target = KIT / "apps" / "artrios-ui"
    run = lambda cmd, cwd: subprocess.run(cmd, cwd=str(cwd), check=False).returncode == 0
    ok = run([found["node"], str(KIT / "ui" / "bin" / "scaffold.js"), "--target", str(target), "--kit", str(KIT), "--keys-file", str(env_file)], KIT)
    ok = ok and run([found["npm"], "install"], target) and run([found["npm"], "run", "build"], target)
    if not ok:
        say("The UI did not install; the error is above. On Windows a native module may need build tools. Everything else is in place.")
        return None
    # One account, "administrator" (PRD AIOS-61 v2.0 S1): the password is asked here and changed at the first sign-in.
    if not (target / "data" / "users.json").exists():
        say("\nThe UI asks for a password. Choose one now; you will set your own at the first sign-in.")
        if not run([found["node"], str(target / "bin" / "set-password.js")], target):
            say("No password was saved. Run `npm run password` in {target} before `npm start`.", target=target)
            return None
    if check_ui(found["node"], target):
        say("UI is ready. Sign in as administrator; add or change providers there in Settings.")
        step_autostart()
        say("Manual start any time:\n  cd \"{target}\"\n  npm start\nor in the background: python install.py --service start (also stop, restart, status, remove).", target=target)
        return {"target": target, "url": ui_url(target)}
    say("The UI was built but did not answer on localhost. Try `npm start` in {target} and read the error.", target=target)
    return None


def ui_url(target: Path) -> str:
    """The address the installed UI listens on: the port scaffold.js wrote to data/config.json."""
    try:
        port = json.loads((target / "data" / "config.json").read_text(encoding="utf-8")).get("port")
    except (OSError, ValueError):
        port = None
    return f"http://localhost:{port}/" if port else "http://localhost:4317/"


def step_autostart() -> None:
    import service
    say("\n== Start with the device ==")
    say("Now: {status}.", status=service.autostart_status())
    if ask_yes("Start the UI automatically when you log in?", True):
        if service.autostart_on() == 0 and ask_yes("Start it now too?", True):
            service.start(Path(ARGS_HOME))
    else:
        service.autostart_off()
        say("Manual: start it yourself with `npm start` or `python install.py --service start`.")


def check_ui(node: str, target: Path) -> bool:
    """Starts the server once and opens its address: the sign-in page (401) means it answers and is locked."""
    proc = subprocess.Popen([node, "server/index.js"], cwd=str(target), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8")
    try:
        line = proc.stdout.readline()
        m = re.search(r"http://127\.0\.0\.1:\d+/", line)
        if not m:
            print(line.strip())
            return False
        for _ in range(10):
            try:
                urllib.request.urlopen(m.group(0), timeout=3)
                return False  # an open page without sign-in is wrong
            except urllib.error.HTTPError as e:
                return e.code == 401
            except OSError:
                time.sleep(0.3)
        return False
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# ---------------------------------------------------------------- onboarding form (seven questions, same as the /onboard skill)

QUESTIONS = [
    ("Q1", "Q1. Who are you, what do you offer, and who is it for?"),
    ("Q2a", "Q2. Paste something you wrote recently (an email, a post). Do not write a new one: text written for this form misleads."),
    ("Q2b", "Q2. Paste a second one, or finish right away to skip."),
    ("Q3", "Q3. Your 2-3 biggest priorities for the next 90 days, one per line, each with a number, date or deliverable."),
    ("Q4", "Q4. Where does revenue land, and where is it tracked?"),
    ("Q5", "Q5. Where do you talk to customers, your team, and the outside world day to day?"),
    ("Q6", "Q6. Where do meeting recordings, notes, and important documents live?"),
    ("Q7", "Q7. What one task eats your week, and where do you track work now?"),
]
PLACEHOLDER = re.compile(r"\[(Your answer here|Sample [12][^\]]*|Priority [123])\]")


def intake_file() -> Path:
    return KIT / "aios-intake.md"


def read_intake() -> dict:
    """Answers stored in aios-intake.md, keyed like QUESTIONS. A block still holding a placeholder counts as empty."""
    f = intake_file()
    if not f.exists():
        return {}
    answers = {}
    for section in re.split(r"(?m)^## ", f.read_text(encoding="utf-8"))[1:]:
        m = re.match(r"Q(\d)", section)
        if not m:
            continue
        blocks = [b.strip() for b in re.findall(r"```\n(.*?)\n?```", section, re.S)]
        blocks = ["" if PLACEHOLDER.search(b) else b for b in blocks]
        if m.group(1) == "2":
            answers["Q2a"] = blocks[0] if blocks else ""
            answers["Q2b"] = blocks[1] if len(blocks) > 1 else ""
        else:
            answers[f"Q{m.group(1)}"] = blocks[0] if blocks else ""
    return answers


def write_intake(answers: dict) -> None:
    template = (KIT / "skills" / "onboard" / "assets" / "aios-intake.md").read_text(encoding="utf-8")
    parts = re.split(r"(?m)^(?=## )", template)
    out = []
    for part in parts:
        m = re.match(r"## Q(\d)", part)
        if m:
            keys = ["Q2a", "Q2b"] if m.group(1) == "2" else [f"Q{m.group(1)}"]
            it = iter(keys)

            def fill(match):
                key = next(it, None)
                return f"```\n{answers.get(key) or match.group(1)}\n```" if key else match.group(0)

            part = re.sub(r"```\n(.*?)\n?```", fill, part, flags=re.S)
        out.append(part)
    tmp = intake_file().with_suffix(".tmp")
    write_file(tmp, "".join(out))
    tmp.replace(intake_file())


def strip_number(line: str) -> str:
    return re.sub(r"^[0-9]+[.)]\s*", "", line)


def write_context(answers: dict, owner: str, language: str) -> list:
    """The first-day files from the /onboard skill, from a template. Old versions go to archives/intake-<ts>/."""
    priorities = [p.strip() for p in answers.get("Q3", "").splitlines() if p.strip()]
    samples = "\n\n".join(s for s in (answers.get("Q2a"), answers.get("Q2b")) if s)
    area = lambda name, source: f"| {name} | {source or '-'} | not yet connected | - | - |"
    q5, q6, q7, q4 = answers.get("Q5", ""), answers.get("Q6", ""), answers.get("Q7", ""), answers.get("Q4", "")
    files = {
        "context/about-me.md": f"# About me\n\n{answers.get('Q1', '')}\n\n## Biggest time sink and task tracking\n\n{q7}\n",
        "context/about-business.md": f"# About the business\n\n{answers.get('Q1', '')}\n\n## Revenue\n\n{q4}\n",
        "context/priorities.md": "# Priorities, next 90 days\n\n" + "\n".join(f"{i}. {strip_number(p)}" for i, p in enumerate(priorities, 1)) + "\n",
        "references/voice.md": f"# Voice\n\nMatch this register when drafting, and show the owner any external text before it goes out.\n\n{samples}\n",
        "connections.md": "# Connections\n\n| Area | Where | Mechanism | Auth | Last checked |\n|---|---|---|---|---|\n" + "\n".join([
            area("Revenue and finance", q4), area("Customer communication", q5), area("Calendar", ""), area("Team and outside communication", q5),
            area("Tasks", q7), area("Meetings", q6), area("Documents", q6)]) + "\n",
    }
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M")
    changed = []
    for rel, text in files.items():
        f = KIT / rel
        if f.exists() and f.read_text(encoding="utf-8") == text:
            continue
        if f.exists():
            backup = KIT / "archives" / f"intake-{stamp}" / rel
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, backup)
        f.parent.mkdir(parents=True, exist_ok=True)
        write_file(f, text)
        changed.append(rel)
    set_profile({"Owner name": owner, "Reply language": language, "Decision log": "decisions/log.md", "Priorities file": "context/priorities.md"})
    return changed


def set_profile(values: dict) -> None:
    f = KIT / "artrios" / "profile.md"
    text = f.read_text(encoding="utf-8")
    for field, value in values.items():
        if value:
            text = re.sub(rf"(?m)^\| {re.escape(field)} \|.*\|\s*$", lambda _: f"| {field} | {value} |", text)
    write_file(f, text)


def profile_value(field: str) -> str:
    f = KIT / "artrios" / "profile.md"
    m = re.search(rf"(?m)^\| {re.escape(field)} \| (.*?) *\|\s*$", f.read_text(encoding="utf-8")) if f.exists() else None
    value = m.group(1) if m else ""
    return "" if value.startswith("[") else value


def step_onboard(data: dict, env_file: Path) -> None:
    say("\n== Onboarding form ==")
    say("Seven questions, one minute each. Answers go to aios-intake.md and you can edit them there and run this again.")
    if not ask_yes("Fill it in now?", True):
        say("Skipped. Later: run the wizard again, or /onboard in a session.")
        return
    answers = read_intake()
    owner = ask("Your name", profile_value("Owner name"))
    language = ask("Reply language", profile_value("Reply language") or ("Bahasa Indonesia" if LANG == "id" else "English"))
    for key, question in QUESTIONS:
        if answers.get(key):
            say("{key}: already answered, kept.", key=key)
            continue
        answers[key] = ask_block(QUESTIONS_ID[key] if LANG == "id" else question)
        write_intake(answers)  # an interrupted form resumes where it stopped
    write_intake(answers)
    changed = write_context(answers, owner, language)
    say("Written: {files}", files=", ".join(changed) if changed else T("nothing changed"))
    provider = data["providers"].get(data["primary"]) if data["primary"] else None
    if not provider:
        say("The summary waits for a provider: run the wizard again when you have one.")
        return
    prompt = (f"Write a summary of this person's situation in at most 120 words, in {language}. Use only what is written here; invent nothing.\n\n"
              f"Who: {answers.get('Q1', '')}\nPriorities: {answers.get('Q3', '')}\nBiggest time sink: {answers.get('Q7', '')}")
    say("Writing a short summary with your provider...")
    summary = ask_model(provider, read_env(env_file), prompt)
    if summary:
        write_file((KIT / "context" / "summary.md"), f"# Summary\n\n{summary.strip()}\n")
        say("Written: context/summary.md")
    else:
        say("No summary this time; the other files are complete. Run the wizard again to retry.")


def wizard(home: Path, pack, lang=None) -> int:
    choose_language(lang)
    say("Artrios kit setup. Kit folder: {kit}", kit=KIT)
    say("Files outside the kit folder: skills in .claude and .codex, one import line in .claude/CLAUDE.md, keys in .artrios/.env.")
    env_file = home / ".artrios" / ".env"
    found = step_prereqs()
    data = step_provider(found, env_file)
    say("\n== Core and skills ==")
    conflicts = install_core(home, pack, True)
    set_profile({"Kit root": KIT.as_posix()})
    ui = step_ui(found, home, env_file)
    step_onboard(data, env_file)
    finish(home, data, ui, found)
    return 1 if conflicts else 0


def finish(home: Path, data: dict, ui, found: dict) -> None:
    """The ending: where the UI is and what to do next, whether or not a provider exists."""
    import service
    say("\n== Done ==")
    say("Primary provider: {primary}", primary=data["primary"] or T("none yet"))
    if ui:
        if service.running_pid(home) is None and ask_yes("Start the UI now?", True):
            service.start(home)
        say("Open the UI:  {url}", url=ui["url"])
        say("Sign in as administrator with the password you just set (the UI asks for a new one at the first sign-in).")
        if service.running_pid(home) is None:
            say("The UI is not running. Start it: python install.py --service start   (or: cd \"{target}\" && npm start)", target=ui["target"])
        if is_wsl():
            say("WSL: open that address in the Windows browser; WSL forwards localhost.")
    else:
        say("The UI was not installed. Install Node 20+, then run the wizard again to get it.")
    if not data["primary"]:
        say("Next: no provider yet. In the UI go to Settings > Model and add one (or install the claude command and run the wizard again).")
    elif found.get("claude"):
        say("Check it: start a new session with your CLI and ask \"who are you?\".")
    say("Run this wizard again any time; it keeps what is already set.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", help="path to a client pack folder that contains skills/")
    ap.add_argument("--home", default=str(Path.home()), help="home folder to install into")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--wizard", action="store_true", help="guided setup")
    ap.add_argument("--lang", choices=["en", "id"], help="wizard language (default: asked when run in a terminal, else English)")
    ap.add_argument("--update", metavar="TAG", help="switch the kit to a release tag (kit-vX.Y.Z), rebuild the UI, roll back on failure")
    ap.add_argument("--uninstall", action="store_true", help="remove what the kit installed")
    ap.add_argument("--service", choices=["start", "stop", "restart", "status", "remove"], help="run the UI in the background")
    ap.add_argument("--autostart", choices=["on", "off", "status"], help="start the UI when you log in")
    ap.add_argument("--remove-env", action="store_true", default=None, help="with --uninstall: also remove .artrios/.env without asking")
    a = ap.parse_args()
    home = Path(a.home)
    global ARGS_HOME
    ARGS_HOME = str(home)

    if a.service or a.autostart:
        import service
        if a.autostart == "on":
            return service.autostart_on()
        if a.autostart == "off":
            return service.autostart_off()
        if a.autostart == "status":
            print(service.autostart_status())
            return 0
        return service.service(a.service, home)
    if a.update:
        return update_kit(home, a.update)
    if a.uninstall:
        return uninstall(home, a.apply, a.remove_env)
    if a.wizard:
        return wizard(home, a.pack, a.lang)
    conflicts = install_core(home, a.pack, a.apply)
    ui_failed = update_ui(home, a.apply)
    if not a.apply:
        print("\nDry run. Add --apply to write, or use --wizard for the guided setup.")
    return 1 if (conflicts or ui_failed) else 0


if __name__ == "__main__":
    sys.exit(main())
