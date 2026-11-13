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
    node, npm = shutil.which("node"), shutil.which("npm")
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
        answer = input(f"{question}{suffix}: ").strip()
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
    print(f"{question}\n  (paste or type; finish with a line holding only a dot)")
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
            exe = shutil.which("claude")
            if not exe:
                return None
            r = subprocess.run([exe, "-p"], input=prompt, capture_output=True, text=True, encoding="utf-8", timeout=180)
            return r.stdout.strip() if r.returncode == 0 else None
        return chat(provider, env.get(provider.get("key_env", "")), prompt)
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        print(f"  model call failed: {e}")
        return None


def step_prereqs() -> dict:
    print("\n== Checking this machine ==")
    print(f"ok    Python {sys.version.split()[0]}")
    found = {name: shutil.which(name) for name in ("git", "node", "npm", "claude", "codex")}
    node_ok = False
    if found["node"]:
        try:
            out = subprocess.run([found["node"], "--version"], capture_output=True, text=True, timeout=20).stdout.strip()
            node_ok = int(out.lstrip("v").split(".")[0]) >= 20
            print(f"{'ok   ' if node_ok else 'OLD  '} Node {out} (the UI needs 20 or newer)")
        except (OSError, ValueError, subprocess.SubprocessError):
            print("WARN  could not read the Node version")
    else:
        print("MISS  Node.js: the UI needs Node 20 or newer (https://nodejs.org); skills work without it")
    for name in ("git", "npm"):
        print(f"{'ok   ' if found[name] else 'MISS '} {name}")
    for name in ("claude", "codex"):
        print(f"{'ok   ' if found[name] else 'none '} {name}")
    found["node_ok"] = node_ok and bool(found["npm"])
    return found


def show_cli_help(name: str) -> None:
    h = CLI_HELP[name]
    cmd = h["win32"] if sys.platform == "win32" else h["other"]
    if cmd:
        print(f"  Install {name} yourself:\n    {cmd}")
    print(f"  Docs: {h['docs']}")
    print("  Open a new terminal after installing so the PATH is fresh.")


def add_api_provider(data: dict, env_file: Path) -> None:
    print("\nEndpoint:")
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
            print("  skipped")
            return
    if not re.match(r"^https?://", base):
        print("  A base URL must start with http:// or https://. Skipped.")
        return
    if key_env and not KEY_RE.match(key_env):
        print("  A key variable uses uppercase letters, digits and underscores. Skipped.")
        return
    model = ask("Model name, as this endpoint spells it")
    if not model:
        print("  A model name is required. Skipped.")
        return
    if key_env:
        key = ask_secret(f"API key (stored in {env_file} as {key_env}; leave empty to keep the current one)")
        if key:
            set_env(env_file, key_env, key)
    provider = {"transport": "chat_completions", "base_url": base.rstrip("/"), "model": model}
    if key_env:
        provider["key_env"] = key_env
    data["providers"][pid] = provider
    print("  Testing with one short call...")
    try:
        print(f"  ok: {chat(provider, read_env(env_file).get(key_env), 'Reply with the single word OK.')[:80]}")
    except RuntimeError as e:
        print(f"  The test failed: {e}\n  The provider is saved; fix it in Settings > Model or run the wizard again.")


def step_provider(found: dict, env_file: Path) -> dict:
    print("\n== Model provider ==")
    print("Skills and the UI need a model. Use the claude command (your own sign-in), or an API key from an OpenAI-compatible endpoint.")
    data = load_providers()
    if data["providers"]:
        print("Already set:", ", ".join(data["providers"]), f"(primary: {data['primary'] or 'none'})")
    while True:
        print("\n  1. Claude Code CLI" + ("" if found["claude"] else " (not found yet)"))
        print("  2. API key or gateway (OpenRouter, OpenAI, Ollama, other)")
        print("  3. Done / skip for now")
        choice = ask("Choose", "3")
        if choice == "1":
            found["claude"] = shutil.which("claude")
            if not found["claude"]:
                show_cli_help("claude")
                input_hint = ask_yes("Check again now?", False)
                found["claude"] = shutil.which("claude") if input_hint else None
                if not found["claude"]:
                    print("  Not found. Install it, open a new terminal, and run the wizard again.")
                    continue
            data["providers"]["claude"] = {"transport": "claude_cli"}
            print("  Added. Sign in by running `claude` yourself; this kit never handles that login.")
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
        print("\nProviders:", ", ".join(names))
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
    print(f"Primary provider: {data['primary'] or 'none'}" + ("" if data["primary"] else ". Skills are installed but cannot run yet; run the wizard again when you have one."))
    return data


def step_ui(found: dict, home: Path, env_file: Path) -> None:
    print("\n== Local web UI ==")
    if not found["node_ok"]:
        print("Skipped: needs Node 20+ and npm. Install them, then run the wizard again.")
        return
    if not ask_yes("Install the UI?", True):
        return
    target = KIT / "apps" / "artrios-ui"
    run = lambda cmd, cwd: subprocess.run(cmd, cwd=str(cwd), check=False).returncode == 0
    ok = run([found["node"], str(KIT / "ui" / "bin" / "scaffold.js"), "--target", str(target), "--kit", str(KIT), "--keys-file", str(env_file)], KIT)
    ok = ok and run([found["npm"], "install"], target) and run([found["npm"], "run", "build"], target)
    if not ok:
        print("The UI did not install; the error is above. On Windows a native module may need build tools. Everything else is in place.")
        return
    # One account, "administrator" (PRD AIOS-61 v2.0 S1): the password is asked here and changed at the first sign-in.
    if not (target / "data" / "users.json").exists():
        print("\nThe UI asks for a password. Choose one now; you will set your own at the first sign-in.")
        if not run([found["node"], str(target / "bin" / "set-password.js")], target):
            print(f"No password was saved. Run `npm run password` in {target} before `npm start`.")
            return
    if check_ui(found["node"], target):
        print("UI is ready. Sign in as administrator; add or change providers there in Settings.")
        step_autostart()
        print(f"Manual start any time:\n  cd \"{target}\"\n  npm start\nor in the background: python install.py --service start (also stop, restart, status, remove).")
    else:
        print(f"The UI was built but did not answer on localhost. Try `npm start` in {target} and read the error.")


def step_autostart() -> None:
    import service
    print("\n== Start with the device ==")
    print(f"Now: {service.autostart_status()}.")
    if ask_yes("Start the UI automatically when you log in?", True):
        if service.autostart_on() == 0 and ask_yes("Start it now too?", True):
            service.start(Path(ARGS_HOME))
    else:
        service.autostart_off()
        print("Manual: start it yourself with `npm start` or `python install.py --service start`.")


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
    print("\n== Onboarding form ==")
    print("Seven questions, one minute each. Answers go to aios-intake.md and you can edit them there and run this again.")
    if not ask_yes("Fill it in now?", True):
        print("Skipped. Later: run the wizard again, or /onboard in a session.")
        return
    answers = read_intake()
    owner = ask("Your name", profile_value("Owner name"))
    language = ask("Reply language", profile_value("Reply language") or "English")
    for key, question in QUESTIONS:
        if answers.get(key):
            print(f"{key}: already answered, kept.")
            continue
        answers[key] = ask_block(question)
        write_intake(answers)  # an interrupted form resumes where it stopped
    write_intake(answers)
    changed = write_context(answers, owner, language)
    print("Written:", ", ".join(changed) if changed else "nothing changed")
    provider = data["providers"].get(data["primary"]) if data["primary"] else None
    if not provider:
        print("The summary waits for a provider: run the wizard again when you have one.")
        return
    prompt = (f"Write a summary of this person's situation in at most 120 words, in {language}. Use only what is written here; invent nothing.\n\n"
              f"Who: {answers.get('Q1', '')}\nPriorities: {answers.get('Q3', '')}\nBiggest time sink: {answers.get('Q7', '')}")
    print("Writing a short summary with your provider...")
    summary = ask_model(provider, read_env(env_file), prompt)
    if summary:
        write_file((KIT / "context" / "summary.md"), f"# Summary\n\n{summary.strip()}\n")
        print("Written: context/summary.md")
    else:
        print("No summary this time; the other files are complete. Run the wizard again to retry.")


def wizard(home: Path, pack) -> int:
    print(f"Artrios kit setup. Kit folder: {KIT}")
    print("Files outside the kit folder: skills in .claude and .codex, one import line in .claude/CLAUDE.md, keys in .artrios/.env.")
    env_file = home / ".artrios" / ".env"
    found = step_prereqs()
    data = step_provider(found, env_file)
    print("\n== Core and skills ==")
    conflicts = install_core(home, pack, True)
    set_profile({"Kit root": KIT.as_posix()})
    step_ui(found, home, env_file)
    step_onboard(data, env_file)
    print("\n== Done ==")
    print(f"Primary provider: {data['primary'] or 'none yet'}")
    print("Check it: start a new session with your CLI and ask \"who are you?\".")
    print("Run this wizard again any time; it keeps what is already set.")
    return 1 if conflicts else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", help="path to a client pack folder that contains skills/")
    ap.add_argument("--home", default=str(Path.home()), help="home folder to install into")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--wizard", action="store_true", help="guided setup")
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
        return wizard(home, a.pack)
    conflicts = install_core(home, a.pack, a.apply)
    ui_failed = update_ui(home, a.apply)
    if not a.apply:
        print("\nDry run. Add --apply to write, or use --wizard for the guided setup.")
    return 1 if (conflicts or ui_failed) else 0


if __name__ == "__main__":
    sys.exit(main())
