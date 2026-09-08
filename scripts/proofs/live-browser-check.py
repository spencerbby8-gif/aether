#!/usr/bin/env python3
"""End-to-end browser proof against a live engine.

Asks the running agent to use the browser tool and reports what actually came
back: which tool calls it made, the answer text, any media event, and how many
heartbeats arrived while it worked. Retries while the engine is still
installing Chromium, because that install runs in the background after boot.

Usage: python3 scripts/proofs/live-browser-check.py <tunnel-url>
"""
import json
import ssl
import sys
import time
import urllib.request

CTX = ssl.create_default_context()
KEY = 'REMOVED_ENGINE_OFF_KEY'
TOOLS = ['web_search', 'fetch_page', 'crawl_site', 'run_command',
         'generate_image', 'generate_voice', 'browser']
PROMPT = ('Use the browser tool: first action=navigate to https://example.com, '
          'then action=read. Tell me the exact page title and the first '
          'sentence of the page. If the browser is unavailable, quote the '
          'exact error text and nothing else.')


def turn(url, timeout=1500):
    body = json.dumps({'messages': [{'role': 'user', 'content': PROMPT}],
                       'stream': True, 'tools': TOOLS}).encode()
    req = urllib.request.Request(url + '/api/chat', data=body, headers={
        'Content-Type': 'application/json', 'X-Engine-Key': KEY})
    t0 = time.time()
    ans, tools, media, beats = [], [], [], 0
    done = False
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        for raw in r:
            line = raw.decode('utf-8', 'replace').strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get('media'):
                media.append(d['media'])
            m = d.get('message') or {}
            th = m.get('thinking') or ''
            if th == '\u23f3':
                beats += 1
            elif th.startswith('\U0001f6e0\ufe0f'):
                tools.append(th[2:100])
            c = m.get('content') or ''
            if c:
                ans.append(c)
            if d.get('done'):
                done = True
                break
    return {'t': time.time() - t0, 'ans': ''.join(ans), 'tools': tools,
            'media': media, 'beats': beats, 'done': done}


def main():
    url = sys.argv[1]
    for attempt in range(1, 6):
        r = turn(url)
        print('attempt %d: %.1fs done=%s heartbeats=%d' %
              (attempt, r['t'], r['done'], r['beats']))
        print('  tool calls: %s' % (r['tools'] or 'none'))
        print('  answer: %s' % r['ans'][:400].replace('\n', ' '))
        a = r['ans'].lower()
        if 'example domain' in a:
            print('\nPASS: the agent drove a real browser and read a real page')
            return 0
        if 'unavailable' in a or 'not installed' in a:
            print('  still installing Chromium -- waiting 90s\n')
            time.sleep(90)
            continue
        print('\nFAIL: no page content came back')
        return 1
    print('\nFAIL: the browser never became available')
    return 1


if __name__ == '__main__':
    sys.exit(main())
