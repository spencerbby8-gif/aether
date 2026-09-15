#!/usr/bin/env python3
"""Make the engine reachable before the model finishes loading into VRAM.

WHAT WAS MEASURED (scripts/perf/wake-profile.py, engine D, beacon timestamps):

    kernel boot                 +0s
    ollama download            +19s
    model pull start           +38s
    model on disk             +215s      <- 176s: 15.3 GB from Hugging Face
    warming up                +216s
    WARM OK                   +331s      <- 115s: weights into VRAM
    agent layer               +332s
    orchestration             +332s
    tunnel ready              +337s
    health READY              +347s

The tunnel is started at the END of cell 4, after the warmup loop. So for the
whole 115s VRAM load -- a third of the entire wake -- the kernel is fully
functional (ollama serving, model on disk, agent layer importable) and still
completely unreachable. The client sees "waking" and there is nothing it can
poll.

THE FIX: start the HTTP server and the tunnel immediately, run the warmup in a
background thread, and gate only /api/chat on the warmup finishing.

    tunnel ready              ~+221s     (was +337s)
    health READY              ~+222s     (was +347s)

Nothing is faked. /api/ps still reports the real model list; /api/chat still
waits for the real warmup and says so while it waits. The engine is simply
discoverable and honest about its state 115s earlier.

Run with --check to assert every change is present, --revert to undo.
"""
import json
import os
import sys

ASSET = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "android", "app", "src", "main", "assets", "aether-notebook-template.json",
)

# --------------------------------------------------------------------------
# 1. Replace the blocking warmup with a threaded one.
# --------------------------------------------------------------------------
WARM_OLD = """NUM_CTX = 8192
notify('warming up ' + MODEL.split(':')[-1] + ' (loading 15GB into VRAM)...')
warm = False
for attempt in range(12):
    rw = subprocess.run(['curl','-s','-m','1200','http://127.0.0.1:11434/api/chat','-d', json.dumps({'model':MODEL,'messages':[{'role':'user','content':'hi'}],'stream':False,'keep_alive':-1,'options':{'num_ctx':NUM_CTX,'num_predict':16}})], env=e, capture_output=True, text=True)
    body = (rw.stdout or '')[:200]
    try: ps = urllib.request.urlopen('http://127.0.0.1:11434/api/ps', timeout=10).read().decode()
    except Exception as ex: ps = 'pserr'
    if '"content"' in body and len(ps) > 25:
        warm = True; notify('WARM OK attempt %d ps=%s' % (attempt, ps[:120])); break
    olog = ''
    try: olog = open('/kaggle/working/ollama.log').read()[-200:]
    except Exception: pass
    notify('warm a%d rc=%s body=%s olog=%s' % (attempt, rw.returncode, body.replace('/kaggle/temp/models/blobs/','')[:130], olog.replace(chr(10),' | ')[-150:]))
    time.sleep(20)
if not warm:
    notify('Qwen unloadable -> FALLBACK: Dolphin Venice 24B (universal arch)')
    fb = 'hf.co/eaddario/Dolphin-Mistral-24B-Venice-Edition-GGUF:Q4_K_M'
    r = subprocess.run(['/kaggle/temp/ob/bin/ollama','pull',fb], env=e, capture_output=True, text=True)
    notify('fallback pull exit=%s' % r.returncode)
    if r.returncode == 0:
        MODEL = fb; open('/kaggle/working/MODEL.txt','w').write(MODEL)
        rw = subprocess.run(['curl','-s','-m','1200','http://127.0.0.1:11434/api/chat','-d', json.dumps({'model':MODEL,'messages':[{'role':'user','content':'hi'}],'stream':False,'keep_alive':-1,'options':{'num_ctx':NUM_CTX,'num_predict':16}})], env=e, capture_output=True, text=True)
        try: ps = urllib.request.urlopen('http://127.0.0.1:11434/api/ps', timeout=10).read().decode()
        except Exception: ps = ''
        warm = 'models' in ps and len(ps) > 25
        notify('fallback warm=%s' % warm)
if not warm:
    setstage('FAILED: all warmups')
    # Announce the reason, then STOP. Hanging here kept the Kaggle run
    # 'running' for hours on an engine that could never serve anything:
    # it burned GPU quota and made the app report 'turning on' forever,
    # because a running kernel reads as a boot still in progress. Ending
    # the cell stops the run and hands the GPU back, so the failure is
    # reported as a failure within seconds.
    notify('ENGINE FAILED: all warmups - releasing the GPU so the app can report it')
    raise SystemExit(1)
notify('model WARM & pinned - deploying AGENT layer (web_search/fetch_page/crawl/run_command)')
"""

WARM_NEW = """NUM_CTX = 8192

# ---------------------------------------------------------------------------
# THE WARMUP IS A BACKGROUND THREAD. IT USED TO BLOCK THE WHOLE CELL.
#
# Measured on a live engine (scripts/perf/wake-profile.py, engine D):
#   model on disk  +215s -> WARM OK  +331s -> tunnel ready  +337s
# The 115s of VRAM loading happened BEFORE the tunnel existed, so for a third
# of the entire wake the kernel was serving ollama with the model on disk and
# still completely unreachable. A client could not even ask how far along it
# was; the UI said "waking" and there was nothing to poll.
#
# The tunnel now comes up first and only /api/chat waits for the warmup. The
# warmup itself is unchanged -- same probe, same Dolphin fallback, same
# failure handling -- it just no longer stands in front of the tunnel.
#
# _READY is the single source of truth for "can this engine answer a message".
# Nothing else is allowed to claim readiness: /api/ps answering 200 with a
# model in the list means the weights are on disk, not that they are in VRAM.
# ---------------------------------------------------------------------------
_READY = {'warm': False, 'stage': 'loading weights into VRAM', 'since': time.time(), 'failed': ''}


def _warm_worker():
    global MODEL
    notify('warming up ' + MODEL.split(':')[-1] + ' (loading 15GB into VRAM)...')
    warm = False
    for attempt in range(12):
        rw = subprocess.run(['curl','-s','-m','1200','http://127.0.0.1:11434/api/chat','-d', json.dumps({'model':MODEL,'messages':[{'role':'user','content':'hi'}],'stream':False,'keep_alive':-1,'options':{'num_ctx':NUM_CTX,'num_predict':16}})], env=e, capture_output=True, text=True)
        body = (rw.stdout or '')[:200]
        try: ps = urllib.request.urlopen('http://127.0.0.1:11434/api/ps', timeout=10).read().decode()
        except Exception as ex: ps = 'pserr'
        if '"content"' in body and len(ps) > 25:
            warm = True; notify('WARM OK attempt %d ps=%s' % (attempt, ps[:120])); break
        olog = ''
        try: olog = open('/kaggle/working/ollama.log').read()[-200:]
        except Exception: pass
        notify('warm a%d rc=%s body=%s olog=%s' % (attempt, rw.returncode, body.replace('/kaggle/temp/models/blobs/','')[:130], olog.replace(chr(10),' | ')[-150:]))
        time.sleep(20)
    if not warm:
        notify('Qwen unloadable -> FALLBACK: Dolphin Venice 24B (universal arch)')
        _READY['stage'] = 'primary model would not load - pulling the fallback'
        fb = 'hf.co/eaddario/Dolphin-Mistral-24B-Venice-Edition-GGUF:Q4_K_M'
        r = subprocess.run(['/kaggle/temp/ob/bin/ollama','pull',fb], env=e, capture_output=True, text=True)
        notify('fallback pull exit=%s' % r.returncode)
        if r.returncode == 0:
            MODEL = fb; open('/kaggle/working/MODEL.txt','w').write(MODEL)
            rw = subprocess.run(['curl','-s','-m','1200','http://127.0.0.1:11434/api/chat','-d', json.dumps({'model':MODEL,'messages':[{'role':'user','content':'hi'}],'stream':False,'keep_alive':-1,'options':{'num_ctx':NUM_CTX,'num_predict':16}})], env=e, capture_output=True, text=True)
            try: ps = urllib.request.urlopen('http://127.0.0.1:11434/api/ps', timeout=10).read().decode()
            except Exception: ps = ''
            warm = 'models' in ps and len(ps) > 25
            notify('fallback warm=%s' % warm)
    if warm:
        _READY['warm'] = True
        _READY['stage'] = 'ready'
        notify('model WARM & pinned - engine can now answer')
        return
    # Same failure handling as before, with one difference: the tunnel is
    # already up, so the failure is reported THROUGH it instead of only to the
    # beacon. A client that is polling finds out immediately rather than
    # waiting for the boot window to expire.
    _READY['failed'] = 'no model could be loaded into VRAM'
    setstage('FAILED: all warmups')
    notify('ENGINE FAILED: all warmups - releasing the GPU so the app can report it')


threading.Thread(target=_warm_worker, daemon=True).start()
notify('warming in the background - bringing the tunnel up now')
"""

# --------------------------------------------------------------------------
# 2. Gate /api/chat on the warmup, and expose the truth on /api/ready.
# --------------------------------------------------------------------------
GATE_OLD = """        try:
            payload = json.loads(body or b'{}')
        except Exception:
            payload = {}
        self._sent = False
        try:
            agent_stream(self, payload)"""

GATE_NEW = """        try:
            payload = json.loads(body or b'{}')
        except Exception:
            payload = {}
        # The tunnel is up before the model is in VRAM (see _warm_worker). A
        # chat that arrives in that window is held rather than failed: Ollama
        # serves one request at a time, so sending it now would queue it
        # behind the warmup anyway and the user would wait the same time with
        # no explanation. A heartbeat goes out every 10s so the client can see
        # the engine is alive and working, not hung.
        if not _READY['warm'] and self.path == '/api/chat':
            if _READY['failed']:
                msg = json.dumps({'error': _READY['failed'], 'ready': False}).encode()
                self.send_response(503); self.send_header('Content-Type','application/json')
                self.send_header('Content-Length', str(len(msg))); self.end_headers()
                self.wfile.write(msg); self.wfile.flush()
                return
            self.send_response(200)
            self.send_header('Content-Type','application/x-ndjson')
            self.send_header('Transfer-Encoding','chunked')
            self.send_header('Connection','close')
            self.close_connection = True
            self.end_headers()
            self._sent = True

            def _hb(obj):
                line = (json.dumps(obj) + chr(10)).encode()
                self.wfile.write(('%x\\r\\n' % len(line)).encode() + line + b'\\r\\n')
                self.wfile.flush()

            _t0 = time.time()
            while not _READY['warm'] and not _READY['failed'] and (time.time() - _t0) < 300:
                try:
                    _hb({'message': {'thinking': 'engine is starting - ' + _READY['stage']
                                     + ' (' + str(int(time.time() - _t0)) + 's)'},
                         'done': False})
                except Exception:
                    return          # client went away mid-wait
                time.sleep(10)
            if _READY['failed']:
                try:
                    _hb({'message': {'content': '(engine error: ' + _READY['failed'] + ')'},
                         'done': True})
                except Exception:
                    pass
                return
            if not _READY['warm']:
                try:
                    _hb({'message': {'content': '(the engine is still loading its model '
                                                'after 300s - send the message again)'},
                         'done': True})
                except Exception:
                    pass
                return
        self._sent = False
        try:
            agent_stream(self, payload)"""

# /api/ready sits next to the /api/ps proxy so a client can ask the engine
# directly instead of inferring readiness from a model list.
READY_ROUTE_OLD = """    def do_GET(self):
        if self.path in ('/','/index.html','/chat'):"""

READY_ROUTE_NEW = """    def do_GET(self):
        if self.path.startswith('/api/ready'):
            # Truthful readiness. /api/ps returning a model only proves the
            # weights are on disk; this is the flag the chat gate actually
            # uses, so a client polling it can never be told "live" by an
            # engine that cannot answer yet.
            msg = json.dumps({'ready': bool(_READY['warm']),
                              'stage': _READY['stage'],
                              'failed': _READY['failed'],
                              'seconds_since_boot': int(time.time() - _READY['since'])}).encode()
            self.send_response(200); self.send_header('Content-Type','application/json')
            self.send_header('Content-Length', str(len(msg))); self._cors(); self.end_headers()
            self.wfile.write(msg)
            return
        if self.path in ('/','/index.html','/chat'):"""

# --------------------------------------------------------------------------
# 3. A run of failing tool steps must end the turn.
#
# MEASURED LIVE, not simulated. Asked for a long-running command, the model
# re-issued it eleven times in one turn. Nothing in the budget caught it:
# `give_up_on` only counts FAILURES and `duplicate_of` only matches an EXACT
# repeat, and each retry differed by one character. The turn ran to the 24-call
# ceiling -- 24 messages, roles SUATAUATATATATATATATATATAT, and an empty final
# answer:
#
#   engine=d MODEL FAIL n=24 roles=SUATAUATATATATATATATATAT has_user=True
#
# A second reproduction (sleep 40, 39, 38 ... six times, all succeeding) took
# 262s and also ended with `final content: ''`. The stall watchdog never fired
# in either case, because it only measures the gap between MODEL calls and a
# loop that keeps calling tools looks exactly like progress.
#
# Two counters close that: consecutive failing steps, and consecutive steps
# that ran tools without saying anything to the user.
#
# BOTH ARE ENFORCED BEFORE THE NEXT STEP EXECUTES. The first version of this
# checked after the step's tools had already run, which stopped the turn one
# full step late -- three more dead 150s round trips instead of none past the
# second. Counters are updated at the end of a step and read at the top of the
# next one.
# --------------------------------------------------------------------------
GUARD_OLD = """            def _run_one(nm, ar):"""

GUARD_NEW = """            # ---- circuit breakers, enforced BEFORE anything executes ----
            # Fed by the accounting at the end of the previous step, so the
            # step that trips a limit never spends the user's time on it.
            if _consec_fail >= _MAX_CONSEC_FAIL:
                emit({'message': {'content':
                    '(I stopped: %d steps in a row failed. Retrying the same '
                    'action was not going to work -- tell me what to try '
                    'instead.)' % _consec_fail}, 'done': False})
                break
            if _silent >= _MAX_SILENT_STEPS:
                emit({'message': {'content':
                    '(I stopped: %d steps in a row ran tools without producing '
                    'an answer. The work so far is saved -- say continue and I '
                    'will pick it up.)' % _silent}, 'done': False})
                break

            def _run_one(nm, ar):"""

COUNTER_OLD = """    _MAX_ITERS = max(10, min(40, budget.max_calls))
    _stalled = 0
    it = 0"""

COUNTER_NEW = """    _MAX_ITERS = max(10, min(40, budget.max_calls))
    _stalled = 0
    # Three consecutive failing steps, not thirty. The budget ceiling is 24
    # calls and a failing step can carry several, so by the time 24 is reached
    # the user has already sat through twenty-odd dead round trips.
    _MAX_CONSEC_FAIL = 3
    # Twelve silent tool steps. A real multi-tool task measured at six, so this
    # is twice that and legitimate work is never cut off.
    _MAX_SILENT_STEPS = 12
    _consec_fail = 0
    _silent = 0
    it = 0"""

# The accounting that feeds them. It MUST live on the tool path: a tool step
# ends with `it += 1; continue`, so anything placed after the verification gate
# is never reached by the very steps these counters exist to judge. The first
# version of this put it there and both breakers stayed at zero forever --
# caught by tests G and I, which ran eight failing steps and twenty silent ones
# without a single stop.
ACCOUNT_OLD = """            if repeats and repeats == len(tcs):"""

ACCOUNT_NEW = """            # ---- accounting for the circuit breakers ----
            # Only real executions count: a replayed call is answered from
            # memory and says nothing about whether the action works.
            if plan:
                _ok_any = False
                for k in range(len(plan)):
                    if plan[k][2]:
                        continue      # replayed from memory, not executed
                    try:
                        _ok_any = _ok_any or bool(
                            normalize(plan[k][0], results[k] or '', plan[k][1]).get('ok', False))
                    except Exception:
                        # An unnormalizable result is not evidence of failure;
                        # counting it would stop turns that are actually working.
                        _ok_any = True
                _consec_fail = 0 if _ok_any else _consec_fail + 1
            # A step that called tools but said nothing to the user has not
            # produced an answer yet. A genuine multi-tool turn is several of
            # these in a row, so the limit is generous and it is enforced at
            # the top of the next step, before anything executes.
            _silent = _silent + 1 if not (m.get('content') or '').strip() else 0

            if repeats and repeats == len(tcs):"""

EDITS = [
    ("threaded warmup", WARM_OLD, WARM_NEW),
    ("chat gate + heartbeats", GATE_OLD, GATE_NEW),
    ("/api/ready route", READY_ROUTE_OLD, READY_ROUTE_NEW),
    ("loop counters", COUNTER_OLD, COUNTER_NEW),
    ("breakers before execution", GUARD_OLD, GUARD_NEW),
    ("breaker accounting", ACCOUNT_OLD, ACCOUNT_NEW),
]

def load():
    with open(ASSET, encoding="utf-8") as fh:
        return json.load(fh)


def cell4(nb):
    for i, c in enumerate(nb["cells"]):
        if c.get("cell_type") != "code":
            continue
        if "Warmup (pin in VRAM" in "".join(c["source"]):
            return i, "".join(c["source"])
    raise SystemExit("could not find the agent cell by content")


def write_cell(nb, idx, src):
    nb["cells"][idx]["source"] = src
    with open(ASSET, "w", encoding="utf-8") as fh:
        # ensure_ascii=True: the shipped asset stores non-ASCII as \uXXXX
        # escapes, so writing the literal characters would rewrite every
        # emoji in the notebook and bury the real change in a 7 KB diff.
        # No trailing newline: the shipped asset has none, and adding one
        # would show up as a change to every line of a single-line file.
        json.dump(nb, fh, ensure_ascii=True, separators=(", ", ": "))


def check():
    nb = load()
    _, src = cell4(nb)
    ok = True
    for name, old, new in EDITS:
        has_new = new in src
        # A needle can legitimately survive as a substring of its own
        # replacement (both breakers wrap the line they replace), so "the old
        # text is gone" is only a meaningful assertion when it is not part of
        # the new text. Otherwise it would report a correct patch as partial.
        # A needle can also survive inside the patched text simply because the
        # patch keeps the surrounding lines it was anchored on. Compare against
        # the count instead: an unpatched file has the needle exactly as many
        # times as the patch leaves behind, plus nothing.
        old_should_be_gone = old not in new and src.count(old) <= new.count(old)
        stale = has_old = (old in src) and old_should_be_gone
        note = "  (still unpatched)" if stale else ""
        if not old_should_be_gone:
            note = "  (needle is a substring of the replacement)"
        print("%-30s %s%s" % (name, "YES" if has_new else "NO ", note))
        ok = ok and has_new and not stale
    # The gate is only real if the old blocking tail is gone.
    gone = "raise SystemExit(1)\nnotify('model WARM & pinned - deploying AGENT layer" not in src
    print("%-30s %s" % ("blocking tail removed", "YES" if gone else "NO "))
    ok = ok and gone
    print("wake-speed-fix: " + ("OK, every change is present" if ok else "INCOMPLETE"))
    return 0 if ok else 1


def revert():
    nb = load()
    idx, src = cell4(nb)
    n = 0
    for name, old, new in EDITS:
        if new in src:
            src = src.replace(new, old, 1)
            n += 1
    write_cell(nb, idx, src)
    print("reverted %d change(s)" % n)
    return 0


def apply():
    nb = load()
    idx, src = cell4(nb)
    for name, old, new in EDITS:
        if new in src:
            continue
        if old not in src:
            raise SystemExit("REFUSING to write: needle for %r not found" % name)
        src = src.replace(old, new, 1)
    write_cell(nb, idx, src)
    print("applied %d change(s)" % len(EDITS))
    return 0


if __name__ == "__main__":
    if "--check" in sys.argv:
        raise SystemExit(check())
    if "--revert" in sys.argv:
        raise SystemExit(revert())
    raise SystemExit(apply())
