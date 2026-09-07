"""Emit heartbeats while tools run, and pre-install the browser at boot.

A tool call used to run with the response silent. Short tools did not matter,
but a browser install or a long build can run for minutes, and an idle tunnel
connection is dropped long before that. The client's stall watchdog is not the
limit -- the tunnel is.

Run from the repo root:  python3 scripts/patch-tool-heartbeats.py
"""
import hashlib
import json

P = 'android/app/src/main/assets/aether-notebook-template.json'

OLD_SINGLE = """            if len(fresh) == 1:
                k, nm, ar = fresh[0]
                results[k] = _run_one(nm, ar)
                emit({'message':{'thinking':'\\u21b3 ' + nm + ' returned ' + str(len(results[k])) + ' chars'},'done':False})
            elif len(fresh) > 1:
                import concurrent.futures as _cf
                with _cf.ThreadPoolExecutor(max_workers=min(4, len(fresh))) as _ex:
                    _futs = {_ex.submit(_run_one, nm, ar): (k, nm) for k, nm, ar in fresh}
                    for _f in _cf.as_completed(_futs):
                        k, nm = _futs[_f]
                        try: results[k] = _f.result()
                        except Exception as e: results[k] = 'tool error: ' + str(e)
                        emit({'message':{'thinking':'\\u21b3 ' + nm + ' returned ' + str(len(results[k])) + ' chars'},'done':False})
"""

NEW_SINGLE = """            if fresh:
                # Always through the pool, even for one call, so a heartbeat
                # goes out every few seconds while a tool runs. Without it a
                # long tool -- a browser install, a build, a slow download --
                # leaves the response silent and the tunnel drops the
                # connection. The client's stall timer was never the limit.
                import concurrent.futures as _cf
                with _cf.ThreadPoolExecutor(max_workers=min(4, len(fresh))) as _ex:
                    _futs = {_ex.submit(_run_one, nm, ar): (k, nm) for k, nm, ar in fresh}
                    _pending = set(_futs)
                    while _pending:
                        _done, _pending = _cf.wait(_pending, timeout=8)
                        for _f in _done:
                            k, nm = _futs[_f]
                            try: results[k] = _f.result()
                            except Exception as e: results[k] = 'tool error: ' + str(e)
                            emit({'message':{'thinking':'\\u21b3 ' + nm + ' returned ' + str(len(results[k])) + ' chars'},'done':False})
                        if _pending:
                            emit({'message':{'thinking':'\\u23f3'},'done':False})
"""

PREWARM = """
# The browser is installed in the background as soon as the engine is up, so
# the first browser action is not a ten-minute download. A lock keeps a request
# that arrives mid-install from starting a second one.
_BROWSER_LOCK = threading.Lock()


def _b_prewarm():
    try:
        with _BROWSER_LOCK:
            try:
                import playwright  # noqa: F401
                return
            except Exception:
                pass
            subprocess.run(['pip', 'install', '-q', 'playwright'],
                           capture_output=True, timeout=900)
            subprocess.run(['python3', '-m', 'playwright', 'install', 'chromium'],
                           capture_output=True, timeout=1200)
    except Exception:
        pass


threading.Thread(target=_b_prewarm, daemon=True).start()
"""


def main():
    nb = json.load(open(P))
    s = nb['cells'][4]['source']

    if '_cf.wait(_pending' in s:
        print('tool heartbeats already present -- nothing to do')
        return

    assert s.count(OLD_SINGLE) == 1, s.count(OLD_SINGLE)
    s = s.replace(OLD_SINGLE, NEW_SINGLE)

    # Prewarm goes in after the browser worker thread is started.
    anchor = "threading.Thread(target=_b_worker, daemon=True).start()"
    assert s.count(anchor) == 1, s.count(anchor)
    s = s.replace(anchor, anchor + "\n" + PREWARM)

    # _b_ensure must take the same lock, or a request during prewarm installs
    # a second copy.
    old_ensure = """def _b_ensure():
    if _BROWSER['ready']:
        return _BROWSER['br']
    if _BROWSER['err']:
        raise RuntimeError(_BROWSER['err'])
    try:"""
    assert s.count(old_ensure) == 1, s.count(old_ensure)
    s = s.replace(old_ensure, """def _b_ensure():
    if _BROWSER['ready']:
        return _BROWSER['br']
    if _BROWSER['err']:
        raise RuntimeError(_BROWSER['err'])
    with _BROWSER_LOCK:
        return _b_launch()


def _b_launch():
    if _BROWSER['ready']:
        return _BROWSER['br']
    try:""")

    nb['cells'][4]['source'] = s
    open(P, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))
    b = open(P, 'rb').read()
    compile(s, 'cell4', 'exec')
    print('template %d bytes sha %s (compiles)' % (len(b), hashlib.sha256(b).hexdigest()))


if __name__ == '__main__':
    main()
