"""Fetch each breadth-first level of crawl_site concurrently.

The crawl was a strictly sequential BFS: up to ten `curl -m 30` calls back to
back. On a slow site that is minutes of wall time with the model idle, and the
profile showed the tool, not the reasoning, would then be the bottleneck.

Pages within a level are independent, so each level is fetched through a small
pool. Results are consumed in request order via Executor.map, so the text the
model sees is byte-identical to the sequential version -- only the timing
changes.

Run from the repo root:  python3 scripts/parallelize-crawl.py
"""
import hashlib
import json

P = 'android/app/src/main/assets/aether-notebook-template.json'

OLD = """    seen, todo, done, texts = {url}, [url], [], []
    base = re.match(r'https?://[^/]+', url).group(0)
    while todo and len(done) < max_pages:
        u = todo.pop(0)
        try:
            r = subprocess.run(['curl','-sL','-m','30','-A','Mozilla/5.0',u], capture_output=True, text=True)
            h = r.stdout or ''
            done.append(u)
            tx = _readable(h)
            if tx: texts.append('## ' + u + chr(10) + tx[:4000])
            for lm in re.findall(r'href="(/[^\"]{1,120}|' + re.escape(base) + r'[^\"]{1,120})\"', h)[:40]:
                lu = lm if lm.startswith('http') else base + lm
                if lu not in seen and '.' not in lm.split('/')[-1][:6]:
                    seen.add(lu); todo.append(lu)
        except Exception: continue
    return (chr(10)+chr(10)).join(texts)[:16000] or 'crawl empty'"""

NEW = """    seen, level, done, texts = {url}, [url], [], []
    base = re.match(r'https?://[^/]+', url).group(0)

    def _fetch(u):
        try:
            r = subprocess.run(['curl','-sL','-m','30','-A','Mozilla/5.0',u], capture_output=True, text=True)
            return u, (r.stdout or '')
        except Exception:
            return u, ''

    # Breadth first, one level at a time, each level fetched concurrently. The
    # pages in a level are independent; waiting on them one by one was up to
    # ten 30s curls back to back. Executor.map yields in request order, so the
    # assembled text is identical to the sequential version.
    import concurrent.futures as _cf
    with _cf.ThreadPoolExecutor(max_workers=4) as _ex:
        while level and len(done) < max_pages:
            batch = level[:max_pages - len(done)]
            level = level[len(batch):]
            for u, h in _ex.map(_fetch, batch):
                done.append(u)
                tx = _readable(h)
                if tx: texts.append('## ' + u + chr(10) + tx[:4000])
                for lm in re.findall(r'href="(/[^\"]{1,120}|' + re.escape(base) + r'[^\"]{1,120})\"', h)[:40]:
                    lu = lm if lm.startswith('http') else base + lm
                    if lu not in seen and '.' not in lm.split('/')[-1][:6]:
                        seen.add(lu); level.append(lu)
    return (chr(10)+chr(10)).join(texts)[:16000] or 'crawl empty'"""


def main():
    nb = json.load(open(P))
    s = nb['cells'][4]['source']
    if '_ex.map(_fetch, batch)' in s:
        print('crawl_site already parallel -- nothing to do')
        return
    assert s.count(OLD) == 1, s.count(OLD)
    s = s.replace(OLD, NEW)
    nb['cells'][4]['source'] = s
    open(P, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))
    compile(s, 'cell4', 'exec')
    raw = open(P, 'rb').read()
    print('template %d bytes sha %s (compiles)'
          % (len(raw), hashlib.sha256(raw).hexdigest()))


if __name__ == '__main__':
    main()
