#!/usr/bin/env python3
"""Run the browser test suite headlessly and report the result.

Serves the project, opens tests/index.html in a headless browser, and waits for
the page to POST its results back. Reporting over HTTP rather than scraping the
DOM matters for two reasons: the suite finishes asynchronously (it fetches and
compiles several MB of filter lists), and Chrome's --virtual-time-budget freezes
performance.now(), which would make every benchmark read as 0ms.

Usage:
    py tools/run_tests.py                # auto-detect a browser
    py tools/run_tests.py --browser firefox
    py tools/run_tests.py --port 8765 --timeout 180
    py tools/run_tests.py --keep-open     # serve and print the URL, don't exit

Exit code is 0 when every test passes, 1 otherwise.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BROWSERS = {
    "chrome": [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "/usr/bin/google-chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ],
    "edge": [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ],
    "firefox": [
        r"C:\Program Files\Mozilla Firefox\firefox.exe",
        "/usr/bin/firefox",
        "/Applications/Firefox.app/Contents/MacOS/firefox",
    ],
}

results = {"payload": None}
done = threading.Event()


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/_results":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", errors="replace")
        try:
            results["payload"] = json.loads(body)
        except json.JSONDecodeError as exc:
            results["payload"] = {"error": f"bad JSON from page: {exc}", "raw": body[:2000]}
        self.send_response(204)
        self.end_headers()
        done.set()

    def log_message(self, *args):
        pass  # keep the console for test output only


def find_browser(preferred: str | None) -> tuple[str, str]:
    order = [preferred] if preferred else ["chrome", "edge", "firefox"]
    for name in order:
        for path in BROWSERS.get(name, []):
            if os.path.exists(path):
                return name, path
    raise SystemExit(
        "No supported browser found. Install Chrome, Edge or Firefox, or pass "
        "--browser with one that exists."
    )


def launch(name: str, path: str, url: str, profile: Path) -> subprocess.Popen:
    if name == "firefox":
        args = [path, "--headless", "--no-remote", "--profile", str(profile), url]
    else:
        args = [
            path, "--headless", "--disable-gpu", "--no-sandbox",
            "--no-first-run", "--disable-extensions",
            f"--user-data-dir={profile}", url,
        ]
    return subprocess.Popen(
        args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )


def render(payload: dict) -> bool:
    if payload is None:
        print("No results received.", file=sys.stderr)
        return False
    if "error" in payload:
        print(f"Page reported an error: {payload['error']}", file=sys.stderr)
        if payload.get("raw"):
            print(payload["raw"], file=sys.stderr)
        return False

    for line in payload.get("lines", []):
        print(line)

    passed = payload.get("passed", 0)
    failed = payload.get("failed", 0)
    elapsed = payload.get("elapsedMs", 0) / 1000
    print()
    if failed == 0:
        print(f"ALL PASS - {passed} tests in {elapsed:.2f}s")
    else:
        print(f"FAILED - {failed} of {passed + failed} tests failed ({elapsed:.2f}s)")
    return failed == 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the browser test suite headlessly.")
    ap.add_argument("--browser", choices=sorted(BROWSERS), help="which browser to use")
    ap.add_argument("--port", type=int, default=8731)
    ap.add_argument("--timeout", type=int, default=180, help="seconds to wait")
    ap.add_argument("--keep-open", action="store_true",
                    help="serve and print the URL instead of launching a browser")
    args = ap.parse_args()

    handler = partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    url = f"http://127.0.0.1:{args.port}/tests/?post=1"

    if args.keep_open:
        print(f"Serving {ROOT}")
        print(f"Open: http://127.0.0.1:{args.port}/tests/")
        print("Ctrl-C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return 0

    name, path = find_browser(args.browser)
    profile = ROOT / ".test-profile"
    profile.mkdir(exist_ok=True)
    print(f"Running tests in headless {name}...\n")

    proc = launch(name, path, url, profile)
    try:
        if not done.wait(timeout=args.timeout):
            print(f"Timed out after {args.timeout}s with no results.", file=sys.stderr)
            return 1
        return 0 if render(results["payload"]) else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        server.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
