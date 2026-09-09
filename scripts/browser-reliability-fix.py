#!/usr/bin/env python3
"""Make the browser agent establish page state before it touches anything.

REPRODUCED FAILURE (real Chromium, current helper, `--policy guess`):
  3/6 workflows completed, 22 tool calls, 92.8s wall -- of which 90s was three
  blind 30s selector timeouts:

    iframe form    TimeoutError: Page.fill: Timeout 30000ms exceeded.
                   waiting for locator("input[name=email]")
    overlay        TimeoutError: Page.click: Timeout 30000ms exceeded.
                   locator resolved to <button type="submit" id=...
    unstable ids   TimeoutError: Page.fill: Timeout 30000ms exceeded.
                   waiting for locator("#email-1")

  The middle one is the whole problem in one line: the element WAS found, the
  click was intercepted by a consent banner, and the agent was told only that
  time ran out. So it guessed another selector and paid 30s again.

WHAT THIS CHANGES
  * `inspect` -- one call returns URL, title, load state, frames, overlays,
    dialogs, every field and button with label/name/role/autocomplete, and
    whether each is visible, enabled and covered. The agent stops guessing.
  * targeting priority: testid/aria -> label/name -> role/text -> CSS
    attributes -> generated path, and `_b_resolve` walks that chain again when
    the first candidate has gone stale.
  * every interaction first checks the target exists, is attached, visible,
    enabled, and is in the frame the agent meant -- including child frames.
  * a failed target returns the actual blocker ("covered by #banner 'We use
    cookies.'", "disabled", "inside frame 'partner'") instead of a timeout.
  * `wait` takes a real condition (dom/load/network/url:/visible:) instead of
    a fixed sleep.
  * `batch` runs several independent actions in one tool call.
  * separate budgets: 8s per interaction, 30s for a page load.

The credential gate and the CAPTCHA refusal are untouched.

  python3 scripts/browser-reliability-fix.py --check
  python3 scripts/browser-reliability-fix.py --emit /tmp/candidate-helper.py
  python3 scripts/browser-reliability-fix.py            # apply to the asset
"""
import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSET = ROOT / "android/app/src/main/assets/aether-notebook-template.json"

# --------------------------------------------------------------------------
# The new page-state + targeting layer, inserted ahead of _b_do.
# --------------------------------------------------------------------------
NEW_LAYER = r'''
# ---- page state, targeting and honest failure -----------------------------
#
# These exist because a blind selector costs a full timeout. Measured on real
# Chromium: three ordinary pages (a form inside an iframe, a consent banner
# over the submit button, and a form whose ids change per load) each burned the
# entire 30s budget and told the agent nothing but "time ran out".

_B_ACTION_MS = 8000      # one interaction. Short, because a miss should be cheap.
_B_LOAD_MS = 30000       # a page load is allowed to be slow; an action is not.

# One snapshot of the page: structure, controls and anything in the way.
_B_SNAPSHOT_JS = r"""() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) === 0) return false;
    return r.width > 1 && r.height > 1;
  };
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const esc = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : String(v);
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + esc(el.id) + '"]');
      if (l && clean(l.textContent)) return clean(l.textContent);
    }
    const wrap = el.closest('label');
    if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? clean(n.textContent) : '';
      }).filter(Boolean).join(' ');
      if (t) return t;
    }
    if (el.placeholder) return clean(el.placeholder);
    return '';
  };
  // Last-resort path: only used when nothing semantic identifies the element.
  const cssPath = (el) => {
    if (el.id) return '#' + esc(el.id);
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 4) {
      let part = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
      n = parent;
      if (n && n.tagName === 'BODY') break;
    }
    return parts.join(' > ');
  };
  // Is something else on top of this element's centre point?
  const coveredBy = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top) return null;
    if (top === el || el.contains(top) || top.contains(el)) return null;
    return {
      selector: top.id ? ('#' + esc(top.id)) : cssPath(top),
      text: clean(top.textContent).slice(0, 60),
      tag: top.tagName.toLowerCase()
    };
  };
  const idLooksStable = (id) => !!id && !/(^\d|\$|:|__|_ng|react|ember|vue_|uid_|auto|generated)/i.test(id);

  const pick = (el, kind) => {
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test') ||
                   el.getAttribute('data-qa') || el.getAttribute('data-cy');
    if (testid) return 'testid=' + testid;
    if (idLooksStable(el.id) && el.tagName !== 'FORM') return '#' + esc(el.id);
    const lab = labelFor(el);
    if (kind === 'field' && lab) return 'label=' + lab;
    if (el.name) return 'css=' + el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    if (kind === 'field' && lab) return 'label=' + lab;
    if (kind === 'button') {
      const role = el.getAttribute('role') || (el.tagName === 'BUTTON' ? 'button' : '');
      const nm = clean(el.getAttribute('aria-label') || el.value || el.textContent);
      if (role && nm) return 'role=' + role + '[name="' + nm.slice(0, 50) + '"]';
      if (nm) return 'text=' + nm.slice(0, 50);
    }
    if (kind === 'field' && el.type && el.autocomplete) {
      return 'css=input[type="' + el.type + '"][autocomplete="' + el.autocomplete + '"]';
    }
    return 'css=' + cssPath(el);
  };

  const fields = [];
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.type === 'hidden') return;
    const cov = vis(el) ? coveredBy(el) : null;
    fields.push({
      selector: pick(el, 'field'),
      label: labelFor(el).slice(0, 50),
      name: el.name || '',
      type: (el.type || el.tagName).toLowerCase(),
      autocomplete: el.autocomplete || '',
      placeholder: (el.placeholder || '').slice(0, 30),
      required: !!el.required,
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      visible: vis(el),
      covered: cov ? (cov.selector + (cov.text ? ' "' + cov.text + '"' : '')) : null,
      options: el.tagName === 'SELECT'
        ? Array.from(el.options).map((o) => o.value).slice(0, 8) : undefined
    });
  });

  const buttons = [];
  document.querySelectorAll('button, input[type=submit], input[type=button], [role=button], a[href]').forEach((el) => {
    if (buttons.length >= 20) return;
    const nm = clean(el.getAttribute('aria-label') || el.value || el.textContent).slice(0, 50);
    const isBtn = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' ||
                  (el.type === 'submit' || el.type === 'button');
    if (!isBtn && !nm) return;
    const cov = vis(el) ? coveredBy(el) : null;
    buttons.push({
      selector: pick(el, 'button'),
      text: nm,
      name: el.name || '',
      type: el.type || (el.tagName === 'A' ? 'link' : 'button'),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      visible: vis(el),
      covered: cov ? (cov.selector + (cov.text ? ' "' + cov.text + '"' : '')) : null
    });
  });

  const dialogs = [];
  document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], .modal, [aria-modal=true]').forEach((el) => {
    if (vis(el)) dialogs.push({ text: clean(el.textContent).slice(0, 90) });
  });

  const overlays = [];
  const vw = window.innerWidth, vh = window.innerHeight;
  document.querySelectorAll('body *').forEach((el) => {
    if (overlays.length >= 5) return;
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'absolute') return;
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    const frac = (r.width * r.height) / (vw * vh || 1);
    if (frac < 0.25) return;
    overlays.push({
      selector: el.id ? ('#' + esc(el.id)) : cssPath(el),
      text: clean(el.textContent).slice(0, 60),
      covers: Math.round(frac * 100)
    });
  });

  return {
    readyState: document.readyState,
    url: location.href,
    title: document.title,
    fields: fields,
    buttons: buttons,
    dialogs: dialogs,
    overlays: overlays,
    forms: document.querySelectorAll('form').length
  };
}"""


def _b_frames(page):
    """Main frame first, then every child frame.

    A control inside an iframe is unreachable from the main frame, and that is
    indistinguishable from "no such element" unless the frames are searched too.
    """
    out = [page.main_frame]
    try:
        for f in page.frames:
            if f is not page.main_frame and f not in out:
                out.append(f)
    except Exception:
        pass
    return out


def _b_frame_name(frame, page):
    if frame is page.main_frame:
        return 'main'
    try:
        el = frame.frame_element()
        for attr in ('id', 'name', 'title'):
            v = el.get_attribute(attr)
            if v:
                return v
    except Exception:
        pass
    try:
        return (frame.url or '')[:60]
    except Exception:
        return 'frame'


def _b_find_frame(page, spec):
    """Resolve `frame=<id|name|url-substring>` to a real frame."""
    spec = (spec or '').strip()
    if not spec or spec == 'main':
        return page.main_frame
    for f in _b_frames(page):
        if f is page.main_frame:
            continue
        try:
            el = f.frame_element()
            if spec in ((el.get_attribute('id') or ''), (el.get_attribute('name') or '')):
                return f
        except Exception:
            pass
        if spec in (f.url or ''):
            return f
    return None


def _b_locator(scope, selector):
    """Turn one of our targeting forms into a Playwright locator.

    Priority is semantic-first: testid, then stable id, then label/name, then
    role/text, then CSS attributes, then a generated path. Accepting a bare CSS
    selector keeps every existing caller working.
    """
    sel = (selector or '').strip()
    low = sel.lower()
    if low.startswith('testid='):
        return scope.get_by_test_id(sel[7:])
    if low.startswith('label='):
        return scope.get_by_label(sel[6:], exact=False)
    if low.startswith('role='):
        body = sel[5:]
        m = re.match(r'^([a-zA-Z]+)\[name="(.*)"\]$', body)
        if m:
            return scope.get_by_role(m.group(1), name=m.group(2), exact=False)
        return scope.get_by_role(body)
    if low.startswith('text='):
        return scope.get_by_text(sel[5:], exact=False)
    if low.startswith('css='):
        return scope.locator(sel[4:])
    return scope.locator(sel)


def _b_split_frame(selector):
    """Split `frame=partner >> label=Email` into (frame_spec, rest)."""
    sel = (selector or '').strip()
    m = re.match(r'^frame=([^>]+?)\s*>>\s*(.+)$', sel, re.S)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return None, sel


def _b_candidates(scope, selector):
    """The selector the agent asked for, then fallbacks in priority order.

    Re-resolution matters because the DOM moves: a single-page form re-renders
    its inputs, an id captured one call ago is gone, and the honest answer is
    to find the same control again rather than to fail.
    """
    out = [selector]
    base = (selector or '').strip()
    for pre in ('css=', 'label=', 'text=', 'testid=', 'role='):
        if base.lower().startswith(pre):
            base = base[len(pre):]
            break
    base = base.strip()
    if base and not base.startswith('#'):
        out.append('label=' + base)
        out.append('text=' + base)
    m = re.match(r'^#?(.+)$', base)
    if m and not base.startswith('['):
        out.append('css=[name="%s"]' % m.group(1))
    seen, uniq = set(), []
    for c in out:
        if c and c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def _b_state_of(locator):
    """Is the target actually usable? Returns (usable, why_not).

    Attachment is deliberately not re-checked here: this Playwright's Locator
    has no is_attached(), and an earlier version wrapped that missing attribute
    in a bare except which reported every interaction as "no longer attached to
    the DOM" -- a confident, completely wrong diagnosis. _b_resolve proves
    attachment with wait_for(state='attached') instead.
    """
    try:
        if locator.count() == 0:
            return False, 'no element matches'
    except Exception as e:
        return False, 'selector error: %s' % str(e)[:100]
    try:
        if not locator.first.is_visible():
            return False, 'the element is present but not visible'
    except Exception as e:
        return False, 'visibility check failed: %s' % str(e)[:100]
    try:
        if not locator.first.is_enabled():
            return False, 'the element is disabled'
    except Exception as e:
        return False, 'enabled check failed: %s' % str(e)[:100]
    return True, ''


def _b_resolve(page, selector, timeout_ms=None):
    """Find a usable element, in any frame. Returns (locator, frame_name, why_not).

    This is the single place an interaction gets its target, so "it timed out"
    is never the only thing we can say. When nothing is usable, the third value
    explains what is actually in the way.

    Two passes on purpose. The first costs nothing: on a normal page the
    element is already there, and searching every frame with a wait attached
    would turn one missing selector into (frames x budget) seconds. Only if
    nothing is found anywhere do we wait, once, for it to render.
    """
    to = timeout_ms or _B_ACTION_MS
    frame_spec, rest = _b_split_frame(selector)
    if frame_spec:
        f = _b_find_frame(page, frame_spec)
        if f is None:
            return None, None, 'there is no frame matching %r' % frame_spec
        scopes = [(f, _b_frame_name(f, page))]
    else:
        scopes = [(f, _b_frame_name(f, page)) for f in _b_frames(page)]

    why = ['no element matches %r' % selector]

    def sweep(wait_ms):
        for scope, fname in scopes:
            for cand in _b_candidates(scope, rest):
                try:
                    loc = _b_locator(scope, cand)
                except Exception as e:
                    why[0] = 'selector %r is not valid: %s' % (cand, str(e)[:70])
                    continue
                try:
                    if wait_ms:
                        loc.first.wait_for(state='attached', timeout=wait_ms)
                    elif loc.count() == 0:
                        continue
                except Exception:
                    continue
                usable, reason = _b_state_of(loc)
                if usable:
                    return loc, fname
                why[0] = '%s (%s)' % (reason, cand)
        return None

    hit = sweep(0)
    if hit:
        return hit[0], hit[1], ''
    hit = sweep(to)
    if hit:
        return hit[0], hit[1], ''
    return None, None, why[0]


def _b_covering(page, locator):
    """What is on top of the target, if anything. This is the consent banner."""
    try:
        return locator.first.evaluate("""el => {
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!top || top === el || el.contains(top) || top.contains(el)) return null;
            const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim();
            return (top.id ? '#' + top.id : top.tagName.toLowerCase()) +
                   (clean(top.textContent) ? ' "' + clean(top.textContent).slice(0, 60) + '"' : '');
        }""")
    except Exception:
        return None


def _b_diagnose(page, selector, reason):
    """Explain the real blocker, and name what is actually on the page."""
    parts = [reason]
    try:
        _, rest = _b_split_frame(selector)
        for f in _b_frames(page):
            try:
                loc = _b_locator(f, rest)
                if loc.count() > 0:
                    parts.append('it does exist inside frame %r, so target it as '
                                 '"frame=%s >> %s"' % (_b_frame_name(f, page),
                                                       _b_frame_name(f, page), rest))
                    break
            except Exception:
                continue
    except Exception:
        pass
    try:
        snap = page.main_frame.evaluate(_B_SNAPSHOT_JS)
        labels = [x.get('label') or x.get('name') for x in snap.get('fields', []) if x.get('visible')]
        labels = [x for x in labels if x][:8]
        if labels:
            parts.append('visible fields on the page: ' + ', '.join(labels))
        cov = [o for o in snap.get('overlays', [])]
        if cov:
            parts.append('an overlay covers %d%% of the page: %s'
                         % (cov[0].get('covers', 0), cov[0].get('selector')))
    except Exception:
        pass
    return '. '.join(parts)


def _b_page_state(page):
    """One snapshot across every frame -- the thing to call before acting."""
    out = {'frames': [], 'fields': [], 'buttons': [], 'dialogs': [], 'overlays': []}
    for f in _b_frames(page):
        name = _b_frame_name(f, page)
        try:
            snap = f.evaluate(_B_SNAPSHOT_JS)
        except Exception as e:
            out['frames'].append({'name': name, 'error': str(e)[:80]})
            continue
        out['frames'].append({
            'name': name, 'url': (snap.get('url') or '')[:160],
            'title': (snap.get('title') or '')[:80],
            'readyState': snap.get('readyState'),
            'fields': len(snap.get('fields', [])),
            'buttons': len(snap.get('buttons', [])),
            'forms': snap.get('forms', 0),
        })
        prefix = '' if name == 'main' else 'frame=%s >> ' % name
        for fl in snap.get('fields', []):
            fl['selector'] = prefix + fl.get('selector', '')
            fl['frame'] = name
            out['fields'].append(fl)
        for bt in snap.get('buttons', []):
            bt['selector'] = prefix + bt.get('selector', '')
            bt['frame'] = name
            out['buttons'].append(bt)
        out['dialogs'].extend(snap.get('dialogs', []))
        if name == 'main':
            out['overlays'].extend(snap.get('overlays', []))
    out['fields'] = out['fields'][:30]
    out['buttons'] = out['buttons'][:20]
    out['url'] = page.url[:200]
    try:
        out['title'] = (page.title() or '')[:120]
    except Exception:
        out['title'] = ''
    try:
        out['loading'] = page.main_frame.evaluate('document.readyState') != 'complete'
    except Exception:
        out['loading'] = False
    return out


def _b_inspect_text(page):
    """The snapshot as a compact line the model can act on immediately."""
    st = _b_page_state(page)
    notes = []
    if st.get('loading'):
        notes.append('page still loading')
    if st.get('overlays'):
        o = st['overlays'][0]
        notes.append('BLOCKED by overlay %s (%d%%)%s' % (
            o.get('selector'), o.get('covers', 0),
            ' "%s"' % o['text'] if o.get('text') else ''))
    if st.get('dialogs'):
        notes.append('dialog: %s' % st['dialogs'][0].get('text', '')[:60])
    frames = [f for f in st.get('frames', []) if f.get('name') != 'main']
    if frames:
        notes.append('frames: ' + ', '.join(f['name'] for f in frames))
    head = 'INSPECTED %s | title=%s | %d fields, %d buttons, %d frames' % (
        st.get('url'), st.get('title'), len(st.get('fields', [])),
        len(st.get('buttons', [])), len(st.get('frames', [])))
    if not st.get('fields') and not st.get('buttons'):
        notes.append('no controls yet -- the page may still be rendering, so '
                     'wait for a condition (value=network, or visible:<selector>) '
                     'and inspect again')
    if notes:
        head += ' | ' + ' | '.join(notes)
    return head + '\n' + json.dumps(st, separators=(',', ':'))[:6000]
'''

# --------------------------------------------------------------------------
# Replacements inside _b_do.
# --------------------------------------------------------------------------
REPLACEMENTS = [
    # --- close: ending the session ends its authorizations -----------------
    (
        """    if action == 'close':
        saved = None
        if session in _BROWSER['ctx']:
""",
        """    if action == 'close':
        # Ending the session ends its authorizations. Leaving live grants
        # behind lets a later session inherit consent nobody gave it -- the
        # 15 min TTL alone is not a boundary the user can see or act on.
        _b_forget(session)
        saved = None
        if session in _BROWSER['ctx']:
""",
        "close revokes the session's grants",
    ),
    # --- budgets: separate the interaction from the page load ---------------
    (
        """    session = str(session or 'main')
    to = min(max(int(timeout or 30), 1), 120) * 1000
""",
        """    session = str(session or 'main')
    # A page load and an interaction are different promises. One budget for
    # both meant a missed selector could sit for 30s; measured, three of them
    # were 90s of a 93s task. An interaction gets 8s unless asked otherwise.
    load_to = min(max(int(timeout or 30), 1), 120) * 1000
    to = min(max(int(kw.get('action_timeout') or 8), 1), 60) * 1000
""",
        "separate action and page-load budgets",
    ),
    # --- navigate: real load condition, then say what is on the page -------
    (
        """    if action == 'navigate':
        if not url:
            return 'browser: navigate needs a url'
        page.goto(url, timeout=to, wait_until='domcontentloaded')
        _b_save(session)
        return 'NAVIGATED %s | title=%s' % (page.url[:300], (page.title() or '')[:160])
""",
        """    if action == 'navigate':
        if not url:
            return 'browser: navigate needs a url'
        # `value` picks the load condition. domcontentloaded is the default
        # because it is the fastest thing that is still deterministic; a page
        # that renders its form later needs 'network' or a `selector` wait.
        cond = (value or text or 'dom').strip().lower()
        wait_until = {'dom': 'domcontentloaded', 'load': 'load',
                      'network': 'networkidle'}.get(cond, 'domcontentloaded')
        page.goto(url, timeout=load_to, wait_until=wait_until)
        # A redirect or a late render is the ordinary reason the next selector
        # misses, so report the state we actually landed in.
        extra = ''
        try:
            if selector:
                page.wait_for_selector(selector, timeout=to)
                extra = ' | target ready'
        except Exception:
            extra = ' | WARNING: %s is not present yet' % selector
        _b_save(session)
        return 'NAVIGATED %s | title=%s%s' % (
            page.url[:300], (page.title() or '')[:160], extra)
""",
        "navigate waits on a real condition",
    ),
    # --- wait: a condition, not a sleep -------------------------------------
    (
        """    if action == 'wait':
        if selector:
            page.wait_for_selector(selector, timeout=to)
            return 'WAITED for %s' % selector
        page.wait_for_timeout(min(int(value or 1000), 10000))
        return 'WAITED %sms' % value
""",
        """    if action == 'wait':
        # A deterministic condition replaces the fixed sleep. Sleeping a fixed
        # time is a guess that is either too short (the element is still not
        # there) or too long (pure waste), so it is only kept as an explicit,
        # capped fallback.
        cond = (value or text or '').strip()
        if selector:
            loc, fname, why = _b_resolve(page, selector, to)
            if loc is None:
                return 'WAIT FAILED: %s' % _b_diagnose(page, selector, why)
            return 'WAITED for %s%s' % (selector, '' if fname == 'main' else ' in frame %s' % fname)
        low = cond.lower()
        try:
            if low.startswith('url:'):
                # Not a glob: in Playwright globs '*' does not cross '/', so
                # '*/login*' never matches http://host/login. Match a regex.
                page.wait_for_url(re.compile(re.escape(cond[4:])), timeout=load_to)
                return 'WAITED for url %s | now %s' % (cond[4:], page.url[:200])
            if low.startswith('visible:'):
                loc, fname, why = _b_resolve(page, cond[8:], load_to)
                if loc is None:
                    return 'WAIT FAILED: %s' % _b_diagnose(page, cond[8:], why)
                return 'WAITED until %s was visible' % cond[8:]
            if low in ('dom', 'load', 'network'):
                page.wait_for_load_state(
                    {'dom': 'domcontentloaded', 'load': 'load',
                     'network': 'networkidle'}[low], timeout=load_to)
                return 'WAITED for %s | now %s' % (low, page.url[:200])
        except Exception as e:
            return 'WAIT FAILED after %dms: %s' % (load_to, str(e)[:120])
        if cond.isdigit():
            ms = min(int(cond), 5000)
            page.wait_for_timeout(ms)
            return ('WAITED %dms (a fixed sleep -- prefer value=dom|network|url:...|'
                    'visible:<selector>)' % ms)
        return ('browser: wait needs a condition -- value=dom, load, network, '
                'url:<part>, visible:<selector>, or a selector')
""",
        "wait takes a condition",
    ),
    # --- click: resolve first, name the blocker ----------------------------
    (
        """    if action == 'click':
        if not selector:
            return 'browser: click needs a selector'
        # Anti-bot gates are reported, never worked around.
        low = (page.content() or '')[:20000].lower()
        if 'captcha' in low or 'g-recaptcha' in low or 'hcaptcha' in low:
            return ('BLOCKED: this page presents a CAPTCHA. I will not attempt to '
                    'solve or bypass it. Tell the user this step needs them.')
        page.click(selector, timeout=to)
        page.wait_for_load_state('domcontentloaded', timeout=to)
        _b_save(session)
        return 'CLICKED %s | now %s' % (selector, page.url[:300])
""",
        """    if action == 'click':
        if not selector:
            return 'browser: click needs a selector'
        # Anti-bot gates are reported, never worked around.
        if _b_captcha(page):
            return ('BLOCKED: this page presents a CAPTCHA. I will not attempt to '
                    'solve or bypass it. Tell the user this step needs them.')
        loc, fname, why = _b_resolve(page, selector, to)
        if loc is None:
            return 'CLICK FAILED: %s' % _b_diagnose(page, selector, why)
        cov = _b_covering(page, loc)
        if cov:
            return ('BLOCKED by overlay: %s is covering %s. Dismiss it first -- '
                    'inspect the page to find its close or accept control.'
                    % (cov, selector))
        try:
            loc.first.click(timeout=to)
        except Exception as e:
            cov = _b_covering(page, loc)
            if cov:
                return 'BLOCKED by overlay: %s is covering %s' % (cov, selector)
            return 'CLICK FAILED on %s: %s' % (selector, str(e)[:140])
        try:
            page.wait_for_load_state('domcontentloaded', timeout=to)
        except Exception:
            pass
        _b_save(session)
        return 'CLICKED %s%s | now %s' % (
            selector, '' if fname == 'main' else ' in frame %s' % fname, page.url[:300])
""",
        "click resolves and names the blocker",
    ),
    # --- submit: same resolution, gate untouched ---------------------------
    (
        """        page.click(selector, timeout=to)
        page.wait_for_load_state('domcontentloaded', timeout=to)
        _b_save(session)
        # A completed sign-in ends the window: the consent was for this login,""",
        """        loc, fname, why = _b_resolve(page, selector, to)
        if loc is None:
            return 'SUBMIT FAILED: %s' % _b_diagnose(page, selector, why)
        cov = _b_covering(page, loc)
        if cov:
            return 'BLOCKED by overlay: %s is covering %s' % (cov, selector)
        try:
            loc.first.click(timeout=to)
        except Exception as e:
            return 'SUBMIT FAILED on %s: %s' % (selector, str(e)[:140])
        try:
            page.wait_for_load_state('domcontentloaded', timeout=to)
        except Exception:
            pass
        _b_save(session)
        # A completed sign-in ends the window: the consent was for this login,""",
        "submit resolves its target",
    ),
    # --- fill/type: resolve through frames, gate untouched -----------------
    (
        """        pending = value or text or ''
        try:
            if action == 'type':
                page.type(selector, pending, timeout=to)
            else:
                page.fill(selector, pending, timeout=to)
        finally:""",
        """        loc, fname, why = _b_resolve(page, selector, to)
        if loc is None:
            return '%s FAILED: %s' % (action.upper(), _b_diagnose(page, selector, why))
        cov = _b_covering(page, loc)
        if cov:
            return 'BLOCKED by overlay: %s is covering %s' % (cov, selector)
        pending = value or text or ''
        try:
            if action == 'type':
                loc.first.press_sequentially(pending, timeout=to)
            else:
                loc.first.fill(pending, timeout=to)
        finally:""",
        "fill/type resolve through frames",
    ),
    # --- select / upload: same --------------------------------------------
    (
        """        page.select_option(selector, value or text or '', timeout=to)
        return 'SELECTED %r in %s' % (value or text, selector)""",
        """        loc, fname, why = _b_resolve(page, selector, to)
        if loc is None:
            return 'SELECT FAILED: %s' % _b_diagnose(page, selector, why)
        loc.first.select_option(value or text or '', timeout=to)
        return 'SELECTED %r in %s' % (value or text, selector)""",
        "select resolves its target",
    ),
    (
        """        page.set_input_files(selector, path, timeout=to)
        return 'UPLOADED %s (%d bytes) into %s' % (path, os.path.getsize(path), selector)""",
        """        loc, fname, why = _b_resolve(page, selector, to)
        if loc is None:
            return 'UPLOAD FAILED: %s' % _b_diagnose(page, selector, why)
        loc.first.set_input_files(path, timeout=to)
        return 'UPLOADED %s (%d bytes) into %s' % (path, os.path.getsize(path), selector)""",
        "upload resolves its target",
    ),
    # --- back: the load budget, not the action budget ----------------------
    (
        """        page.go_back(timeout=to)""",
        """        page.go_back(timeout=load_to)""",
        "back uses the load budget",
    ),
]

CAPTCHA_HELPER = '''

def _b_captcha(page):
    """Is there an anti-bot gate on the page? Detected so it can be reported.

    Cheaper and more complete than the old `page.content()[:20000]` sniff,
    which serialized the whole document on every click and still missed
    anything past the first 20KB.
    """
    try:
        return bool(page.evaluate("""() => {
            const h = document.documentElement.innerHTML.slice(0, 200000).toLowerCase();
            return /captcha|g-recaptcha|hcaptcha|cf-turnstile|challenge-form/.test(h);
        }"""))
    except Exception:
        return False
'''

NEW_ACTIONS = '''
    if action == 'inspect':
        # The call to make before acting. One snapshot replaces a sequence of
        # blind probes, and it is what turns "timed out" into "covered by the
        # cookie banner". Settle first: a deterministic wait on the load state,
        # never a sleep.
        try:
            page.wait_for_load_state('domcontentloaded', timeout=load_to)
        except Exception:
            pass
        if selector:
            try:
                page.wait_for_selector(selector, timeout=to)
            except Exception:
                pass
        _b_save(session)
        return _b_inspect_text(page)

    if action == 'batch':
        # Several independent actions in one tool call. Deliberately sequential
        # and deliberately not for stateful chains: a click that navigates
        # invalidates everything after it, so those stay separate calls.
        try:
            steps = kw.get('steps') or json.loads(text or value or '[]')
        except Exception:
            return 'browser: batch needs steps as a JSON array'
        if not isinstance(steps, list) or not steps:
            return 'browser: batch needs a non-empty JSON array of steps'
        out = []
        for i, step in enumerate(steps[:8]):
            if not isinstance(step, dict):
                out.append('%d. skipped: not an object' % (i + 1))
                continue
            if str(step.get('action', '')).lower() in ('click', 'submit', 'navigate', 'back'):
                out.append('%d. refused: %s changes page state, call it on its own'
                           % (i + 1, step.get('action')))
                continue
            step = dict(step)
            step['session'] = session
            try:
                r = _b_do(**step)
            except Exception as e:
                r = 'error: %s' % str(e)[:110]
            out.append('%d. %s' % (i + 1, str(r)[:400]))
        return 'BATCH %d steps\\n' % len(out) + '\\n'.join(out)

'''


def transform(helper):
    """Apply every edit. Returns (new_source, {label: count})."""
    found = {}
    out = helper

    if "def _b_captcha(" not in out:
        anchor = "def _b_do("
        assert anchor in out, "cannot find _b_do to anchor the captcha helper"
        out = out.replace(anchor, CAPTCHA_HELPER.strip("\n") + "\n\n\n" + anchor, 1)
        found["captcha helper"] = 1

    if "_B_SNAPSHOT_JS" not in out:
        anchor = "def _b_do("
        out = out.replace(anchor, NEW_LAYER.strip("\n") + "\n\n\n" + anchor, 1)
        found["page-state layer"] = 1

    for old, new, label in REPLACEMENTS:
        n = out.count(old)
        if n:
            out = out.replace(old, new)
        found[label] = found.get(label, 0) + n

    if "if action == 'inspect':" not in out:
        anchor = "    if action == 'read':"
        assert anchor in out, "cannot find the read action to anchor inspect/batch"
        out = out.replace(anchor, NEW_ACTIONS.strip("\n") + "\n\n" + anchor, 1)
        found["inspect + batch actions"] = 1

    return out, found


def check(helper):
    """Verify the post-state. Counting the pre-state and calling it applied is
    inverted, so look for the new code being present and the old being gone."""
    _, found = transform(helper)
    rows = [
        ("page-state layer", "_B_SNAPSHOT_JS" in helper),
        ("captcha helper", "def _b_captcha(" in helper),
        ("inspect action", "if action == 'inspect':" in helper),
        ("batch action", "if action == 'batch':" in helper),
        ("_b_resolve used by click", "loc, fname, why = _b_resolve(page, selector, to)" in helper),
        ("overlay diagnosis", "_b_covering(page, loc)" in helper),
        ("frames searched", "def _b_frames(page):" in helper),
        ("wait takes a condition", "browser: wait needs a condition" in helper),
        ("separate budgets", "_B_ACTION_MS" in helper),
        ("old blind click gone", "page.click(selector, timeout=to)" not in helper),
        ("old blind fill gone", "page.fill(selector, pending, timeout=to)" not in helper),
        ("old fixed-sleep wait gone", "page.wait_for_timeout(min(int(value or 1000), 10000))" not in helper),
    ]
    bad = [n for n, ok in rows if not ok]
    for n, ok in rows:
        print("  %-28s %s" % (n, "yes" if ok else "NO"))
    print("browser-reliability-fix: " + ("NOT APPLIED" if bad else "OK, every change is present"))
    return 1 if bad else 0


def read_helper():
    nb = json.loads(ASSET.read_text(encoding="utf-8"))
    for cell in nb["cells"]:
        if cell.get("cell_type") != "code":
            continue
        s = cell["source"] if isinstance(cell["source"], str) else "".join(cell["source"])
        if "_B_HELPER_SRC" not in s:
            continue
        i = s.index("_B_HELPER_SRC")
        q = s.index("'", i)
        end = q + 1
        while end < len(s):
            if s[end] == "\\":
                end += 2
                continue
            if s[end] == "'":
                break
            end += 1
        return nb, cell, s, q, end + 1, ast.literal_eval(s[q:end + 1])
    raise SystemExit("browser helper not found in the notebook asset")


def ESCAPE(s):
    """Re-encode Python source for storage inside a single-quoted literal."""
    return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")


# The tool schema sits outside the helper literal, so it needs its own edits.
# An action missing from the enum is an action the model can never call, which
# would make the whole inspect-first layer dead weight.
TEMPLATE_EDITS = [
    (
        "'enum':['navigate','click','type','fill','submit','select','read',"
        "'screenshot','wait','back','upload','authorize','revoke',"
        "'new_context','close','list','cookies']",
        "'enum':['inspect','navigate','click','type','fill','submit','select',"
        "'read','screenshot','wait','back','upload','authorize','revoke',"
        "'new_context','close','list','cookies','batch']",
        "schema: inspect and batch are callable",
    ),
    (
        "Drive a real headless browser: open sites, navigate, click, type, fill "
        "forms, select options, upload files, read pages, screenshot, and keep "
        "signed-in sessions across calls.",
        "Drive a real headless browser: open sites, navigate, click, type, fill "
        "forms, select options, upload files, read pages, screenshot, and keep "
        "signed-in sessions across calls. ALWAYS call action=inspect once after "
        "navigating, and again whenever a selector misses: one call returns the "
        "url, title, frames, visible fields (with label, name, role and a "
        "selector that works), buttons, overlays and dialogs covering the page, "
        "and whether the page is still loading. Act on the selectors it "
        "returns -- ids are often generated and change per load, so prefer the "
        "label- or role-based ones. It also names what is blocking a control, "
        "so never retry the same failing selector: dismiss the overlay, wait "
        "for the frame, or tell the user what is in the way. Use action=batch "
        "with text=a JSON array of independent read-only steps to get several "
        "answers in one call.",
        "schema: description tells the model to inspect first",
    ),
    (
        "'timeout':{'type':'integer'},",
        "'timeout':{'type':'integer','description':'page load budget in "
        "seconds, default 30'},'action_timeout':{'type':'integer',"
        "'description':'per click/fill budget in seconds, default 8 -- keep it "
        "short and inspect instead of waiting'},'steps':{'type':'string',"
        "'description':'for action=batch: JSON array of read-only steps'},",
        "schema: action_timeout and steps exposed",
    ),
]


def main():
    args = sys.argv[1:]
    nb, cell, src, q, end, helper = read_helper()

    if "--check" in args:
        return check(helper)

    new, found = transform(helper)
    ast.parse(new)

    # The schema lives outside the helper literal. An action the enum does not
    # name is an action the model can never emit -- inspect/batch would be dead
    # code no matter how well they worked.
    tpl = src[:q] + "'" + ESCAPE(new) + "'" + src[end:]
    for old, rep, label in TEMPLATE_EDITS:
        n = tpl.count(old)
        found[label] = n
        tpl = tpl.replace(old, rep)

    if "--emit" in args:
        p = Path(args[args.index("--emit") + 1])
        p.write_text(new)
        print("emitted %s (%d bytes, was %d)" % (p, len(new), len(helper)))
        for k, v in found.items():
            print("  %-34s %d" % (k, v))
        return 0

    missing = [k for k, v in found.items() if v == 0]
    if missing:
        print("REFUSING to write an incomplete patch: " + ", ".join(missing))
        return 1

    lit = ESCAPE(new)
    cell["source"] = tpl
    for c in nb["cells"]:
        s = c["source"] if isinstance(c["source"], str) else "".join(c["source"])
        if c.get("cell_type") == "code" and s.strip():
            ast.parse(s)
    ASSET.write_text(json.dumps(nb, separators=(",", ":"), ensure_ascii=True),
                     encoding="utf-8")
    print("browser-reliability-fix: applied (%d -> %d bytes)" % (len(helper), len(new)))
    for k, v in found.items():
        print("  %-34s %d" % (k, v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
