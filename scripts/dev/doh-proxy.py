#!/usr/bin/env python3
"""A CONNECT proxy that resolves hostnames through DNS-over-HTTPS.

WHY. This sandbox resolves through 8.8.8.8, which returned NXDOMAIN for a
brand-new trycloudflare tunnel hostname while Cloudflare's own resolver
answered it correctly. The engine was healthy; the record simply had not
reached the resolver this sandbox uses, and there is no root here to pin
/etc/hosts. Proofs were failing with "Name or service not known" against a
perfectly live engine.

Only CONNECT is implemented, which is all an HTTPS client needs. The tunnel is
blind, so the TLS handshake passes through untouched and SNI plus the
certificate still match the real hostname -- nothing here can see or alter the
traffic. Answers are cached, and a name the system resolver already knows is
left alone so ordinary hosts are unaffected.

Usage:  python3 scripts/dev/doh-proxy.py [port]
        HTTPS_PROXY=http://127.0.0.1:8899 python3 scripts/proofs/... <url>
"""
import json
import socket
import sys
import threading
import urllib.request

LISTEN = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
DOH = 'https://1.1.1.1/dns-query?name=%s&type=A'
cache = {}


def resolve(host):
    if host in cache:
        return cache[host]
    try:                                    # the system resolver first
        ip = socket.gethostbyname(host)
    except Exception:
        ip = None
    if not ip:
        try:
            req = urllib.request.Request(DOH % host,
                                         headers={'accept': 'application/dns-json'})
            d = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
            for a in (d.get('Answer') or []):
                if a.get('type') == 1:
                    ip = a['data']
                    print('DoH  %-52s -> %s' % (host, ip), flush=True)
                    break
        except Exception as e:
            print('DoH failed for %s: %s' % (host, e), flush=True)
    if ip:
        cache[host] = ip
    return ip


def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except Exception:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass


def handle(c):
    try:
        c.settimeout(60)
        head = b''
        while b'\r\n\r\n' not in head and len(head) < 65536:
            d = c.recv(4096)
            if not d:
                c.close()
                return
            head += d
        line = head.split(b'\r\n', 1)[0].decode('latin1')
        parts = line.split()
        if len(parts) < 2 or parts[0].upper() != 'CONNECT':
            c.sendall(b'HTTP/1.1 405 Only CONNECT\r\n\r\n')
            c.close()
            return
        host, _, port = parts[1].partition(':')
        ip = resolve(host)
        if not ip:
            c.sendall(b'HTTP/1.1 502 Cannot resolve\r\n\r\n')
            c.close()
            return
        try:
            u = socket.create_connection((ip, int(port or 443)), timeout=30)
        except Exception as e:
            print('connect %s:%s failed: %s' % (ip, port, e), flush=True)
            c.sendall(b'HTTP/1.1 502 Upstream refused\r\n\r\n')
            c.close()
            return
        c.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
        c.settimeout(None)
        # Anything the client already sent along with the request.
        rest = head.split(b'\r\n\r\n', 1)[1]
        if rest:
            u.sendall(rest)
        threading.Thread(target=pipe, args=(c, u), daemon=True).start()
        pipe(u, c)
    except Exception as e:
        print('handler: %s' % e, flush=True)
        try:
            c.close()
        except Exception:
            pass


srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('0.0.0.0', LISTEN))
srv.listen(128)
print('DoH CONNECT proxy on 0.0.0.0:%d' % LISTEN, flush=True)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
