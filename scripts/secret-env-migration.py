#!/usr/bin/env python3
"""Migrate hardcoded control secrets to environment configuration.

Every script that talked to an engine or the beacon carried the engine OFF
key and/or the ntfy beacon topic as a literal default. The literals are the
leak: they are readable in the public repo's current tree and in every
historical commit. This pass makes the working tree secret-free:

  OFF_KEY = "nxoff-..."            ->  OFF_KEY = os.environ["ENGINE_OFF_KEY"]
  KEY = os.environ.get(            ->  KEY = os.environ["ENGINE_OFF_KEY"]
      "ENGINE_OFF_KEY", "nxoff-...")
  TOPIC = "btb-kaggle-..."         ->  TOPIC = os.environ["BEACON_TOPIC"]
  BEACON = "https://ntfy.sh/       ->  BEACON = "https://ntfy.sh/" +
      btb-kaggle-.../json?..."                os.environ["BEACON_TOPIC"] + "/json?..."

  AETHER_OFF_KEY (one script) is unified onto ENGINE_OFF_KEY.
  `import os` is added where missing; every touched file is py_compile'd.
  Docs get `<set via ENGINE_OFF_KEY>` / `<set via BEACON_TOPIC>` redactions.

Deliberately NOT touched: files whose nxoff-/btb-kaggle- text is a DETECTION
REGEX (verify-engine-source.mjs, security-sweep.sh, e2e-phase5.mjs,
tests/kaggle-wake-source.test.ts) -- those match shapes, never values.

Idempotent: a second run is a no-op. Prints per-file change counts only,
never a secret value.

  python3 scripts/secret-env-migration.py [--check]
    --check   report what would change, change nothing, exit 1 if anything
"""
import argparse
import pathlib
import py_compile
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

# Detection-regex carriers -- shapes, not values. Never rewrite these.
SKIP = {
    "scripts/verify-engine-source.mjs",
    "scripts/security-sweep.sh",
    "scripts/e2e-phase5.mjs",
    "tests/kaggle-wake-source.test.ts",
}

GET_OFF_RE = re.compile(
    r'os\.environ\.get\("(?:ENGINE_OFF_KEY|AETHER_OFF_KEY)"\s*,\s*["\']nxoff-[A-Za-z0-9]+["\']\)')
AETHER_OFF_RE = re.compile(r'os\.environ\.get\("AETHER_OFF_KEY"\)')
NTFY_URL_RE = re.compile(r'(["\'])https://ntfy\.sh/btb-kaggle-[a-z0-9]+(/[^"\']*)\1')
OFF_RE = re.compile(r'(["\'])nxoff-[A-Za-z0-9]+\1')
TOPIC_RE = re.compile(r'(["\'])btb-kaggle-[a-z0-9]+\1')
MD_OFF_RE = re.compile(r'nxoff-[A-Za-z0-9]+')
MD_TOPIC_RE = re.compile(r'btb-kaggle-[a-z0-9]+')
MD_URL_RE = re.compile(r'https://ntfy\.sh/btb-kaggle-[a-z0-9]+(/?)')

ENV_OFF = 'os.environ["ENGINE_OFF_KEY"]'
ENV_TOPIC = 'os.environ["BEACON_TOPIC"]'


def ensure_import_os(text: str) -> str:
    if re.search(r'^\s*import os\b', text, re.M):
        return text
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.startswith("import ") or line.startswith("from "):
            lines.insert(i, "import os")
            return "\n".join(lines)
    idx = 1 if lines and lines[0].startswith("#!") else 0
    lines.insert(idx, "import os")
    return "\n".join(lines)


def migrate_python(path: pathlib.Path, check: bool):
    t = path.read_text(encoding="utf-8")
    orig = t
    t = GET_OFF_RE.sub(ENV_OFF, t)
    t = AETHER_OFF_RE.sub(ENV_OFF, t)
    t = NTFY_URL_RE.sub(lambda m: '"https://ntfy.sh/" + ' + ENV_TOPIC + ' + "' + m.group(2) + '"', t)
    t = OFF_RE.sub(ENV_OFF, t)
    t = TOPIC_RE.sub(ENV_TOPIC, t)
    if t == orig:
        return None
    t = ensure_import_os(t)
    if not check:
        path.write_text(t, encoding="utf-8")
        py_compile.compile(str(path), doraise=True)
    n_off = len(OFF_RE.findall(orig)) + len(GET_OFF_RE.findall(orig))
    n_topic = len(TOPIC_RE.findall(orig)) + len(NTFY_URL_RE.findall(orig))
    return f"{path}: {n_off} OFF-key literal(s), {n_topic} topic literal(s) -> env"


def migrate_doc(path: pathlib.Path, check: bool):
    t = path.read_text(encoding="utf-8")
    orig = t
    t = MD_URL_RE.sub("https://ntfy.sh/<BEACON_TOPIC>\\1", t)
    t = MD_OFF_RE.sub("<set via ENGINE_OFF_KEY>", t)
    t = MD_TOPIC_RE.sub("<set via BEACON_TOPIC>", t)
    if t == orig:
        return None
    if not check:
        path.write_text(t, encoding="utf-8")
    return f"{path}: redacted {len(MD_OFF_RE.findall(orig))} OFF-key + {len(MD_TOPIC_RE.findall(orig))} topic mention(s)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    changed, clean = [], []
    for path in sorted(ROOT.rglob("*")):
        rel = str(path.relative_to(ROOT))
        if not path.is_file() or rel in SKIP:
            continue
        if "/." in rel or rel.startswith(".") or "node_modules" in rel:
            continue
        try:
            if path.suffix == ".py":
                r = migrate_python(path, args.check)
            elif path.suffix == ".md":
                r = migrate_doc(path, args.check)
            else:
                continue
        except Exception as e:  # noqa: BLE001
            print(f"ERROR processing {rel}: {e}")
            sys.exit(1)
        if r:
            changed.append(r)
        elif path.suffix in (".py", ".md") and (
            OFF_RE.search(path.read_text(encoding="utf-8", errors="ignore") or "")
            or TOPIC_RE.search(path.read_text(encoding="utf-8", errors="ignore") or "")
        ):
            clean.append(rel)

    for line in changed:
        print("  CHANGED", line)
    leftovers = []
    for path in sorted(ROOT.rglob("*")):
        rel = str(path.relative_to(ROOT))
        if not path.is_file() or rel in SKIP or "/." in rel or rel.startswith(".") or "node_modules" in rel:
            continue
        if path.suffix not in (".py", ".md", ".ts", ".mjs", ".sh", ".java", ".json", ".xml", ".properties"):
            continue
        try:
            t = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if OFF_RE.search(t) or TOPIC_RE.search(t) or NTFY_URL_RE.search(t):
            leftovers.append(rel)
    if leftovers:
        print("LEFTOVER literals in:", *leftovers, sep="\n  ")
        sys.exit(1)
    print(f"\nOK: {len(changed)} file(s) migrated, no literal OFF key or topic remains in the tree"
          + (" (check mode; nothing written)" if args.check else ""))
    if args.check and changed:
        sys.exit(1)


if __name__ == "__main__":
    main()
