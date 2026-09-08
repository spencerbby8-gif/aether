#!/usr/bin/env python3
"""Prove, per engine, that thinking exists and actually runs.

Two different claims, checked separately:

  capability  -- the model the engine loaded reports "thinking" in its
                 capabilities. Read from Ollama's own /api/show on the live
                 kernel, not from anything the kernel asserts about itself.
  engagement  -- a prompt that should make it think produces the reasoning
                 marker, and one that should not does not. A capability that is
                 never used is not "working".

Usage: python3 scripts/proofs/thinking-proof.py <url> [<url> ...]
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

# Should reason: a real question with a marker word.
# Short on purpose: this proves reasoning ENGAGES, and a long prompt would make
# the proof take minutes per engine without proving anything more.
THINKS = 'Why is the sky blue? One sentence.'
# Should not: short, no marker. This is the speed that must be preserved.
FAST = 'Reply with exactly: ok'


def post(url, path, body, timeout=300):
    req = urllib.request.Request(url + path, data=json.dumps(body).encode(),
                                headers={'Content-Type': 'application/json',
                                         'X-Engine-Key': KEY})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return json.loads(r.read().decode('utf-8', 'replace') or '{}')


def models(url, wait=420):
    # GET: this endpoint takes no body, and POSTing to it is what produced a
    # 502 that looked like a dead engine.
    #
    # An engine can announce itself before the weights are resident, and
    # /api/ps then returns an empty list. That is not "no thinking capability",
    # it is "still loading" -- so wait for a model rather than failing on it.
    t0 = time.time()
    while True:
        try:
            req = urllib.request.Request(url + '/api/ps',
                                         headers={'X-Engine-Key': KEY})
            with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
                d = json.loads(r.read().decode('utf-8', 'replace') or '{}')
            ms = [m.get('name') or m.get('model') for m in (d.get('models') or [])]
        except Exception:
            ms = []
        if ms or time.time() - t0 > wait:
            return ms
        print('  ... model not resident yet, waiting', flush=True)
        time.sleep(20)


def capabilities(url, model):
    d = post(url, '/api/show', {'model': model}, 120)
    return d.get('capabilities') or []


def turn(url, prompt, timeout=420):
    body = json.dumps({'messages': [{'role': 'user', 'content': prompt}],
                       'stream': True, 'tools': TOOLS}).encode()
    req = urllib.request.Request(url + '/api/chat', data=body, headers={
        'Content-Type': 'application/json', 'X-Engine-Key': KEY})
    t0 = time.time()
    marker = first_token = None
    text = []
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
            m = d.get('message') or {}
            th = m.get('thinking') or ''
            if '\U0001f9e0' in th and marker is None:
                marker = time.time() - t0
            c = m.get('content') or ''
            if c:
                text.append(c)
                if first_token is None:
                    first_token = time.time() - t0
            if d.get('done'):
                done = True
                break
    return {'marker': marker, 'first_token': first_token,
            'total': time.time() - t0, 'done': done,
            'text': ''.join(text)}


def main():
    urls = sys.argv[1:]
    ok = True
    for url in urls:
        print('\n== %s ==' % url.split('//')[-1].split('.')[0])
        try:
            ms = models(url)
        except Exception as e:
            print('  FAIL  engine not reachable: %s' % str(e)[:80])
            ok = False
            continue
        print('  models: %s' % (ms or 'none'))
        for m in ms:
            try:
                caps = capabilities(url, m)
            except Exception as e:
                caps = []
                print('  FAIL  /api/show: %s' % str(e)[:80])
            has = 'thinking' in caps
            print('  %s %s capabilities=%s' % ('ok  ' if has else 'FAIL', m, caps))
            ok = ok and has

        r = turn(url, THINKS)
        reasoned = r['marker'] is not None
        print('  %s a question that should think -> marker at %s, first token %s, total %.1fs'
              % ('ok  ' if reasoned else 'FAIL',
                 '%.1fs' % r['marker'] if r['marker'] else 'never',
                 '%.1fs' % r['first_token'] if r['first_token'] else '-', r['total']))
        ok = ok and reasoned and r['done']

        f = turn(url, FAST)
        quiet = f['marker'] is None
        print('  %s a trivial prompt stays cheap -> marker %s, first token %s, total %.1fs'
              % ('ok  ' if quiet else 'FAIL',
                 'absent' if quiet else 'PRESENT',
                 '%.1fs' % f['first_token'] if f['first_token'] else '-', f['total']))
        ok = ok and quiet and f['done']

    print('\n%s' % ('PASS: thinking is present and engaged on every engine checked'
                    if ok else 'FAIL'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
