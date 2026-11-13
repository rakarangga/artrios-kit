"""Screenshot every Brain tab of a running Artrios UI and measure the stall when switching tabs.

Usage:
  ARTRIOS_PASSWORD=... python shot.py --url "http://127.0.0.1:4317/" [--out DIR] [--tabs "Rings,Areas,Links,Timeline,3D Orbit"]
                 [--wait 2500] [--light]

Needs Python Playwright with Chromium (`pip install playwright`, `python -m playwright install chromium`).
WebGL runs on SwiftShader, so the 3D tab is slower here than on a real GPU: read its timing as an upper bound.
Writes <out>/brain-<tab>.png and prints one line per tab: frames, longest gap between frames (ms), page errors.
"""
import argparse
import json
import os
import re
import sys

from playwright.sync_api import sync_playwright

# Clicks a tab inside the page and records animation-frame times for `ms`; the longest gap is the visible stall.
PROBE = """async ([name, ms]) => {
  const tab = [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === name);
  if (!tab) return { missing: true };
  const t0 = performance.now(), ts = [];
  await new Promise((done) => {
    const f = (n) => { ts.push(n - t0); if (n - t0 < ms) requestAnimationFrame(f); else done(); };
    tab.click();
    requestAnimationFrame(f);
  });
  let gap = 0;
  for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
  return { frames: ts.length, firstFrameMs: Math.round(ts[0] ?? -1), maxGapMs: Math.round(gap) };
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="the address the server printed")
    ap.add_argument("--out", default=".")
    ap.add_argument("--tabs", default="Rings,Areas,Links,Timeline,3D Orbit")
    ap.add_argument("--wait", type=int, default=2500, help="ms to watch each tab after the click")
    ap.add_argument("--light", action="store_true", help="light color scheme instead of dark")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": 1600, "height": 1000}, color_scheme="light" if a.light else "dark")
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(a.url)
        # Sign-in page (one account, administrator): the password comes from the environment, never from a file.
        if page.locator("form[data-kind=login]").count():
            pw = os.environ.get("ARTRIOS_PASSWORD")
            if not pw:
                sys.exit("The UI asks for a sign-in: set ARTRIOS_PASSWORD in the environment for this run.")
            page.fill("input[name=password]", pw)
            page.click("form[data-kind=login] button[type=submit]")
            page.wait_for_load_state("load")
            if page.locator("form[data-kind=change]").count():
                sys.exit("The account still has to change its password: sign in once in a browser first.")
        page.wait_for_timeout(1500)
        page.get_by_text("Brain", exact=True).first.click()
        page.wait_for_selector("[role=tab]", timeout=60000)  # after a restart the server builds the graph first
        page.wait_for_timeout(3000)  # first tab draws, idle-time layouts and the 3D library warm up
        for name in [t.strip() for t in a.tabs.split(",") if t.strip()]:
            before = len(errors)
            r = page.evaluate(PROBE, [name, a.wait])
            if r.get("missing"):
                print(f"{name}: tab not found")
                continue
            path = os.path.join(a.out, "brain-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") + ".png")
            page.screenshot(path=path)
            print(json.dumps({"tab": name, **r, "errors": errors[before:], "shot": path}, ensure_ascii=False))
        b.close()
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
