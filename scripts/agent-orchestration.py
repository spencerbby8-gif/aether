#!/usr/bin/env python3
# Aether agent orchestration layer.
#
# Written as its own module and exec'd into the kernel namespace at boot, for
# the same reason the browser helper is a separate file: it has to be testable
# outside a Kaggle kernel. Everything here is deterministic and has no network
# or model dependency, so the routing, budgeting, normalization and
# verification can be proven before a model ever sees them.
#
# What this layer is responsible for:
#   route()      ordinary language -> capabilities, evidence, ordered steps
#   Plan         goal -> evidence -> tools -> dependencies -> order -> verify
#   normalize()  tool output -> a concise brief for the model, raw kept for UI
#   verify()     did the requested outcome actually happen
#   Budget       stop spending calls on work that cannot help
import os
import re
import json
import time
import html as htmlmod

# --------------------------------------------------------------------------
# Capabilities. The kernel exposes seven tools; four of the intents below all
# land on run_command, but they are kept distinct because they verify
# differently -- "install pandas" is proven by importing pandas, "write a
# file" by the file existing.
# --------------------------------------------------------------------------
CHAT = 'chat'
SEARCH = 'web_search'
FETCH = 'fetch_page'
CRAWL = 'crawl_site'
BROWSER = 'browser'
FILESYSTEM = 'filesystem'
TERMINAL = 'terminal'
PACKAGE = 'package_manager'
ARCHIVE = 'archive'
CODE = 'code_execution'
IMAGE = 'image'
AUDIO = 'audio'

# Which tool actually runs an intent.
INTENT_TOOL = {
    SEARCH: 'web_search', FETCH: 'fetch_page', CRAWL: 'crawl_site',
    BROWSER: 'browser', FILESYSTEM: 'run_command', TERMINAL: 'run_command',
    PACKAGE: 'run_command', ARCHIVE: 'run_command', CODE: 'run_command',
    IMAGE: 'generate_image', AUDIO: 'generate_voice', CHAT: None,
}

# Intents that gather facts. They share nothing with each other, so a task
# that needs three of them pays for them once, in parallel.
RESEARCH = (SEARCH, FETCH, CRAWL)

# Stages. Lower runs first. Within a stage, steps are independent unless an
# explicit dependency says otherwise -- see _link().
STAGE = {
    SEARCH: 0, FETCH: 0, CRAWL: 0,
    BROWSER: 1,
    PACKAGE: 2, FILESYSTEM: 2, TERMINAL: 2, CODE: 2,
    # An archive is a deliverable: it has to come last, after the files it
    # collects exist.
    ARCHIVE: 3,
    IMAGE: 3, AUDIO: 3,
    CHAT: 4,
}

RE = lambda p: re.compile(p, re.I)

URL_RE = RE(r'https?://[^\s)\]>"\']+|www\.[^\s)\]>"\']+')

# A hostname with no scheme is still a URL. Without this, "sign up on
# news.ycombinator.com" was read as prose and the substring "news" routed the
# task to web_search instead of to the browser.
BARE_HOST_RE = RE(
    r'\b[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?'
    r'(?:\.[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?)*'
    r'\.(?:com|org|net|io|dev|ai|co|uk|ng|edu|gov|info|me|app|sh|xyz|tech|site'
    r'|online|blog|news|wiki|test|local|cloud|run|gg|tv|de|fr|jp|in|za)\b'
    r'(?::\d{2,5})?(?:/[^\s)\]>"\']*)?')

# A verb immediately before the URL means the user wants that specific page
# read, which is a different operation from crawling the site it is on.
FETCH_VERB_RE = RE(r'\b(fetch|retrieve|grab|open|read|get|load)\s*$')

# Each rule is (intent, pattern). Patterns are deliberately narrow: a router
# that fires on vague words sends the agent off to search when the user only
# wanted a conversation, and that costs a tool call and several seconds.
RULES = [
    (IMAGE, RE(r'\b(generate|draw|create|make|design|produce|render)\b[^.?!\n]{0,40}\b(image|picture|photo|illustration|artwork|art|logo|poster|banner|wallpaper|thumbnail|icon|avatar|diagram)\b')),
    (IMAGE, RE(r'\b(image|picture|illustration|logo|poster)\s+of\b')),
    (AUDIO, RE(r'\b(read|say|speak|narrate|voic[e]\b|tell)[^.?!\n]{0,30}\b(out loud|aloud)\b')),
    (AUDIO, RE(r'\b(text[- ]to[- ]speech|\btts\b|voice ?over|voiceover|audio (version|clip|file)|convert[^.?!\n]{0,20}(to )?(speech|audio)|read this (text )?out)\b')),
    (BROWSER, RE(r'\b(log ?in|log ?into|sign ?in|sign ?up|register an account|create an account|fill (out )?(the |this )?form|complete the form|checkout|check out|add to cart|place (an )?order|subscribe to|click (the |on )?\w+ button|submit the form)\b')),
    (BROWSER, RE(r'\b(interact with|drive the browser|automate the (site|page|website)|scrape[^.?!\n]{0,30}behind (a )?login|book (a |the )?(flight|hotel|ticket|table))\b')),
    (CRAWL, RE(r'\b(crawl|spider|explore (the |this |that )?(site|website)|every page|all (the )?pages|whole site|sitemap|map (out )?the site)\b')),
    (PACKAGE, RE(r'\b(install|uninstall|upgrade|update)\b[^.?!\n]{0,30}\b(package|library|module|dependency|dependencies|pip|npm|apt|cargo|gem)\b')),
    (PACKAGE, RE(r'\b(pip3?|npm|yarn|pnpm|apt(-get)?|brew|cargo)\s+(install|add|i)\b')),
    # "install the latest version of docker" puts an article in the way, so the
    # bare-name rule below rejects it. An artifact noun is the signal instead.
    (PACKAGE, RE(r'\b(install|uninstall|upgrade)\b[^.?!\n]{0,30}\b(version|package|library|module|dependency|dependencies|tool|toolchain|app|software|server|driver|binary|runtime)\b')),
    # "install pandas" names no package manager, but it is still an install.
    # The negative lookahead keeps "install the update" from matching: an
    # article means the object is a thing in the world, not a package name.
    (PACKAGE, RE(r'\b(install|uninstall|upgrade)\s+(?!the\b|a\b|an\b|this\b|that\b|it\b|them\b)[A-Za-z0-9][\w.\-+]*')),
    # "Package the workspace into build.zip" asks for a file the user can
    # download, which is a different job from `pip install`. Without its own
    # intent this routed to PACKAGE and was verified by asking whether a Python
    # module had become importable -- which passed, while the archive sat where
    # nobody could fetch it.
    (ARCHIVE, RE(r'\b(package|bundle|archive|zip (up )?|compress|tar (up )?)\b[^.?!\n]{0,40}\.(zip|tar|tgz|gz)\b')),
    (ARCHIVE, RE(r'\b(into|as|to)\s+[A-Za-z0-9_.-]+\.(zip|tar|tgz|gz)\b')),
    (CODE, RE(r'\b(write|create|generate)\b[^.?!\n]{0,30}\b(script|program|function|class|code|python file|\.py|\.js|\.ts|test)\b')),
    (CODE, RE(r'\b(run|execute|eval(uate)?)\b[^.?!\n]{0,30}\b(this |the |my )?(script|code|program|python|computation)\b')),
    (CODE, RE(r'\b(compute|calculate|work out|sort|parse|convert|count|analyse|analyze|process|transform|deduplicate|refactor|debug|build|compile|run the tests?)\b')),
    (FILESYSTEM, RE(r'\b(create|write|save|make)\b[^.?!\n]{0,20}\b(file|files|folder|directory|csv file|json file|markdown file|\.txt|\.md|\.csv|\.json)\b')),
    (FILESYSTEM, RE(r'\b(read|open|list|show|cat|delete|remove|move|rename|copy)\b[^.?!\n]{0,30}\b(file|files|folder|directory|contents|listing)\b')),
    (TERMINAL, RE(r'\b(run|execute)\b[^.?!\n]{0,25}\b(command|shell|bash|terminal)\b')),
    (TERMINAL, RE(r'\b(disk space|how much space|what is running|processes|uptime|environment variables|which python|free memory)\b')),
    # Factual-world questions. These are last so that "make an image of the
    # latest AI news" routes to image, with search picked up separately.
    # A temporal word on its own is not a request for the web. "Hello, how are
    # you today?" routed to web_search on exactly that word, which costs a tool
    # call and several seconds to answer a greeting. The word has to be
    # attached to something only the world can answer.
    # `version` is deliberately absent from this noun list: "install the
    # latest version of docker" is a package job, and matching on it sent the
    # agent to the web instead. `release` covers the case that is a question.
    (SEARCH, RE(r'\b(latest|current(ly)?|today|tonight|right now|as of|this (week|month|year)|recent|breaking|upcoming|up ?to ?date)\b[^.?!\n]{0,40}\b(news|price|prices|cost|quote|score|scores|weather|forecast|release|released|update|updates|announcement|result|results|standings|report|article|story|figures?|numbers?|data|stats?|statistics|exchange rate|population|status|schedule|line ?-?up|odds|poll)\b')),
    (SEARCH, RE(r'\b(the latest (on|about)|what.s the latest)\b')),
    # Bare `version` is not here either: "install the latest version of docker"
    # is a package job. A version question still routes through the temporal
    # rule or through `release`/`changelog`.
    (SEARCH, RE(r'\b(news|price|prices|cost|quote|score|scores|results|standings|release date|released|weather|forecast|population|gdp|exchange rate|changelog|who won|who is the (ceo|president|winner))\b')),
    (SEARCH, RE(r'\b(when did|where is|how many|what year|which (country|company|team)|who (invented|founded|wrote|directed|discovered))\b')),
    # "how much" needs a money word. On its own it caught "how much free disk
    # space do I have?", which is a shell question, not a web one.
    (SEARCH, RE(r'\bhow much\b[^.?!\n]{0,40}\b(cost|costs|costing|price|prices|money|cash|usd|dollars?|euros?|pounds?|naira|gbp|btc|bitcoin|per (unit|month|year|hour))\b')),
    (SEARCH, RE(r'\b(look up|search (for|the web)|google|find out|research|what does \w+ mean|define)\b')),
]

# A pronoun or back-reference means the later step consumes the earlier
# result. Without it, "find X and make an image of it" would run the image
# generation before the search had returned anything.
DEPENDS_HINTS = RE(r'\b(of it|of that|of them|of those|from (it|that|the (results?|data|article|page))|the (result|results|data|info|information|answer)|that (information|data|info)|based on (it|that|the)|using (it|that|those|the (results?|data))|those (results?|facts?|numbers?)|it into|them into|summariz\w+ (it|that|them))\b')


def _intents(text):
    """Ordered, de-duplicated intents the words actually ask for."""
    found = []
    for intent, rx in RULES:
        if rx.search(text) and intent not in found:
            found.append(intent)
    return found


def urls_in(text):
    """URLs mentioned in the request, de-duplicated, order preserved."""
    text = text or ''
    out = []
    covered = []
    for m in URL_RE.finditer(text):
        u = m.group(0).rstrip('.,;:!?')
        covered.append((m.start(), m.end()))
        if u not in out:
            out.append(u)
    for m in BARE_HOST_RE.finditer(text):
        if any(s <= m.start() < e for s, e in covered):
            continue          # already captured as part of a full URL
        u = m.group(0).rstrip('.,;:!?')
        if u not in out:
            out.append(u)
    return out


def _wants_fetch(text, url):
    """True when a fetch/read verb sits immediately before this URL."""
    i = text.find(url)
    if i < 0:
        return False
    return bool(FETCH_VERB_RE.search(text[:i]))


def route(text):
    """Ordinary language -> capabilities, the evidence they need, and steps.

    Returns a plain dict so it can be sent to the client as a plan event and
    stored in a checkpoint without any class surviving the round trip.
    """
    text = text or ''
    urls = urls_in(text)
    # Rules match against the text with URLs removed. Otherwise the words
    # inside a domain name get read as intent: "sign up on
    # news.ycombinator.com" routed to web_search because of the substring
    # "news", which sends the agent off to search instead of to the browser.
    prose = text
    for u in urls:
        prose = prose.replace(u, ' ')

    intents = _intents(prose)

    # A URL is evidence of something to read, but only if nothing already
    # claimed it. It never removes an intent the words asked for: "search for
    # python news and fetch https://x" wants both.
    if urls and FETCH not in intents and BROWSER not in intents:
        # An explicit "fetch <url>" is its own operation even when the same
        # request also crawls a different site; a bare URL alongside a crawl
        # is not.
        if any(_wants_fetch(text, u) for u in urls) or CRAWL not in intents:
            intents.append(FETCH)

    if not intents:
        intents = [CHAT]

    chained = bool(DEPENDS_HINTS.search(text))

    steps = [{'id': 's%d' % (i + 1), 'intent': intent,
              'tool': INTENT_TOOL.get(intent), 'stage': STAGE.get(intent, 4),
              'deps': [], 'status': 'planned'}
             for i, intent in enumerate(intents)]

    # Dependencies are linked in a second pass. Doing it while building meant
    # a step only saw the steps before it, so "make an image of it" -- which
    # routes image-first because the image rule is listed first -- got no
    # dependency and would have run before the search returned anything.
    if chained:
        research = [s['id'] for s in steps if s['intent'] in RESEARCH]
        for s in steps:
            if s['stage'] > 0 and research:
                s['deps'] = [r for r in research if r != s['id']]

    evidence = []
    for s in steps:
        evidence.extend(EVIDENCE[s['intent']])

    return {
        'goal': text.strip()[:400],
        'capabilities': [s['intent'] for s in steps],
        'tools': sorted({s['tool'] for s in steps if s['tool']}),
        'evidence': sorted(set(evidence)),
        'steps': steps,
        'chained': chained,
        'urls': urls,
    }


# What has to be true, per intent. Written as claims a verifier can actually
# test rather than aspirations.
EVIDENCE = {
    SEARCH: ['at least one result with a source URL'],
    FETCH: ['page text retrieved, not empty and not an error'],
    CRAWL: ['more than one page of text retrieved'],
    BROWSER: ['final page state matches the requested outcome'],
    FILESYSTEM: ['the named path exists on disk'],
    TERMINAL: ['command exited 0'],
    PACKAGE: ['the package is importable or on PATH afterwards'],
    ARCHIVE: ['an archive file exists where it can be downloaded'],
    CODE: ['code ran and exited 0, artifact present if one was asked for'],
    IMAGE: ['an image file exists with a JPEG or PNG header'],
    AUDIO: ['an audio file exists with a RIFF header'],
    CHAT: ['a non-empty answer'],
}


# --------------------------------------------------------------------------
# Plan
# --------------------------------------------------------------------------
class Step(object):
    __slots__ = ('id', 'intent', 'tool', 'stage', 'deps', 'status', 'result',
                 'brief', 'artifacts', 'started', 'ended', 'error', 'tries')

    def __init__(self, d):
        self.id = d.get('id')
        self.intent = d.get('intent')
        self.tool = d.get('tool')
        self.stage = int(d.get('stage') or 0)
        self.deps = list(d.get('deps') or [])
        self.status = d.get('status') or 'planned'
        self.result = d.get('result')
        self.brief = d.get('brief')
        self.artifacts = list(d.get('artifacts') or [])
        self.started = d.get('started')
        self.ended = d.get('ended')
        self.error = d.get('error')
        self.tries = int(d.get('tries') or 0)

    @property
    def seconds(self):
        if self.started and self.ended:
            return round(self.ended - self.started, 3)
        return None

    def to_dict(self):
        return {k: getattr(self, k) for k in Step.__slots__}

    def describe(self):
        t = ('%.1fs' % self.seconds) if self.seconds is not None else '-'
        return '%s %s/%s %s (%s)' % (self.id, self.intent, self.tool or 'none',
                                     self.status, t)


class Plan(object):
    """goal -> evidence -> tools -> dependencies -> order -> verify -> result.

    Serializable on purpose. Engine failover means another process continues
    this task, and the only way it can is if the plan, what finished, what came
    back, and what to do next all survive the trip as data.
    """

    def __init__(self, spec):
        self.goal = spec.get('goal') or ''
        self.evidence = list(spec.get('evidence') or [])
        self.steps = [Step(s) for s in (spec.get('steps') or [])]
        self.chained = bool(spec.get('chained'))
        self.urls = list(spec.get('urls') or [])
        self.created = spec.get('created') or time.time()
        self.finished = spec.get('finished')
        self.outcome = spec.get('outcome')
        self.notes = list(spec.get('notes') or [])

    # -- ordering --------------------------------------------------------
    def waves(self):
        """Independent steps grouped into waves that can run concurrently.

        A step joins a wave once every step it depends on is in an earlier
        one. Steps with no dependencies and no shared stage land in the same
        wave, which is what makes parallelism happen for real rather than for
        calls the model happened to emit together.
        """
        placed = {}
        remaining = list(self.steps)
        waves = []
        guard = 0
        while remaining and guard < 100:
            guard += 1
            ready = [s for s in remaining
                     if all(d in placed for d in s.deps)]
            if not ready:
                # A dependency that will never be satisfied. Reporting the
                # cycle beats looping: the alternative is a silent stall.
                names = ', '.join(s.id for s in remaining)
                self.notes.append('dependency cycle or missing step: ' + names)
                ready = [min(remaining, key=lambda s: s.stage)]
            ready.sort(key=lambda s: (s.stage, s.id))
            for s in ready:
                placed[s.id] = len(waves)
            waves.append(ready)
            remaining = [s for s in remaining if s not in ready]
        return waves

    def parallelism(self):
        w = self.waves()
        return {
            'waves': len(w),
            'steps': len(self.steps),
            'widest': max([len(x) for x in w] or [0]),
            'serial_cost': len(self.steps),
        }

    # -- recording -------------------------------------------------------
    def find(self, step_id):
        for s in self.steps:
            if s.id == step_id:
                return s
        return None

    def record(self, step_id, brief=None, result=None, artifacts=None,
               error=None, status='done'):
        s = self.find(step_id)
        if s is None:
            return None
        if s.started is None:
            s.started = time.time()
        s.ended = time.time()
        s.tries += 1
        s.status = status
        s.brief = brief
        s.result = result
        s.error = error
        if artifacts:
            s.artifacts.extend(a for a in artifacts if a not in s.artifacts)
        return s

    def adopt(self, tool, brief=None, raw=None, ok=True):
        """Record a tool call the model made against the first open step that
        expected that tool.

        The model does not name plan steps, so the plan has to claim results as
        they arrive. A tool the plan did not anticipate is still recorded --
        the plan is a forecast, not a cage -- and an unanticipated call is
        exactly the case worth noticing later.
        """
        step = None
        for s in self.steps:
            if s.tool == tool and s.status in ('planned', 'retry', 'failed'):
                step = s
                break
        if step is None:
            for s in self.steps:
                if s.tool == tool and s.status not in ('done', 'verified'):
                    step = s
                    break
        if step is None:
            self.notes.append('unplanned call: ' + str(tool))
            return None
        return self.record(step.id, brief=brief, result=raw,
                           status='done' if ok else 'failed')

    def pending(self):
        return [s for s in self.steps
                if s.status in ('planned', 'failed', 'retry')]

    def next_action(self):
        """The next wave worth running, or None when nothing is left."""
        done = {s.id for s in self.steps if s.status in ('done', 'verified')}
        ready = [s for s in self.pending() if all(d in done for d in s.deps)]
        if not ready:
            return None
        ready.sort(key=lambda s: (s.stage, s.id))
        top = ready[0].stage
        return [s for s in ready if s.stage == top]

    # -- verification ----------------------------------------------------
    def verify(self, results_by_id=None):
        """Check the requested outcome, not whether the tools returned.

        Returns (ok, list_of_unmet). Every claim in `evidence` has to be
        matched by a check that passed. A task that produced no image is not
        done just because generate_image replied.
        """
        results_by_id = results_by_id or {}
        unmet = []
        for s in self.steps:
            raw = results_by_id.get(s.id, s.result or '')
            ok, why = verify_intent(s.intent, raw, s.artifacts)
            s.status = 'verified' if ok else ('failed' if s.tries else 'planned')
            if not ok:
                unmet.append('%s: %s' % (s.intent, why))
        self.finished = time.time()
        self.outcome = 'verified' if not unmet else 'incomplete'
        return (not unmet), unmet

    # -- failover --------------------------------------------------------
    def to_dict(self):
        return {
            'goal': self.goal,
            'capabilities': [s.intent for s in self.steps],
            'tools': sorted({s.tool for s in self.steps if s.tool}),
            'evidence': self.evidence,
            'steps': [s.to_dict() for s in self.steps],
            'waves': len(self.waves()),
            'chained': self.chained, 'urls': self.urls,
            'created': self.created, 'finished': self.finished,
            'outcome': self.outcome, 'notes': self.notes,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(d or {})

    def checkpoint(self):
        """Compact enough to survive a beacon message or a kernel restart."""
        return json.dumps(self.to_dict(), sort_keys=True, default=str)

    @classmethod
    def resume(cls, blob):
        return cls.from_dict(json.loads(blob) if isinstance(blob, str) else blob)

    def summary(self):
        p = self.parallelism()
        done = sum(1 for s in self.steps if s.status in ('done', 'verified'))
        return ('goal=%r steps=%d done=%d waves=%d widest=%d outcome=%s'
                % (self.goal[:60], len(self.steps), done,
                   p['waves'], p['widest'], self.outcome or 'running'))


# --------------------------------------------------------------------------
# Verification. Each check looks for the artifact or fact the user asked for.
# --------------------------------------------------------------------------
def _exists(path):
    try:
        return os.path.exists(path) and os.path.getsize(path) > 0
    except Exception:
        return False


def _header(path, prefixes):
    try:
        with open(path, 'rb') as f:
            head = f.read(4)
        return any(head.startswith(p) for p in prefixes)
    except Exception:
        return False


IMAGE_MAGIC = (b'\xff\xd8', b'\x89P')
AUDIO_MAGIC = (b'RIFF',)

# Where generated media lands. The kernel sets this to its GEN_DIR at boot.
# Without it the verifier cannot find an artifact the tool reported by bare
# filename, and a task that really did produce an image reads as a failure.
MEDIA_DIR = None

# Where files the user can download are served from. The kernel sets this to its
# GEN_DIR at boot. An archive built anywhere else is real but unreachable, and
# "packaged successfully" would be a claim nothing checked.
SERVED_DIR = None


def _media_paths(result, artifacts):
    """Every path a media artifact could be at, absolute or resolved."""
    cands = list(artifacts or [])
    cands.extend(_paths_in(result))
    for m in re.finditer(r'([A-Za-z0-9_.\-]+\.(?:jpg|jpeg|png|wav|mp3|ogg))',
                         result or '', re.I):
        name = m.group(1)
        if MEDIA_DIR:
            cands.append(os.path.join(MEDIA_DIR, name))
        cands.append(name)
    return cands


def _paths_in(text):
    out = []
    for m in re.finditer(r'(/[^\s\'"()\[\]]+\.\w{1,6})', text or ''):
        out.append(m.group(1))
    return out


def verify_intent(intent, result, artifacts=None):
    """(ok, why). Deliberately conservative: when it cannot tell, it says so
    rather than passing a task that may not have happened."""
    r = result or ''
    artifacts = artifacts or []
    low = r.lower()

    if intent == IMAGE:
        for p in _media_paths(r, artifacts):
            if _header(p, IMAGE_MAGIC):
                return True, ''
        # A URL handed back is only trusted when the bytes were checked too;
        # "IMAGE READY" on its own is what a task claims, not what happened.
        return False, 'no image file with a valid JPEG/PNG header was produced'

    if intent == AUDIO:
        for p in _media_paths(r, artifacts):
            if _header(p, AUDIO_MAGIC):
                return True, ''
        return False, 'no audio file with a RIFF header was produced'

    if intent == SEARCH:
        srcs = re.findall(r'https?://[^\s)]+', r)
        if r.strip() in ('', 'no results'):
            return False, 'the search returned nothing'
        if len(srcs) < 1:
            return False, 'results came back with no source URL to cite'
        return True, ''

    if intent == FETCH:
        if not r.strip() or low.startswith('fetch failed'):
            return False, 'the page could not be retrieved'
        if len(r.strip()) < 40:
            return False, 'the page came back essentially empty'
        return True, ''

    if intent == CRAWL:
        if r.strip() == 'crawl empty' or not r.strip():
            return False, 'the crawl produced no page text'
        return True, ''

    if intent == BROWSER:
        if low.startswith('blocked') or low.startswith('needs approval'):
            return False, r.strip().split('\n')[0][:160]
        if 'failed' in low and 'url=' not in low:
            return False, 'the browser action failed: %s' % r.strip()[:160]
        if not r.strip():
            return False, 'the browser returned nothing'
        return True, ''

    if intent == ARCHIVE:
        # A task that asked for a file the user can download. "Created
        # build.zip" in the answer is a claim; the archive has to exist where
        # the tunnel can serve it. Measured failure: the model ran
        # `zip -r build.zip build` through run_command, the file landed in the
        # session workspace rather than the served directory, and the turn
        # verified ok while /files/build.zip returned 404. The user was told the
        # work was packaged and could not get it.
        # Believe the directory, not the prose. A name in the result is enough
        # when it is there; otherwise fall back to what is actually served.
        name = _archive_name(r)
        if name and _served(name):
            return True, ''
        if _any_served_archive():
            return True, ''
        if name:
            return False, ('%s is not published where it can be downloaded. Use '
                           'the package_files tool rather than a shell command, '
                           'so the archive is served.' % name)
        return False, ('no archive was produced. Use the package_files tool to '
                       'create one the user can download.')

    if intent in (TERMINAL, CODE, FILESYSTEM, PACKAGE):
        m = re.search(r'exit=(-?\d+)', r)
        if m and m.group(1) != '0':
            return False, 'the command exited %s' % m.group(1)
        if low.startswith('blocked for safety'):
            return False, 'the command was refused by the safety blocklist'
        if low.startswith('timed out'):
            return False, 'the command timed out'
        if intent == PACKAGE:
            pkg = _package_name(r)
            if pkg and not _importable(pkg):
                return False, '%s is still not importable' % pkg
            return True, ''
        if intent == FILESYSTEM:
            named = [p for p in _paths_in(r) if os.path.isabs(p)]
            if named and not any(_exists(p) for p in named):
                return False, 'none of the named paths exist: %s' % ', '.join(named[:3])
        if not m and not r.strip():
            return False, 'the command produced no output and no exit code'
        return True, ''

    if intent == CHAT:
        return (bool(r.strip())), ('the answer is empty' if not r.strip() else '')

    return True, ''


_IMPORT_NAME = {
    'pillow': 'PIL', 'beautifulsoup4': 'bs4', 'scikit-learn': 'sklearn',
    'opencv-python': 'cv2', 'pyyaml': 'yaml', 'python-dateutil': 'dateutil',
}


_ARCHIVE_RE = re.compile(r'([A-Za-z0-9_.-]+\.(?:zip|tar|tgz|gz))')


def _archive_name(result):
    """The archive filename a result claims to have produced."""
    m = _ARCHIVE_RE.search(result or '')
    return m.group(1) if m else None


def _any_served_archive():
    """The newest archive actually present in the served directory, or None.

    The verifier's first attempt at this only read the filename out of the tool
    result, which failed on the tool's OWN success message: package_files
    reports "ARCHIVE READY: 2 file(s), 233 bytes, sha256:..., 2 entries: ..."
    and never repeats the archive's name. So a task that had genuinely produced
    a downloadable archive was told it had not, and the model was sent off to
    redo work that was already done. Checking the directory is the honest test
    anyway: the question is whether the file is there, not whether the text
    mentioned it.
    """
    try:
        if not SERVED_DIR or not os.path.isdir(SERVED_DIR):
            return None
        cands = []
        for f in os.listdir(SERVED_DIR):
            if f.lower().endswith(('.zip', '.tar', '.tgz', '.gz')):
                try:
                    cands.append((os.path.getmtime(os.path.join(SERVED_DIR, f)), f))
                except Exception:
                    pass
        return max(cands)[1] if cands else None
    except Exception:
        return None


def _served(name):
    """True when the named file sits in the directory the tunnel serves."""
    try:
        return bool(SERVED_DIR) and os.path.exists(
            os.path.join(SERVED_DIR, os.path.basename(name)))
    except Exception:
        return False


def _package_name(result):
    m = re.search(r'(?:Successfully installed|Installing collected packages:)\s+([^\n]+)', result or '')
    if not m:
        return None
    toks = re.findall(r'([A-Za-z0-9_.\-]+)', m.group(1))
    return toks[0] if toks else None


def _importable(pkg):
    """Cheap and local: does the name resolve? No install, no network."""
    import importlib.util
    mod = _IMPORT_NAME.get(pkg.lower(), pkg).replace('-', '_')
    try:
        return importlib.util.find_spec(mod) is not None
    except Exception:
        return False


# --------------------------------------------------------------------------
# Normalization. The model gets a brief; the UI keeps the raw output.
# --------------------------------------------------------------------------
ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
MODEL_BRIEF_MAX = 900
UI_RAW_MAX = 8000


def _clean(s):
    s = ANSI.sub('', s or '')
    return re.sub(r'[ \t]{2,}', ' ', s)


def _head_tail(s, budget):
    """Keep both ends. Truncating only the tail is how a traceback at the end
    of a build log gets cut away, leaving the model a clean-looking success."""
    s = s.strip()
    if len(s) <= budget:
        return s
    keep = budget - 60
    head = s[:int(keep * 0.62)]
    tail = s[-int(keep * 0.38):]
    return head + '\n...[%d chars cut]...\n' % (len(s) - len(head) - len(tail)) + tail


def normalize(tool, result, args=None):
    """-> {'brief','raw','ok','kind','facts'}.

    `brief` is what goes back into the prompt. `raw` is what the UI can show
    when the user wants the detail. Sending the raw text to the model is what
    fills the context window with progress bars and pip chatter.
    """
    raw = _clean(result if isinstance(result, str) else str(result))
    brief, facts, kind = raw, [], 'text'

    if tool == 'run_command':
        kind = 'command'
        m = re.search(r'exit=(-?\d+)', raw)
        code = int(m.group(1)) if m else None
        body = raw.split('\n', 1)[1] if m and raw.startswith('exit=') else raw
        facts = ['exit=%s' % code] if code is not None else []
        # Warning banners and progress spam are the bulk of most output and
        # carry almost none of the signal.
        body = re.sub(r'^\s*(WARNING|DEPRECATION|notice:)[^\n]*\n?', '',
                      body, flags=re.I | re.M)
        body = re.sub(r'\r[^\n]*', '', body)
        brief = 'exit=%s\n%s' % (code, _head_tail(body, MODEL_BRIEF_MAX)) if code is not None \
            else _head_tail(body, MODEL_BRIEF_MAX)

    elif tool == 'web_search':
        kind = 'search'
        items = re.findall(r'^\*\s*(.+?)(?:\s*::\s*(\S+))?(?:\n\s+(.*))?$',
                           raw, re.M)
        facts = []
        lines = []
        for i, (title, u, snip) in enumerate(items[:6], 1):
            title = (title or '').strip()[:110]
            u = (u or '').strip()
            lines.append('%d. %s%s' % (i, title, ' -- ' + u if u else ''))
            if u:
                facts.append(u)
        brief = '\n'.join(lines) if lines else _head_tail(raw, 300)
        if len(items) > 6:
            brief += '\n(+%d more results)' % (len(items) - 6)

    elif tool in ('fetch_page', 'crawl_site'):
        kind = 'page'
        first = raw.split('\n', 1)
        head = first[0][:160]
        body = first[1] if len(first) > 1 else ''
        brief = head + '\n' + _head_tail(body, MODEL_BRIEF_MAX)
        facts = [w for w in re.findall(r'https?://\S+', raw)][:6]

    elif tool == 'browser':
        kind = 'browser'
        brief = _head_tail(raw, MODEL_BRIEF_MAX)
        if raw.startswith('BLOCKED') or raw.startswith('NEEDS APPROVAL'):
            kind = 'browser-blocked'
        m = re.search(r'now (https?://\S+)', raw)
        if m:
            facts.append(m.group(1))

    elif tool in ('generate_image', 'generate_voice'):
        kind = 'media'
        brief = _head_tail(raw, 400)
        facts = re.findall(r'https?://\S+', raw)[:2]

    else:
        brief = _head_tail(raw, MODEL_BRIEF_MAX)

    ok = not bool(re.match(
        r'(?i)^(tool error|error:|.*FAILED:|no results|fetch failed|crawl empty'
        r'|BLOCKED|NEEDS APPROVAL|TIMED OUT|image generation failed'
        r'|audio generation failed|TTS failed|.*timed out)', brief.strip()))
    # A command that exited non-zero is a failure however clean its output
    # looks. Relying on the text alone let "exit=3" read as a success.
    if kind == 'command':
        m = re.search(r'exit=(-?\d+)', brief)
        if m and m.group(1) != '0':
            ok = False

    return {
        'brief': brief[:UI_RAW_MAX],
        'raw': raw[:UI_RAW_MAX],
        'ok': ok,
        'kind': kind,
        'facts': facts,
        'chars_saved': max(0, len(raw) - len(brief)),
    }


# --------------------------------------------------------------------------
# Budget. Not a flat iteration count: a call that cannot change the outcome
# should not be spent, and a task that is already verified should stop.
# --------------------------------------------------------------------------
class Budget(object):
    """Spends calls, and refuses to spend them on work already done.

    Exact repeats were already caught by the kernel. What was not caught is the
    near repeat: the same page fetched with a trailing slash, the same file
    read twice, the same selector inspected again after nothing changed. Those
    are the calls that eat a task alive.
    """

    def __init__(self, max_calls=24, max_fails=2):
        self.max_calls = max_calls
        self.max_fails = max_fails
        self.calls = 0
        self.replayed = 0
        self.refused = 0
        self._seen = {}
        self._fails = {}

    @staticmethod
    def _key(tool, args):
        a = dict(args or {})
        # Normalized so cosmetic differences do not defeat the match.
        for k in ('url', 'query', 'selector', 'command', 'path', 'prompt', 'text'):
            if k in a and isinstance(a[k], str):
                v = a[k].strip().rstrip('/')
                v = re.sub(r'\s+', ' ', v)
                if k == 'selector':
                    v = v.lower()
                if k == 'query':
                    v = ' '.join(sorted(v.lower().split()))
                a[k] = v
        return tool + '|' + json.dumps(a, sort_keys=True, default=str)

    def duplicate_of(self, tool, args):
        """A previous SUCCESSFUL call this one would merely repeat, or None.

        Failures are deliberately not replayed. Handing back a cached error
        looks like progress to the loop above it, and what it actually does is
        turn one failed action into an infinite free retry -- measured as five
        "replays" of an image generation that had already failed.
        """
        return self._seen.get(self._key(tool, args))

    def note(self, tool, args, result_brief, ok):
        self.calls += 1
        if ok:
            self._seen[self._key(tool, args)] = result_brief
        else:
            # Drop any earlier success under the same key: the state has moved
            # on, and the stale answer is worse than none.
            self._seen.pop(self._key(tool, args), None)
            k = self._key(tool, args)
            self._fails[k] = self._fails.get(k, 0) + 1

    def replay(self):
        self.replayed += 1

    def give_up_on(self, tool, args):
        """True when the same action has failed enough that another attempt is
        a waste of the user's time -- the agent should re-plan or explain."""
        return self._fails.get(self._key(tool, args), 0) >= self.max_fails

    def exhausted(self):
        return self.calls >= self.max_calls

    def remaining(self):
        return max(0, self.max_calls - self.calls)

    def stats(self):
        return {
            'calls': self.calls, 'replayed': self.replayed,
            'refused': self.refused, 'remaining': self.remaining(),
            'max': self.max_calls,
        }


def build_plan(text):
    return Plan(route(text))
