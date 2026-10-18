"""Open the dashboard: python3 serve.py

Serves only the dashboard's own files, and only to this computer (127.0.0.1),
so sign-in tokens, credentials and raw data in this folder are never exposed.
Requests must name this server itself (Host 127.0.0.1:<port> or
localhost:<port>), so a website can't reach it by pointing its own domain
name at 127.0.0.1 (DNS rebinding).
"""
import argparse
import os
import re
import socket
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
# Only the dashboard's own scripts run, and it talks to nothing but this server.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; "
       "base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
PUBLIC = {'/index.html', '/styles.css', '/app.js', '/icons.js', '/dashboard_data.json', '/demo_data.json', '/portrait.webp',
          '/placeholder-man.webp', '/placeholder-woman.webp'}


class DashboardHandler(SimpleHTTPRequestHandler):
    def host_ok(self):
        port = self.server.server_address[1]
        return (self.headers.get('Host') or '').lower() in {f'127.0.0.1:{port}', f'localhost:{port}'}

    def do_GET(self):
        if not self.host_ok():
            self.send_error(403)
            return
        path = urlparse(self.path).path
        if path == '/':
            path = '/index.html'
        m = re.fullmatch(r'/hr/(\d{4}-\d{2}-\d{2})\.json', path)
        if m:
            self.send_day_hr(m.group(1))
            return
        if path not in PUBLIC:
            self.send_error(404)
            return
        self.path = path
        super().do_GET()

    def send_day_hr(self, date):
        # One day's raw heart-rate readings for the Heart page, fetched only when opened.
        try:
            import hr_detail
            body = hr_detail.day_readings_json(date)
        except Exception:
            body = None
        if body is None:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def end_headers(self):
        # Always serve the latest build after the daily sync.
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', CSP)
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
