#!/usr/bin/env python3
"""Cold-wake dataset cache + progress-based stall detector.

Applies to android/app/src/main/assets/aether-notebook-template.json.
Idempotent; --check asserts state, --revert undoes (byte-exact), bare run
applies. Same writer discipline as wake-speed-fix.py: ensure_ascii=True,
separators (", ", ": "), no trailing newline, so apply->revert round-trips
byte-identically.

EDIT SET A -- cold wake (measured BEFORE, beacon stage timelines A/B/C/D):

    ollama tarball download   21-41s every boot   (github.com)
    model pull 16.9 GB      111-353s every boot   (hf.co)

Both are network transfers of bytes that never change. Kaggle kernels mount
datasets read-only from /kaggle/input with no download, so the engine-cache
dataset (built once by scripts/push-cache-builder.py: ollama tarball + the
exact model store a real pull produced) turns both into local reads:
extract from the mount, symlink blobs, untar manifests, verify against
`ollama list`. Every cache path falls through to the old download path on
any problem, so a missing/corrupt cache costs nothing but the check.

EDIT SET B -- stall detection (the flat 180s wall-clock limit was wrong in
BOTH directions):

  * too slow: a dead engine held the user's "thinking" state for a full 180s
    before the turn was reported (measured live, 3 firings);
  * too fast: it counted wall time regardless of progress, so a HEALTHY
    generation longer than 180s (NUM_PREDICT=4096 at ~15 tok/s is a
    legitimate 273s) would have been killed mid-sentence.

Measured live numbers that set the new limits:
    slowest legitimate first token   51.9s (cold reasoning turn)
    slowest cold prefill             23.1s (2953 tokens)
    worst legitimate inter-chunk gap  9.7s (normal <0.1s)
New detector: 90s to first progress, 45s between chunks, 900s absolute
backstop. Every parsed chunk (content, thinking, tool call) counts as
progress -- silence is the only failure signature. The final answer call
(which had NO watchdog at all: a dead engine froze the stream for curl's
full 1200s timeout) gets the same treatment at 90s.
"""
import json
import os
import sys

ASSET = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "android", "app", "src", "main", "assets", "aether-notebook-template.json",
)

# --------------------------------------------------------------------------
# A1. cell 2: ollama tarball from the dataset cache
# --------------------------------------------------------------------------
A1_OLD = """ok = os.path.exists(OB + '/bin/ollama')
if not ok:
    os.makedirs(OB, exist_ok=True)
    for u in URLS:"""

A1_NEW = """ok = os.path.exists(OB + '/bin/ollama')
CACHE_PKG = '/kaggle/input/aether-engine-cache/ollama-linux-amd64.tar.zst'
if not ok and os.path.exists(CACHE_PKG):
    # Cold-wake fix: this download cost 21-41s on every boot (measured on
    # A/B/C/D). The identical bytes are mounted from the Kaggle dataset, so
    # this is a local read. Falls through to the download URLs on any error.
    setstage('ollama from dataset cache')
    try:
        os.makedirs(OB, exist_ok=True)
        subprocess.run(['pip', 'install', '-q', 'zstandard'])
        import zstandard
        with open(CACHE_PKG, 'rb') as fi, open('/kaggle/temp/ollama.tar', 'wb') as fo:
            zstandard.ZstdDecompressor().copy_stream(fi, fo)
        _rt = subprocess.run(['tar', '-xf', '/kaggle/temp/ollama.tar', '-C', OB], capture_output=True, text=True)
        if _rt.returncode == 0 and os.path.exists(OB + '/bin/ollama'):
            ok = True
            notify('ollama READY from dataset cache')
    except Exception as _ex:
        notify('cache extract failed, will download: ' + str(_ex)[:150])
if not ok:
    os.makedirs(OB, exist_ok=True)
    for u in URLS:"""

# --------------------------------------------------------------------------
# A2. cell 3: model store from the dataset cache
# --------------------------------------------------------------------------
A2_OLD = """e = json.load(open('/kaggle/working/ollama.env'))
CANDS = ['hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS', 'hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:Q4_K_M']
done = None
for t in CANDS:
    setstage('pulling ' + t.split(':')[-1])"""

A2_NEW = """e = json.load(open('/kaggle/working/ollama.env'))
CANDS = ['hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS', 'hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:Q4_K_M']
done = None
CACHE = '/kaggle/input/aether-engine-cache'
if os.path.isdir(CACHE):
    # Cold-wake fix: `ollama pull` of this model cost 111-353s on every boot
    # (measured on A/B/C/D) -- the single largest slice of cold wake. The
    # exact store a real pull produced is mounted from the Kaggle dataset:
    # blobs symlinked (the mount is read-only), manifests extracted, then
    # verified against `ollama list` before being trusted. Any problem at
    # all falls through to the network pull below.
    try:
        import tarfile
        _blobs = [f for f in os.listdir(CACHE) if f.startswith('sha256-')]
        # Kaggle auto-extracts tars inside datasets (measured: manifests.tar
        # mounts as a manifests/ directory), so accept either shape.
        _mdir = CACHE + '/manifests'
        _mtar = CACHE + '/manifests.tar'
        if _blobs and (os.path.isdir(_mdir) or os.path.exists(_mtar)):
            _t0 = time.time()
            setstage('model from dataset cache')
            os.makedirs('/kaggle/temp/models/blobs', exist_ok=True)
            for _f in _blobs:
                _dst = '/kaggle/temp/models/blobs/' + _f
                if not os.path.exists(_dst):
                    os.symlink(CACHE + '/' + _f, _dst)
            if os.path.isdir(_mdir):
                subprocess.run(['cp', '-r', _mdir, '/kaggle/temp/models/'], check=True)
            else:
                with tarfile.open(_mtar) as _tf:
                    _tf.extractall('/kaggle/temp/models')
            # Kaggle extracts manifests.tar into a folder named after the
            # file, so the tree arrives as manifests/manifests/hf.co/...
            # (measured live: ollama listed nothing until this was undone).
            # Flatten one level of accidental nesting when present.
            _nest = '/kaggle/temp/models/manifests/manifests'
            if os.path.isdir(_nest):
                for _entry in os.listdir(_nest):
                    subprocess.run(['mv', os.path.join(_nest, _entry),
                                    '/kaggle/temp/models/manifests/'], check=True)
                os.rmdir(_nest)
            # The store is complete when every blob the manifests reference is
            # present. Asking `ollama list` here was wrong on first live run:
            # the server is started in the previous cell and may still be
            # coming up, so list returned empty and a perfect cache was
            # discarded for a full network pull.
            _mm = '/kaggle/temp/models/manifests'
            _refs, _missing = [], []
            for _base, _dirs, _files in os.walk(_mm):
                for _fn in _files:
                    try:
                        _man = json.load(open(os.path.join(_base, _fn)))
                    except Exception:
                        continue
                    for _l in (_man.get('layers') or []):
                        _d = (_l.get('digest') or '').replace(':', '-')
                        if _d.startswith('sha256-'):
                            _refs.append(_d)
                            if not os.path.exists('/kaggle/temp/models/blobs/' + _d):
                                _missing.append(_d)
            if _refs and not _missing:
                # Trust but verify: ask the server itself. First live run of
                # the cache path passed the disk check and Ollama still said
                # "model not found", so the server gets the final word; on
                # any doubt fall through to the pull (self-healing) and say
                # exactly what the server saw.
                _listed = ''
                for _ in range(6):
                    _lr = subprocess.run(['/kaggle/temp/ob/bin/ollama', 'list'], env=e, capture_output=True, text=True)
                    _listed = (_lr.stdout or '') + (_lr.stderr or '')
                    if 'qwen3.8-27b' in _listed.lower():
                        break
                    time.sleep(5)
                if 'qwen3.8-27b' in _listed.lower():
                    done = CANDS[0]
                    notify('model READY from dataset cache: %d blobs, %d manifest layers in %.1fs' % (len(_blobs), len(_refs), time.time() - _t0))
                else:
                    _paths = subprocess.run(['find', '/kaggle/temp/models/manifests', '-type', 'f'], capture_output=True, text=True)
                    notify('cache on disk but ollama does not list it; pulling. list=%r manifests=%r' % (_listed[:120], (_paths.stdout or '')[:300]))
            else:
                notify('model cache incomplete (refs=%d missing=%d); pulling' % (len(_refs), len(_missing)))
    except Exception as _ex:
        notify('model cache failed, will pull: ' + str(_ex)[:150])
for t in CANDS:
    if done:
        break
    setstage('pulling ' + t.split(':')[-1])"""

# --------------------------------------------------------------------------
# B1. ollama_stream gains an on_progress hook
# --------------------------------------------------------------------------
B1_OLD = "def ollama_stream(payload, push, timeout=1200, on_think=None):"
B1_NEW = "def ollama_stream(payload, push, timeout=1200, on_think=None, on_progress=None):"

# --------------------------------------------------------------------------
# B2. every parsed chunk reports progress
# --------------------------------------------------------------------------
B2_OLD = """                try: ch = json.loads(raw)
                except Exception: continue
                mm = ch.get('message') or {}"""

B2_NEW = """                try: ch = json.loads(raw)
                except Exception: continue
                # Stall-detector input: EVERY parsed chunk counts as progress
                # -- content, thinking or a tool call. Which kind it was does
                # not matter; silence is the only failure signature.
                if on_progress is not None:
                    try: on_progress()
                    except Exception: pass
                mm = ch.get('message') or {}"""

# --------------------------------------------------------------------------
# B3. the agent loop wires progress into its shared state
# --------------------------------------------------------------------------
B3_OLD = """        def _call(q=q, p=payload, s=push, ot=on_think):"""
B3_NEW = """        def on_prog(st=st):
            # Progress signal for the stall detector: stamped on every parsed
            # chunk the worker receives from Ollama.
            st['last'] = time.time()
            st['prog'] = True

        def _call(q=q, p=payload, s=push, ot=on_think, op=on_prog):"""

B4_OLD = "                q.put(ollama_stream(p, s, on_think=ot))"
B4_NEW = "                q.put(ollama_stream(p, s, on_think=ot, on_progress=op))"

# --------------------------------------------------------------------------
# B5. the watchdog itself: silence-based instead of wall-clock
# --------------------------------------------------------------------------
B5_OLD = """        _STALL_LIMIT = 180.0
        _waited = 0.0
        while tw.is_alive():
            emit({'message':{'thinking':'⏳'},'done':False})
            tw.join(timeout=10)
            _waited += 10.0
            if _waited >= _STALL_LIMIT:
                # Give up on this model call and let the loop's own error path
                # handle it: the turn is reported, not abandoned silently.
                notify('MODEL STALL: no response after %.0fs, abandoning the call' % _waited)
                try:
                    q.put({'message': {'role': 'assistant',
                                       'content': '(engine stall: the model produced '
                                                  'nothing for %.0f seconds)' % _waited},
                           'done': True})
                except Exception:
                    pass
                break
        try:
            resp = q.get(timeout=30)"""

B5_NEW = """        # Stall detector v2: silence-based, replacing the flat 180s wall
        # limit that was wrong in both directions -- a dead engine held the
        # user's turn for a full 180s (measured live, 3 firings), while a
        # HEALTHY generation over 180s (NUM_PREDICT=4096 at ~15 tok/s is a
        # legitimate 273s) would have been cut off mid-sentence because the
        # old counter advanced on wall time regardless of progress.
        # Limits set from live measurements: slowest legitimate first token
        # 51.9s (cold reasoning turn), slowest cold prefill 23.1s, worst
        # legitimate inter-chunk gap 9.7s (normal <0.1s).
        _FIRST_PROGRESS_LIMIT = 90.0
        _NO_PROGRESS_LIMIT = 45.0
        _STALL_LIMIT = 900.0
        _waited = 0.0
        st['last'] = time.time()
        st['prog'] = False
        while tw.is_alive():
            emit({'message':{'thinking':'⏳'},'done':False})
            tw.join(timeout=5)
            _waited += 5.0
            _silence = time.time() - st['last']
            _lim = _NO_PROGRESS_LIMIT if st.get('prog') else _FIRST_PROGRESS_LIMIT
            if _silence >= _lim or _waited >= _STALL_LIMIT:
                # Give up on this model call and let the loop's own error path
                # handle it: the turn is reported, not abandoned silently.
                notify('MODEL STALL: %.0fs silent (limit %.0fs, %.0fs into the call), abandoning' % (_silence, _lim, _waited))
                try:
                    q.put({'message': {'role': 'assistant',
                                       'content': '(engine stall: the model produced '
                                                  'nothing for %.0f seconds)' % _silence},
                           'done': True})
                except Exception:
                    pass
                break
        try:
            resp = q.get(timeout=30)"""

# --------------------------------------------------------------------------
# B6. the final answer call gets the same watchdog (it had none)
# --------------------------------------------------------------------------
B6_OLD = """    try:
        for raw in p.stdout:
            emit(json.loads(raw))
    finally:
        try: p.kill()
        except Exception: pass"""

B6_NEW = """    # The final answer call had NO watchdog: an engine that died here froze
    # the user's stream for curl's full 1200s timeout -- the worst possible
    # "stuck on generating". Same silence rule as the agent loop; legitimate
    # inter-chunk gaps measured under 10s, so 90s of silence is dead.
    _fl = {'t': time.time()}
    def _fwatch(p=p, fl=_fl):
        while p.poll() is None:
            time.sleep(5)
            if time.time() - fl['t'] < 90.0:
                continue
            notify('MODEL STALL: final answer silent 90s, killing the stream')
            try:
                emit({'message': {'content': '(engine stall: the model stopped '
                                             'responding mid-answer)'}, 'done': True})
            except Exception:
                pass
            try: p.kill()
            except Exception: pass
            return
    threading.Thread(target=_fwatch, daemon=True).start()
    try:
        for raw in p.stdout:
            _fl['t'] = time.time()
            emit(json.loads(raw))
    finally:
        try: p.kill()
        except Exception: pass"""

EDITS = [
    ("[1] Install ollama", "ollama-from-cache", A1_OLD, A1_NEW),
    ("[2] Pull model", "model-from-cache", A2_OLD, A2_NEW),
    ("Warmup (pin in VRAM", "stream-on-progress-param", B1_OLD, B1_NEW),
    ("Warmup (pin in VRAM", "chunk-progress-signal", B2_OLD, B2_NEW),
    ("Warmup (pin in VRAM", "loop-progress-wiring", B3_OLD, B3_NEW),
    ("Warmup (pin in VRAM", "loop-progress-call", B4_OLD, B4_NEW),
    ("Warmup (pin in VRAM", "silence-watchdog", B5_OLD, B5_NEW),
    ("Warmup (pin in VRAM", "final-call-watchdog", B6_OLD, B6_NEW),
]


def load():
    with open(ASSET, "r", encoding="utf-8") as f:
        raw = f.read()
    return raw, json.loads(raw)


def save(nb):
    with open(ASSET, "w", encoding="utf-8") as f:
        f.write(json.dumps(nb, ensure_ascii=True, separators=(", ", ": ")))


def cell_for(nb, marker):
    for c in nb["cells"]:
        src = "".join(c.get("source", []))
        if marker in src:
            return c, src
    raise SystemExit("cell not found for marker %r" % marker)


def run(apply, revert):
    raw, nb = load()
    changed = False
    for marker, name, old, new in EDITS:
        c, src = cell_for(nb, marker)
        has_old = old in src
        has_new = new in src
        if revert:
            if not has_new:
                print("  --   %-24s (not applied)" % name)
                continue
            src2 = src.replace(new, old, 1)
            c["source"] = src2
            changed = True
            print("  rev  %-24s" % name)
        elif apply:
            if has_new:
                print("  ==   %-24s (already applied)" % name)
                continue
            n = src.count(old)
            if n != 1:
                raise SystemExit("REFUSING: needle for %r found %d times" % (name, n))
            c["source"] = src.replace(old, new, 1)
            changed = True
            print("  +    %-24s" % name)
        else:  # check
            if has_new:
                print("  ok   %-24s applied" % name)
            elif has_old:
                print("  --   %-24s not applied (original present)" % name)
                changed = True  # signal: not fully applied
            else:
                # Neither: the needle moved. Only an error when the
                # replacement does not contain the needle (substring case).
                if old not in new:
                    print("  ERR  %-24s neither state found" % name)
                    changed = True
                else:
                    print("  ok   %-24s (needle is substring of replacement)" % name)
    if apply or revert:
        if not changed:
            print("nothing to write")
            return 0
        save(nb)
        print("written:", ASSET)
    return 1 if changed and not (apply or revert) else 0


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(run(False, False))
    if "--revert" in sys.argv:
        sys.exit(run(False, True))
    sys.exit(run(True, False))
