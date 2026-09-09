#!/usr/bin/env python3
"""Bind the browser credential gate to a real grant instead of a self-set flag.

The helper already refused credential fills unless `user_approved` was true, and
the tool schema already exposed that flag to the model. So the whole gate rested
on a boolean the model could set for itself: nothing connected it to anything the
user actually said. That fails in both directions -- a model that leaves it false
can never log in, and a model that sets it true has skipped the user entirely.

This replaces the flag with a scoped grant:

  * `authorize` records a grant for (session, host, kind) with a TTL. The app
    calls it when the user has explicitly agreed to that specific action.
  * credential `fill`/`type`/`submit` require a live grant for the page's host.
    `user_approved` on its own no longer opens anything.
  * `submit` is its own action, so "look at the form", "fill the form" and "send
    the form" are three separately gated decisions rather than one click.
  * a value is held only for the call that needed it and wiped afterwards.
  * completing a credential submit ends the grant: consent was for that sign-in.

CAPTCHA and MFA are still refused rather than solved.

The helper is embedded as a single-quoted Python string inside the notebook, so
this decodes it, patches plain text, and re-encodes -- matching escaped source
directly is how the previous attempt silently reported success while applying
nothing.

Run: python3 scripts/browser-auth-fix.py [--check]
"""
import ast
import json
import pathlib
import re
import sys

ASSET = pathlib.Path(__file__).resolve().parent.parent / (
    "android/app/src/main/assets/aether-notebook-template.json")

MARKER = "_B_HELPER_SRC"

# --------------------------------------------------------------------------
# 1. the grant store, inserted after the existing secret selectors
# --------------------------------------------------------------------------
OLD_SECRETS = """_SECRET_SEL = ('input[type=password]', 'input[name*=pass]', 'input[name*=pwd]',
               'input[name*=secret]', 'input[name*=token]', 'input[name*=otp]',
               'input[name*=cvv]', 'input[autocomplete*=password]')
"""

NEW_SECRETS = """_SECRET_SEL = ('input[type=password]', 'input[name*=pass]', 'input[name*=pwd]',
               'input[name*=secret]', 'input[name*=token]', 'input[name*=otp]',
               'input[name*=cvv]', 'input[autocomplete*=password]')

# ---- authorization grants -------------------------------------------------
# (session, host, kind) -> unix expiry. A grant is the ONLY thing that opens a
# credential action. It is created by `authorize`, which the app calls when the
# user has explicitly agreed to that specific action on that specific site.
#
# The previous design gated on a `user_approved` boolean the model set itself,
# which bound the decision to nothing the user had said. A model that forgot it
# could never log in; a model that set it had skipped the user entirely.
_B_GRANTS = {}
_B_GRANT_TTL = 900          # 15 min: long enough for a login, short enough to lapse
_B_GRANT_KINDS = ('fill', 'submit', 'upload')


def _b_host(url):
    m = re.match(r'https?://([^/]+)', url or '')
    return (m.group(1) if m else '').lower()


def _b_granted(session, url, kind):
    \"\"\"True when a live grant covers this session, host and action kind.\"\"\"
    key = (str(session), _b_host(url), kind)
    exp = _B_GRANTS.get(key)
    if exp is None:
        return False
    if exp < time.time():
        _B_GRANTS.pop(key, None)      # lapsed: consent is not forever
        return False
    return True


def _b_forget(session=None):
    \"\"\"Drop grants for one session, or all of them.\"\"\"
    if session is None:
        _B_GRANTS.clear()
    else:
        for k in [k for k in list(_B_GRANTS) if k[0] == str(session)]:
            _B_GRANTS.pop(k, None)
"""

# --------------------------------------------------------------------------
# 2. authorize / revoke actions
# --------------------------------------------------------------------------
OLD_CTX = """    if action == 'new_context':
        _b_page(session)
        return 'BROWSER READY session=%s' % session
"""

NEW_CTX = """    if action == 'new_context':
        _b_page(session)
        return 'BROWSER READY session=%s' % session

    if action == 'authorize':
        kind = (value or text or 'fill').strip().lower()
        if kind not in _B_GRANT_KINDS:
            return 'browser: authorize needs value in %s' % (', '.join(_B_GRANT_KINDS))
        ctx, page = _b_page(session)
        host = _b_host(url) or _b_host(page.url)
        if not host:
            return 'browser: authorize needs a url, or an open page, to scope the grant'
        ttl = min(max(int(timeout or _B_GRANT_TTL), 30), 3600)
        _B_GRANTS[(str(session), host, kind)] = time.time() + ttl
        # A grant names the site and the action. It never carries a credential.
        return 'AUTHORIZED %s on %s for %ds (session %s)' % (kind, host, ttl, session)

    if action == 'revoke':
        _b_forget(session)
        return 'REVOKED authorization for session %s' % session
"""

# --------------------------------------------------------------------------
# 3. gated fill, and submit as its own decision
# --------------------------------------------------------------------------
OLD_FILL = """    if action in ('type', 'fill'):
        if not selector:
            return 'browser: %s needs a selector' % action
        if _b_is_secret(selector) or _b_secret_element(page, selector):
            if not user_approved:
                return ('NEEDS APPROVAL: %s targets a credential field. Ask the user '
                        'to confirm this exact step first; the value is never shown.'
                        % selector)
        if action == 'type':
            page.type(selector, value or text or '', timeout=to)
        else:
            page.fill(selector, value or text or '', timeout=to)
        # The value is not echoed back: it may be a password or a token.
        return '%s into %s (%d chars, value withheld)' % (
            action.upper(), selector, len(value or text or ''))
"""

NEW_FILL = """    if action in ('type', 'fill'):
        if not selector:
            return 'browser: %s needs a selector' % action
        secret = _b_is_secret(selector) or _b_secret_element(page, selector)
        if secret and not _b_granted(session, page.url, 'fill'):
            # `user_approved` alone is deliberately NOT enough: it is a value the
            # model chooses, so it cannot stand in for the user agreeing.
            return ('NEEDS APPROVAL: %s targets a credential field on %s. The user has '
                    'to authorize filling credentials on this site first; until then '
                    'this step stops here. The value is never shown or stored.'
                    % (selector, _b_host(page.url) or 'this page'))
        pending = value or text or ''
        try:
            if action == 'type':
                page.type(selector, pending, timeout=to)
            else:
                page.fill(selector, pending, timeout=to)
        finally:
            # Scoped to this call: the value does not outlive the action that
            # needed it, so it cannot leak into a later reply or a log.
            pending = ''
        # The value is not echoed back: it may be a password or a token.
        return '%s into %s (%d chars, value withheld)' % (
            action.upper(), selector, len(value or text or ''))

    if action == 'submit':
        if not selector:
            return 'browser: submit needs a selector'
        # Submitting is a separate decision from filling: sending is the step
        # that actually hands a secret to the site, so it needs its own grant.
        has_secret = False
        try:
            has_secret = page.locator(', '.join(_SECRET_SEL)).count() > 0
        except Exception:
            has_secret = False
        if has_secret and not _b_granted(session, page.url, 'submit'):
            return ('NEEDS APPROVAL: submitting a form with credentials on %s. The user '
                    'has to authorize submitting on this site first.'
                    % (_b_host(page.url) or 'this page'))
        page.click(selector, timeout=to)
        page.wait_for_load_state('domcontentloaded', timeout=to)
        _b_save(session)
        # A completed sign-in ends the window: the consent was for this login,
        # not for everything the session does afterwards.
        if has_secret:
            _b_forget(session)
        return 'SUBMITTED %s | now %s' % (selector, page.url[:300])
"""

# --------------------------------------------------------------------------
# 4. tool schema (plain text in the notebook source, not inside the helper)
# --------------------------------------------------------------------------
OLD_ENUM = ("'enum':['navigate','click','type','fill','select','read','screenshot',"
            "'wait','back','upload','new_context','close','list','cookies']")
NEW_ENUM = ("'enum':['navigate','click','type','fill','submit','select','read',"
            "'screenshot','wait','back','upload','authorize','revoke','new_context',"
            "'close','list','cookies']")

OLD_DESC = ("Set user_approved=true ONLY after the user has explicitly agreed in the "
            "conversation to that specific external action. Never use it to bypass "
            "CAPTCHA, MFA or anti-bot protection.")
NEW_DESC = ("To enter credentials, call action=authorize for that site first -- the app "
            "only grants it when the user has explicitly agreed, and a credential fill or "
            "submit is refused without a live grant. Never guess credentials. Never use "
            "this to bypass CAPTCHA, MFA or anti-bot protection.")

HELPER_PAIRS = [
    (OLD_SECRETS, NEW_SECRETS, "grant store"),
    (OLD_CTX, NEW_CTX, "authorize/revoke actions"),
    (OLD_FILL, NEW_FILL, "gated fill + submit"),
]
SOURCE_PAIRS = [
    (OLD_ENUM, NEW_ENUM, "tool enum"),
    (OLD_DESC, NEW_DESC, "tool description"),
]


def encode_helper(text: str) -> str:
    """Re-encode as the single-quoted Python literal the notebook stores."""
    out = text.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
    return out


def main() -> int:
    check = "--check" in sys.argv
    nb = json.loads(ASSET.read_text(encoding="utf-8"))
    # Keyed by label, across ALL cells: a pattern only counts as missing when no
    # cell contained it. Reporting per-cell made every cell that merely lacked
    # the helper look like a failure, and aborted a patch that had worked.
    report = {}
    changed = False

    def note(label, how):
        prev = report.get(label)
        if prev == "applied" or prev == "already present":
            return                      # a real hit anywhere wins
        report[label] = how

    for cell in nb["cells"]:
        if cell.get("cell_type") != "code":
            continue
        raw = cell["source"]
        src = raw if isinstance(raw, str) else "".join(raw)
        original = src

        # --- helper body: decode, patch, re-encode -------------------------
        if MARKER in src:
            i = src.index(MARKER)
            q = src.index("'", i)
            # ast.literal_eval on the literal gives the exact decoded text.
            end = q + 1
            while end < len(src):
                if src[end] == "\\":
                    end += 2
                    continue
                if src[end] == "'":
                    break
                end += 1
            literal = src[q:end + 1]
            helper = ast.literal_eval(literal)
            for old, new, label in HELPER_PAIRS:
                if new in helper:
                    note(label, "already present")
                    continue
                if old in helper:
                    helper = helper.replace(old, new, 1)
                    note(label, "applied")
                else:
                    note(label, "NOT FOUND")
            newlit = "'" + encode_helper(helper) + "'"
            if newlit != literal:
                src = src[:q] + newlit + src[end + 1:]

        # --- plain-text schema bits ---------------------------------------
        for old, new, label in SOURCE_PAIRS:
            if new in src:
                note(label, "already present")
            elif old in src:
                src = src.replace(old, new, 1)
                note(label, "applied")
            else:
                note(label, "NOT FOUND")

        if src != original:
            cell["source"] = src
            changed = True

    bad = [label for label, how in report.items() if how == "NOT FOUND"]
    for label, how in report.items():
        print("  %-26s %s" % (label, how))

    if bad:
        print("browser-auth-fix: FAILED -- %d pattern(s) not found, nothing written"
              % len(bad))
        return 1
    if check:
        print("browser-auth-fix: OK, every change is present")
        return 0
    if not changed:
        print("browser-auth-fix: nothing to do")
        return 0

    ASSET.write_text(json.dumps(nb, ensure_ascii=True, separators=(",", ":")),
                     encoding="utf-8")
    print("browser-auth-fix: applied. Run scripts/sync-engine-source.mjs next.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
