# Single-location refactor — session as acting subject, actor.locations as derived union

## Context

woo currently carries three containment-ish properties:

- `location` — physical containment (LambdaMOO `.location`).
- `anchor` — feature-space membership (sticky note physically in the deck
  but presented as part of the pinboard).
- `presence_in` — list of spaces an actor is "tuned into" simultaneously
  (chat room + dubspace + pinboard from one tab strip).

The split was added to make the SPA's tabbed UX work. It's a non-LambdaMOO
deviation. Verified online against LambdaCore: there is **one**
`.location`, and patterns from "sit on the couch" to "alcove with
acoustic transparency" all use `.location` as the truth — the contained
object overrides `:announce_all`/`:announce_all_but` to forward to
`this.location` for the parent room to also hear.

The agreed direction: **align with LambdaMOO's single-axis containment
for non-actor objects, and lift "where am I" to the session, not the
actor.** Actors can be in more than one place because they can have more
than one live session (browser/MCP/whatever). Each session has exactly
one `current_location` and acts only there. The actor's `.locations` is
the deduplicated union over their live sessions — derived, not stored
authoritatively.

## Target shape

### Non-actor objects

- **`location`**: single, LambdaMOO-shaped. `take`/`drop`/`give`
  unchanged.
- **`anchor`**: gone. Anything that today has `anchor: <space>` gets
  `location: <space>` instead. Projection (pinboard grid, taskspace
  kanban) iterates the space's contents — same as today, just reading
  `location`.
- Sticky notes get `location: the_pinboard` (was `the_deck` with
  `anchor: the_pinboard`).

### Actors

- **No authoritative `location`.** The actor's location is implicit
  in `actor.locations`, which is the dedup union of `current_location`
  across the actor's live sessions.
- **`presence_in`** is gone as a structural property. Its job is
  carried by `actor.locations`.
- **`subscribers`** on each `$space` keeps its current meaning — the
  audience the space broadcasts observations to. Populated via
  `:enter` adding the actor's id; pruned via `:leave` and via session
  teardown.

### Session

- New field on `Session`: `current_location: ObjRef`. Persisted
  alongside the rest of the session record.
- Set on session create (default: actor's `home`).
- Mutated by `enter` / `go` / `out` and by programmatic `:moveto` from
  verbs running in that session.
- Persists across socket detach/reattach. You close the laptop,
  reconnect tomorrow, that session is still in the dubspace.
- Removed from the union when the session is reaped.

### Acoustic transparency (LambdaMOO pattern)

```
verb $nested_space:announce_all(text...) rxd {
  pass(@args);                              // tell my own occupants
  if (this.location && isa(this.location, $space)) {
    this.location:announce_all(@args);      // forward to enclosing space
  }
}
```

- `the_dubspace.location = the_chatroom`. Speech in the dubspace
  reaches dubspace occupants AND chatroom occupants.
- `the_pinboard.location = the_deck`. Same.
- A future couch-in-living-room opts in identically.

Default: `$nested_space` forwards. To suppress (private rooms),
override `:announce_all` to skip the `pass()` chain or inherit from
`$space` directly without the forward feature.

## Verb semantics

| Verb | session.current_location | Notes |
|---|---|---|
| `enter <X>` | := X | Session-scoped move. Other sessions of the same actor are unaffected. |
| `go <dir>` / cardinal | := destination | Same. Exit lookup happens in current_location. |
| `out` from `$nested_space` | := this.location (the parent space) | Collapse one level of nesting for the calling session only. |
| `out` from top-level room | := destination (via `out` exit) | LambdaMOO behavior. |
| `:moveto(actor, X)` from a verb running in session S | := X | Session-scoped. The verb has session context (`ctx.session`). |
| Wizard `@moveto user X` | all sessions := X | Eject-shape. Forces a single location across the actor's sessions. |

`actor.locations` (derived) updates accordingly: union always reflects
the live currents.

## Match scope and verb visibility

- `matchObjectForActorAsync` walks `current_location.contents` (+ actor
  inventory). Single-axis, LambdaMOO-shaped. The "is the dubspace
  reachable?" question doesn't arise — either the session's current is
  the_dubspace (so filter_1 is matchable), or it isn't (so it's not).
- `canSeeCommandObject` collapses to that one branch. The
  `ctx.caller`/`ctx.thisObj`/`anchor` bypass we just added gets
  deleted.

## Observation routing

- **Outbound** (this session emits speech): observation broadcasts to
  `current_location.subscribers`, then forwarded up the
  `:announce_all` chain.
- **Inbound** (this session's actor receives observations): routed by
  audience computation (`events.md` §12.7) using
  `subscribers ∩ source-space-and-its-forwarders`. Each connected
  session whose `current_location` is in that audience receives the
  frame.
- The actor renders observations from any of their `actor.locations`
  in the appropriate per-tab feed. Two browser tabs in two locations
  → both feeds scroll independently.

## What this changes, by surface

### Substrate (`src/core/world.ts`, `src/core/types.ts`)

- `Session` gains `current_location: ObjRef`.
- `canSeeCommandObject` collapses to LambdaMOO grammar.
- `matchObjectForActorAsync` consults the calling session's current,
  not actor's location.
- presence-index machinery is rebuilt around
  `subscribersIndex` keyed by space, populated/pruned by
  `:enter`/`:leave` and session lifecycle.
- Observation audience: the dubspace's `:announce_all` forwards
  upward; the runtime resolves "actor X is in audience" by checking
  whether any of X's session currents are in the forwarded audience
  set.

### Catalogs

- **chat**: `$room:enter` → `session:set_current_location(this)`,
  add to subscribers. `$room:leave` → set current to home (or eject
  destination), remove from subscribers.
  `$nested_space < $space` with default forwarder.
- **dubspace**: `$dubspace < $nested_space < $space`. Drop `anchor`
  from controls (filter_1 etc. keep `location: the_dubspace`).
- **pinboard**: `$pinboard < $nested_space < $space`. Sticky-note
  `location` becomes `the_pinboard`. `anchor` field deleted from
  `$pin`.
- **taskspace**: same `$nested_space` pattern.

### SPA (`src/client/main.ts`)

- Tab strip is per-session monitor. Each tab represents a viewable
  location.
- The "active" tab is the session's current_location. Switching tabs
  = navigating the session there (`enter <tab.space>` or `go`-shape).
- Multi-presence in the same browser requires per-tab session tokens
  (see open question below). Today, multi-tab in one browser shares
  one session — so multi-presence today only happens across distinct
  browsers/MCP clients/incognito windows.
- Where-am-I indicator: title bar shows the current_location for the
  active tab.
- The `presence_in`-derived `actorPresentInSpace` checks all collapse
  to "is `current_location === space` for the active tab" or "is
  `space ∈ actor.locations`" depending on context.

### Spec

- `spec/semantics/core.md` (containment) — note the LambdaMOO
  alignment; remove `anchor`/`presence_in` rows.
- `spec/semantics/events.md` §12.7 — replace multi-axis audience
  build with "subscribers + forwarder chain".
- `spec/semantics/bootstrap.md` — class table updated for
  `$nested_space`. Session record has `current_location`.
- New brief: `spec/semantics/projection.md` — "feature-spaces project
  contents; they don't define a separate membership axis."
- `spec/semantics/identity.md` — session-scoped current_location.

## Migration

1. **Add `$nested_space` class and `:announce_all` forwarder** in
   substrate seed and chat catalog. No instances yet.
2. **Add `current_location` to `Session`.** Default to actor's home
   on session create. Persisted. Reads from `actor.location` (legacy)
   on the first read after migration to seed value.
3. **Bump catalogs to v0.2.0.** Manifest migrations:
   - Each object with `anchor`: `location := anchor`, clear `anchor`.
     Update parent contents Set.
   - Sticky notes: physical location becomes the_pinboard.
4. **Sessions migrate** their `current_location` from
   `actor.location` (or first member of `presence_in`).
5. **Substrate change**: `canSeeCommandObject` /
   `matchObjectForActorAsync` / audience computation drop
   anchor/presence_in lookups. `presence_in` writes become no-ops
   (back-compat) for one release, then removed.
6. **SPA change**: per-tab current; tab navigation = session move.
7. **Per-tab session model** (the open question — see below) lands
   when ready; until then multi-presence is "open a second
   browser/MCP".

Each step independently shippable; SPA can run against a substrate
that still respects `presence_in` until step 6 lands.

## What does NOT change

- `:tell`/`:say`/`:emote`/`:say_to` chat verbs — same shapes, same
  emissions. Audience scoping is now single-axis with explicit
  forwarding.
- `:on_say_to(text)` input-handler hook on objects (recently
  introduced) — same; backtick-speech `` `filter 500 `` works once
  the session is in the dubspace.
- LambdaMOO `:tell(text...)` output contract on `$player` —
  unchanged.

## Open questions

### `@join <user>` ambiguity

If user X has multiple live sessions (laptop in dubspace, MCP client
in pinboard), `@join X` from another player is ambiguous: which
location? Resolution proposals:

- **First-accepting**: walk X's `actor.locations` in some order
  (most-recently-active session first?), call `space:accept_join(...)`
  on each, take the first that returns true. Spaces can refuse
  (private rooms, capacity caps).
- **Pick deterministically**: most-recently-active session wins.
- **Prompt the joiner**: "X is in the dubspace and the pinboard;
  which?" — chat-grammar `@join X in <space>`.

Probably first-accepting + deterministic tiebreak. Need to spec the
tiebreak so behavior is predictable.

### Same-browser multi-tab → multi-session?

Today: one browser, one session token, all tabs share. Switching the
active tab is purely visual; the actor still has one current.

For multi-tab → multi-presence to work (each tab in its own
location), each browser tab needs its own session. Options:

- **One session per WebSocket attach.** A new tab gets its own WS,
  the gateway mints a fresh session record bound to that socket. The
  bearer/apikey identity is shared (it's the same human) but the
  *session* is per-tab. Closing the tab reaps the session.
- **One session per browser.** Multi-tab in one browser still shares
  current. To get two currents the user opens a second
  browser/incognito window. Simpler model; less convenient UX.

Lean toward the first: it matches the user's mental model that "each
tab is a thing I'm doing." But it's a session-model change worth
calling out.

### Wizard `@moveto` and verb-context `moveto`

Verb-context `:moveto` moves the calling session only (we have
`ctx.session`). Wizard `@moveto user X` semantics:

- Move all sessions of `user` to X (eject-shape, what LambdaMOO
  effectively does because there's only one). Heavy hammer.
- Move only the most-recent session (least disruptive).
- Pick a session and report which one was moved.

Default: all sessions. Wizards moving someone usually want them
*there*, not "there in one tab still elsewhere in another."

### Acoustic depth and loops

A in B in C, A forwards to B forwards to C: speech in A reaches all
three. LambdaMOO behavior, fine. Loop avoidance: forwarding stops
when `this.location` is null or isn't a `$space`. No cycle protection
in v1; cycles arise from configuration bugs and can be diagnosed if
they surface.

### `presence_in` deprecation pace

Two options:

- **One-release shim**: `presence_in` writes become no-ops with
  deprecation log; reads return derived `actor.locations`. Catalogs
  that mention it keep compiling. Remove next major.
- **Rip same release**: gone immediately; catalogs that mention it
  fail to install. Forces all in-repo catalogs to be migrated up
  front but cleaner.

Lean toward one-release shim — the bundled catalogs aren't the only
ones, third-party would benefit from a window.

### Session current_location persistence and reaping

Currently sessions are reaped after `lastDetachAt + N`. With
current_location persisted on the session, a long-detached session
holds a slot in `subscribers` of the room indefinitely. Either:

- Reap subscribers on session detach, restore on attach.
- Keep subscribers stable across the detach/attach window (current
  behavior). Stale-subscriber lazy-scrub already exists.

The latter matches the user's expectation: "I close my laptop and
come back, my dubspace tab is still where I left it."

## Why now

1. The dubspace dispatch bug we just hit (`canSeeCommandObject`
   reaching to the wrong axis) is structurally the consequence of
   three properties answering "is this thing reachable from here?"
   Single axis means one answer.
2. The forthcoming workflow/task design adds *more* feature-spaces
   (workflows, stages). Building on top of the multi-axis model
   compounds the inconsistency. After this collapse, every new space
   is a normal LambdaMOO nested room — no special grammar.

## What this requires from the user before I start

- Confirmation on session-as-acting-subject (current_location lives
  on Session, actor.locations derived).
- Resolution on `@join` ambiguity (probably first-accepting +
  most-recently-active tiebreak).
- Decision on per-tab session model (preferred: one session per WS
  attach).
- `presence_in` deprecation pace (preferred: one-release shim).
- Wizard `@moveto` scope (preferred: all sessions).
