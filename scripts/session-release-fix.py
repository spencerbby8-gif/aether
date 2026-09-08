"""Make shutdown actually end the Kaggle run and release the GPU.

Measured, not assumed. POST /off returned 200 and the tunnel went to 530, but
kernels/status still said "running" 50 minutes later -- and the next push was
refused with "Maximum batch GPU session count of 2 reached". So os._exit(0)
kills this Python process and leaves the Kaggle SESSION alive, which is the
thing that holds the quota. The idle watchdog had the same bug, so the
"60 min idle -> shutdown to save quota" path never saved anything either.

Why exiting the process does not work: Kaggle runs the notebook's cells in
order and the run ends when the last cell RETURNS. Cell 5 blocks in
`while True`, so it owns the run. Killing the interpreter leaves Kaggle holding
a session whose kernel died.

So shutdown now sets a flag, drops the tunnel, and lets cell 5 break out and
return. The run completes normally and the GPU is released.

Run from the repo root:  python3 scripts/session-release-fix.py
"""
import hashlib
import json

P = 'android/app/src/main/assets/aether-notebook-template.json'

HALT_OLD = """def _halt():
    \"\"\"End the Kaggle session, not just this process.

    os._exit alone left the Jupyter server alive, and Kaggle counts the session
    against GPU quota even with nothing running -- measured as still "running"
    three minutes after /off returned 200, which then refused the next push
    with "Maximum batch GPU session count of 2 reached".
    \"\"\"
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
        pass"""

HALT_NEW = """def _halt():
    \"\"\"End the Kaggle run, not just this process.

    os._exit(0) was measured to be useless here: /off returned 200, the tunnel
    died, and kernels/status still said "running" 50 minutes later -- and the
    next push was refused with "Maximum batch GPU session count of 2 reached".
    Kaggle runs the cells in order and the run ends when the last cell returns,
    and that last cell is blocked in its keep-alive loop. So set the flag that
    loop watches and let the notebook finish on its own.
    \"\"\"
    _HALT['on'] = True
    time.sleep(0.5)
    # Drop the tunnel at once so clients stop talking to a dead engine; the
    # supervisor stands down on the same flag and will not restart it.
    try:
        subprocess.run(['pkill', '-f', 'cloudflared'])
    except Exception:
        pass"""

CELL5_OLD_HEAD = """import time, subprocess, json, os
print('keep-alive + idle-watchdog running (60 min idle -> shutdown to save quota)', flush=True)
IDLE_LIMIT = 3600.0
last_pub = 0.0
while True:
    time.sleep(60)
    try:"""

CELL5_NEW_HEAD = """import time, subprocess, json, os
print('keep-alive + idle-watchdog running (60 min idle -> shutdown to save quota)', flush=True)
IDLE_LIMIT = 3600.0
last_pub = 0.0
try:
    _HALT
except NameError:          # cell 4 never got as far as defining it
    _HALT = {'on': False}
_reason = 'completed'
while True:
    # Sleep in short slices. A shutdown request used to wait for the whole
    # 60-second tick, which is most of the delay a user feels when pressing
    # the off button.
    for _ in range(12):
        if _HALT.get('on'):
            break
        time.sleep(5)
    if _HALT.get('on'):
        _reason = 'shutdown requested from the app'
        break
    try:"""

CELL5_OLD_IDLE = """        print('IDLE SHUTDOWN', flush=True)
        os._exit(0)"""

CELL5_NEW_IDLE = """        print('IDLE SHUTDOWN', flush=True)
        _reason = 'idle for 60 minutes'
        break

# Returning from the last cell is what ends the Kaggle run and hands the GPU
# back. os._exit(0) does not: the kernel was still reported as "running" 50
# minutes after /off killed the process, still holding its session.
print('NOTEBOOK COMPLETE (' + _reason + ') - GPU session released', flush=True)"""


def main():
    nb = json.load(open(P))
    c4, c5 = nb['cells'][4]['source'], nb['cells'][5]['source']
    if 'NOTEBOOK COMPLETE' in c5:
        print('session-release shutdown already present -- nothing to do')
        return
    for a, where in ((HALT_OLD, 'cell 4 _halt'), (CELL5_OLD_HEAD, 'cell 5 head'),
                     (CELL5_OLD_IDLE, 'cell 5 idle')):
        assert where.split()[0] == 'cell'
        src = c4 if 'cell 4' in where else c5
        assert src.count(a) == 1, (where, src.count(a))
    c4 = c4.replace(HALT_OLD, HALT_NEW)
    c5 = c5.replace(CELL5_OLD_HEAD, CELL5_NEW_HEAD).replace(
        CELL5_OLD_IDLE, CELL5_NEW_IDLE)
    nb['cells'][4]['source'] = c4
    nb['cells'][5]['source'] = c5
    open(P, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))
    compile(c4, 'cell4', 'exec')
    compile(c5, 'cell5', 'exec')
    raw = open(P, 'rb').read()
    print('template %d bytes sha %s (both cells compile)'
          % (len(raw), hashlib.sha256(raw).hexdigest()))


if __name__ == '__main__':
    main()
