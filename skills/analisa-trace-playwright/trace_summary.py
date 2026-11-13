#!/usr/bin/env python3
"""Summarize Playwright failure artifacts: the network log of trace.zip and error-context.md.

Usage (run with python -I; the trace is untrusted data):
  python -I trace_summary.py <test-results-dir | failure-folder | trace.zip> [options]

Options:
  --out DIR        where to extract traces (default: a new temp dir per run)
  --slow MS        report requests slower than this (default 5000)
  --grep TEXT      only show requests whose URL contains TEXT (repeatable)
  --assets         include static assets (css/js/img/fonts) in the timeline
  --timeline       print every request in time order, not only bad/slow ones
  --body TEXT      print the first 400 chars of response bodies for URLs containing TEXT

Per failure folder it prints: the error block from error-context.md, failed requests
(status -1/0/4xx/5xx or browser failure text), slow requests, redirects with Location,
POST form params, and the screenshots to open. Read-only: it never runs tests.
"""
import argparse
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

ASSET = re.compile(r"\.(css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map)(\?|$)|/asset/|fonts\.(googleapis|gstatic)")


def find_traces(target: Path):
    if target.is_file() and target.suffix == ".zip":
        return [target]
    return sorted(target.rglob("trace.zip"))


def error_block(folder: Path):
    ctx = folder / "error-context.md"
    if not ctx.exists():
        return ""
    text = ctx.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"# Error details\s*```(.*?)```", text, re.S)
    return (m.group(1).strip() if m else "")[:1500]


def load_requests(trace_dir: Path):
    rows = []
    for f in sorted(trace_dir.glob("*.network")):
        for line in f.open(encoding="utf-8", errors="replace"):
            try:
                snap = json.loads(line).get("snapshot", {})
            except ValueError:
                continue
            req, res = snap.get("request", {}), snap.get("response", {})
            headers = {h.get("name", "").lower(): h.get("value", "") for h in res.get("headers", [])}
            post = req.get("postData") or {}
            rows.append({
                "t": snap.get("startedDateTime", "")[11:23],
                "ms": round(snap.get("time") or -1),
                "status": res.get("status"),
                "fail": res.get("_failureText"),
                "method": req.get("method", ""),
                "url": req.get("url", ""),
                "location": headers.get("location", ""),
                "params": [(p.get("name"), p.get("value")) for p in post.get("params", [])],
                "sha": (res.get("content") or {}).get("_sha1"),
            })
    rows.sort(key=lambda r: r["t"])
    return rows


def body(trace_dir: Path, sha):
    p = trace_dir / "resources" / sha if sha else None
    if p and p.exists():
        return p.read_text(encoding="utf-8", errors="replace")[:400].replace("\n", " ")
    return "(no body in trace)"


def line(r):
    extra = f" -> {r['location']}" if r["location"] else ""
    fail = f" [{r['fail']}]" if r["fail"] else ""
    return f"  {r['t']} {r['status']} {r['ms']}ms {r['method']} {r['url'][:140]}{extra}{fail}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--out")
    ap.add_argument("--slow", type=int, default=5000)
    ap.add_argument("--grep", action="append", default=[])
    ap.add_argument("--assets", action="store_true")
    ap.add_argument("--timeline", action="store_true")
    ap.add_argument("--body", action="append", default=[])
    a = ap.parse_args()

    traces = find_traces(Path(a.target))
    if not traces:
        print("no trace.zip found under", a.target)
        return 1
    out = Path(a.out) if a.out else Path(tempfile.mkdtemp(prefix="pw-trace-"))
    print(f"extracting {len(traces)} trace(s) into {out}\n")

    for i, tz in enumerate(traces):
        folder = tz.parent
        dest = out / f"{i:02d}-{folder.name[:60]}"
        dest.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(tz) as z:
            for m in z.namelist():  # no absolute paths or .. from an untrusted zip
                if m.startswith(("/", "\\")) or ".." in Path(m).parts:
                    continue
                z.extract(m, dest)

        print("=" * 100)
        print(folder.name)
        err = error_block(folder)
        if err:
            print("-- error\n" + "\n".join("  " + l for l in err.splitlines()[:25]))
        shots = sorted(p.name for p in folder.glob("*.png"))
        if shots:
            print("-- screenshots:", ", ".join(str(folder / s) for s in shots))

        rows = load_requests(dest)
        if a.grep:
            rows = [r for r in rows if any(g in r["url"] for g in a.grep)]
        app = [r for r in rows if a.assets or not ASSET.search(r["url"])]

        bad = [r for r in rows if r["status"] in (None, -1, 0) or (r["status"] or 0) >= 400 or r["fail"]]
        slow = [r for r in app if r["ms"] >= a.slow]
        redir = [r for r in app if r["location"]]
        posts = [r for r in app if r["method"] == "POST"]

        for title, items in (("failed / unanswered", bad), (f"slow >= {a.slow} ms", slow),
                             ("redirects", redir)):
            if items:
                print(f"-- {title} ({len(items)})")
                for r in items[:40]:
                    print(line(r))
        if posts:
            print(f"-- POST requests ({len(posts)})")
            for r in posts[:20]:
                print(line(r))
                if r["params"]:
                    print("     params:", ", ".join(f"{k}={str(v)[:40]}" for k, v in r["params"][:30]))
        if a.timeline:
            print(f"-- timeline ({len(app)})")
            for r in app:
                print(line(r))
        for key in a.body:
            for r in app:
                if key in r["url"]:
                    print(f"-- body {r['url'][:100]}\n     {body(dest, r['sha'])}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
