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

# Must NOT spend reasoning: short, no marker. This is where the speed lives.
FAST = ['hi', 'thanks bro', 'what time is it?', 'What is the capital of France?',
        'hello there', 'ok', 'good morning', 'tell me about planet Earth',
        'how much is a budget hotel']

# Must spend reasoning: genuine work.
THINKS = ['How do I fix a memory leak in my Android app?',
          'Write a python function that parses a csv and groups rows by date',
          'my app crashes with NullPointerException on launch',
          'plan my week',
          'Wetin be the best way to save money for Nigeria?',
          'Explain the difference between TCP and UDP',
          'why is my gradle build so slow',
          'what is 17 * 23',
          'should i buy or rent',
          'I have a bug in my code',
          'this needs an estimate']

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
