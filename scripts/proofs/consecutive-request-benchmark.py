#!/usr/bin/env python3
"""Twenty-plus consecutive real requests against one live engine.

The directive is explicit that responsiveness has to be shown over a run, not
on one lucky request: time to first token, tool start, total, and proof that
every request ends in a terminal state. So this fires a mixed sequence of real
chat and tool requests at a live engine, one after another, and measures each.

It also splits the run in half and compares medians, because a leak or a
watchdog that never resets shows up as the last request being slower than the
first -- and "the 20th message must work like the 1st" is not something a
single request can demonstrate.

Usage: python3 scripts/proofs/consecutive-request-benchmark.py <tunnel-url>
"""
import os
import json
import ssl
import statistics
import sys
import time
import urllib.request

CTX = ssl.create_default_context()
KEY = os.environ["ENGINE_OFF_KEY"]
TOOLS = ['web_search', 'fetch_page', 'crawl_site', 'run_command',
         'generate_image', 'generate_voice', 'browser']

# A mix, weighted towards the fast paths so the run finishes, but covering
# every capability the directive names.
PLAN = [
    ('text', 'Reply with exactly: one'),
    ('text', 'Reply with exactly: two'),
    ('command', 'Use run_command to run: echo three'),
    ('text', 'Reply with exactly: four'),
    ('text', 'Reply with exactly: five'),
    ('command', 'Use run_command to run: date -u'),
    ('text', 'Reply with exactly: seven'),
    ('search', 'Use web_search to find the population of Lagos, then answer in one sentence.'),
    ('text', 'Reply with exactly: nine'),
    ('command', 'Use run_command to create a file: echo hello > /kaggle/working/bench.txt'),
    ('text', 'Reply with exactly: eleven'),
    ('fetch', 'Use fetch_page on https://example.com and tell me the page title.'),
    ('text', 'Reply with exactly: thirteen'),
    ('text', 'Reply with exactly: fourteen'),
    ('command', 'Use run_command to run: cat /kaggle/working/bench.txt'),
    ('text', 'Reply with exactly: sixteen'),
    ('browser', 'Use the browser tool: action=navigate to https://example.com, then '
                'action=read. Tell me the page title.'),
    ('text', 'Reply with exactly: eighteen'),
    ('search', 'Use web_search to find today\'s news about Nigeria, then answer in one sentence.'),
    ('text', 'Reply with exactly: twenty'),
    ('browser', 'Use the browser tool: action=navigate to https://example.com then '
                'action=screenshot. Report the title.'),
    ('text', 'Reply with exactly: twenty-two'),
]


def one(url, prompt, timeout=420):
    body = json.dumps({'messages': [{'role': 'user', 'content': prompt}],
                       'stream': True, 'tools': TOOLS}).encode()
    req = urllib.request.Request(url + '/api/chat', data=body, headers={
        'Content-Type': 'application/json', 'X-Engine-Key': KEY})
    t0 = time.time()
    first_byte = first_token = first_tool = None
    deltas = beats = tools = 0
    media = 0
    state = 'error'
    text = []
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            for raw in r:
                if first_byte is None:
                    first_byte = time.time() - t0
                line = raw.decode('utf-8', 'replace').strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get('media'):
                    media += 1
                m = d.get('message') or {}
                th = m.get('thinking') or ''
                if th == '\u23f3':
                    beats += 1
                elif th.startswith('\U0001f6e0\ufe0f'):
                    tools += 1
                    if first_tool is None:
                        first_tool = time.time() - t0
                c = m.get('content') or ''
                if c:
                    deltas += 1
                    text.append(c)
                    if first_token is None:
                        first_token = time.time() - t0
                if d.get('done'):
                    state = 'completed'
                    break
    except Exception as e:
        state = 'error: %s' % str(e)[:60]
    total = time.time() - t0
    return {'first_byte': first_byte, 'first_token': first_token,
            'first_tool': first_tool, 'total': total, 'deltas': deltas,
            'beats': beats, 'tools': tools, 'media': media, 'state': state,
            'text': ''.join(text)}


def med(vals):
    v = [x for x in vals if x is not None]
    return statistics.median(v) if v else None


def fmt(v):
    return '%.1fs' % v if v is not None else '-'


def main():
    url = sys.argv[1]
    print('== %d consecutive real requests ==\n' % len(PLAN))
    hdr = ('%-4s %-8s %-8s %-8s %-8s %-8s %-5s %-5s %s'
           % ('#', 'kind', '1stbyte', '1sttok', '1sttool', 'total', 'dlt', 'beat', 'state'))
    print(hdr)
    print('-' * len(hdr))
    rows = []
    for i, (kind, prompt) in enumerate(PLAN, 1):
        r = one(url, prompt)
        rows.append((kind, r))
        print('%-4d %-8s %-8s %-8s %-8s %-8s %-5d %-5d %s'
              % (i, kind, fmt(r['first_byte']), fmt(r['first_token']),
                 fmt(r['first_tool']), fmt(r['total']), r['deltas'], r['beats'],
                 r['state']), flush=True)

    ok = [r for _, r in rows if r['state'] == 'completed']
    hung = [r for _, r in rows if r['state'] not in ('completed',) and r['total'] >= 419]
    half = len(rows) // 2
    first, second = rows[:half], rows[half:]

    print('\n== summary ==')
    print('  completed: %d of %d' % (len(ok), len(rows)))
    print('  timed out / hung: %d' % len(hung))
    print('  median first byte   %s' % fmt(med([r['first_byte'] for _, r in rows])))
    print('  median first token  %s' % fmt(med([r['first_token'] for _, r in rows])))
    print('  median total        %s' % fmt(med([r['total'] for _, r in rows])))
    print('  worst first token   %s' % fmt(max([r['first_token'] or 0 for _, r in rows])))
    print('  tool calls made     %d   media events %d   heartbeats %d'
          % (sum(r['tools'] for _, r in rows), sum(r['media'] for _, r in rows),
             sum(r['beats'] for _, r in rows)))
    print('\n  first half median first token  %s' % fmt(med([r['first_token'] for _, r in first])))
    print('  second half median first token %s' % fmt(med([r['first_token'] for _, r in second])))
    print('  first half median total        %s' % fmt(med([r['total'] for _, r in first])))
    print('  second half median total       %s' % fmt(med([r['total'] for _, r in second])))

    f = [r['total'] for _, r in rows if r['state'] == 'completed']
    fails = len(rows) - len(ok)
    print('\n%s' % ('PASS: every request terminated and none hung'
                    if fails == 0 and not hung
                    else 'FAIL: %d did not complete, %d hung' % (fails, len(hung))))
    return 0 if (fails == 0 and not hung) else 1


if __name__ == '__main__':
    sys.exit(main())
