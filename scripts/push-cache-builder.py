#!/usr/bin/env python3
"""One-off: push a bootstrap kernel that builds the per-account engine cache.

Cold wake measured across A/B/C/D (beacon stage timelines, this session):
    ollama tarball download    21-41s   every boot
    model pull 16.9 GB       111-353s   every boot
Both are network transfers of bytes that never change. Kaggle kernels mount
datasets read-only from /kaggle/input with no download, so each account gets
a PRIVATE dataset holding the ollama tarball + the exact model store a real
`ollama pull` produced (blobs + manifests.tar). Private per account avoids
the public-dataset privacy API entirely and each kernel mounts its own
account's copy at the same path: /kaggle/input/aether-engine-cache.

Uploads go through the official kaggle CLI, which chunks them: a naive
single-POST upload of the 1.4 GB tarball died mid-stream with SSL EOF
(measured, builder v2).

Run per account:
    python3 scripts/push-cache-builder.py a|b|c|d
Every slot requires KAGGLE_USERNAME_x / KAGGLE_KEY_x in the environment;
no key is committed to the repository.
"""
import json
import os
import sys
import time
import urllib.request

SLUG = "aether-cache-builder-one-off"
BEACON_TOPIC = os.environ["BEACON_TOPIC"]

KEYS = {
    "a": (os.environ.get("KAGGLE_USERNAME_A", "fridaymoses"), os.environ.get("KAGGLE_KEY_A", "")),
    "b": (os.environ.get("KAGGLE_USERNAME_B", "spencercoldtr"), os.environ.get("KAGGLE_KEY_B", "")),
    "c": (os.environ.get("KAGGLE_USERNAME_C", "dyceelvk"), os.environ.get("KAGGLE_KEY_C", "")),
    "d": (os.environ.get("KAGGLE_USERNAME_D", ""), os.environ.get("KAGGLE_KEY_D", "")),
}

CELL = r'''
# one-off: build this account's aether-engine-cache dataset
import subprocess, os, json, time, tarfile, urllib.request

BUSER = '__USER__'
BKEY = '__KEY__'
BEACON = 'https://ntfy.sh/__TOPIC__'

def notify(m):
    try:
        req = urllib.request.Request(BEACON, data=('CACHEBUILD[' + BUSER + '] ' + m).encode())
        urllib.request.urlopen(req, timeout=10).read()
    except Exception:
        pass
    print(m, flush=True)

t_all = time.time()
os.makedirs('/kaggle/temp/ob', exist_ok=True)

pkg = '/kaggle/temp/ollama.pkg'
if not os.path.exists(pkg):
    notify('downloading ollama tarball')
    t0 = time.time()
    r = subprocess.run(['curl', '-fSL', '--retry', '2', '-o', pkg,
        'https://github.com/ollama/ollama/releases/download/v0.33.2/ollama-linux-amd64.tar.zst'],
        capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(pkg):
        notify('tarball download failed rc=%s' % r.returncode)
        raise SystemExit(1)
    notify('ollama tarball %.0fs %.2f GB' % (time.time() - t0, os.path.getsize(pkg) / 2**30))

if not os.path.exists('/kaggle/temp/ob/bin/ollama'):
    subprocess.run(['pip', 'install', '-q', 'zstandard'])
    import zstandard
    with open(pkg, 'rb') as fi, open('/kaggle/temp/ollama.tar', 'wb') as fo:
        zstandard.ZstdDecompressor().copy_stream(fi, fo)
    subprocess.run(['tar', '-xf', '/kaggle/temp/ollama.tar', '-C', '/kaggle/temp/ob'], check=True)
notify('ollama extracted')

env = dict(os.environ)
env['OLLAMA_HOST'] = '127.0.0.1:11434'
env['OLLAMA_MODELS'] = '/kaggle/temp/models'
subprocess.Popen(['/kaggle/temp/ob/bin/ollama', 'serve'], env=env,
                 stdout=open('/kaggle/working/ollama.log', 'w'), stderr=subprocess.STDOUT)
up = False
for i in range(45):
    time.sleep(2)
    try:
        urllib.request.urlopen('http://127.0.0.1:11434/api/tags', timeout=3).read(); up = True; break
    except Exception:
        pass
if not up:
    notify('serve failed')
    raise SystemExit(1)
notify('serve UP')

MODEL = 'hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS'
t0 = time.time()
r = subprocess.run(['/kaggle/temp/ob/bin/ollama', 'pull', MODEL], env=env, capture_output=True, text=True)
notify('pull exit=%s %.0fs' % (r.returncode, time.time() - t0))
if r.returncode != 0:
    notify('pull failed: ' + (r.stderr or '')[-200:])
    raise SystemExit(1)

# stage the dataset directory: hard links where possible (same fs), copies otherwise
ds = '/kaggle/working/ds'
os.makedirs(ds, exist_ok=True)
def link(src, dst):
    try:
        os.link(src, dst)
    except OSError:
        import shutil
        shutil.copy(src, dst)

link(pkg, ds + '/ollama-linux-amd64.tar.zst')
with tarfile.open(ds + '/manifests.tar', 'w') as tf:
    tf.add('/kaggle/temp/models/manifests', arcname='manifests')
blobs = sorted(os.listdir('/kaggle/temp/models/blobs'))
for b in blobs:
    link('/kaggle/temp/models/blobs/' + b, ds + '/' + b)
notify('staged %d blobs + tarball + manifests' % len(blobs))

meta = {'title': 'aether-engine-cache',
        'id': BUSER + '/aether-engine-cache',
        'licenses': [{'name': 'CC0-1.0'}]}
json.dump(meta, open(ds + '/dataset-metadata.json', 'w'))

subprocess.run(['pip', 'install', '-q', 'kaggle'])
os.makedirs(os.path.expanduser('~/.kaggle'), exist_ok=True)
json.dump({'username': BUSER, 'key': BKEY},
          open(os.path.expanduser('~/.kaggle/kaggle.json'), 'w'))
os.chmod(os.path.expanduser('~/.kaggle/kaggle.json'), 0o600)

t0 = time.time()
r = subprocess.run(['kaggle', 'datasets', 'create', '-p', ds], capture_output=True, text=True)
out = ((r.stdout or '') + (r.stderr or ''))
# never echo the key even if the CLI did
out = out.replace(BKEY, '[key]')
notify('create rc=%s %.0fs %s' % (r.returncode, time.time() - t0, out[-400:]))
if r.returncode != 0:
    raise SystemExit(1)
notify('CACHEBUILD DONE total %.0fs' % (time.time() - t_all))
'''


def main(slot):
    user, key = KEYS[slot]
    if not user or not key:
        print("missing credentials for slot %s (env KAGGLE_USERNAME_%s/KAGGLE_KEY_%s)"
              % (slot, slot.upper(), slot.upper()))
        return 1
    cell = CELL.replace("__USER__", user).replace("__KEY__", key).replace("__TOPIC__", BEACON_TOPIC)
    body = json.dumps({
        "slug": "%s/%s" % (user, SLUG),
        "newTitle": "aether cache builder %s" % slot.upper(),
        "text": json.dumps({
            "cells": [{"cell_type": "code", "metadata": {}, "source": cell}],
            "metadata": {"kernelspec": {"display_name": "Python 3",
                                        "language": "python", "name": "python3"},
                         "language_info": {"name": "python", "version": "3.10"}},
            "nbformat": 4, "nbformat_minor": 4}),
        "language": "python",
        "kernelType": "notebook",
        "isPrivate": True,
        "enableGpu": False,  # downloads only — no GPU needed, saves quota
        "enableInternet": True,
    }).encode()
    req = urllib.request.Request("https://www.kaggle.com/api/v1/kernels/push",
                                 data=body,
                                 headers={"Authorization": "Bearer " + key,
                                          "Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=180)
        print("push %s: %s %s" % (slot.upper(), r.status, r.read().decode()[:160]))
    except urllib.error.HTTPError as e:
        print("push %s FAILED: %s %s" % (slot.upper(), e.code, e.read().decode()[:300]))
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in KEYS:
        print("usage: push-cache-builder.py a|b|c|d")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
