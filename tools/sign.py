#!/usr/bin/env python3
"""Package and sign the extension through Mozilla's AMO API.

Release Firefox refuses to permanently install an unsigned extension, which is
why `about:debugging` installs vanish on restart. Signing fixes that. The
*unlisted* channel used here means the add-on is signed for your own use but is
NOT published to addons.mozilla.org and goes through no review.

What it does:
  1. zips extension/ into an .xpi
  2. uploads it to AMO on the unlisted channel
  3. polls until Mozilla has signed it
  4. downloads the signed .xpi to dist/

Credentials come from (first match wins):
  * --issuer / --secret
  * AMO_JWT_ISSUER / AMO_JWT_SECRET environment variables
  * .amo-credentials.json in the project root  (gitignored)

Get them from https://addons.mozilla.org/developers/addon/api/key/
The .amo-credentials.json format is:

    {"issuer": "user:12345:67", "secret": "abc123..."}

Usage:
    py tools/sign.py                 # package, upload, sign, download
    py tools/sign.py --package-only  # just build the .xpi, no network
    py tools/sign.py --timeout 900
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT_DIR = ROOT / "extension"
DIST = ROOT / "dist"
CRED_FILE = ROOT / ".amo-credentials.json"

API = "https://addons.mozilla.org/api/v5"
POLL_INTERVAL = 10

# Files that must never end up inside a signed package.
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
EXCLUDE_SUFFIXES = {".map"}


# ---------------------------------------------------------------------------
# Packaging
# ---------------------------------------------------------------------------

def read_manifest() -> dict:
    path = EXT_DIR / "manifest.json"
    if not path.exists():
        raise SystemExit(f"{path} not found")
    return json.loads(path.read_text(encoding="utf-8"))


def addon_id(manifest: dict) -> str:
    try:
        return manifest["browser_specific_settings"]["gecko"]["id"]
    except KeyError:
        raise SystemExit(
            "manifest.json has no browser_specific_settings.gecko.id — AMO needs "
            "a stable add-on id to sign against."
        )


def build_xpi(manifest: dict) -> Path:
    version = manifest["version"]
    DIST.mkdir(exist_ok=True)
    xpi = DIST / f"sift-adblocker-{version}.xpi"

    files = []
    for path in sorted(EXT_DIR.rglob("*")):
        if not path.is_file():
            continue
        if path.name in EXCLUDE_NAMES or path.suffix in EXCLUDE_SUFFIXES:
            continue
        files.append(path)

    if not any(f.name == "manifest.json" and f.parent == EXT_DIR for f in files):
        raise SystemExit("manifest.json must sit at the root of extension/")

    # Deterministic: sorted order and a fixed timestamp, so rebuilding the same
    # source produces a byte-identical .xpi.
    with zipfile.ZipFile(xpi, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in files:
            rel = path.relative_to(EXT_DIR).as_posix()
            info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, path.read_bytes())

    size = xpi.stat().st_size
    print(f"  packaged {len(files)} files -> {xpi.relative_to(ROOT)} ({size / 1024:.0f} KB)")
    return xpi


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def load_credentials(args) -> tuple[str, str]:
    if args.issuer and args.secret:
        return args.issuer, args.secret

    env_issuer = os.environ.get("AMO_JWT_ISSUER")
    env_secret = os.environ.get("AMO_JWT_SECRET")
    if env_issuer and env_secret:
        return env_issuer, env_secret

    if CRED_FILE.exists():
        try:
            data = json.loads(CRED_FILE.read_text(encoding="utf-8"))
            return data["issuer"], data["secret"]
        except (json.JSONDecodeError, KeyError) as exc:
            raise SystemExit(f"{CRED_FILE.name} is malformed: {exc}")

    raise SystemExit(
        "No AMO credentials found.\n\n"
        "  1. Sign in at https://addons.mozilla.org/developers/addon/api/key/\n"
        "  2. Generate a JWT issuer and secret\n"
        "  3. Save them as .amo-credentials.json in the project root:\n\n"
        '     {"issuer": "user:12345:67", "secret": "..."}\n\n'
        "That file is gitignored. Or set AMO_JWT_ISSUER / AMO_JWT_SECRET."
    )


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(issuer: str, secret: str, lifetime: int = 300) -> str:
    """HS256 JWT, as AMO's API expects. Hand-rolled to avoid a PyJWT dependency."""
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "iss": issuer,
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": now + lifetime,
    }
    segments = [
        b64url(json.dumps(header, separators=(",", ":")).encode()),
        b64url(json.dumps(payload, separators=(",", ":")).encode()),
    ]
    signing_input = ".".join(segments).encode("ascii")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    segments.append(b64url(signature))
    return ".".join(segments)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def encode_multipart(fields: dict, files: dict) -> tuple[bytes, str]:
    """Build a multipart/form-data body. urllib has no native support."""
    boundary = f"----sift{uuid.uuid4().hex}"
    out = bytearray()

    for name, value in fields.items():
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        out += f"{value}\r\n".encode()

    for name, (filename, content) in files.items():
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        out += f"--{boundary}\r\n".encode()
        out += (
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
        ).encode()
        out += f"Content-Type: {ctype}\r\n\r\n".encode()
        out += content
        out += b"\r\n"

    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def api_call(method: str, url: str, issuer: str, secret: str,
             body: bytes = None, content_type: str = None):
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"JWT {make_jwt(issuer, secret)}")
    req.add_header("User-Agent", "sift-adblocker-signer/1.0")
    if content_type:
        req.add_header("Content-Type", content_type)

    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {"detail": raw.decode("utf-8", errors="replace")[:800]}


# ---------------------------------------------------------------------------
# Signing flow
# ---------------------------------------------------------------------------

def upload(xpi: Path, guid: str, version: str, issuer: str, secret: str) -> None:
    url = f"{API}/addons/{urllib.parse.quote(guid, safe='')}/versions/{version}/"
    body, ctype = encode_multipart(
        {"channel": "unlisted"},
        {"upload": (xpi.name, xpi.read_bytes())},
    )
    print(f"  uploading {xpi.name} to the unlisted channel...")
    status, data = api_call("PUT", url, issuer, secret, body, ctype)

    if status in (200, 201, 202):
        return
    if status == 409:
        raise SystemExit(
            f"AMO already has version {version} of {guid}.\n"
            f"Bump \"version\" in extension/manifest.json and run this again."
        )
    if status in (401, 403):
        raise SystemExit(
            f"AMO rejected the credentials (HTTP {status}): {data}\n"
            "Check the issuer/secret, and note that AMO keys expire if unused."
        )
    raise SystemExit(f"Upload failed (HTTP {status}): {json.dumps(data)[:900]}")


def wait_for_signature(guid: str, version: str, issuer: str, secret: str,
                       timeout: int) -> str:
    url = f"{API}/addons/{urllib.parse.quote(guid, safe='')}/versions/{version}/"
    deadline = time.time() + timeout
    print("  waiting for Mozilla to sign it (usually under two minutes)...")

    while time.time() < deadline:
        status, data = api_call("GET", url, issuer, secret)

        if status == 200:
            files = data.get("files") or []
            if data.get("processed") and files:
                f = files[0]
                if f.get("signed") and f.get("download_url"):
                    return f["download_url"]
                if data.get("valid") is False:
                    raise SystemExit(
                        "AMO validation failed. Full report:\n  "
                        + str(data.get("validation_url") or data)
                    )
        elif status not in (404, 202):
            raise SystemExit(f"Polling failed (HTTP {status}): {json.dumps(data)[:600]}")

        time.sleep(POLL_INTERVAL)
        print("    still processing...")

    raise SystemExit(
        f"Timed out after {timeout}s. Signing may still finish — re-run with "
        f"--download-only to fetch it."
    )


def download(url: str, dest: Path, issuer: str, secret: str) -> None:
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"JWT {make_jwt(issuer, secret)}")
    req.add_header("User-Agent", "sift-adblocker-signer/1.0")
    with urllib.request.urlopen(req, timeout=180) as resp:
        dest.write_bytes(resp.read())


def main() -> int:
    ap = argparse.ArgumentParser(description="Package and sign the extension via AMO.")
    ap.add_argument("--issuer")
    ap.add_argument("--secret")
    ap.add_argument("--package-only", action="store_true",
                    help="build the .xpi and stop; no network, no credentials needed")
    ap.add_argument("--download-only", action="store_true",
                    help="skip upload, just fetch an already-signed version")
    ap.add_argument("--timeout", type=int, default=600)
    args = ap.parse_args()

    manifest = read_manifest()
    guid = addon_id(manifest)
    version = manifest["version"]

    print(f"Sift Ad Blocker {version}  ({guid})")
    xpi = build_xpi(manifest)

    if args.package_only:
        print(f"\nUnsigned package ready: {xpi.relative_to(ROOT)}")
        print("This installs via about:debugging only. Sign it for a permanent install.")
        return 0

    issuer, secret = load_credentials(args)

    if not args.download_only:
        upload(xpi, guid, version, issuer, secret)

    download_url = wait_for_signature(guid, version, issuer, secret, args.timeout)

    signed = DIST / f"sift-adblocker-{version}-signed.xpi"
    print("  downloading the signed package...")
    download(download_url, signed, issuer, secret)

    print(f"\nSigned: {signed.relative_to(ROOT)} ({signed.stat().st_size / 1024:.0f} KB)")
    print("\nInstall it permanently:")
    print("  1. Open Firefox and go to  about:addons")
    print("  2. Click the gear icon -> Install Add-on From File…")
    print(f"  3. Choose  {signed}")
    print("\nIt survives restarts. To update later, bump the version in")
    print("extension/manifest.json and run this again.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
