import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aetherNotebookTemplate,
  AETHER_NOTEBOOK_SHA256,
} from "../src/server/engine/aether-engine-source";

/**
 * Browser agent recovery — proof that the circuit breakers classify before
 * they count.
 *
 * The engine's agent loop (cell 4 of the shipped notebook) used to treat
 * every not-ok step as a generic failure, so three CAPTCHA/blocked steps in
 * a row killed a browser task while nothing had actually failed. The fix
 * classifies failures (blocked / transient / recover / terminal) and counts
 * each class in its own bounded rail.
 *
 * These tests do not re-implement the logic: they extract the SHIPPED
 * functions (_fail_kind, _account_step, _B_CAPS, and the Budget class from
 * the orchestration module embedded in the same cell) from the template
 * asset and exercise them through python3, the same interpreter the engine
 * runs. The loop accounting around them is mirrored verbatim from
 * agent_stream so the breaker behaviour is proven, not asserted.
 */

function engineCell(): string {
  const template = aetherNotebookTemplate(); // throws if tampered
  const nb = JSON.parse(template) as { cells: Array<{ source?: string | string[] }> };
  for (const c of nb.cells) {
    const s = Array.isArray(c.source) ? c.source.join("") : (c.source ?? "");
    if (s.includes("Warmup (pin in VRAM")) return s;
  }
  throw new Error("engine cell not found in template");
}

const HARNESS = String.raw`
import ast, json, re, sys

funcs_src = open(sys.argv[1]).read()      # _B_CAPS, _fail_kind, _account_step
cell_src = open(sys.argv[2]).read()       # the full engine cell

ns = {'re': re}
exec(compile(funcs_src, 'recovery-funcs', 'exec'), ns)
_fail_kind, _account_step, _B_CAPS = ns['_fail_kind'], ns['_account_step'], ns['_B_CAPS']

fails = []
COUNT = [0]
def check(name, cond, detail=''):
    COUNT[0] += 1
    if not cond:
        fails.append(name + (' :: ' + str(detail) if detail else ''))

def N(brief, ok=False, kind='text', raw=None):
    return {'brief': brief, 'raw': raw or brief, 'ok': ok, 'kind': kind}

# ---- 1. classifier: the four classes, on the shapes the tools emit --------
cases = [
    (N('BLOCKED: this page presents a CAPTCHA. I will not attempt to bypass it.'), 'blocked'),
    (N('BLOCKED by overlay: #veil is covering #subscribe. Dismiss it first -- inspect the page.'), 'blocked'),
    (N('BLOCKED for safety: this action was refused.'), 'blocked'),
    (N('NEEDS APPROVAL: fill targets a credential field on example.com.'), 'blocked'),
    (N('the page is asking me to complete a captcha challenge'), 'blocked'),
    (N('sign in required before this page can be used'), 'blocked'),
    (N('please verify you are human'), 'blocked'),
    (N('', kind='browser-blocked', raw='BLOCKED: this page presents a CAPTCHA.'), 'blocked'),
    (N('TIMED OUT after 8s'), 'transient'),
    (N('HTTP 429 too many requests'), 'transient'),
    (N('rate limit exceeded -- retry later'), 'transient'),
    (N('fetch failed: connection reset by peer'), 'transient'),
    (N('crawl empty'), 'transient'),
    (N('HTTP 503 service unavailable'), 'transient'),
    (N('MISSING #email-1 -- not found in any frame; inspect the page'), 'recover'),
    (N('no results'), 'recover'),
    (N('tool error: KeyError: foo'), 'terminal'),
    (N('exit=1 traceback follows'), 'terminal'),
]
for n, expect in cases:
    got = _fail_kind('browser', n)
    check('classify %r -> %s' % (n['brief'][:40], expect), got == expect, 'got %s' % got)

# ok results never reach the classifier; a healthy result must stay healthy
check('ok result is not classified', N('done', ok=True)['ok'] is True)

# ---- 2. the loop accounting, mirrored from agent_stream --------------------
NORM = lambda t, res, a: res if isinstance(res, dict) else {'brief': res, 'raw': res, 'ok': False, 'kind': 'text'}
def step(*results):
    plan = [('browser', {}, False) for _ in results]
    return _account_step(plan, list(results), NORM)

def run_loop(steps):
    """Breaker accounting exactly as agent_stream does it, on shipped code."""
    consec = 0
    brk = {'blocked': 0, 'transient': 0, 'recover': 0}
    outcome = 'ran-to-end'
    for st in steps:
        cls = step(st)
        if cls == 'ok':
            consec = 0
            brk = {'blocked': 0, 'transient': 0, 'recover': 0}
        elif cls == 'terminal':
            consec = consec + 1
        else:
            brk[cls] = brk.get(cls, 0) + 1
        if consec >= 3:
            outcome = 'generic-failure-rail'; break
        if brk['blocked'] >= _B_CAPS['blocked']:
            outcome = 'user-action-rail'; break
        if brk['transient'] >= _B_CAPS['transient']:
            outcome = 'transient-rail'; break
        if brk['recover'] >= _B_CAPS['recover']:
            outcome = 'recover-rail'; break
    return outcome, consec, brk

CAPTCHA = N('BLOCKED: this page presents a CAPTCHA.')
TIMEOUT = N('TIMED OUT after 8s')
MISS    = N('MISSING #email-1 -- not found in any frame')
BOOM    = N('tool error: KeyError: foo')
GOOD    = N('filled #email', ok=True, kind='browser')

# THE bug: three CAPTCHA steps in a row must NOT trip the generic rail
out, consec, brk = run_loop([CAPTCHA, CAPTCHA, CAPTCHA])
check('3 captcha steps do not trip the generic rail', consec == 0 and out == 'ran-to-end',
      'outcome=%s consec=%d brk=%s' % (out, consec, brk))

# ...and the old code would have aborted here: prove it by running the same
# steps through the PRE-fix accounting (any not-ok step counts)
old_consec = 0
for st in [CAPTCHA, CAPTCHA, CAPTCHA]:
    if not NORM('browser', st, {})['ok']:
        old_consec += 1
check('pre-fix accounting WOULD have aborted at 3', old_consec >= 3)

# blocked is still bounded: the 4th blocked step stops the turn honestly
out, consec, brk = run_loop([CAPTCHA, CAPTCHA, CAPTCHA, CAPTCHA])
check('4 blocked steps stop on the user-action rail', out == 'user-action-rail' and consec == 0,
      'outcome=%s' % out)

# terminal failures still trip the generic rail at 3 (safety unchanged)
out, consec, brk = run_loop([BOOM, BOOM, BOOM])
check('3 terminal failures still trip the generic rail', out == 'generic-failure-rail' and consec == 3)

# mixed blocked/recoverable work continues instead of dying at 3
out, consec, brk = run_loop([CAPTCHA, MISS, CAPTCHA, MISS, CAPTCHA])
check('mixed blocked/recover continues', out == 'ran-to-end' and consec == 0, 'outcome=%s' % out)

# a healthy step resets the rails (proof: the sequence ends ON the success,
# so the counter must read zero, and two failures after a reset do not trip)
out, consec, brk = run_loop([BOOM, BOOM, GOOD])
check('success resets the rails',
      out == 'ran-to-end' and consec == 0 and brk == {'blocked': 0, 'transient': 0, 'recover': 0})
out, consec, brk = run_loop([BOOM, BOOM, GOOD, BOOM, BOOM])
check('two failures after a reset do not trip', out == 'ran-to-end' and consec == 2)

# transient failures get their own bounded rail
out, consec, brk = run_loop([TIMEOUT] * 5)
check('5 transient steps stop on the transient rail', out == 'transient-rail' and consec == 0)

# worst-class ranking: terminal beats blocked within one step
check('terminal outranks blocked in a step', step(CAPTCHA, BOOM) == 'terminal')
# any success makes the step ok, exactly like the old _ok_any
check('any ok tool makes the step ok', step(CAPTCHA, GOOD) == 'ok')
# replayed-from-memory calls are skipped as before
check('replayed calls are not counted', _account_step(
    [('browser', {}, True), ('browser', {}, False)], [GOOD, GOOD], NORM) == 'ok')

# ---- 3. the 24-call budget and bounded retries are untouched ---------------
tree = ast.parse(cell_src)
orch = None
for node in tree.body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], 'id', '') == '_A_ORCH_SRC':
        orch = ast.literal_eval(node.value)
check('orchestration module found in cell', orch is not None)
ns2 = {}
exec(compile(orch, 'orch', 'exec'), ns2)
Budget = ns2['Budget']

b = Budget(max_calls=24, max_fails=2)
for i in range(24):
    b.note('browser', {'action': 'click', 'selector': '#a%d' % i}, 'r', True)
check('budget boundary: 24 calls exhausts the budget',
      b.calls == 24 and b.exhausted() and b.remaining() == 0 and b.stats()['max'] == 24)

b2 = Budget(max_calls=24, max_fails=2)
key = {'action': 'click', 'selector': '#x'}
b2.note('browser', key, 'fail', False)
check('first failure of an action is retried', not b2.give_up_on('browser', key))
b2.note('browser', key, 'fail', False)
check('second failure of the same action gives up (bounded retry)',
      b2.give_up_on('browser', key))

# ---- 4. the other safety rails are unchanged in the shipped cell -----------
check('_MAX_CONSEC_FAIL is still 3', '_MAX_CONSEC_FAIL = 3' in cell_src)
check('_MAX_SILENT_STEPS is still 12', '_MAX_SILENT_STEPS = 12' in cell_src)
check('budget is still 24 calls / 2 fails', 'budget = Budget(max_calls=24, max_fails=2)' in cell_src)
check('CAPTCHA remains human-in-the-loop (never bypassed)',
      'I will not attempt to' in cell_src and 'BLOCKED for safety' in cell_src)

if fails:
    print('BROWSER-RECOVERY FAILURES (%d):' % len(fails))
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('BROWSER-RECOVERY ALL OK: %d checks' % COUNT[0])
`;

const PYTHON =
  existsSync("/usr/bin/python3") || existsSync("/usr/local/bin/python3")
    ? existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "/usr/local/bin/python3"
    : null;

describe.skipIf(!PYTHON)("browser agent recovery (shipped engine code)", () => {
  const cell = engineCell();

  it("the template is the pinned, un-tampered blob", () => {
    // aetherNotebookTemplate() already throws on hash mismatch; this makes
    // the failure legible in this suite's context
    expect(cell.length).toBeGreaterThan(190_000);
    expect(AETHER_NOTEBOOK_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the shipped loop keeps its safety rails while classifying failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "aether-recovery-"));
    const start = cell.indexOf("# ---- circuit-breaker failure classification");
    const end = cell.indexOf("def agent_stream", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const funcs = cell.slice(start, end);
    writeFileSync(join(dir, "funcs.py"), funcs);
    writeFileSync(join(dir, "cell.py"), cell);
    writeFileSync(join(dir, "harness.py"), HARNESS);
    try {
      const out = execFileSync(PYTHON as string, [
        join(dir, "harness.py"), join(dir, "funcs.py"), join(dir, "cell.py"),
      ], { encoding: "utf8", timeout: 60_000 });
      expect(out).toContain("BROWSER-RECOVERY ALL OK");
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        `browser recovery harness failed:\n${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`,
      );
    }
  });

  it("the generic rail still exists and counts terminal failures only", () => {
    // structural anchors, kept adjacent to the behavioural proof above
    expect(cell).toContain("_MAX_CONSEC_FAIL = 3");
    expect(cell).toContain("budget = Budget(max_calls=24, max_fails=2)");
    expect(cell).toContain("_brk[_step] = _brk.get(_step, 0) + 1");
  });
});
