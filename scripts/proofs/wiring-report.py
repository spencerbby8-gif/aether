#!/usr/bin/env python3
"""
Wiring report: every interactive control in the app, and the code that runs
when it is pressed.

WHY THIS EXISTS. No emulator can run in this sandbox, so "every button works"
cannot be demonstrated by tapping. What CAN be shown mechanically is that no
control is left unbound: for each id that a layout declares, either the activity
attaches a listener to it or it is a passive view. A control that appears in the
first column with nothing in the second is a dead button, which is exactly the
class of bug being asked about.

It is a static report, not a runtime proof, and it says so.

Usage: python3 scripts/proofs/wiring-report.py
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
JAVA = os.path.join(ROOT, "android/app/src/main/java/com/aether/app")
LAYOUT = os.path.join(ROOT, "android/app/src/main/res/layout")

# Tags that are only ever containers or decoration.
PASSIVE_TAGS = {"LinearLayout", "FrameLayout", "ScrollView", "View",
                "androidx.drawerlayout.widget.DrawerLayout"}

# Tags that are only interactive if the id says so (TextView and ImageView are
# used for labels just as often as for buttons).
CONDITIONAL_TAGS = {"TextView", "ImageView"}


def looks_pressable(tag, ident):
    if tag in ("Button", "ImageButton", "EditText"):
        return True
    if tag in CONDITIONAL_TAGS:
        return "btn" in ident.lower()
    return tag not in PASSIVE_TAGS

BIND_PATTERNS = [
    # findViewById(R.id.x).setOnClickListener(v -> ...)
    re.compile(r"findViewById\(R\.id\.(\w+)\)\.set(On\w*Listener)"),
    # field = findViewById(R.id.x)  ...  field.set...(
    re.compile(r"(\w+)\s*=\s*findViewById\(R\.id\.(\w+)\)"),
]


def layout_controls():
    """id -> tag for every id declared in a layout."""
    out = {}
    for name in sorted(os.listdir(LAYOUT)):
        if not name.endswith(".xml"):
            continue
        text = open(os.path.join(LAYOUT, name), encoding="utf-8").read()
        for m in re.finditer(r"<([A-Za-z][\w.]*)\b[^>]*?android:id=\"@\+id/(\w+)\"", text, re.S):
            tag, ident = m.group(1), m.group(2)
            out[ident] = (tag, name)
    return out


def java_sources():
    files = {}
    for dirpath, _, names in os.walk(JAVA):
        for n in names:
            if n.endswith(".java"):
                p = os.path.join(dirpath, n)
                files[n] = open(p, encoding="utf-8").read()
    return files


def bindings(src):
    """id -> description of what happens when it is pressed."""
    found = {}
    for m in re.finditer(r"findViewById\(R\.id\.(\w+)\)\.set(On\w*Listener)\s*\(\s*(?:v\s*->|\(?\w*\)?\s*->)?\s*([A-Za-z_][\w.]*)?", src):
        ident, kind, call = m.group(1), m.group(2), m.group(3)
        found[ident] = f"{kind} -> {call or 'inline'}"
    # fields: find `field = findViewById(R.id.x)` then `field.set...Listener`
    for m in re.finditer(r"(\w+)\s*=\s*findViewById\(R\.id\.(\w+)\)", src):
        field, ident = m.group(1), m.group(2)
        for b in re.finditer(re.escape(field) + r"\.set(On\w*Listener)\s*\(\s*(?:v\s*->|\(?\w*\)?\s*->)?\s*([A-Za-z_][\w.]*)?", src):
            found[ident] = f"{b.group(1)} -> {b.group(2) or 'inline'}"
    return found


def main():
    controls = layout_controls()
    srcs = java_sources()
    all_bindings = {}
    for name, src in srcs.items():
        for ident, what in bindings(src).items():
            all_bindings[ident] = (name, what)

    print("== controls declared in layouts (passive views listed separately)")
    dead = []
    for ident, (tag, layout) in sorted(controls.items()):
        if tag in PASSIVE_TAGS:
            continue
        owner, what = all_bindings.get(ident, ("", ""))
        if what:
            print(f"  {ident:<14} {tag:<12} {layout:<22} {owner}: {what}")
            continue
        if looks_pressable(tag, ident):
            dead.append((ident, tag, layout))
            print(f"  {ident:<14} {tag:<12} {layout:<22} -- NOT BOUND")
        else:
            print(f"  {ident:<14} {tag:<12} {layout:<22} passive view")

    print()
    print("== controls bound in code but with no layout id")
    for ident, (name, what) in sorted(all_bindings.items()):
        if ident not in controls:
            print(f"  {ident:<14} {name}: {what}")

    print()
    print("== programmatically created controls (built in code, bound there)")
    for name, src in sorted(srcs.items()):
        for m in re.finditer(r"(\w+)\.set(On\w*Listener)\s*\(\s*(?:v\s*->|\(?\w*\)?\s*->)?\s*([A-Za-z_][\w.]*)?", src):
            var, kind, call = m.group(1), m.group(2), m.group(3)
            if var in ("findViewById",):
                continue
            if re.search(r"\b" + re.escape(var) + r"\s*=\s*findViewById", src):
                continue      # already reported as a layout control
            print(f"  {name:<22} {var:<10} {kind} -> {call or 'inline'}")

    print()
    if dead:
        print(f"RESULT: {len(dead)} interactive control(s) with no handler:")
        for ident, tag, layout in dead:
            print(f"  {ident} ({tag}) in {layout}")
        return 1
    print("RESULT: every interactive control declared in a layout has a handler bound in code.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
