"""Make /off actually end the Kaggle session.

Measured on a live engine: POST /off returned 200, the tunnel went to 530, and
Kaggle's kernels/status still said "running" three minutes later. The next push
was then refused with "Maximum batch GPU session count of 2 reached."

os._exit(0) kills this Python process, but the notebook runs under a Jupyter
server that owns the Kaggle SESSION -- and Kaggle counts a live session against
GPU quota even with no process running. So the engine looked off, held its
quota, and could not be started again. pkill jupyter is what ends the session.

The tunnel supervisor also has to stand down, or it restarts cloudflared
straight after the shutdown and the engine looks alive again.

Run from the repo root:  python3 scripts/off-switch-fix.py
"""
import hashlib
import json

P = 'android/app/src/main/assets/aether-notebook-template.json'

OFF_OLD = """            notify('ENGINE OFF via UI - quota saved')
            print('ENGINE OFF requested - shutting down now', flush=True)
            threading.Thread(target=lambda: (time.sleep(0.5), os._exit(0))).start()"""

OFF_NEW = """            notify('ENGINE OFF via UI - quota saved')
            print('ENGINE OFF requested - shutting down now', flush=True)
            threading.Thread(target=_halt, daemon=True).start()"""

HALT = '''

_HALT = {'on': False}


def _halt():
    """End the Kaggle session, not just this process.

    os._exit alone left the Jupyter server alive, and Kaggle counts the session
    against GPU quota even with nothing running -- measured as still "running"
    three minutes after /off returned 200, which then refused the next push
    with "Maximum batch GPU session count of 2 reached".
    """
    _HALT['on'] = True
    time.sleep(0.5)
    try:
        subprocess.run(['pkill', '-f', 'cloudflared'])
    except Exception:
        pass
    try:
        subprocess.run(['pkill', '-f', 'jupyter'])
    except Exception:
        pass
    time.sleep(4)
    try:
        os._exit(0)
    except Exception:
        pass

'''

GUARD_OLD = """    global tun, url, SYSMSG
    while True:
        time.sleep(30)"""

GUARD_NEW = """    global tun, url, SYSMSG
    while True:
        time.sleep(30)
        if _HALT['on']:
            return          # shutting down on purpose: do not resurrect it"""


def main():
    nb = json.load(open(P))
    s = nb['cells'][4]['source']
    if 'def _halt' in s:
        print('/off session kill already present -- nothing to do')
        return
    for a in (OFF_OLD, GUARD_OLD):
        assert s.count(a) == 1, (a[:40], s.count(a))
    s = s.replace(OFF_OLD, OFF_NEW)
    s = s.replace(GUARD_OLD, GUARD_NEW)
    # _halt must exist before the handler can call it; put it next to the
    # supervisor, which is defined long before the request handler runs.
    i = s.index('def _read_tunnel_url')
    s = s[:i] + HALT.lstrip('\n') + '\n' + s[i:]
    nb['cells'][4]['source'] = s
    open(P, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))
    compile(s, 'cell4', 'exec')
    raw = open(P, 'rb').read()
    print('template %d bytes sha %s (compiles)'
          % (len(raw), hashlib.sha256(raw).hexdigest()))


if __name__ == '__main__':
    main()
