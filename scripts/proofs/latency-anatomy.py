#!/usr/bin/env python3
"""Where does the time actually go?

Every number here comes from Ollama's own timing fields, read through the
kernel's raw proxy (any POST that is not exactly /api/chat is forwarded to the
local Ollama unchanged). No model is in the loop, so nothing is paraphrased:
load_duration, prompt_eval_count, prompt_eval_duration, eval_count,
eval_duration are the engine's own counters.

It measures the four things that could be slow, separately:
  1. load      -- pulling weights into VRAM after an idle unload
  2. prefill   -- processing the prompt, and whether the KV cache is reused
  3. decode    -- generating tokens
  4. thinking  -- the reasoning pass, on against off

Usage: python3 scripts/proofs/latency-anatomy.py <tunnel-url>
"""
import json
import ssl
import sys
import time
import urllib.request

CTX = ssl.create_default_context()
KEY = 'REMOVED_ENGINE_OFF_KEY'
BASE = sys.argv[1].rstrip('/')

S = 1e9


def post(path, payload, timeout=900):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=body, headers={
        'Content-Type': 'application/json', 'X-Engine-Key': KEY})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        d = json.loads(r.read().decode())
    d['_wall'] = time.time() - t0
    return d


def row(label, d):
    ld = d.get('load_duration', 0) / S
    pc = d.get('prompt_eval_count', 0)
    pd = d.get('prompt_eval_duration', 0) / S
    ec = d.get('eval_count', 0)
    ed = d.get('eval_duration', 0) / S
    print('  %-34s load %6.2fs | prefill %5d tok %7.2fs (%5.1f tok/s)'
          ' | decode %4d tok %6.2fs (%5.1f tok/s) | wall %6.1fs'
          % (label, ld, pc, pd, (pc / pd if pd else 0), ec, ed,
             (ec / ed if ed else 0), d.get('_wall', 0)))
    return {'load': ld, 'pcount': pc, 'ptime': pd, 'dtime': ed,
            'wall': d.get('_wall', 0)}


def main():
    model = json.loads(urllib.request.urlopen(urllib.request.Request(
        BASE + '/api/ps', headers={'X-Engine-Key': KEY}), timeout=40,
        context=CTX).read().decode())['models'][0]['name']
    print('model: %s' % model)
    opts = {'num_ctx': 16384, 'num_predict': 40}

    big = ('You are a careful assistant. ' * 700)[:14000]

    print('\n== 1. raw generate: prompt size vs prefill ==')
    row('short prompt', post('/api/generate', {
        'model': model, 'prompt': 'Say hello.', 'stream': False,
        'options': opts, 'keep_alive': -1}))
    row('14k-char system-ish prompt', post('/api/generate', {
        'model': model, 'system': big, 'prompt': 'Say hello.',
        'stream': False, 'options': opts, 'keep_alive': -1}))
    c = row('same 14k prompt again (cache)', post('/api/generate', {
        'model': model, 'system': big, 'prompt': 'Say hello.',
        'stream': False, 'options': opts, 'keep_alive': -1}))
    b = row('same 14k prompt, new question', post('/api/generate', {
        'model': model, 'system': big, 'prompt': 'What is 2+2?',
        'stream': False, 'options': opts, 'keep_alive': -1}))
    print('  -> repeated identical prompt saved %.2fs of prefill'
          % (b['ptime'] - c['ptime']))

    print('\n== 2. num_ctx: the window we declare ==')
    for n in (4096, 16384):
        o = dict(opts); o['num_ctx'] = n
        row('num_ctx=%d, 14k prompt' % n, post('/api/generate', {
            'model': model, 'system': big, 'prompt': 'Say hello.',
            'stream': False, 'options': o, 'keep_alive': -1}))

    print('\n== 3. the chat path the app really uses ==')
    msgs = [{'role': 'user', 'content': 'Say hello in one short sentence.'}]
    row('chat, think OFF', post('/api/chat?probe=1', {
        'model': model, 'messages': msgs, 'stream': False, 'think': False,
        'options': opts, 'keep_alive': -1}))
    row('chat, think ON', post('/api/chat?probe=1', {
        'model': model, 'messages': msgs, 'stream': False, 'think': True,
        'options': opts, 'keep_alive': -1}))
    print('\nDone. Compare prefill against decode: whichever dominates is the '
          'bottleneck.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
