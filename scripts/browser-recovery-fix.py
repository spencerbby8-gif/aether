#!/usr/bin/env python3
"""Browser agent recovery: classify step failures for the circuit breakers.

BEFORE (the reported bug): every engine POST's agent loop counted a step as
"failed" when none of its executed tools normalized to ok -- with no
distinction between WHY. A CAPTCHA wall, a rate limit, a missed selector and
a crashing tool all incremented the same consecutive-failure counter, so a
browser task that hit three blocked/missed steps in a row ended with
"(I stopped: 3 steps in a row failed)" while nothing had actually failed.
That is the "it always stops after a few runs" behaviour.

AFTER: _fail_kind() classifies a failing result as

    blocked    the site needs a human: CAPTCHA, sign-in, consent, approval
    transient  time or the network may fix it: timeout, rate limit, 5xx
    recover    the agent can fix it cheaply: missed selector, no results
    terminal   a real failure

and _account_step() routes each step into the matching bounded rail
(_B_CAPS). The generic consecutive-failure rail (_MAX_CONSEC_FAIL = 3) now
counts terminal failures only. CAPTCHA and other explicit user-action
blockers stay human-in-the-loop: they are reported honestly and stop the
turn when the blocked rail fills -- never bypassed.

The 24-call Budget, per-action max_fails=2, _MAX_ITERS and the silent-step
rail are untouched.

Applies to android/app/src/main/assets/aether-notebook-template.json.
Idempotent; --check asserts state, --revert undoes (byte-exact), bare run
applies. Writer discipline as wake-cache-stall-fix.py: ensure_ascii=True,
separators (", ", ": "), no trailing newline.

After applying: node scripts/sync-engine-source.mjs, then move BOTH pins in
tests/kaggle-wake-source.test.ts (SHA-256 constant and rendered byteLength).
"""
import json
import os
import sys

ASSET = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "android", "app", "src", "main", "assets", "aether-notebook-template.json",
)

# --------------------------------------------------------------------------
# R1. the classifier + step accountant, defined before agent_stream
# --------------------------------------------------------------------------
R1_OLD = """_a_load_orch()
notify('orchestration layer loaded (route/plan/budget/normalize/verify)')

def agent_stream(handler, user_payload):"""

R1_NEW = """_a_load_orch()
notify('orchestration layer loaded (route/plan/budget/normalize/verify)')

# ---- circuit-breaker failure classification --------------------------------
#
# A CAPTCHA wall, a rate limit and a crashing tool are three different
# situations, and the old rail treated them identically: any step whose
# executed tools were not all-ok incremented the consecutive-failure
# counter, so a site that asked for a human on three steps in a row ended
# the turn with "(I stopped: 3 steps in a row failed)" -- while nothing
# had actually failed. Classify first, then count in the right bucket.
# Every bucket stays bounded; this removes no safety limit.

_B_CAPS = {'blocked': 4, 'transient': 5, 'recover': 6}

def _fail_kind(tool, n):
    \"\"\"Map a FAILING tool result to a breaker class.

    blocked    the site needs a human: CAPTCHA, sign-in, consent, approval.
    transient  time or the network may fix it: timeout, rate limit, 5xx.
    recover    the agent can fix it cheaply: missed selector, no results.
    terminal   a real failure: none of the above.
    \"\"\"
    n = n or {}
    kind = str(n.get('kind') or '')
    text = str(n.get('brief') or n.get('raw') or '').strip()
    if kind == 'browser-blocked':
        return 'blocked'
    if re.match(r'(?i)^(BLOCKED|NEEDS APPROVAL)', text):
        return 'blocked'
    if re.search(r'(?i)\\b(captcha|are you (a )?(robot|human)|verify (that )?you.{0,12}human|'
                 r'sign ?in required|log ?in required|two.?factor|one.?time code|'
                 r'cookie consent|paywall|subscription required)\\b', text):
        return 'blocked'
    if re.match(r'(?i)^TIMED OUT', text) or re.search(
            r'(?i)\\b(timed? ?out|rate.?limit|too many requests|http 429|http 50[23]|'
            r'bad gateway|service unavailable|temporarily unavailable|'
            r'connection (reset|refused|closed)|fetch failed|crawl empty|network)\\b', text):
        return 'transient'
    if re.search(r'(?i)\\b(not found|no results|no visible|nothing matched|no match|missing)\\b', text):
        return 'recover'
    return 'terminal'

def _account_step(plan, results, normalize):
    \"\"\"Classify one executed step for the circuit breakers.

    Returns 'ok' when any executed tool succeeded (the old _ok_any), else
    the worst failure class among the executed tools, ranked
    terminal > blocked > transient > recover. Replayed-from-memory calls
    say nothing about the world and are skipped, exactly as before. An
    unnormalizable result is still not counted as failure.\"\"\"
    rank = {'ok': 0, 'recover': 1, 'transient': 2, 'blocked': 3, 'terminal': 4}
    ok_any = False
    worst = None
    for k in range(len(plan)):
        if plan[k][2]:
            continue
        try:
            n = normalize(plan[k][0], results[k] or '', plan[k][1])
            ok = bool(n.get('ok', False))
        except Exception:
            n = None
            ok = True
        if ok:
            ok_any = True
            continue
        fk = _fail_kind(plan[k][0], n)
        if rank.get(fk, 4) > rank.get(worst, 0):
            worst = fk
    if ok_any:
        return 'ok'
    return worst or 'terminal'

def agent_stream(handler, user_payload):"""

# --------------------------------------------------------------------------
# R2. counter initialization inside agent_stream
# --------------------------------------------------------------------------
R2_OLD = """    _MAX_CONSEC_FAIL = 3
    # Twelve silent tool steps. A real multi-tool task measured at six, so this
    # is twice that and legitimate work is never cut off.
    _MAX_SILENT_STEPS = 12
    _consec_fail = 0
    _silent = 0
    it = 0"""

R2_NEW = """    _MAX_CONSEC_FAIL = 3
    # Twelve silent tool steps. A real multi-tool task measured at six, so this
    # is twice that and legitimate work is never cut off.
    _MAX_SILENT_STEPS = 12
    # Blocked / transient / recoverable steps are routed by _account_step
    # into their own bounded rails (_B_CAPS): a CAPTCHA must not read as a
    # crash, but it must not loop forever either. The generic rail above
    # now counts terminal failures only.
    _consec_fail = 0
    _silent = 0
    _brk = {'blocked': 0, 'transient': 0, 'recover': 0}
    it = 0"""

# --------------------------------------------------------------------------
# R3. the circuit breakers: named, honest stop messages per class
# --------------------------------------------------------------------------
R3_OLD = """            if _consec_fail >= _MAX_CONSEC_FAIL:
                emit({'message': {'content':
                    '(I stopped: %d steps in a row failed. Retrying the same '
                    'action was not going to work -- tell me what to try '
                    'instead.)' % _consec_fail}, 'done': False})
                break
            if _silent >= _MAX_SILENT_STEPS:"""

R3_NEW = """            if _consec_fail >= _MAX_CONSEC_FAIL:
                emit({'message': {'content':
                    '(I stopped: %d steps in a row failed. Retrying the same '
                    'action was not going to work -- tell me what to try '
                    'instead.)' % _consec_fail}, 'done': False})
                break
            if _brk['blocked'] >= _B_CAPS['blocked']:
                emit({'message': {'content':
                    '(I stopped: the site wants a human before I can continue '
                    '-- a CAPTCHA, a sign-in or a consent step. Nothing is '
                    'broken; complete that step and send the task again, or '
                    'tell me another way.)'}, 'done': False})
                break
            if _brk['transient'] >= _B_CAPS['transient']:
                emit({'message': {'content':
                    '(I stopped: repeated timeouts and rate limits -- the '
                    'site or the network is refusing me right now. The work '
                    'so far is saved; try again in a few minutes.)'}, 'done': False})
                break
            if _brk['recover'] >= _B_CAPS['recover']:
                emit({'message': {'content':
                    '(I stopped: %d steps in a row could not find what they '
                    'were aimed at. Retrying the same way was not going to '
                    'work -- tell me what to try instead.)'
                    % _brk['recover']}, 'done': False})
                break
            if _silent >= _MAX_SILENT_STEPS:"""

# --------------------------------------------------------------------------
# R4. the accounting: classify, then count in the right rail
# --------------------------------------------------------------------------
R4_OLD = """            if plan:
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
                _consec_fail = 0 if _ok_any else _consec_fail + 1"""

R4_NEW = """            if plan:
                _step = _account_step(plan, results, normalize)
                if _step == 'ok':
                    _consec_fail = 0
                    _brk = {'blocked': 0, 'transient': 0, 'recover': 0}
                elif _step == 'terminal':
                    _consec_fail = _consec_fail + 1
                else:
                    _brk[_step] = _brk.get(_step, 0) + 1"""

EDITS = [
    ("Warmup (pin in VRAM", "classifier+accountant", R1_OLD, R1_NEW),
    ("Warmup (pin in VRAM", "counter-init", R2_OLD, R2_NEW),
    ("Warmup (pin in VRAM", "breakers-per-class", R3_OLD, R3_NEW),
    ("Warmup (pin in VRAM", "accounting-classified", R4_OLD, R4_NEW),
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
    before = raw
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
            print("  rev  %-24s" % name)
        elif has_new:
            print("  ok   %-24s (already applied)" % name)
        elif has_old:
            src2 = src.replace(old, new, 1)
            c["source"] = src2
            print("  app  %-24s" % name)
        else:
            raise SystemExit(
                "FAIL: edit %r does not match the cell -- the template has "
                "moved; refusing to write" % name)
    after = json.dumps(nb, ensure_ascii=True, separators=(", ", ": "))
    if after == before and not revert:
        print("nothing to write")
        return
    save(nb)
    print("written: %s (%d -> %d bytes)" % (ASSET, len(before), len(after)))


def main():
    if "--check" in sys.argv:
        raw, nb = load()
        ok = True
        for marker, name, old, new in EDITS:
            c, src = cell_for(nb, marker)
            if new in src:
                print("  ok   %s (applied)" % name)
            elif old in src:
                print("  MISS %s (not applied)" % name)
                ok = False
            else:
                print("  FAIL %s (template drifted)" % name)
                ok = False
        sys.exit(0 if ok else 1)
    run(apply=("--revert" not in sys.argv), revert=("--revert" in sys.argv))


if __name__ == "__main__":
    main()
