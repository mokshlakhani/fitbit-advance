"""Open the dashboard: python3 serve.py

Serves only the dashboard's own files, and only to this computer (127.0.0.1),
so sign-in tokens, credentials and raw data in this folder are never exposed.
"""
import argparse
import os
import socket
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = {'/index.html', '/styles.css', '/app.js', '/dashboard_data.json', '/demo_data.json'}


class DashboardHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/':
            path = '/index.html'
        if path not in PUBLIC:
            self.send_error(404)
            return
        self.path = path
        super().do_GET()

    def do_HEAD(self):
        self.do_GET()

    def end_headers(self):
        # Always serve the latest build after the daily sync.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *args):
        pass


def free_port(start=8088):
    for port in range(start, start + 50):
        with socket.socket() as s:
            try:
                s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    raise SystemExit('No free port found between 8088 and 8137.')


def serve(port=None, open_browser=True):
    port = port or free_port()
    server = ThreadingHTTPServer(('127.0.0.1', port), partial(DashboardHandler, directory=HERE))
    url = f'http://127.0.0.1:{port}/'
    print(f'Dashboard running at {url}  (press Ctrl+C to stop)')
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
    finally:
        server.server_close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='Serve the dashboard on this computer only.')
    ap.add_argument('--port', type=int, help='port to use (default: 8088 or the next free one)')
    ap.add_argument('--no-browser', action='store_true', help="don't open a browser tab")
    args = ap.parse_args()
    serve(args.port, not args.no_browser)
