#!/usr/bin/env python3
"""Serve one constrained HLS format from operator-managed local directories."""

import argparse
import ipaddress
import os
from pathlib import Path
import re
import stat
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


IDENTIFIER = r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
SEGMENT = r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ts"
ROUTE = re.compile(rf"/sources/({IDENTIFIER})/({IDENTIFIER})/(index\.m3u8|{SEGMENT})")
PLAYLIST_TAG = re.compile(
    r"#(?:EXT-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE):[0-9]{1,16}"
    r"|EXT-X-PLAYLIST-TYPE:(?:VOD|EVENT)"
    r"|EXT-X-(?:ENDLIST|DISCONTINUITY|INDEPENDENT-SEGMENTS)"
    r"|EXTINF:[0-9]{1,6}(?:\.[0-9]{1,9})?,)"
)
PLAYLIST_LIMIT = 256 * 1024
SEGMENT_LIMIT = 64 * 1024 * 1024


def validate_playlist(raw):
    lines = raw.decode("ascii").replace("\r\n", "\n").rstrip("\n").split("\n")
    if not lines or lines[0] != "#EXTM3U":
        raise ValueError("expected a media playlist")
    pending_segment = False
    segments = 0
    for line in lines[1:]:
        if re.fullmatch(SEGMENT, line) and pending_segment:
            segments += 1
            pending_segment = False
        elif not pending_segment and PLAYLIST_TAG.fullmatch(line):
            pending_segment = line.startswith("#EXTINF:")
        else:
            raise ValueError("unsupported media playlist")
    if pending_segment or not segments:
        raise ValueError("playlist has no complete segments")
    return ("\n".join(lines) + "\n").encode("ascii")


def open_asset(root, tenant, source, asset):
    directory_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
    root_fd = os.open(root, directory_flags)
    try:
        tenant_fd = os.open(tenant, directory_flags, dir_fd=root_fd)
        try:
            source_fd = os.open(source, directory_flags, dir_fd=tenant_fd)
            try:
                return os.fdopen(os.open(asset, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd), "rb")
            finally:
                os.close(source_fd)
        finally:
            os.close(tenant_fd)
    finally:
        os.close(root_fd)


class Gateway(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(8)
        super().setup()

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_asset(head=False)

    def do_HEAD(self):
        self.send_asset(head=True)

    def send_asset(self, head):
        if ipaddress.ip_address(self.client_address[0]) not in self.server.worker_network:
            self.send_error(403)
            return
        route = ROUTE.fullmatch(self.path)
        if not route:
            self.send_error(404)
            return
        tenant, source, asset = route.groups()
        try:
            stream = open_asset(self.server.root, tenant, source, asset)
        except OSError:
            self.send_error(404)
            return
        with stream:
            details = os.fstat(stream.fileno())
            playlist = asset == "index.m3u8"
            limit = PLAYLIST_LIMIT if playlist else SEGMENT_LIMIT
            if not stat.S_ISREG(details.st_mode) or not 0 < details.st_size <= limit:
                self.send_error(404)
                return
            if playlist:
                raw = stream.read(limit + 1)
                try:
                    if len(raw) > limit:
                        raise ValueError("playlist exceeds size limit")
                    body = validate_playlist(raw)
                except ValueError:
                    self.send_error(422)
                    return
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl" if playlist else "video/MP2T")
            self.send_header("Content-Length", str(len(body) if playlist else details.st_size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not head:
                try:
                    if playlist:
                        self.wfile.write(body)
                    else:
                        remaining = details.st_size
                        while remaining:
                            block = stream.read(min(remaining, 128 * 1024))
                            if not block:
                                break
                            self.wfile.write(block)
                            remaining -= len(block)
                except (ConnectionError, TimeoutError):
                    pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--bind", required=True, type=ipaddress.IPv4Address)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--worker-network", required=True, type=ipaddress.IPv4Network)
    args = parser.parse_args()
    if not args.root.is_dir() or args.bind.is_unspecified or not 1 <= args.port <= 65535:
        parser.error("provide an existing root, explicit bind address and valid port")
    server = ThreadingHTTPServer((str(args.bind), args.port), Gateway)
    server.root = args.root.resolve(strict=True)
    server.worker_network = args.worker_network
    server.serve_forever()


if __name__ == "__main__":
    main()
