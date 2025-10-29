#!/usr/bin/env python3

import argparse
import http.server
import os
import socketserver
from functools import partial


class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Serve files and respond to CORS preflight checks."""

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200, "OK")
        self.end_headers()


def main():
    parser = argparse.ArgumentParser(
        description="Serve ./docs with permissive CORS headers for dev tunnelling."
    )
    parser.add_argument(
        "--directory",
        "-d",
        default="docs",
        help="Directory to serve (default: %(default)s)",
    )
    parser.add_argument(
        "--port",
        "-p",
        type=int,
        default=8001,
        help="Port to listen on (default: %(default)s)",
    )
    parser.add_argument(
        "--bind",
        "-b",
        default="0.0.0.0",
        help="Address to bind (default: %(default)s)",
    )
    args = parser.parse_args()

    directory = os.path.abspath(args.directory)
    handler_cls = partial(CORSRequestHandler, directory=directory)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.bind, args.port), handler_cls) as httpd:
        print(f"Serving {directory} at http://{args.bind}:{args.port} with CORS enabled")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down…")
        finally:
            httpd.server_close()


if __name__ == "__main__":
    main()
