#!/usr/bin/env python3
"""The reasoning gate: real work thinks, trivia stays instant.

Reasoning costs tens of seconds per model call, so it is spent selectively.
That trade is only correct if the gate actually picks the right turns -- and it
did not: the hint table was matched by substring with a leading space, so
"plan my week" never matched and was answered without thinking, while genuine
questions like "How do I fix a memory leak..." were skipped too.

needs_reasoning is lifted out of the template, so this tests the shipped rule.

Run from the repo root:  python3 scripts/proofs/reasoning-gate-check.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, '..', '..', 'android', 'app', 'src', 'main',
                   'assets', 'aether-notebook-template.json')

# Must NOT spend reasoning. Measured on a live engine a reasoning turn costs
# ~82s to its first token and minutes overall, against ~7-25s for one that does
# not, so this list is the speed and it is guarded on purpose. It includes
# ordinary requests that a wider gate would have swept in -- "write a function",
# "my app crashes" -- because paying minutes for them is the wrong trade.
FAST = ['hi', 'thanks bro', 'what time is it?', 'What is the capital of France?',
        'hello there', 'ok', 'good morning', 'tell me about planet Earth',
        'how much is a budget hotel',
        'Write a python function that parses a csv and groups rows by date',
        'my app crashes with NullPointerException on launch',
        'Reply with one short sentence: what is the capital of France?']

# Must spend reasoning: the vocabulary the gate has always had, now matched on
# word boundaries instead of by substring.
THINKS = ['plan my week',                       # the bug: started with the hint
          'Why is my gradle build so slow',
          'Explain the difference between TCP and UDP',
          'what is 17 * 23',
          'should i buy or rent',
          'analyse this data',
          'refactor this class',
          'help me troubleshoot my deploy',
          'x ' * 250,
          'which is better, postgres or sqlite? and why?']

passed = failed = 0


def chk(what, ok, seen=''):
    global passed, failed
    print('  %s %s   [%s]' % ('ok  ' if ok else 'FAIL', what, seen))
    if ok:
        passed += 1
    else:
        failed += 1


def main():
    s = json.load(open(TPL))['cells'][4]['source']
    i = s.index('THINK_HINTS = ')
    k = s.index('\ndef ', s.index('def needs_reasoning') + 5)
    ns = {}
    exec(s[i:k], ns)
    nr = ns['needs_reasoning']

    print('== the reasoning gate ==')
    for p in FAST:
        chk('fast, no reasoning: %s' % p[:46], nr(p) is False, 'off' if not nr(p) else 'ON')
    for p in THINKS:
        chk('reasons: %s' % p[:52], nr(p) is True, 'ON' if nr(p) else 'off')
    chk('an empty prompt does not reason', nr('') is False and nr(None) is False, 'off')

    print('\n%d passed, %d failed' % (passed, failed))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
