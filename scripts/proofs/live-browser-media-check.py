#!/usr/bin/env python3
"""Live proof that a browser screenshot reaches the client as a media event.

The client renders media from a structured event, not from prose, so a
screenshot that only turns up as a URL in the answer text would never show.
This asks a live engine to open a page and screenshot it, then asserts a media
event arrived with a kind, a URL and a source naming the browser.

Usage: python3 scripts/proofs/live-browser-media-check.py <tunnel-url>
"""
import os
import json
import ssl
import sys
import time
import urllib.request

CTX = ssl.create_default_context()
KEY = os.environ["ENGINE_OFF_KEY"]
TOOLS = ['web_search', 'fetch_page', 'crawl_site', 'run_command',
         'generate_image', 'generate_voice', 'browser']
PROMPT = ('Use the browser tool to navigate to https://example.com and then take '
          'a screenshot of the page. Report the title and the screenshot.')

passed = failed = 0


def chk(what, ok, seen=''):
    global passed, failed
    print('  %s %s   [%s]' % ('ok  ' if ok else 'FAIL', what, seen))
    if ok:
        passed += 1
    else:
        failed += 1


def main():
    url = sys.argv[1]
    body = json.dumps({'messages': [{'role': 'user', 'content': PROMPT}],
                       'stream': True, 'tools': TOOLS}).encode()
    req = urllib.request.Request(url + '/api/chat', data=body, headers={
        'Content-Type': 'application/json', 'X-Engine-Key': KEY})
    t0 = time.time()
    media, tools, ans, beats, done = [], [], [], 0, False
    with urllib.request.urlopen(req, timeout=1500, context=CTX) as r:
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
                tools.append(th[2:80])
            c = m.get('content') or ''
            if c:
                ans.append(c)
            if d.get('done'):
                done = True
                break
    text = ''.join(ans)
    print('== browser screenshot as a media event ==')
    print('  %.1fs  done=%s  heartbeats=%d' % (time.time() - t0, done, beats))
    for t in tools:
        print('  tool: %s' % t)
    print('  media events: %d' % len(media))
    for m in media:
        print('    %s' % json.dumps(m)[:150])

    imgs = [m for m in media if m.get('kind') == 'image']
    chk('a screenshot media event arrived', len(imgs) >= 1, '%d image event(s)' % len(imgs))
    if imgs:
        m = imgs[0]
        chk('it carries a playable URL', str(m.get('url', '')).startswith('http'),
            str(m.get('url'))[:70])
        chk('it names the browser as its source', m.get('source') == 'browser',
            str(m.get('source')))
        # The file really exists: the URL is served off the engine's disk.
        try:
            req2 = urllib.request.Request(str(m['url']))
            with urllib.request.urlopen(req2, timeout=60, context=CTX) as rr:
                head = rr.read(8)
                size = int(rr.headers.get('Content-Length') or 0)
            chk('the screenshot is a real PNG served by the engine',
                head[:4] == b'\x89PNG', 'sig=%s bytes=%d' % (head[:4].hex(), size))
        except Exception as e:
            chk('the screenshot is a real PNG served by the engine', False, str(e)[:80])
    chk('the turn completed', done, 'done=%s' % done)
    chk('heartbeats kept the response alive', beats >= 1, 'beats=%d' % beats)

    print('\n%d passed, %d failed' % (passed, failed))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
