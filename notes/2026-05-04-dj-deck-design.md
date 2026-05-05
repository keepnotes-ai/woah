# DJ deck — set-and-crossfade design

## Context

The current dubspace is fine for ambient sound shaping (loop slots, drum
machine, filter sweep) but not for actual DJing. The intended UX:

- Queue tracks from URLs (mp3/m4a/ogg/wav) **and** from saved
  step-sequenced patterns. The dubspace's percussion verb is the model
  for the latter, generalized: configurable step count (4–16) and
  author-defined voices (not the fixed kick/snare/hat/tone).
- Compose a *set* — an ordered playlist with crossfades between tracks
  baked in. Tracks can be either kind, freely interleaved.
- Reuse named *crossfades* — parameterized transition patterns. Ship a
  small library; users can author their own with a crossfade editor and
  save under a name.
- Take requests from chat: anyone present in the deck space can queue.
- Live override: the operator can grab the crossfader/gain/filter
  controls mid-transition and improvise; the stored set plan is
  unchanged.
- A few one-shot FX bumps from buttons on the deck (echo, reverb swell,
  filter slam) — not scripted, just live.

Just URLs + sequencer + saved sequences + crossfades + Web Audio is
enough to make a nice little track. That's the v1 scope.

Whether this replaces the existing dubspace controls or sits alongside
them is open (see below).

## Persistent classes

### `$track < $thing` (abstract)

Common base for anything queueable. Properties:

| Property | Type | Notes |
|---|---|---|
| `title` | str | Human-readable. |
| `duration` | float | Effective seconds the track plays before its crossfade-out window. For audio tracks this is the file length; for sequence tracks it's `bars × bar_duration`. |
| `art_url` | str \| null | Optional cover art. |
| `default_transition` | obj \| null | Optional default `$crossfade` for this track. |

Verbs: `:title()`, `:describe()`. Subclasses provide `:source_descriptor()`
which returns the SPA-side play handle (a small map the audio engine
interprets — see "Audio engine contract" below).

### `$audio_track < $track`

URL-based audio asset.

| Property | Type | Notes |
|---|---|---|
| `url` | str | The audio URL. Resolved through `:resolve_url(url)`. |
| `kind` | str | "audio" for direct URLs; future resolvers may produce other tags. |

Constructor `$audio_track:from_url(url)` calls the resolver feature
chain and returns either an `$audio_track` instance or an error.

### `$sequence_track < $track`

Step-sequenced track. The current dubspace `$drum_loop` is the model,
generalized: configurable step count and author-defined voices.

| Property | Type | Notes |
|---|---|---|
| `bpm` | int | 60–200. |
| `step_count` | int | 4–16. Defaults to 16. Each pattern row has this many slots. |
| `bars` | int | How many times the pattern repeats before crossfade-out. Default 1. |
| `voices` | list<voice_spec> | Author-defined; see below. |
| `pattern` | map<str,list<bool>> | Keyed by voice name. Each list is `step_count` bools. |
| `swing` | float \| null | Optional 0.0–0.5 swing on off-beats. |

`voice_spec`:

```
{
  name: str,                   // pattern key
  kind: "click" | "tone" | "noise" | "sample",
  params: map                  // shape depends on kind:
                               //  click  → { freq_hz, decay_ms, gain }
                               //  tone   → { freq_hz, wave: "sine"|"square"|"saw"|"triangle",
                               //              attack_ms, decay_ms, gain }
                               //  noise  → { color: "white"|"pink", attack_ms, decay_ms,
                               //              filter_hz?, gain }
                               //  sample → { url, gain, pitch?, start_ms?, end_ms? }
}
```

`duration` is computed: `(step_count * bars * 60.0) / (bpm * 4.0)`
seconds (assuming 16th-note steps in 4/4). The track's
`:source_descriptor()` returns
`{ kind: "sequence", bpm, step_count, bars, voices, pattern, swing }`
for the audio engine to schedule via Web Audio's
`AudioContext.currentTime` + per-step oscillator/noise nodes.

Sequence tracks compose with audio tracks freely: any pair can be
joined by any `$crossfade`. Filter automation lanes apply to whatever
the slot is playing. The audio engine doesn't care whether a slot is
a buffer-source-node (audio) or a scheduled cluster of synthesis
nodes (sequence) — it just modulates the slot's gain/filter graph.

### `$crossfade < $thing`

Named, parameterized transition pattern. Properties:

```
{
  name: str,                   // human-readable identifier
  description: str,
  out_starts_at: float,        // outgoing fade start. Negative = relative
                               // to outgoing track's end. Positive = absolute
                               // seconds from outgoing track start.
  out_duration: float,         // length of outgoing fade
  in_starts_at: float,         // incoming play start (skip intro). Always
                               // ≥ 0; relative to incoming track 00:00.
  in_duration: float,          // length of incoming gain ramp
  filters: list<filter_spec>   // see below
}
```

`filter_spec`:

```
{
  lane: "out" | "in",
  kind: "lowpass" | "highpass" | "bandpass" | "notch" | "peaking",
  from: float,                 // seconds, see "Time origin" below
  to: float,                   // seconds, same frame as `from`
  freq_hz: { from: float, to: float } | float,
  q: float | null,
  ramp: "linear" | "exp"
}
```

**Time origin.** `from` and `to` are absolute seconds within the
lane's track, using the same sign convention as the lane's
`*_starts_at`:

- For `lane: "out"`: negative values are seconds-before-track-end
  (matching `out_starts_at`'s sign convention); positive values are
  seconds-from-track-start. So `from: -8.0, to: 0.0` means "the last
  8 seconds of the outgoing track."
- For `lane: "in"`: always non-negative, seconds-from-track-start.
  So `from: 0.0, to: 4.0` means "the first 4 seconds of the incoming
  track."

This keeps filter automation expressible without knowing the
absolute track length at authoring time — "ramp the bass cut over
the last 8 seconds" works regardless of track duration.

World-readable. Owned by creator (LambdaMOO ownership). Non-owners can
*use* a crossfade by reference; only owner can mutate. Forking is
explicit (see below). Anyone can subclass `$crossfade` later if private
patterns become a need.

Children of `$crossfade` enumerable via `children($crossfade)` for the
editor's "available crossfades" list.

### `$set < $thing`

Ordered playlist with embedded transition refs. Properties:

| Property | Type | Notes |
|---|---|---|
| `entries` | list<map> | Track/crossfade pairs; see below. |
| `repeat` | bool | When true, the deck loops the set after the last entry. Default false. Top-level only — no per-track repeat. |

`entries` shape:

```
list<{
  track: obj,                  // $track ref
  out_crossfade: obj | null,   // $crossfade — how to leave this track
  in_crossfade: obj | null,    // $crossfade — how to enter (often inherited
                               // from prev's out)
  position_override: float | null  // override track.start_at if set
}>
```

World-readable by default; owner edits, anyone can fork. (No privacy
flag in v1 — privacy comes via subclassing later if it becomes a need.)
Forking a set is shallow: new entries list, same `$track` and
`$crossfade` refs. To tweak a crossfade for the fork, fork the
crossfade explicitly too.

Sets persist independently of any deck session. A DJ prepares a set,
walks away, comes back tomorrow, loads it.

**Repeat semantics.** When `repeat: true` and the deck has played the
last entry, `:next()` re-snapshots the set's entries onto the queue
and continues from index 0. The loop-boundary transition uses the
*last entry's `out_crossfade`* into the *first entry's `in_crossfade`*
(same rule as any other transition; the wrap-around is just two
adjacent entries in time, even though they're at opposite ends of
the entries list). An empty set with `repeat: true` is a no-op (deck
idles; nothing to play).

## `$dj_deck < $space`

Operator surface. Two features attached at install:

- **`$conversational`** — chat verbs and command planner; listeners
  see a chat feed in the deck's space tab.
- **`$transparent`** — acoustic-transparency forwarder per the
  single-location refactor. Speech in the deck reaches its mount
  room, and room chat reaches deck listeners. (A deployment that
  wants insulation — say, a noisy basement DJ space whose chat
  shouldn't bleed upstairs — installs `$semitransparent` instead, or
  detaches `$transparent` after install. Default is `$transparent`.)

Properties:

| Property | Type | Notes |
|---|---|---|
| `decks` | list<obj> | Two `$track_slot`s (A, B). |
| `queue` | list<map> | Live queue of pending entries. Each entry is a `{track, in_crossfade, out_crossfade}` map (the same shape as a set entry, except runtime-mutable). |
| `history` | list<obj> | Recently-played tracks. |
| `master_gain` | float | |
| `crossfader` | float | -1.0 (full A) to +1.0 (full B). |
| `mount_room` | obj \| null | Inherited dubspace pattern. |
| `operators` | list<obj> | Who can call mutating verbs. |
| `loaded_set` | obj \| null | The `$set` whose snapshot currently fills the queue, or null if the queue was assembled freeform. Held so `repeat` can re-snapshot at end-of-set. |
| `repeat` | bool | Runtime mirror of the loaded set's `repeat` (or false if no set loaded). Operator can flip live via `:set_repeat(bool)` without touching the source `$set`. |
| `now_playing` | map \| null | **Cache** of `{slot, track, started_at, transition}` for the current track, refreshed on every `track_started`. The authoritative source is the latest sequenced `track_started` applied frame in the deck's log; late-joining clients read that, not this property. The cache exists for fast reads from chat verbs and the SPA initial render; treat as cache, not source-of-truth. |

Verbs:

- `:queue_add(track, in_crossfade?, out_crossfade?)` — append to queue.
  ACL-gated through a `$queue_policy` feature attached to the deck at
  install. **Default policy ships with sane limits**: max 50 entries
  in the queue (further `:queue_add` returns an `E_QUOTA` error);
  per-actor rate-limit of 5 adds per minute (rolling window). Operators
  bypass both. The default policy is its own feature object so
  deployments can detach and replace; a "wide-open" policy or a
  "voting" policy is just a different `$queue_policy` instance. Without
  a policy attached, the default-default is "operators only."
- `:queue_reorder(idx_from, idx_to)`, `:queue_remove(idx)` — operator only.
- `:load_set(set)` — snapshot the set's entries into the queue, store
  `loaded_set := set`, and mirror `repeat := set.repeat`. Subsequent
  edits to the set don't disturb the playing queue (the snapshot is the
  show).
- `:set_repeat(value)` — flip the deck's runtime `repeat` mirror
  without modifying the source `$set`. Operator only. Sequenced
  (replay-faithful, like `:live_set_*`).
- `:next()` — advance: start the next queue entry on the idle slot,
  schedule the crossfade per its `in_crossfade` from the
  currently-playing slot. **Loop behavior**: when the queue is empty
  and `repeat == true && loaded_set != null`, re-snapshot the
  loaded set's entries onto the queue and advance from the new
  index 0; the loop-boundary transition uses the (now-popped) last
  entry's `out_crossfade` into the new entry's `in_crossfade`. When
  the queue is empty and `repeat == false`, the deck idles
  (subsequent listeners see `now_playing: null`).
- `:play()`, `:pause()`, `:seek(slot, t)` — operator only.
- `:fx_bump(name, params?)` — emit a one-shot FX observation. Live; no state
  change.

`$track_slot < $control` — one playing/loaded track. Mutated by `$dj_deck`
verbs.

## Audio: web-audio only

We commit to the Web Audio API as the only audio engine. Track URLs must
be playable as `<audio src>` directly (mp3/m4a/ogg/wav with
`Content-Type: audio/*` and CORS permitted). No YouTube IFrame, no
SoundCloud Widget, no degraded engines.

Why: every parameter in `$crossfade` is meaningful. Filter automation
fires sample-accurate. Sync via wall-clock offsets is precise. The
crossfade editor's preview is identical to deck playback. No
"this-broke-on-YT" failure mode.

What we give up: casual "drop a YT link in chat" UX. Mitigation below.

### `:resolve_url(url)` extension point

`$audio_track:from_url(url)` walks the resolver chain (a
`$track_resolver` feature attached to `$audio_track` or to `$dj_deck`'s
containing space). Each resolver gets a chance to return
`{url: <streaming-audio-url>, title, duration, art_url, kind}` or pass.

(Resolvers don't apply to `$sequence_track` — those have no URL and
are constructed via the sequence editor, not from-URL.)

The default resolver accepts URLs whose HEAD response is `audio/*` and
extracts what it can from `Content-Type` / `Content-Length` headers
(plus optional ID3 tag fetch for title).

A world that wants YouTube support attaches a `$yt_resolver` feature
that POSTs the URL to a wizard-configured `yt-dlp` instance and returns
a streaming audio URL. **We don't ship the resolver** — that's the
operator's call, and the operator's ToS responsibility. The substrate
doesn't know or care; it sees an audio URL.

Same shape for any future source (Bandcamp, archive.org, podcast feeds,
local-file-server): a small resolver feature.

## Sync model

When a slot starts a track, the dj_deck appends a sequenced
`track_started` applied frame:

```
{ slot: A, track: t_42, started_at: <wall_clock_ms>, transition: <map> }
```

Every connected client (operator and listener) reads the applied frame,
computes "track started 3.2s ago, transition has ramp_in 4s, current
gain should be 0.8" using its own `audioContext.currentTime` and the
emit `started_at`. Late-joining clients read the latest `track_started`
from the space's log and start the track at the right offset.

Drift: not corrected continuously. Each `track_started` is a fresh sync
point; clients reset their local clock to it.

Auto-advance: when a slot starts a track, the deck schedules a
`suspend()` task for `track.duration - transition.out_duration -
fudge_factor` seconds to fire `:next()`. Operator can interrupt with
`:next()` early or `:queue_remove(0)` and `:next()` to skip.

**Late-firing alarm.** A hibernated deck's `suspend()` task can fire
seconds (or minutes) after the track was supposed to end — DOs
hibernate; alarms fire when traffic resumes. `:next()` must
defensively check on entry: if `now - now_playing.started_at >
track.duration`, the previous track is already over, so advance
immediately and skip the crossfade-out window (the outgoing track's
audio source is already past its file end; there's nothing to fade
out). The incoming track plays at full gain from start without an
overlapping mix. The audio engine handles this naturally — the
expired source-node has stopped emitting; gain automation on a
stopped node is a no-op — but the substrate has to make the
`track_started` for the new entry without trying to schedule a
phantom out-fade on the old one.

## Live override

Scripts only assert at transition boundaries — track start, crossfade
in, crossfade out, track end. Between events, parameters hold whatever
value they were last set to.

Operator live-touch wins:

- `:live_set_gain(slot, value)`, `:live_set_filter(slot, freq, q)`,
  `:live_set_crossfader(value)` — **sequenced verbs**, called via
  `dj_deck:call(...)`. Each emits an applied frame
  `{type: "live_override", lane, value, ts}`.
- The audio engine receives the applied frame, calls
  `audioParam.cancelScheduledValues(now)` on the relevant lane, writes
  the live value. The current scripted automation on that lane stops.
- Subsequent transition events schedule fresh automation that ignores
  the live override. Live override is "for the rest of this transition";
  the next transition resets.

**Why sequenced, not direct.** A listener who joins 10s after the
operator slammed a filter knob shouldn't hear the scripted automation
because the override observation was live-only and they missed it. By
making `:live_set_*` sequenced, the override lands in the deck's log
and any client replaying from `last_seq` reconstructs the same audio
state. Cost is small: a few applied frames per transition, all tiny.
Benefit: "the recorded show is what was played" — replay from any
seq is faithful.

The stored set plan (the `$set` instance) is unchanged. The deck's
*log* records the improvisation; the *plan* doesn't. If the operator
wants to capture their improvisation as a reusable crossfade, that's
a "save current state to crossfade" verb later — out of scope for v1.

## Crossfade editor (SPA mode)

Opens from "edit crossfade" on the deck or from a list view of
available crossfades.

- **Load an existing crossfade**: presents a duplicate-then-edit UI
  (you can't modify someone else's). Saves create a new instance owned
  by the editing actor.
- **Or load a blank**: starts from the `cut` template.

UI:

- Timeline with two lanes (outgoing / incoming).
- Draggable gain envelope on each lane (anchor points → linear or exp
  ramp).
- Filter lanes: add/remove, pick `kind`, drag automation curve, set
  `freq_hz.from/to` and `q`.
- Numeric parameter inputs alongside the visual controls.
- Preview button: plays a fixed sample track pair (catalog ships two
  short demo tracks) with the current settings, on a transient
  preview-deck space the editor opens. Same audio engine as the deck —
  what you preview is what you'll get.
- Save: name + description, creates a new `$crossfade`.

Substrate verbs supporting this:

- `$crossfade:duplicate(new_name)` → clone-with-new-owner.
- `$crossfade:set_params(params)` → owner-only mutator.
- `$crossfade:preview_pair(track_a, track_b)` → opens the preview-deck
  with the current `$crossfade` as the bridge.

## Shipped crossfades

Loaded by the catalog at install time. Owned by `$wiz`, world-readable.

| Name | Description |
|---|---|
| `cut` | Instant switch, no fade. |
| `slow-blend` | 16s gain-only crossfade. |
| `quick-blend` | 4s gain-only crossfade. |
| `bass-swap` | 8s — outgoing low-pass sweep down, incoming high-pass sweep up. |
| `filter-sweep` | 12s — outgoing band-pass closing, incoming wide. |
| `echo-out` | Outgoing fades with reverb tail; incoming starts dry. |
| `loop-then-cut` | Outgoing loops a 2-bar selection, then hard cut. |
| `harmonic-blend` | 8s — outgoing pitch-down 100¢, incoming pitch-up 100¢, meet at 0¢. |

Sample crossfades double as templates for new authors.

## FX bumps

One-shot live observations, not sequenced. `:fx_bump(name, params?)`
emits `{type: "fx_bump", name, params, ts}` to subscribers. The audio
engine has a fixed library of named effects:

- `reverb-swell` (params: `duration`, `wet_ramp`)
- `echo-tail` (params: `feedback`, `time`)
- `filter-slam` (params: `freq`, `q`)
- `gate-stutter` (params: `rate`, `depth`)
- `pitch-warp` (params: `cents`, `duration`)

No state change. Cheap. Visible to all listeners.

## Verb naming (per [core.md §C11.1](../spec/semantics/core.md))

In-fiction (no prefix) — operator deck verbs:

- `play`, `pause`, `next`, `seek`, `queue` (chat command), `bump`
  (chat command for `:fx_bump`).

Meta (`@`-prefixed) — authoring/admin. **Draft until the editors land.**
The substrate verbs that back these (`:duplicate`, `:set_params`,
factory creation) ship in step 1, but the chat-grammar surface is
deliberately deferred until each corresponding editor exists, because
typing `@new_crossfade foo` without an editor produces an unedited
default with no path to mutate it. SPA buttons in the editors' own
views handle creation; the chat grammar lands once the editor is
real.

- `@new_crossfade <name>` — opens the crossfade editor with a fresh
  `$crossfade`. (Lands with the crossfade editor.)
- `@new_set <name>` — creates an empty `$set` and opens the set
  editor. (Lands with the set editor.)
- `@new_sequence <name>` — opens the sequence editor with a fresh
  `$sequence_track`. (Lands with the sequence editor.)
- `@list_crossfades` / `@list_sets` / `@list_sequences` — show
  available, with owners.
- `@fork <crossfade-or-set-or-sequence>` — clone to your ownership.
- `@delete <crossfade-or-set-or-sequence>` — owner-only.
- `@load_set <set>` — equivalent to `:load_set`, exposed at the chat
  grammar layer for builders.

Chat grammar table additions to the chat catalog's command_plan, lowering
to direct verbs on the deck. Each row lights up only after the editor
that gives the verb meaning has shipped.

## Build order

1. **Substrate classes** — `$track` (abstract), `$audio_track`,
   `$sequence_track`, `$crossfade`, `$set`, `$dj_deck`, `$track_slot`.
   State only; no audio yet.
2. **Default URL resolver** — hits HEAD for `Content-Type: audio/*`,
   extracts `duration` from a quick read of the audio file's metadata if
   feasible. Returns `$audio_track` or error.
3. **Chat queue command** + ACL hook + queue-reorder verbs.
4. **SPA Web Audio engine — audio path** — reads `now_playing` and the
   queued transition spec. Loads `$audio_track` URLs into
   `AudioBufferSourceNode`s. Gain envelopes; no filter automation yet.
5. **SPA Web Audio engine — sequence path** — schedules
   `$sequence_track` voices via Web Audio (oscillators for `tone`,
   noise buffers for `noise`, decaying envelope for `click`,
   `AudioBufferSourceNode` for `sample`). Same slot graph as audio
   tracks (gain → filter → master).
6. **Sequenced `track_started`** + auto-advance via `suspend()`.
   Auto-advance duration uses `track.duration`, which for
   `$sequence_track` is `(step_count * bars * 60.0) / (bpm * 4.0)`.
7. **Live override** — `:live_set_*` verbs, audio engine cancels
   scheduled automation on touch.
8. **Filter automation** — full Web Audio biquad automation per
   `$crossfade.filters`. Works identically across audio and sequence
   slots (filter sits between source and master gain on both).
9. **Crossfade editor** — SPA mode with timeline UI; preview on
   transient deck. Lands the `@new_crossfade` chat grammar.
10. **Sequence editor** — SPA mode: pick step count, define voices
    (kind + params), toggle pattern cells, set bpm/bars/swing.
    Preview button plays the loop in isolation. Lands the
    `@new_sequence` chat grammar.
11. **Set editor** — SPA mode: drag tracks (audio or sequence) into
    an ordered list, pick crossfade per transition, save. Lands the
    `@new_set` and `@load_set` chat grammar.
12. **FX bumps** — fixed library of effects + button UI.
13. **Stock crossfade catalog** — seed `cut`, `slow-blend`, etc. as
    `$wiz`-owned `$crossfade` instances at install time.
14. **Stock sequence catalog** — seed a few demo `$sequence_track`s
    (a 4/4 kick-snare-hat pattern, a 16-step bassline pattern, a
    polyrhythm) so the queue has interesting things to play with out
    of the box.

Each step independently shippable; the deck can run with degraded
features at every stage. Steps 1–8 give a working DJ deck (URL
playback + sequencer + crossfades + filter automation + live
override). Steps 9–14 add authoring affordances and stock content.

## Done when

Concrete acceptance tests, one per build step. Each step is "done"
when its rows are green; the whole refactor is done when all are.

| Step | Acceptance |
|---|---|
| 1 — substrate classes | `world.create($audio_track)` and `world.create($sequence_track)` succeed; `:duration` returns expected value for a sequence track of `(step_count=16, bars=1, bpm=120) → 2.0s`. |
| 2 — URL resolver | `$audio_track:from_url("https://example.com/test.mp3")` returns a track whose `duration` matches the file's actual length within 0.1s. Invalid URL returns `E_INVARG`. |
| 3 — chat queue command | Non-operator subscriber can `queue <url>` and the deck's `queue` reflects the addition; rate limit fires on the 6th add within a minute. |
| 4 — SPA audio engine | Two URL tracks crossfade gain-only on the same deck across two browser windows; visible playhead positions agree within 50ms; `now_playing.started_at` matches between the two. |
| 5 — sequence path | A 16-step sequence track plays the right voices at the right beats; preview button in step 10's sequence editor produces audible output. |
| 6 — sequenced track_started | Late-joining client (3rd browser window opening 5s into a track) starts playback at the correct offset within 100ms. |
| 7 — live override | Operator slams the crossfader; the audio engine cancels scheduled automation; a listener replaying the deck's log from `seq=0` reproduces the same audio state at the same timeline points. |
| 8 — filter automation | A `bass-swap` crossfade applied to two tracks produces measurably correct frequency-domain output (low-pass cutoff drops as scripted; high-pass cutoff rises). Verified by `AnalyserNode` snapshot. |
| 9 — crossfade editor | User creates a new crossfade, saves, queues two tracks with it, hears the saved transition. |
| 10 — sequence editor | User creates a 12-step sequence with two `tone` voices and one `noise` voice, saves, queues into a set, plays. |
| 11 — set editor | User assembles a set of three tracks (one audio, two sequence) with three different crossfades; loads onto the deck; plays through. Repeat toggle works: a `repeat: true` set wraps from last entry back to first via the last entry's `out_crossfade` + first entry's `in_crossfade`; live `:set_repeat(false)` mid-loop stops at end of current pass. |
| 12 — FX bumps | Buttons emit `fx_bump` observations; all listeners hear the effect; deck state unchanged. |
| 13 — stock crossfades | Catalog install creates 8 `$wiz`-owned crossfades; `children($crossfade)` returns them. |
| 14 — stock sequences | Catalog install creates demo sequence tracks; queueing them produces audible patterns. |

Cross-cutting acceptance for the substrate decisions:

- **Replay fidelity.** Replay the deck's log from `seq=0` on a fresh
  client; the audio output matches the original session bit-for-bit
  in transition timing and parameter values, including any live
  overrides issued during the original session.
- **Late-firing alarm.** Force a `suspend()` task to fire after
  `track.duration + 30s`; `:next()` advances immediately, no phantom
  out-fade attempted, no audio glitch on the incoming track.
- **`now_playing` is just a cache.** Delete `now_playing` between
  applied frames; late-joining client still starts correctly by
  reading the latest `track_started` from the log.

## Open questions

### Catalog placement: augment dubspace

**Decision: augment** (not replace, not split). `$dj_deck`,
`$track`, `$audio_track`, `$sequence_track`, `$crossfade`, `$set`,
and `$track_slot` ship inside the existing `@local:dubspace`
catalog as v0.2.0. Reasons:

- `$track_slot < $control` — `$control` is already in the dubspace
  catalog (parent of `$loop_slot`, `$channel`, `$filter`, etc.).
  Having `$track_slot` reuse `$control` keeps the inheritance tidy
  without duplicating the base class. If we ever split into a
  separate `@local:djdeck` catalog, `$control` would need hoisting
  into a shared upstream catalog (probably the chat catalog or a new
  `@local:audio_base`); deferred until a real reason to split
  appears.
- The existing dubspace loop-slot / drum-machine controls stay for
  now. They share the catalog with the new DJ deck classes; a deployed
  world gets both surfaces in the same room. Some future world might
  install a no-DJ subset by detaching unwanted features, but the
  default install is "everything."
- One catalog version bump, one migration window, one set of
  manifest changes.

If catalog size becomes unwieldy later, the split path is clear
(hoist `$control` upstream, move dj-only classes to a new catalog,
keep instance migrations explicit).

### Operator vs listener role

Same as current dubspace: `subscribers` = listeners (audio fanout);
`operators: list<obj>` = who can call mutating verbs. Default-policy:
first to enter is operator; subsequent enterers join `subscribers`
only. Operators can promote others. Wizard override.

Concurrent enters (two would-be first-operators arrive within ms of
each other) are resolved by the deck's sequenced log: `:enter` is a
sequenced verb on `$dj_deck`, so the deck's task queue serializes
them and the second one sees `operators` already populated. No
race.

### What happens when no operator is connected?

Music continues from the last `track_started` until the track ends.
Auto-advance still fires (the suspend task lives on the deck, not on a
session). When the queue empties, the deck idles. Listeners stay
connected; the next operator can resume.

### Set-load semantics on a playing deck

Loading a new set while music is playing: snapshot replaces the queue
*from index +1 onward*. The currently-playing track finishes per its
out_crossfade; the first entry of the new set begins. Operator can
choose "load and skip current" via `:load_set(set, {skip: true})`.

### Listener seek/scrub

The SPA UI doesn't expose scrub controls for listeners; only operators
see deck transport controls. This is a UI affordance, not a normative
substrate invariant — a listener with DevTools can pause their
`<audio>` element or mute their browser tab; nothing the substrate
does prevents that. The substrate's invariant is "no listener verb
mutates deck state." That's enforced.

### Royalties / copyright

Not the substrate's problem. Catalog README documents that operators
are responsible for what they queue. The default URL resolver only
plays direct audio URLs the operator knows the source of.

### Privacy

No `private` flag in v1. Anyone wanting private sets/crossfades
subclasses (`$private_set`) and overrides `:can_be_seen_by`. Deferred
until someone actually asks.

### Cross-host audio

A `$dj_deck` lives on one host. Listeners on remote hosts receive
applied frames via the existing cross-host bridge. Audio playback is
entirely client-side, so cross-host doesn't affect timing — every client
syncs to `started_at` independently.

## What this requires

**Substrate (already shipped):**

- `$space` with sequenced log, subscribers index.
- `moveto` (for actor entry into the deck space).
- Feature attachment (for `$conversational` and `$track_resolver`).
- `suspend()` for auto-advance scheduling.
- Cross-host applied-frame fanout for distributed listeners.

**Substrate (small additions):**

- Nothing structural — this is all catalog + SPA work.

**Catalog (new):**

- `$track` (abstract), `$audio_track`, `$sequence_track`,
  `$crossfade`, `$set`, `$dj_deck`, `$track_slot` classes.
- Stock `$crossfade` instances (cut, slow-blend, bass-swap, etc.).
- Stock `$sequence_track` instances (one or two starter patterns).
- Two demo audio tracks for the crossfade-editor preview.
- Default `$track_resolver` feature.
- Chat grammar additions: `queue` (lights up at step 3), `bump`
  (step 12). Builder `@`-prefixed verbs land alongside their editors
  (steps 9–11).

**SPA (new):**

- Web Audio engine reading deck state. Single slot graph
  (source → filter → gain → master) shared by both audio buffer
  sources and scheduled synthesis nodes.
- Crossfade editor view (step 9).
- Sequence editor view (step 10).
- Set editor view (step 11).
- FX bump button row on the deck UI (step 12).
- Set browser / crossfade browser / sequence browser views.

## Audio engine contract

The SPA's Web Audio engine consumes `track:source_descriptor()` for
each loaded slot. Two shapes:

```
{ kind: "audio", url: "https://...mp3", start_at: 10.0 }
```

```
{ kind: "sequence", bpm: 120, step_count: 16, bars: 1,
  voices: [{name, kind, params}, ...],
  pattern: { name: [bool, ...], ... },
  swing: null }
```

Both feed the same per-slot graph: `source_or_synth_cluster → filter →
gain → master`. Crossfades automate `gain` and `filter.frequency`
identically regardless of source kind. Live override and FX bump
hook into the same graph.

**Sequence scheduling — rolling window.** A naive implementation
would call `oscillator.start(t)` / `noiseNode.start(t)` for every
step in the whole pattern at track-start: at 16 steps × 5 voices ×
16 bars that's 1280 nodes ahead of time. Web Audio handles it but
it's wasteful. The engine schedules in a rolling window — typically
2 bars ahead — and a `setInterval` (or scheduled `setTimeout`)
extends the schedule one bar at a time as `audioContext.currentTime`
advances. This is the standard Web Audio sequencer pattern. Live
override and crossfade-out simply stop scheduling new bars beyond
the transition point; the already-scheduled bars in flight finish
naturally (or get cancelled at the source-node level).
