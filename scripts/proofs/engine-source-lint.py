#!/usr/bin/env python3
"""Undefined-name gate for the engine source.

Three separate bugs reached a deployed engine because nothing checked that the
names cell 4 and the browser helper use actually exist: `sys` was never
imported, `hashlib` was used inside a try/except that swallowed the NameError
so the helper file was never written, and the helper called `_readable`, which
only exists in the kernel. All three are invisible to compile() and to every
test that stubs the browser.

Cell 4 is analysed with an allowlist of names defined in the notebook's other
cells. The helper is a standalone program and gets no allowlist at all.

Needs: pip install pyflakes. Run from the repo root:
    python3 scripts/proofs/engine-source-lint.py
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, '..', '..', 'android', 'app', 'src', 'main',
                   'assets', 'aether-notebook-template.json')


def lint(src):
    f = tempfile.NamedTemporaryFile('w', suffix='.py', delete=False)
    f.write(src)
    f.close()
    try:
        r = subprocess.run([sys.executable, '-m', 'pyflakes', f.name],
                           capture_output=True, text=True)
    finally:
        os.unlink(f.name)
    out = []
    for line in (r.stdout or '').splitlines():
        if line.strip():
            out.append(line.split('.py:', 1)[-1].strip())
    return out


def main():
    try:
        import pyflakes  # noqa: F401
    except Exception:
        print('  SKIP  pyflakes is not installed here; nothing proven')
        return 0

    nb = json.load(open(TPL))
    cells = [c.get('source', '') for c in nb.get('cells', [])]
    cell4 = cells[4]
    others = '\n'.join(c for i, c in enumerate(cells) if i != 4)

    # A name defined in another cell is legitimately visible at runtime; a
    # notebook is one namespace. Anything else is a real NameError waiting to
    # happen, and the browser code hides those inside try/except.
    allow = set()
    for finding in lint(cell4):
        if "undefined name '" in finding:
            name = finding.split("undefined name '")[1].split("'")[0]
            if ('def %s' % name) in others or ('%s =' % name) in others:
                allow.add(name)

    print('== engine source, undefined names ==')
    bad = []
    for finding in lint(cell4):
        if "undefined name '" not in finding:
            continue                     # unused locals and redefinitions: noise
        name = finding.split("undefined name '")[1].split("'")[0]
        if name in allow:
            continue
        bad.append('cell 4: ' + finding)
    print('  cell 4 undefined names (excluding %d defined in other cells): %d'
          % (len(allow), len(bad)))
    for b in bad:
        print('    ' + b[:120])

    i = cell4.index('_B_HELPER_SRC = ') + len('_B_HELPER_SRC = ')
    helper = eval(cell4[i:cell4.index('\n', i)])
    hbad = lint(helper)
    print('  browser helper findings: %d' % len(hbad))
    for b in hbad:
        print('    helper: ' + b[:120])

    ok = not bad and not hbad
    print('\n%s' % ('PASS: no undefined names in the engine source'
                    if ok else 'FAIL: %d finding(s)' % (len(bad) + len(hbad))))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
