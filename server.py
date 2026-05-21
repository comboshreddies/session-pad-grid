#!/usr/bin/env python3
"""
Local static server:
  - **/soundlib/** — files on disk next to server.py (run `python3 scripts/download_soundlib.py all` first).
  - **/novation/** — reverse-proxy to intro.novationmusic.com so the browser can `fetch` pack.json and WAVs same-origin (avoids CDN CORS).

Run from this directory:
  python3 scripts/download_soundlib.py all   # once, to populate ./soundlib/
  python3 server.py
Then open http://127.0.0.1:8765/
"""

from __future__ import annotations

import http.client
import mimetypes
import os
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


ORIGIN = "intro.novationmusic.com"


class Handler(SimpleHTTPRequestHandler):
    def _maybe_proxy(self) -> bool:
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/novation/"):
            return False
        rel = urllib.parse.unquote(parsed.path[len("/novation/") :].lstrip("/"))
        self._proxy_novation(rel, parsed.query, send_body=self.command != "HEAD")
        return True

    def do_GET(self) -> None:  # noqa: N802
        if self._maybe_proxy():
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        if self._maybe_proxy():
            return
        super().do_HEAD()

    def _proxy_novation(self, rel: str, query: str, *, send_body: bool) -> None:
        if ".." in rel.split("/"):
            self.send_error(400, "Bad path")
            return
        parts = [urllib.parse.quote(seg, safe="") for seg in rel.split("/") if seg != ""]
        target = "/" + "/".join(parts)
        if query:
            target += "?" + query
        method = "HEAD" if not send_body else "GET"
        conn = http.client.HTTPSConnection(ORIGIN, timeout=30)
        try:
            conn.request(method, target, headers={"Host": ORIGIN, "User-Agent": "session-pad-grid-local-proxy"})
            resp = conn.getresponse()
            body = b"" if not send_body else resp.read()
        except OSError as e:
            self.send_error(502, str(e))
            return
        finally:
            conn.close()

        ctype = resp.getheader("Content-Type") or mimetypes.guess_type(rel)[0] or "application/octet-stream"
        self.send_response(resp.status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        # Quieter default logging for proxied asset traffic
        if args and isinstance(args[0], str) and args[0].startswith("GET /novation/"):
            return
        if args and isinstance(args[0], str) and args[0].startswith("HEAD /novation/"):
            return
        super().log_message(format, *args)


def main() -> None:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    host = "127.0.0.1"
    port = 8765
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Serving http://{host}:{port}/  (local: /soundlib/… ; proxy: /novation/…)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
