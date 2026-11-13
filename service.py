"""Run the Artrios UI as a background service and start it when the device starts (AIOS-138).

  python install.py --service start|stop|restart|status|remove
  python install.py --autostart on|off|status

The service is `node bin/start.js` (UI and scheduler) in the installed UI folder, apps/artrios-ui. Its process id lives in
<home>/.artrios/service.json and its output in <home>/.artrios/service.log. Stop asks the launcher to stop through a stop
file (a clean stop: the scheduler ends its jobs first) and only kills the process tree if it does not obey within 10 s.

Autostart runs `install.py --service start` at logon, once per user, no password stored:
  Windows  a hidden launcher in the user's Startup folder (Task Scheduler At log on needs admin rights, so it is not used)
  Linux    systemd user unit artrios-kit.service (enable-linger is a separate, optional step: it starts it without a login)
  macOS    LaunchAgent ~/Library/LaunchAgents/com.artrios.kit.plist
A device without a signed-in user (Windows) is not supported in this version.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

KIT = Path(__file__).resolve().parent
TASK = "ArtriosKit"
UNIT = "artrios-kit.service"
PLIST = "com.artrios.kit"
HOST_ONLY = {}  # tool name -> the Windows path that was skipped (WSL only), so a message can say why it counts as missing


def is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text(encoding="utf-8", errors="replace").lower()
    except OSError:
        return False


def which(name: str):
    """shutil.which, except that inside WSL a program found only under /mnt/<drive>/ (the Windows PATH that WSL appends)
    counts as missing: node.exe or npm.cmd from Windows cannot build or run a Linux install (UNC cwd, native modules)."""
    path = shutil.which(name)
    if path and is_wsl() and re.match(r"^/mnt/[a-zA-Z]/", path):
        HOST_ONLY[name] = path
        return None
    return path


def ui_dir() -> Path:
    return KIT / "apps" / "artrios-ui"


def state_dir(home: Path) -> Path:
    return home / ".artrios"


def state_file(home: Path) -> Path:
    return state_dir(home) / "service.json"


def read_state(home: Path) -> dict:
    try:
        return json.loads(state_file(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def alive(pid) -> bool:
    if not pid:
        return False
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"], capture_output=True, text=True).stdout
        return f'"{pid}"' in out
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def running_pid(home: Path):
    pid = read_state(home).get("pid")
    return pid if alive(pid) else None


def start(home: Path) -> int:
    pid = running_pid(home)
    if pid:
        print(f"Already running (pid {pid}).")
        return 0
    node = which("node")
    target = ui_dir()
    if not node or not (target / "bin" / "start.js").exists():
        print(f"The UI is not installed in {target}, or node is missing. Run `python install.py --wizard` first.")
        return 1
    state_dir(home).mkdir(parents=True, exist_ok=True)
    stop_file = state_dir(home) / "service.stop"
    stop_file.unlink(missing_ok=True)
    log = open(state_dir(home) / "service.log", "ab")
    env = {**os.environ, "ARTRIOS_STOP_FILE": str(stop_file)}
    kw = {"creationflags": 0x00000008 | 0x00000200 | 0x08000000} if sys.platform == "win32" else {"start_new_session": True}
    proc = subprocess.Popen([node, str(target / "bin" / "start.js")], cwd=str(target), stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, **kw)
    state_file(home).write_text(json.dumps({"pid": proc.pid, "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "ui": str(target)}), encoding="utf-8")
    time.sleep(1.5)
    if proc.poll() is not None:
        print(f"It stopped right away (exit {proc.returncode}). Read {state_dir(home) / 'service.log'}.")
        state_file(home).unlink(missing_ok=True)
        return 1
    print(f"Started (pid {proc.pid}). Output: {state_dir(home) / 'service.log'}. The address is in that log.")
    return 0


def kill_tree(pid: int) -> None:
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


def stop(home: Path) -> int:
    pid = running_pid(home)
    if not pid:
        print("Not running.")
        state_file(home).unlink(missing_ok=True)
        return 0
    stop_file = state_dir(home) / "service.stop"
    stop_file.write_text("stop", encoding="utf-8")
    for _ in range(100):
        if not alive(pid):
            break
        time.sleep(0.1)
    else:
        print("It did not stop by itself within 10 s; ending the process tree.")
        kill_tree(pid)
    stop_file.unlink(missing_ok=True)
    state_file(home).unlink(missing_ok=True)
    print("Stopped.")
    return 0


def status(home: Path) -> int:
    pid = running_pid(home)
    print(f"Service: {'running, pid ' + str(pid) if pid else 'stopped'}")
    print(f"Autostart: {autostart_status()}")
    return 0 if pid else 3


# ---------------------------------------------------------------- autostart


def command() -> list:
    """What the system runs at logon: this kit's installer starting the service. pythonw avoids a console window on Windows."""
    exe = sys.executable
    if sys.platform == "win32":
        w = Path(exe).with_name("pythonw.exe")
        exe = str(w) if w.exists() else exe
    return [exe, str(KIT / "install.py"), "--service", "start"]


def _q(parts: list) -> str:
    return " ".join(f'"{p}"' for p in parts)


def startup_file() -> Path:
    return Path(os.environ.get("APPDATA", str(Path.home()))) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / f"{TASK}.vbs"


def unit_path() -> Path:
    return Path.home() / ".config" / "systemd" / "user" / UNIT


def plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{PLIST}.plist"


def autostart_status() -> str:
    if sys.platform == "win32":
        return "on (Startup folder)" if startup_file().exists() else "off"
    if sys.platform == "darwin":
        return "on (LaunchAgent)" if plist_path().exists() else "off"
    return "on (systemd user unit)" if unit_path().exists() else "off"


def autostart_on() -> int:
    cmd = command()
    if sys.platform == "win32":
        f = startup_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        line = " ".join('""' + p + '""' for p in cmd)
        f.write_text(f'CreateObject("WScript.Shell").Run "{line}", 0, False\r\n', encoding="utf-8")
        print(f"Autostart on: {f} runs at log on for you (no admin, no password). Runs only while you are signed in.")
    elif sys.platform == "darwin":
        p = plist_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        args = "".join(f"<string>{a}</string>" for a in cmd)
        p.write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>{PLIST}</string><key>ProgramArguments</key><array>{args}</array><key>RunAtLoad</key><true/></dict></plist>\n', encoding="utf-8")
        subprocess.run(["launchctl", "unload", str(p)], capture_output=True)
        subprocess.run(["launchctl", "load", str(p)], capture_output=True)
        print(f"Autostart on: LaunchAgent {p}.")
    else:
        p = unit_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f"[Unit]\nDescription=Artrios kit UI and scheduler\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart={_q(cmd)}\n\n[Install]\nWantedBy=default.target\n", encoding="utf-8")
        for c in (["daemon-reload"], ["enable", UNIT]):
            r = subprocess.run(["systemctl", "--user", *c], capture_output=True, text=True)
            if r.returncode:
                print("systemctl --user", " ".join(c), "failed:", (r.stderr or r.stdout).strip())
                return 1
        print(f"Autostart on: systemd user unit {p}. It starts when you log in. To start it at boot without a login, run once: loginctl enable-linger $USER")
    return 0


def autostart_off() -> int:
    if sys.platform == "win32":
        f = startup_file()
        print("Autostart off." if f.exists() else "Autostart was not on.")
        f.unlink(missing_ok=True)
    elif sys.platform == "darwin":
        p = plist_path()
        if p.exists():
            subprocess.run(["launchctl", "unload", str(p)], capture_output=True)
            p.unlink()
        print("Autostart off.")
    else:
        p = unit_path()
        if p.exists():
            subprocess.run(["systemctl", "--user", "disable", UNIT], capture_output=True)
            p.unlink()
            subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
        print("Autostart off.")
    return 0


def remove(home: Path) -> int:
    """Stop and drop autostart. The installed UI folder and its data stay."""
    rc = stop(home)
    autostart_off()
    return rc


def service(action: str, home: Path) -> int:
    if action == "start":
        return start(home)
    if action == "stop":
        return stop(home)
    if action == "restart":
        stop(home)
        return start(home)
    if action == "status":
        return status(home)
    return remove(home)
