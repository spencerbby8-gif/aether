#!/usr/bin/env python3
"""Prove crawl_site works against the real web, on a live engine.

crawl_site has been unit-tested (a 4-page crawl finishes in 2.00s with the
level order preserved) but never run against a live engine, so its real
behaviour -- DNS, redirects, robots-less HTML, link extraction -- was unproven.

Evidence comes from the wire, not the model's prose. The kernel emits
"tool crawl_site({...})" when it dispatches and "crawl_site returned N chars"
when the call comes back, so the character count is a measurement of what the
tool actually fetched. The model's summary is checked separately and only as a
weak signal, because a model can describe a page it never saw.

Usage: python3 scripts/proofs/live-crawl-check.py <tunnel-url>
"""
import json
import re
import ssl
import sys
import time
import urllib.request

CTX = ssl.create_default_context()
KEY = 'REMOVED_ENGINE_OFF_KEY'
SITE = 'https://quotes.toscrape.com'

passed = failed = 0


def chk(what, ok, seen=''):
    global passed, failed
    print('  %s %s   [%s]' % ('ok  ' if ok else 'FAIL', what, seen))
    if ok:
        passed += 1
    else:
        failed += 1


def run(url, prompt, budget=600):
    body = json.dumps({
        'messages': [{'role': 'user', 'content': prompt}],
        'stream': True,
        'tools': ['crawl_site', 'fetch_page']}).encode()
    req = urllib.request.Request(url + '/api/chat', data=body, headers={
        'Content-Type': 'application/json', 'X-Engine-Key': KEY})
    think, text = [], []
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=budget, context=CTX) as r:
        for raw in r:
            raw = raw.strip()
            if not raw:
                continue
            try:
                d = json.loads(raw.decode('utf-8', 'replace'))
            except Exception:
                continue
            m = d.get('message') or {}
            if m.get('thinking'):
                think.append(m['thinking'])
            if m.get('content'):
                text.append(m['content'])
            if d.get('done'):
                break
    return think, ''.join(text), time.time() - t0


def main():
    url = sys.argv[1].rstrip('/')
    print('== crawl_site against the live web ==')
    print('  target: %s' % SITE)
    think, answer, secs = run(
        url, 'Use crawl_site on %s with max_pages 4 and tell me what the site '
             'is about. Cite the pages you read.' % SITE)
    joined = ' '.join(think)
    print('  elapsed %.1fs, %d activity events' % (secs, len(think)))

    chk('the crawl tool was really dispatched',
        bool(re.search(r'crawl_site\s*\(', joined)),
        (re.search(r'.{0,60}crawl_site.{0,60}', joined) or ['(none)'])[0].strip())

    m = re.search(r'crawl_site returned (\d+) chars', joined)
    chk('the crawl returned content', bool(m), m.group(0) if m else 'no return event')
    n = int(m.group(1)) if m else 0
    # One page of this site reads to roughly 2-4k of text; four pages must be
    # clearly more than one. Asserted low on purpose -- the point is that real
    # pages came back, not a precise page count.
    chk('more than a single page came back', n > 4000, '%d chars' % n)

    chk('the answer is a real answer, not empty', len(answer.strip()) > 80,
        '%d chars' % len(answer.strip()))
    # quotes.toscrape.com is a quotations site; a crawl that read it says so.
    chk('the answer describes what the site actually is',
        bool(re.search(r'quot|author|tag', answer, re.I)),
        answer.strip().replace('\n', ' ')[:90])

    print('\n%d passed, %d failed' % (passed, failed))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
