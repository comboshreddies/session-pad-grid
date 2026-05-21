#!/usr/bin/env python3
"""
One-time helper: obtain a Freesound OAuth2 access token for downloading original WAV files.

1. Create an API application at https://freesound.org/apiv2/apply/
2. Set redirect URI to http://localhost:8765/callback (or any URL you control)
3. export FREESOUND_CLIENT_ID=... FREESOUND_CLIENT_SECRET=...
4. python3 scripts/freesound_oauth_token.py
5. export FREESOUND_ACCESS_TOKEN=<printed token>
6. export FREESOUND_API_KEY=<same client id, used as API token for search>

Docs: https://freesound.org/docs/api/authentication.html
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

REDIRECT = os.environ.get("FREESOUND_REDIRECT_URI", "http://localhost:8765/callback")
AUTH_URL = "https://freesound.org/apiv2/oauth2/authorize/"
TOKEN_URL = "https://freesound.org/apiv2/oauth2/token/"


class _Handler(BaseHTTPRequestHandler):
    code: str | None = None

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        _Handler.code = (qs.get("code") or [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            b"<html><body><p>Authorization complete. You can close this tab.</p></body></html>"
        )

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return


def main() -> None:
    client_id = os.environ.get("FREESOUND_CLIENT_ID", "").strip()
    client_secret = os.environ.get("FREESOUND_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        print("Set FREESOUND_CLIENT_ID and FREESOUND_CLIENT_SECRET from your Freesound app.", file=sys.stderr)
        sys.exit(1)

    params = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": REDIRECT,
        }
    )
    url = f"{AUTH_URL}?{params}"
    print("Opening browser for Freesound authorization…")
    print(url)
    webbrowser.open(url)

    parsed = urllib.parse.urlparse(REDIRECT)
    port = parsed.port or 8765
    server = HTTPServer((parsed.hostname or "127.0.0.1", port), _Handler)
    print(f"Waiting for callback on {REDIRECT} …")
    server.handle_request()
    code = _Handler.code
    if not code:
        print("No authorization code received.", file=sys.stderr)
        sys.exit(1)

    body = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    token = data.get("access_token")
    if not token:
        print("Token response:", data, file=sys.stderr)
        sys.exit(1)
    print("\nAdd to your environment:\n")
    print(f"export FREESOUND_ACCESS_TOKEN={token}")
    print("# Search uses Token auth — use the API key from https://freesound.org/apiv2/apply/ (not necessarily client id):")
    print("export FREESOUND_API_KEY=your_api_key_here")


if __name__ == "__main__":
    main()
