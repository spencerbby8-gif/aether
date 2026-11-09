# Agent task timeline — the live execution view

What the user sees while Aether works, and why it looks the way it does.

## The problem it replaces

The old panel was one collapsible card holding a flat list of rows. Every step
looked like every other step, nothing showed which phase was executing, and a
ten-step run was ten identical lines. The information was honest but
undifferentiated — you could not tell "gathering" from "running a command"
without reading each row.

## Structure

```
Assistant bubble
└── Activity card            collapsed line + chevron   (unchanged behaviour)
    └── AgentTimelineView    raised surface, elevation 3dp
        ├── Phase block      "Understanding the task"   surface, elevation 1dp
        ├── Phase block      "Gathering information"    surface, elevation 1dp–4dp
        │   ├── step row     ⌕ Searched the web    1.2s   node ●───
        │   └── step row     ↗ Read a source      12.0s   node ●───
        └── Phase block      "Running commands"         lifted: accent border
            └── step row     › Running a command          node ◉ (breathing)
```

Phases are produced by `core/AgentRun` and rendered by `AgentTimelineView`.
Both are independent of the transport, so the same widget would serve a future
web client's data shape.

## Elevation language (status without words)

| Layer | Elevation | Meaning |
|---|---|---|
| Timeline card | 3dp | this turn did work |
| Phase block, done | 1dp | a closed chapter |
| Phase block, executing | 4dp + 2dp accent border | the thing happening now |
| Phase block, queued | 1dp | not lifted until it runs |
| Glyph tile | 2dp accent gradient | identity of the phase |
| Detail well (expanded) | inset, `code_bg` + 1dp border | raw information, recessed |

Depth is the status signal, so a person can read the state at a glance without
reading text — and it still reads correctly in grayscale, because the executing
block also has the heavier border and the breathing node.

## Motion

Every animation is **gated by `AetherPrefs.animations`**. With it off, the same
screen renders as a still image with identical information; nothing is conveyed
only by movement.

| Motion | Where | Duration | Job |
|---|---|---|---|
| Node halo breathe | executing step's rail node | 1400ms loop | "this step is live" |
| Three-bar pulse | executing phase header | 900ms loop | second, coarse signal at header level |
| Block arrive | new phase | 200ms fade + 8dp rise | a new chapter appeared |
| Detail list fade | expanding the run | 180ms | continuity, unchanged from before |

There is **no progress bar and no percentage**. The engine reports steps, not
fractions, so a percentage would be invented data.

## Organisation rules (`AgentRun`)

1. Steps are grouped by **consecutive** kind. Search → command → search is three
   phases, not one merged "gathering" block: the timeline must not reorder
   history to look tidier than it was.
2. Kinds: `GATHER` (search/read/list), `BROWSE` (browser), `EXECUTE`
   (run_command), `CREATE` (image/voice), `OTHER`.
3. An unrecognised tool still appears, under "Working". Hiding it would be worse
   than showing it un-categorised.
4. The reasoning block is `synthetic`: it has no steps, is never counted, and
   stops being "active" the moment a real tool starts.
5. An unfinished step keeps its phase live, is counted as `0 of 1`, and reports
   no duration — a stuck command must never look completed.

## Honesty invariants

- Rows exist only for events `AgentActivity` accepted. The engine's private
  reasoning is dropped at the parser, so it cannot leak into the timeline.
- A finished turn stops animating entirely (`finish()` clears `running`).
- Counts and durations are summed from the steps themselves.
- No placeholder row is ever added to fill space or imply work.

## Accessibility

- Each expandable row keeps the content description `Expand <label>` /
  `Collapse <label>`, matching the pre-timeline wording so screen readers and
  the existing UI tests stay correct.
- Status is available three ways: text state, node fill, and elevation.
- Detail text is selectable; source rows are links with the URL as the label.

## Packaging

| Piece | File |
|---|---|
| Grouping model (pure Java) | `core/AgentRun.java` |
| Widget | `AgentTimelineView.java` (inner `RailNode` draws the rail and node) |
| Integration | `ChatActivity.ActivityPanel.renderList()` |
| Grouping proof | `scripts/proofs/TaskTimelineGroupingProof.java` (26 checks) |
| Screenshot | `17b-agent-timeline.png`, from recorded engine events |

## What is proven, and what is not

Proven: the grouping, counting and liveness rules (26 JVM checks on the real
classes with the engine's real event formats); the rendering path compiles and
the widget is captured on a device from recorded engine events.

Not proven: a live turn on a real engine with the animation observed in motion.
Screenshots are stills; the breathing node and the fade-in are exercised by the
code path but not judged visually here.
