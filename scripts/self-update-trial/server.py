"""Serves the self-update trial's release files on 127.0.0.1: `server.py <folder> <port>`.

With a file named .cut in the folder, an archive download is ended halfway, as a dropped connection would end it.
"""
import http.server, os, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.translate_path(self.path.split("?")[0])
        if os.path.exists(".cut") and path.endswith(".tar.zst") and os.path.isfile(path):
            size = os.path.getsize(path)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(path, "rb") as f:
                self.wfile.write(f.read(size // 2))
            self.wfile.flush()
            self.connection.close()
            return
        try:
            super().do_GET()
        except (ConnectionResetError, BrokenPipeError):
            # The updater hangs up as soon as it sees a bad archive; that is the case under test, not an error here.
            pass
    def log_message(self, *args):
        pass

os.chdir(sys.argv[1])
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), Handler).serve_forever()
