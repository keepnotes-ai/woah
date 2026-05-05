# `$block` and the plug pattern

Date: 2026-05-05

## Concept

A `$block` is an in-world actor that bridges woo to an outside-world data
source or system. It has a fixed location (a "smart window," a wall
display, a sensor readout, a vending machine). Its data values come from
upstream — woo is not the source of truth, the plug is — but the block
exposes a normal woo surface: properties, verbs, perms, observations.

The plug is an outside-world process — Python, Rust, TypeScript, or
anything else that can speak the WS API — running on-prem or in cloud, not
in a CF DO. It authenticates as the block's actor, pushes data by writing
the block's properties, and answers query/command verbs the block exposes.
Each plug has its own apikey credential. Python is convenient for the
example plugs because it speaks databases, APIs, and ML stacks easily; the
choice of language has nothing to do with the substrate.

The plug doesn't have to be a deterministic data fetcher. It can be an LLM
agent driving the block: a research-report vending machine, a conversational
database, a long-running synthesis tool. From woo's side, all plugs look the
same — they just speak the WS API.

This is **a presentation/bridge layer over an outside system**, not the
system itself. The analogy is cube.js: the block is a published surface;
the actual data and behavior live upstream. Many blocks; many plugs; one
shape vocabulary so any UI can render any block.

### What "read-only" means

Most data props are read-only to non-plug actors: the values come from
upstream, only the plug authors them. But blocks can also be interactive in
the normal woo sense:

- **Config / control props** are owner-writable (`writable_owner`). The
  weather block's `location`, the database block's `connection_alias`, a
  vending machine's `prompt_template`. The plug observes its own block's
  prop-write observations and reacts to control changes.
- **Query / command verbs** are public (or per-class). `:ask` forwards a
  free-form query to the plug. `:order` enqueues work for the plug. These
  create reactive plug behavior without bypassing the read-only-data
  invariant.
- **Subclass-level interactivity** is allowed. A `$block` subclass can ship
  arbitrary public verbs that mutate its own state, take actor input, or
  produce artifacts (notes, files, other objects). The base class just
  publishes data; subclasses extend the contract.

So the invariant is sharper: **the substrate doesn't author the data, but
the substrate fully owns the surface**. That's what makes blocks composable
with the rest of woo.

Plug connection modes:

- **Scheduled / disconnected.** Plug connects on a schedule (e.g., hourly),
  pushes, disconnects. Most blocks. Cheap.
- **Persistent.** Plug holds a long-lived WS, either because it pushes
  frequently (a sensor, a ticker) or because it must answer `:ask` queries
  on demand. While unplugged, conversational queries fail with "block is
  unplugged" and the block falls back to last-pushed data.

A block can be either; the same `$weather_block` class can run in scheduled
mode for the basic forecast and in persistent mode if you want to ask it
about other locations or hours.

## Scope: what we will actually build

Two base classes, two demo instances. Everything else is open-ended in
this note but explicitly out of scope for now.

**Base classes**

- `$block` — anchored data-display actor. Live property writes from a
  plug; canonical shape vocabulary; owner-writable config; no sequencing
  in the base.
- `$dispenser_block` — `$block` subclass that produces artifacts. Adds
  the parked-task `:order` / `:deliver` pattern, sequenced
  `order_placed` / `delivered` events, and `$note` creation with
  back-references.

**Demo instances**

- **Weather block** (`$weather_block`, in the living room). Plug calls
  `tomorrow.io` for the configured location; sets `current` (scalar),
  `forecast` (series, hourly out N hours), `history` (series, hourly
  back N hours), `last_pushed_at`. Scheduled mode: hourly push +
  disconnect.
- **Horoscope vending machine** (`$horoscope_block`, on the deck). A
  `$dispenser_block`. You `:order("scorpio")` (or some other prompt)
  and a few seconds later receive a `$note` containing the horoscope.
  Plug is a tiny LLM. The system prompt is a property on the block —
  owner-writable — so the same plug code drives whatever character the
  machine is configured to be.

These two demos exercise: scheduled push, owner config, sequenced order
flow, parked-task delivery, note-as-output with back-reference, and CF
Worker-hosted plugs end-to-end. Nothing else is required to validate the
pattern.

## In-world model

`$block` is an actor with the following constraints:

- **Anchored.** `:moveto` raises `E_PERM`. `:acceptable(target)` returns false
  except for wizard. The block is fixed at its declared `home`. Same shape as
  catalog-installed furniture; formalize as a `$block` mixin.
- **Own DO per instance.** `host_placement: "self"` on every `$block`
  descendant instance. Each block is independent at the substrate level —
  its eviction, persistence, and observation log are isolated.
- **No history, no sequence.** Property writes ride the **live** observation
  route, not sequenced. They do not enter the space log; reconnects re-read
  the current property values. Blocks with frequent updates do not bloat
  the log, and `/api/me` cursors do not need to track them.
- **Stays put when offline.** Properties persist across plug disconnect.
  Looking at an offline block shows last-set data plus a freshness indicator.
- **Plugged-in is derived, not stored.** Computed from `last_pushed_at` and a
  per-class freshness window (weather: 90 min; ticker: 60s). For persistent
  plugs the indicator also reflects whether a session is currently attached
  (so an attached-but-failing-to-fetch plug shows "plugged in, errors"
  rather than "stale"). No boolean prop.
- **Has an owner.** The actor who created the block. Owner can write
  configuration properties; the plug (acting as the block's actor) can
  write data properties; everyone else is read-only.

## Outside-world model

A plug is a small program that:

1. Connects to woo over WebSocket using an `apikey:` credential bound to the
   block's actor identity.
2. Calls `:set_property(name, value)` or `:set_properties({...})` on its block.
3. Optionally listens for verbs targeted at the block (for `:ask`-style query
   forwarding).
4. Disconnects (or stays attached, idle, if it wants).

A plug can run anywhere with network egress to woo: a laptop, a small VM, a
shared "plug container." It does not run inside a CF DO.

The **plug container** is a separate, simple Python process supervisor. It
reads a `plugs.yaml`, spawns one coroutine per plug, restarts on failure.
The container does not know woo concepts; it just runs N independent plug
clients.

## Credential management

This is the single most important operational topic and gets its own
section. Plug credentials live outside woo (in the Worker's environment)
and the lifecycle has to be deliberate.

### Token model

Today's `apikey:` is wizard-equivalent and not actor-scoped. Extend it:

- Auth registry stores `apikey` records as
  `(id, secret_hash, actor, label, created_at, last_seen_at?, revoked_at?)`.
- `authenticate("apikey:<id>:<secret>")` returns a session whose `actor` is
  the registered actor and whose perms are exactly that actor's perms.
- A token can be wizard-bound (existing behavior) or actor-bound (new). For
  blocks, the actor is the block itself.
- Token format: opaque random secret. No JWT claims, no embedded perms.
  All authority derives from the registry record's `actor`.
- Server stores `secret_hash` (argon2 or scrypt). The plaintext secret is
  visible exactly once: at mint time, in the response to `:mint_apikey`.

A plug session has exactly the block's perms — no more, no less. A
compromised token can corrupt its block's data; nothing else.

### Provisioning flow

Owner-driven. The block is the unit of credential management.

1. Owner creates the block: `@create_instance $horoscope_block` (or
   whatever authoring verbs are current).
2. Owner sets configuration props: `:set_property("location", ...)`,
   `:set_property("system_prompt", ...)`.
3. Owner mints the plug credential:
   ```
   :mint_apikey(label: "horoscope-cf-worker-prod")
   → { id: "ak_…", secret: "…visible-once…" }
   ```
4. Owner pastes the secret into the plug Worker's `wrangler.toml` /
   `wrangler secret put`:
   ```
   wrangler secret put WOO_APIKEY
   ```
5. Owner deploys: `wrangler deploy`. Plug starts, connects, begins
   pushing/listening.

The secret never appears in source control, never appears in logs, never
appears in `:look` output. Only at the response to `:mint_apikey`. If the
owner missed it, mint again.

### Rotation

`:rotate_apikey(old_id)` mints a new credential and revokes the old one.
The owner redeploys the Worker with the new secret. Brief gap (seconds)
during which the old credential is rejected and the new one is live.

Rotation triggers:

- Suspected leak.
- Periodic policy (90-day expiry per organization standards, configurable
  per-token; expired tokens reject with a clear `E_AUTH_EXPIRED` error so
  Worker logs surface it).
- Owner change (when a block changes hands; see below).

### Revocation

Three paths:

- **Explicit**: `:revoke_apikey(id)` by owner or wizard. Sets
  `revoked_at`; subsequent `authenticate` calls reject.
- **Block destruction**: when the block is recycled, all its keys revoke.
- **Owner change**: transferring block ownership rotates all keys
  automatically; the prior owner's pasted secrets stop working.

Revocation is immediate and durable. The session table is also walked: any
live session authenticated under the revoked token is closed.

### Storage at rest

- **Server-side**: `secret_hash` only, never plaintext. Argon2 or scrypt
  with sane parameters. Store revocation timestamps for audit (we don't
  delete records — an absent record and a revoked record are distinct).
- **Plug-side**: CF Worker secrets (encrypted at rest by CF, accessible
  only to the deployed Worker). For non-CF deployments, the operator's
  local secret manager — the contract is "the plug can read it, no one
  else can."
- **Owner-side**: never. Owners paste once and forget. If they need to
  re-paste, they rotate.

### Observability

Operators (and owners) need to see credential state to debug "why isn't
this plug working":

- `:list_apikeys()` — owner/wizard. Returns
  `[{id, label, created_at, last_seen_at, revoked_at}]`. No secret.
- `:look()` on the block surfaces the freshest `last_seen_at` across all
  active keys; a stale `last_seen_at` plus an active key means
  "configured but plug not running."
- The auth path records `last_seen_at` on each successful authenticate.

For the Worker side, log lines on connect failure should include the
`E_AUTH_*` error code so operators see "expired" vs "revoked" vs
"unknown id" without ambiguity.

### Open questions

- **Who can mint?** Owner, or wizard only? Lean owner — the token's authority
  is bounded to the block they own, so there's no escalation. Wizard
  retains override.
- **Single-active-key vs many?** Lean many (allows zero-downtime rotation,
  blue/green Worker deploys). The single-session-per-key constraint stops
  racing writers regardless.
- **Per-key perms tier?** Today: token = full block perms. Could later add
  per-key scopes ("this key can only call `:set_property`, not
  `:mint_apikey`") for defense-in-depth. Defer until needed.

## Verbs

Core `$block` verbs (most exposed via MCP `tool_exposed: true`):

- `:set_property(name, value)` — plug or wizard only. Writes one property,
  emits one live observation.
- `:set_properties(values)` — plug or wizard only. Bulk write, atomic, one
  observation. Avoids the N-round-trip pattern weather plugs would otherwise
  invent.
- `:get_data(name)` — for "detail tier" properties not shipped in
  `RoomSnapshot.contents` summary. Direct call; UI mounts and fetches lazily.
- `:look()` — public. Shows name, freshness derived from `last_pushed_at`,
  and a short description. The chat-level inspect of a block.
- `:mint_apikey()`, `:rotate_apikey()` — wizard only.
- `:ask(query)` — **trait, not part of `$block`**. Database block opts in.
  Parked-task pattern: the verb emits a `query` observation, the plug answers
  via `:answer(id, result)`, the parked task wakes. Timeout returns
  `E_TIMEOUT`. Most blocks don't need this and shouldn't pollute the agent
  tool list with it.

Property writability tiers are **enumerated in the class manifest**:

```json
{
  "writable_owner": ["location", "units", "forecast_hours", "label", "theme"],
  "writable_self":  ["current", "forecast", "history", "last_pushed_at",
                     "last_error"]
}
```

- `writable_owner` — set by the block's owner (creator) at create / move /
  reconfigure time. These are the per-class config knobs (the weather
  block's location and units; the database block's connection alias).
  Subclasses extend this list with class-specific config.
- `writable_self` — set by the plug, authenticated as the block's actor.
  These are the data props the UI renders.
- Everything else (`home`, `aliases`, `description`, system props) — wizard
  only. A compromised plug cannot overwrite these. A confused owner cannot
  either.

`:set_property[ies]` consults the appropriate list based on the calling
session's relationship to the block (owner vs self vs other). The substrate
enforces; the catalog declares.

## Data shape vocabulary

Cube.js works because every consumer knows the shape vocabulary. For blocks,
declare a small set of **canonical collection kinds** that generic UIs can
render without class-specific code. Strawman:

```ts
// table-shaped
{ kind: "table", columns: [{name, type}], rows: [[...]] }

// time-series
{ kind: "series", series: [{name, unit, points: [[ts, value], ...]}] }

// scalar with units
{ kind: "scalar", value: 72, unit: "°F", label: "current_temp" }

// geo
{ kind: "geo", points: [{lat, lon, props}] }
```

Block classes declare property schemas in the manifest:

```json
"properties": [
  { "name": "current_temp", "kind": "scalar", "unit": "°F" },
  { "name": "forecast",     "kind": "table",  "columns": [...] }
]
```

Generic `<woo-block>` custom element renders any of these. Specialized d3
components per class override when a richer view is wanted. Plug authors map
their backend shape into one of these kinds.

This is what makes "any UI can render just properties" actually true.

## Observation route

Base `$block` property writes from the plug emit live observations:

```ts
{ type: "block_data", block: id, name, value, kind?, ts }
```

Audience: the block and the room it anchors. Reducer (default): patch
`projection.observe(block).props[name] = value`. Per-class reducers can do
extra work (animations, derived props) but the default is one line.

Live route means: not in the space log, not sequenced, no replay. A reconnect
just re-reads the current property values via `/api/me`'s `here.contents`
summary plus on-demand `:get_data` fetches.

### Sequencing is per-class

The base class is live-only — that matches the "no history" semantics of
data display. Subclasses opt into sequenced observations for events that
must survive reconnect:

- A vending-machine block emits `order_placed` and `delivered` as
  **sequenced**. An order placed during a brief disconnect should still be
  fulfilled when the client reconnects.
- A long-running task block emits `task_started` and `task_finished` as
  **sequenced**, while progress ticks ride live.
- A weather block stays purely live — no event matters enough to replay;
  if you missed the 3pm push, you can re-look and get the current value.

This is not a substrate change; it's a verb-author choice. Base
`:set_property` calls the live observe path; subclass verbs can call
`observe_to_space(this, …)` directly for events that need sequencing.
Document this in the `$block` class doc-string so subclass authors
understand the default and the override.

## Property visibility tiers

With own-DO-per-block, each block in a room is a cross-host summary read
during `RoomSnapshot.contents`. With ten blocks in a room, that is ten
parallel host-bridge calls. To keep this bounded:

- **Summary tier.** Always inline in `RoomSnapshot.contents[].props`. Bounded
  to a few hundred bytes per block (name, kind, headline value, unit,
  `last_pushed_at`).
- **Detail tier.** Behind `:get_data(name)` direct call. Mounted UI fetches
  detail when the block surface is actually visible/focused.

Block class manifests declare which props belong to which tier. The substrate
filters `RoomSnapshot` accordingly. A block whose summary props exceed a few
hundred bytes is a manifest authoring error.

## Topology summary

```
+--------------------+   apikey ws    +-----------------+
| Plug Worker        | <----------->  | Per-block DO    |
| (CF Worker)        | set_properties | (CF DO, "self") |
| weather-plug       | block_data     |   props         |
| horoscope-plug     | live obs       |   verbs         |
+--------------------+                +--------+--------+
                                               |
                                               | anchored
                                               v
                                     +---------+---------+
                                     | Room DO           |
                                     |  (the_deck etc.)  |
                                     |  contents include |
                                     |  block summaries  |
                                     +-------------------+
```

Each plug is its own CF Worker, deployed independently with `wrangler`. The
plug's apikey is a Worker secret. Cron-triggered Workers handle the
scheduled-push case (weather); fetch-event or persistent-WS Workers handle
the on-demand case (horoscope's `:order` listener).

This keeps the blast radius small (one plug crashes, others are unaffected),
the deploy story simple (`wrangler deploy` per plug repo), and the demo
self-contained on the same provider as woo. Alternative hosting (GCP, a
shared Python container, on-prem) remains possible — the WS API doesn't
care where the plug runs — but isn't part of the build plan.

## Agentic plugs

A plug is just an authenticated WS client; it can be:

- **Deterministic** — scheduled fetch from a fixed API (weather block).
- **Reactive** — listens for query observations on its block and answers
  via `:answer` (database block).
- **Agentic** — an LLM-driven chain. Receives a prompt observation, runs
  whatever it wants outside woo (web search, code execution, model calls,
  other tool use), produces an artifact, returns it through the block's
  surface (vending machine).

From the substrate's view, all three are identical. The only difference is
what the plug does with the data and how long the round-trip is. Latency
budgets shift: a weather plug answers a `:ask` in <1s; a research-report
plug takes 30s–5min and the verb has to be parked, not awaited.

The parked-task pattern (substrate-supported) is the right shape for any
plug call whose answer is not immediately available:

1. Public verb is invoked, parks the task with an `order_id`.
2. Plug receives the order observation, starts work outside woo.
3. Plug calls `:answer(order_id, payload)` (or `:deliver(...)` for
   artifact-producing variants).
4. The parked task wakes; the original caller's frame resolves.

Timeout default: per-class (database `:ask`: 30s; vending `:order`: 10min).
On timeout the parked task wakes with `E_TIMEOUT` and the plug should still
be allowed to deliver later, just with the order marked stale.

## `$dispenser_block`: the artifact-producing subclass

A `$block` subclass for cases where the plug produces a moving artifact
rather than updating display data.

**Added properties**

- `writable_owner`: `system_prompt`. (Description is already on `$block`
  via `writable_owner`'s base; subclasses extend if they need more.)
- `writable_self` (plug): `pending_orders` (ephemeral; for `:status` lookups).

**Added verbs**

- `:order(request)` — public. Parks the task. Emits sequenced
  `{type: "order_placed", order_id, requester, request, ts}`.
- `:deliver(order_id, body)` — plug-only. Creates a `$note` with `body`,
  sets `produced_by = this`, moves to the requester's inventory, wakes
  the parked task. Emits sequenced
  `{type: "delivered", order_id, note: id, ts}`.
- `:cancel(order_id)` — requester, owner, or wizard. Wakes the parked task
  with `E_CANCELED`.
- `:status(order_id)` — public. Returns state from `pending_orders`.

The output `$note` carries `produced_by` and `produced_at`. UI renders a
"from: <block name>" chip that links back. That's it for the back-reference
story in v1; richer note interactivity is open-ended.

Order/deliver events are **sequenced** so a reconnect during an order
doesn't lose it. Everything else stays live. Why a note instead of a
self-prop: notes are portable, have UI/perms already, and survive multiple
orders. The block is a thin producer.

### Horoscope demo

`$horoscope_block` extends `$dispenser_block`. Lives on the deck.

- The owner sets two things: `description` (what the machine looks like)
  and `system_prompt` (what persona it speaks with).
- You `:order("scorpio")` (or whatever). The plug Worker reads
  `system_prompt + request`, calls a tiny Workers AI model, calls
  `:deliver` with the result.
- A `$note` lands in your inventory.

That's the whole demo. No `tone`, no `house_style`, no `follow_up_url`,
no `model` knob — the plug picks the model, the prompt is whatever the
owner wrote, the request is whatever the orderer typed. Adding knobs is
trivial later if needed; the demo's job is to show the pattern works
end-to-end.

## Persistent-WS blocks: scaling

A "live" or persistent block is one whose plug holds a long-lived WS
connection (high-rate data, on-demand `:ask`, or both). At ten of these the
substrate doesn't notice. At ten thousand, several costs need explicit
attention.

### Connection plane

Plug WS connections terminate at the gateway worker. CF Workers cap concurrent
connections per instance, but the **hibernating WebSocket API** is the right
shape: an idle WS sits at near-zero cost; the DO behind it can hibernate
without dropping the socket; a message wakes the DO. That converts the cost
from "always-on connection count" to "active push rate."

Implication: a quiet ticker (1 push/min) at 10k blocks costs ~10k tiny wakeups
spread over a minute. A noisy ticker (10 push/sec) at 100 blocks costs 1000
wakeups/sec — DOs stay warm. Match plug cadence to the class's actual data
freshness need; the cost gradient is steep.

### Per-DO storage write rate

`:set_property` persists. CF DO storage has a per-DO write throughput ceiling
(transactional, sub-millisecond at low rates, much slower under contention).
A 10Hz plug writing five props per push = 50 writes/sec to one DO, into the
range where storage becomes the bottleneck.

Add an **ephemeral property tier**: properties marked `ephemeral: true` live
in the DO's in-memory map only, never persist. On DO eviction they are gone;
the plug's next push re-populates them. For high-rate live data this is the
correct semantics — the data is upstream-of-truth, the block is a cache.

```json
"properties": [
  { "name": "current_price", "kind": "scalar", "ephemeral": true },
  { "name": "history",       "kind": "series", "ephemeral": false }
]
```

The substrate skips the storage write for ephemeral props. Cold DO returns
last-persisted data + the "unplugged" indicator until the plug catches up.

### Observation fan-out

Live observations don't enter the space log, so write cost is bounded. But
fan-out is still O(audience) per push. A block in `the_chatroom` with 50
subscribers, pushing 10Hz, generates 500 frames/sec from one block. Ten such
blocks: 5000 frames/sec.

Three mitigations, in order of complexity:

1. **Audience cache.** The room DO already computes audience for live
   observations. Memoize the audience list per `(space, version)` and reuse
   until membership changes. Eliminates per-push audience recomputation.
2. **Focused-audience tier.** Live observations from a high-rate block go
   only to subscribers who have **focused** the block in the last N seconds
   (the `woo_focus` mechanism already exists). The block emits "focused
   actor entered/left audience" events; the audience set is dynamic. Idle
   observers in the same room don't get the firehose.
3. **Pub/sub split.** If a block pushes at >1Hz to >100 subscribers, peel
   the live channel out of the substrate-routed observation path entirely
   and ship it through CF Pub/Sub or a dedicated WebSocket fan-out DO. Use
   the substrate for sequenced events only. Defer until measurement
   demands it.

Most blocks won't need any of this. (1) is cheap and worth doing
preemptively. (2) is the right answer for things like dashboards in busy
rooms. (3) is for genuinely demanding cases.

### Cross-host audience for live blocks

Block-DO pushes; audience lives on the room-DO. Computing audience requires
a cross-host read each time, *unless* subscribers are mirrored. Use the
existing space_subscriber mirror, refreshed on subscribe/unsubscribe events.
The block-DO holds a local view of the room's subscribers and fans out
locally. Already the pattern for cross-host space audiences; nothing new
needed for blocks.

### Reconnect storms

Gateway eviction or rolling deploy disconnects every persistent plug
simultaneously. Plug Workers must implement randomized backoff (1–60s
uniform jitter on first attempt, exponential on subsequent failures).
Server-side: rate-limit reconnect-auth at the gateway to a sane per-second
ceiling. The first-class plug-Worker template should bake this in.

### Per-plug DO cold-start cost

Each block's DO has its own bootstrap (catalog state hydrate, session record
re-create). At 10k blocks across several rooms, simultaneous cold start
under traffic produces a thundering herd. Practical mitigations:

- Lazy mount: a block's DO only cold-starts when its data is actually read
  (someone enters the room and `RoomSnapshot.contents` reaches it, or its
  plug pushes). Idle blocks stay hibernated.
- Bootstrap leanness: `$block` and its descendants should compile to small
  woocode. Heavy class state lives at runtime, not at bootstrap.

### Numbers we should validate

Before committing to "every block its own DO" at scale, run a smoke test:

- 1000 blocks, each with a persistent plug pushing 1 small property/min.
  Measure: WS overhead, DO hibernation behavior, observation fan-out CPU,
  storage write rate.
- 10 blocks, each pushing 10 props/sec. Measure: per-DO storage saturation,
  audience-fan-out cost, plug-side backpressure.
- 1 block pushing 100Hz with `ephemeral: true`. Measure: with no storage
  writes, where does the next bottleneck land?

These three points cover the cost regimes: many-quiet, few-loud, single-very-loud.
Without them the design's "own DO per block" choice is taken on faith.

## Owner and creation

Block creation is just `@create_instance $weather_block`. The standard
authoring/builder verbs apply. After creation, the owner sets configuration
properties (`location`, `units`, ...) using `:set_property` (their session,
their actor as `caller`, the prop in `writable_owner`).

Then the owner mints an apikey via `:mint_apikey()` and pastes the secret
into the plug Worker's secret store (see Credential management).
`wrangler deploy` and the plug starts.

Reconfiguration is the same path: `:set_property` on a config prop. If a
config change requires the plug to re-fetch (e.g., `location` change),
either:

- The plug subscribes to observations on its own block and reacts to a
  `block_config_changed` observation by re-fetching;
- Or the substrate emits `:reconfigure(prop_name, new_value)` as a sequenced
  observation the plug listens for.

The first is simpler — the plug already gets observations for any `:set_property`
call, including its own, so it can filter by who-set-it.

Class-specific config props are declared in the class manifest's
`writable_owner` list. Subclasses extend the parent's list. Generic block
UIs render an "owner config" panel dynamically from the manifest;
class-specific UIs can override.

## Open decisions

Things to settle as the build lands. Most have a leaning already.

1. **Apikey extension shape.** Extend existing `apikey:` records with an
   `actor` column, or introduce a parallel `block:` token class. Lean
   extend — fewer auth code paths.
2. **Property schema validation.** Validate writes against declared kind?
   Lean yes — fails loud during plug development.
3. **Summary vs detail size enforcement.** Substrate-enforced cap, or
   convention. Lean enforced (truncate-and-warn, not reject).
4. **`:order` parking timeout default.** 60s for horoscope; class-level
   override with a small default.
5. **Concurrent plug sessions per apikey.** Reject second connect (single
   active session per key) or allow many for blue/green deploy? Lean
   allow-many at the apikey level, single-session-per-block enforced
   separately if at all.
6. **Who can mint a plug apikey?** Owner. Wizard override.
7. **Ephemeral prop on plug detach.** Stay until DO eviction; UI marks
   stale. Don't clear.
8. **Reconfigure protocol.** Plug listens to its own block's observations
   and reacts. No new typed event needed.
9. **Plug observability.** `last_error` is a `writable_self` prop the plug
   writes on failure; `:look` surfaces it. Already implied; confirm.
10. **Generic vs class-specific UI ordering.** Frame resolution distance
    handles this; class-specific outranks generic. Smoke test.

## Build order

What we will actually do, in order.

1. **Actor-bound apikey.** Extend auth registry to record `(id, hash,
   actor, label, created_at, last_seen_at, revoked_at)`. `authenticate`
   returns a session with the registered actor's perms. `:mint_apikey`,
   `:rotate_apikey`, `:revoke_apikey`, `:list_apikeys`. **Blocker for
   everything else.**
2. **`$block` base class.** Anchored verbs; `:set_property`,
   `:set_properties`, `:get_data`, `:look`; `writable_self` and
   `writable_owner` enforcement; ephemeral property tier; summary/detail
   tiers; live observation route for `block_data`.
3. **Canonical kinds and generic `<woo-block>` UI.** `scalar | series |
   table | geo` recognized; generic component renders any of them;
   text-dump fallback for unknown kinds.
4. **`$weather_block` + Worker plug.**
   - Catalog: class, manifest, owner-config panel, current/forecast/history
     props.
   - Plug: CF Worker with cron trigger, hourly. Reads tomorrow.io,
     pushes via WS, disconnects.
   - Demo: weather block in the living room, working end-to-end.
5. **`$dispenser_block` base class.** Parked-task `:order` / `:deliver`
   pattern; sequenced `order_placed` / `delivered` events; `$note`
   creation with back-references; `:cancel`, `:status`.
6. **`$horoscope_block` + Worker plug.**
   - Catalog: class extending `$dispenser_block`. One owner-writable
     `system_prompt`. Description via the base block.
   - Plug: CF Worker listening for `order_placed`, calls Workers AI tiny
     model with `system_prompt + request`, calls `:deliver`.
   - Demo: horoscope machine on the deck, end-to-end.
7. **Audience cache for live observations.** Memoize per
   `(space, version)`. Validate with a small smoke (10 blocks, 1Hz,
   10 subscribers — sized to demo workloads, not the persistent-WS
   scaling section's hypothetical 10Hz × 50).
8. **Credential-management UX polish.** `:list_apikeys` and `:look`
   surface `last_seen_at` clearly; expired/revoked errors carry distinct
   `E_AUTH_*` codes; rotation flow documented in catalog README.

Steps 1–4 are the weather demo. Steps 5–6 are the horoscope demo. Step 1
is the actual blocker — once apikey is right, the catalogs are
straightforward.

The persistent-WS scaling work, the database block, the dashboard
composition, and the audience-tier escalation paths are explicitly **not**
in this build. Their write-up exists so the design is anticipating them,
not so we build them now.

## Open-ended (not in build, here for orientation)

These are real opportunities the design anticipates but doesn't commit to.
The note keeps them so future iteration has a starting point, not so we
ship them.

- **Database block.** Mongo / Postgres plug with `:ask` forwarding to a
  real query engine. Validates persistent mode, exercises table/series
  shapes through real-world data. Forces the externalized blob storage
  question if results get large.
- **Externalized blob storage.** Content-addressable blob store for
  multi-MB plug payloads. Property holds a handle; bytes live in R2 or
  similar. Needed when the first big-data plug arrives.
- **Block composition / dashboards.** A "dashboard block" reading other
  blocks' props. Pure woocode; no new substrate. Layout (`$dashboard_block`
  vs `$widget_block`) is a UI manifest size-hint question.
- **Pub/sub for very-high-fanout blocks.** Peel live channels out of the
  substrate-routed observation path for >1Hz × >100-subscriber cases.
  Audience cache + focused-audience tier likely cover real workloads
  first.
- **Connection-mode hint.** Class-level
  `connection_mode: "scheduled" | "persistent" | "either"` for smarter
  hibernation and UI cues. Inferable from `ephemeral: true` for now.
- **Interactive notes.** First-version dispenser notes carry only
  back-reference props. Later, notes can carry verbs (`:cite_section`,
  `:expand`) that route back to the producing block, building citation
  graphs. The substrate already supports this; defer until something
  wants it.
- **Plug as full agent runtime.** When the plug is an LLM doing tool use,
  the tool surface might want to include other woo verbs (the agent
  reaching back into the world). Block-as-actor has its perms, not the
  requester's — a real auth story to design before agentic plugs become
  common.
- **Cross-version plug ↔ block compatibility.** Plug declares supported
  block-class versions; mismatches surface in `:look` as "incompatible
  plug." Defer until the first breaking schema change.

## Why "presentation, not source" matters

The block does not store history, does not query upstream, does not own the
data lifecycle. It is the published shape — last write wins, freshness is a
timestamp, missing data is a UI fallback. This makes:

- the substrate small (no new persistence model, no new query engine);
- plugs trivial to write (auth, push, done);
- UIs uniform (one shape vocabulary);
- the world coherent under partial failure (plug down ≠ world down).

Composition (dashboards, derived metrics, dataflow) is a layer above this
that reads block surfaces. Keep that layer outside `$block` itself; the
substrate just publishes shapes, and downstream consumers — woocode verbs,
client components, agents via MCP — compose them.
