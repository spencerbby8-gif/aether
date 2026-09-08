"""Restart the tunnel when cloudflared dies.

Observed on a live engine: it served thirteen requests normally, then its
tunnel started answering 530 while Kaggle still reported the kernel as
running. Every request after that failed. Nothing restarted the tunnel, so the
engine was unreachable for the rest of its life and the only recovery was a
fresh push.

cloudflared quick tunnels do die on their own. The kernel now watches the
process and, when it exits, starts a new one and announces the new URL -- the
old quick tunnel address never comes back, so a client holding it needs the
replacement. The log is truncated first: otherwise the URL scan re-reads the
dead address and re-announces it.

Run from the repo root:  python3 scripts/tunnel-supervisor.py
"""
import hashlib
import json

P = 'android/app/src/main/assets/aether-notebook-template.json'

ANCHOR = "tun = subprocess.Popen('/kaggle/working/cloudflared tunnel --url http://localhost:8080 --no-autoupdate'.split(), stdout=open('/kaggle/working/tunnel.log','w'), stderr=subprocess.STDOUT)"

SUPERVISOR = '''

TUNNEL_LOG = '/kaggle/working/tunnel.log'


def _read_tunnel_url(path=TUNNEL_LOG):
    """The quick tunnel URL in the log, or None when there is not one yet."""
    try:
        m = re.search(r'https://[a-z0-9-]+\\.trycloudflare\\.com',
                      open(path).read())
        return m.group(0) if m else None
    except Exception:
        return None


def _start_tunnel():
    # Truncate first. The scan below would otherwise find the URL of the tunnel
    # that just died and announce a dead address as if it were the new one.
    open(TUNNEL_LOG, 'w').close()
    return subprocess.Popen(
        '/kaggle/working/cloudflared tunnel --url http://localhost:8080 --no-autoupdate'.split(),
        stdout=open(TUNNEL_LOG, 'w'), stderr=subprocess.STDOUT)


def _tunnel_supervisor():
    """Keep the engine reachable for as long as the kernel is alive.

    A quick tunnel dying does not kill the kernel, and Kaggle keeps reporting
    the notebook as running, so from the outside the engine simply stops
    answering with no way to tell why. Watch the process and replace it.
    """
    global tun, url, SYSMSG
    while True:
        time.sleep(30)
        try:
            if tun is not None and tun.poll() is None:
                continue
        except Exception:
            pass
        try:
            old = url
            tun = _start_tunnel()
            fresh = None
            for _ in range(30):
                time.sleep(4)
                fresh = _read_tunnel_url()
                if fresh:
                    break
            if not fresh:
                continue
            url = fresh
            if old and old in SYSMSG:
                SYSMSG = SYSMSG.replace(old, fresh)
            notify('AGENT LIVE LINK: ' + str(url) + ' (tools: ' + ' '.join(EXEC.keys()) + ')')
        except Exception:
            pass


threading.Thread(target=_tunnel_supervisor, daemon=True).start()
'''


def main():
    nb = json.load(open(P))
    s = nb['cells'][4]['source']
    if '_tunnel_supervisor' in s:
        print('tunnel supervisor already present -- nothing to do')
        return
    assert s.count(ANCHOR) == 1, s.count(ANCHOR)
    s = s.replace(ANCHOR, ANCHOR + SUPERVISOR)
    nb['cells'][4]['source'] = s
    open(P, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))
    compile(s, 'cell4', 'exec')
    raw = open(P, 'rb').read()
    print('template %d bytes sha %s (compiles)'
          % (len(raw), hashlib.sha256(raw).hexdigest()))


if __name__ == '__main__':
    main()
