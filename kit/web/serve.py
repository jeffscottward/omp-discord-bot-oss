#!/usr/bin/python3
"""Static report server for $REPORTS_WEB_DIR (omp-reports-web.service). The FIRSTMATE dashboard is $REPORTS_WEB_DIR/firstmate/.

python -m http.server plus:
- HTTP Range requests (206), which iOS Safari needs to play <audio>/<video>;
- Cache-Control: no-cache, so phones revalidate (304) instead of showing stale pages.
Usage: serve.py [PORT BIND DIRECTORY]
Without arguments: REPORTS_PORT (8790), REPORTS_BIND (127.0.0.1) and REPORTS_WEB_DIR from ~/.config/omp-discord/kit.env.
Keep BIND on loopback and publish it with `tailscale serve` (see docs/SETUP.md), not on a public interface.
"""
import functools
import http.server
import os
import re
import sys


def _kit_env():
    """Read the kit settings file (KEY=VALUE lines; the shell kit scripts read the same file).
    File: $OMP_KIT_ENV, else ~/.config/omp-discord/kit.env. A variable that is already set in the environment wins."""
    path = os.environ.get("OMP_KIT_ENV") or os.path.expanduser("~/.config/omp-discord/kit.env")
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].strip()
        key, sep, val = line.partition("=")
        key, val = key.strip(), val.strip()
        if not sep or line.startswith("#") or not key.isidentifier() or key in os.environ:
            continue
        if len(val) >= 2 and val[0] == val[-1] == "'":
            val = val[1:-1]
        else:
            if len(val) >= 2 and val[0] == val[-1] == '"':
                val = val[1:-1]
            val = os.path.expanduser(os.path.expandvars(val))
        os.environ[key] = val


_kit_env()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".webmanifest": "application/manifest+json", ".md": "text/markdown; charset=utf-8",
                      ".mp3": "audio/mpeg", ".m4a": "audio/mp4"}
    _range = None

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        if self.command in ("GET", "HEAD"):
            self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        self._range = None
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        path = self.translate_path(self.path)
        if not m or os.path.isdir(path) or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        a, b = m.group(1), m.group(2)
        if a == "" and b == "":
            return super().send_head()
        if a == "":
            start, end = max(0, size - int(b)), size - 1
        else:
            start, end = int(a), min(int(b), size - 1) if b else size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        f = open(path, "rb")
        try:
            fs = os.fstat(f.fileno())
            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
            self.end_headers()
            f.seek(start)
            self._range = end - start + 1
            return f
        except Exception:
            f.close()
            raise

    def copyfile(self, source, outputfile):
        left = self._range
        if left is None:
            return super().copyfile(source, outputfile)
        while left > 0:
            chunk = source.read(min(65536, left))
            if not chunk:
                break
            outputfile.write(chunk)
            left -= len(chunk)


def main():
    if len(sys.argv) == 4:
        port, bind, directory = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    else:
        port = int(os.environ.get("REPORTS_PORT") or 8790)
        bind = os.environ.get("REPORTS_BIND") or "127.0.0.1"
        directory = os.environ.get("REPORTS_WEB_DIR") or os.path.expanduser("~/.local/share/omp-discord/reports-web")
    os.makedirs(directory, exist_ok=True)
    handler = functools.partial(Handler, directory=directory)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer((bind, port), handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
