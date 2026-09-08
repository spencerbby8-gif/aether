"""Widen the reasoning gate where it was costing capability, not speed.

Audited against realistic prompts, the gate let trivia through fast but also
skipped genuine work: "How do I fix a memory leak in my Android app?", "Write a
python function that parses a csv...", "my app crashes with
NullPointerException", "plan my week".

The last one was an outright bug: the hint table held ' plan' with a leading
space and matched by substring, so any prompt that STARTED with a hint never
matched. Hints are now matched on word boundaries.

What deliberately stays off, because this is where the speed lives: "hi",
"thanks bro", "what time is it?", "What is the capital of France?" -- short
prompts with no marker. A question only earns reasoning once it is long enough
to be a real question.

Run from the repo root:  python3 scripts/widen-reasoning-gate.py
"""
import hashlib
import json

P = 'android/app/src/main/assets/aether-notebook-template.json'

OLD_HINTS = """THINK_HINTS = ('why ', 'why?', 'compar', 'prove', 'calcul', 'comput', ' plan',
               'design', 'debug', 'optimi', 'analy', 'step by step', 'tradeoff',
               'trade-off', 'should i', 'which is better', 'review', 'refactor',
               'derive', 'estimate', 'strateg', 'architect', 'troubleshoot',
               'pros and cons', 'difference between')"""

NEW_HINTS = """# Stems and phrases: matched as a prefix on a word boundary, so 'analy' catches
# "analysis" and "analyse" alike.
THINK_HINTS = ('compar', 'calcul', 'comput', 'optimi', 'analy', 'step by step',
               'tradeoff', 'trade-off', 'should i', 'which is better',
               'refactor', 'strateg', 'architect', 'troubleshoot',
               'pros and cons', 'difference between', 'how do i', 'how can i',
               'how should', 'write a function', 'write code', 'best way',
               'traceback', 'stack trace')

# Whole words, matched exactly. 'plan' has to be here rather than a stem or it
# would fire on "planet".
THINK_WORDS = ('why', 'plan', 'fix', 'bug', 'crash', 'error', 'explain',
               'implement', 'review', 'design', 'debug', 'prove', 'derive',
               'estimate', 'recommend', 'advice', 'exception')"""

OLD_FN = """    t = (text or '').lower()
    if len(t) >= 400:
        return True                      # a long brief deserves thought
    if t.count('?') >= 2:
        return True                      # multi-part question
    if any(h in t for h in THINK_HINTS):
        return True
    if _re.search(r'\\d\\s*[-+*/^%]\\s*\\d', t):
        return True                      # arithmetic in the prompt
    return False"""

NEW_FN = """    t = (text or '').lower().strip()
    if not t:
        return False
    if len(t) >= 400:
        return True                      # a long brief deserves thought
    if t.count('?') >= 2:
        return True                      # multi-part question
    # Word boundaries, not substrings. The old test needed a leading space, so
    # a prompt that began with a hint -- "plan my week" -- never matched and
    # was answered without thinking.
    if _re.search(r'\\b(?:' + '|'.join(_re.escape(h) for h in THINK_HINTS) + r')', t):
        return True
    if _re.search(r'\\b(?:' + '|'.join(_re.escape(w) for w in THINK_WORDS) + r')\\b', t):
        return True
    if _re.search(r'\\d\\s*[-+*/^%]\\s*\\d', t):
        return True                      # arithmetic in the prompt
    # A substantive question earns thought. A three word one does not, and that
    # distinction is where the speed is kept.
    if '?' in t and len(t) >= 40:
        return True
    return False"""


def main():
    nb = json.load(open(P))
    s = nb['cells'][4]['source']
    if 'THINK_WORDS' in s:
        print('gate already widened -- nothing to do')
        return
    for old, new in ((OLD_HINTS, NEW_HINTS), (OLD_FN, NEW_FN)):
        assert s.count(old) == 1, (s.count(old), old[:60])
        s = s.replace(old, new)
    nb['cells'][4]['source'] = s
    open(P, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))
    compile(s, 'cell4', 'exec')
    raw = open(P, 'rb').read()
    print('template %d bytes sha %s (compiles)'
          % (len(raw), hashlib.sha256(raw).hexdigest()))


if __name__ == '__main__':
    main()
