"""Minimal Range-supporting HTTP server that logs every request — simulates /stream/."""
import http.server, os, re, sys, threading

FILE = os.path.join(os.environ.get("TEMP", "/tmp"), "hevc10_nofaststart.mp4")
LOG = []

class RangeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        size = os.path.getsize(FILE)
        rng = self.headers.get("Range")
        LOG.append(rng or "FULL")
        print(f"REQ Range: {rng}", flush=True)
        if rng:
            m = re.match(r"bytes=(\d+)-(\d*)", rng)
            start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            length = end - start + 1
        else:
            start, length = 0, size
            self.send_response(200)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Type", "video/mp4")
        self.end_headers()
        with open(FILE, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk: break
                try: self.wfile.write(chunk)
                except (ConnectionAbortedError, BrokenPipeError): return
                remaining -= len(chunk)

http.server.ThreadingHTTPServer(("127.0.0.1", 18999), RangeHandler).serve_forever()
