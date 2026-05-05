# Sprawl scale — vicinity projection

## Context

We're heading to:

- ~25 rooms in the main "house" grounds, all connected via exits.
- Each actor gets personal rooms and personal objects — thousands of
  objects total once the world has tens of users.
- Per-actor objects and rooms should be **discoverable, not enumerable**:
  the rest of the world doesn't need to know they exist until someone
  actually encounters them.

The substrate already supports per-room hosts and Directory routing, so
the durable side scales fine — adding 100 more cluster DOs is cheap.
What doesn't scale is the **projection** model: today `/api/state`
returns every object in the world, fans out to every cluster host, and
re-runs on every applied frame. That breaks long before 100 hosts.

## Where the cost actually lives today

`world.state(actor)` walks all of `world.objects`:

```
objects: Object.fromEntries(Array.from(this.objects.keys()).sort()
  .map((id) => [id, this.stateObject(id, actor)]))
```

That alone is O(N_objects). The gateway then fans out
`/__internal/state` to every cluster host to enrich slices it doesn't
own — O(N_hosts) RPCs. Both numbers are small now (90 objects, 6 hosts)
and big in the proposed world (thousands × hundreds).

The earlier walk metric run already showed `/__internal/state → host`
as the dominant per-refresh cost (90 RPCs in 90 seconds across 5
cluster hosts; max 412ms). Multiply hosts by 20 and the gateway is
doing >1000 cross-host RPCs per refresh, almost all of them returning
data the actor will never look at.

## The shape we need

**Project only the actor's vicinity.** Not the world. The vicinity is:

- The actor itself, with full props.
- `actor.location` (the room the actor is in), full descriptor +
  contents list.
- All objects in `actor.location.contents` — summary (id, title,
  one-line description, owner, portable flag).
- All objects in `actor.contents` (the actor's inventory) — summary.
- All objects in `actor.focus_list` — summary (the existing MCP focus
  set is exactly this: "things I've explicitly told the system I care
  about right now").
- Catalog metadata (name, version, installed_at) — flat list, no class
  detail expanded.
- `chat_rooms` and similar tab-navigation lists — just `[id, name]`
  pairs, not full descriptors.

That's ~10s of objects regardless of how big the world gets, and most
of them live on the actor's host or the room's host. Fan-out drops
from O(N_hosts) to O(1 or 2 hosts).

When the actor moves rooms, the new vicinity is recomputed against
the new location. When they look at someone or pick something up, the
new id flows in via the look result or a `taken` observation. The SPA
keeps a cache keyed by id, expanding incrementally.

## Surface changes

### Substrate

- New `WooWorld.vicinityState(actor)` returning the shape above. Lives
  alongside `world.state(actor)` for now; the gateway routes
  `/api/state` to it (or to a new `/api/state/vicinity` route while
  the old one is kept for compatibility).
- The vicinity build needs cross-host fetches for `here` and any
  remote items in contents/inventory. Today's
  `composeRoomLook(actor, room)` already does this and batches via
  `remote-describe-many`. Vicinity reuses that primitive.
- The full-world `state()` stays for wizard-only debug / `/api/admin/state` —
  someone has to be able to introspect everything when working on the
  substrate, and that someone is `$wiz`.

### REST

- `/api/state` returns the vicinity shape. Same auth, same
  `actor_routes` field for navigation, same catalogs summary.
- `/api/state?full=1` (or a separate `/api/admin/state`) gates the
  legacy world projection on wizard-only.
- `/api/objects/:id` (already exists) is the lazy-expand path. SPA
  fetches detail on demand for an object the user clicked / looked at.

### SPA

- `state.world.objects` becomes a discovered-objects map rather than
  the full world. Expand on:
  - Vicinity refresh (location changed, contents changed, focus
    changed).
  - `looked` / `who` / `taken` / `dropped` / `entered` / `left`
    observations naming new ids (just summary fields).
  - Explicit `/api/objects/:id` lookups when the user clicks an id
    we haven't seen before.
- `adaptWorld` no longer iterates "all objects" to derive
  `chatRoom` / `dubspace` / `pinboard` etc. Those come from the
  catalog metadata + a small "rooms" list in the vicinity payload.
- Refresh trigger: only on observations whose `space` is in the
  actor's `presence_in`, plus their own room/inventory mutations.
  Today every applied frame schedules a refresh; that doesn't scale.

### Catalogs

The vicinity payload's catalog summary is just
`{ catalog, version, installed_at }[]`. Class lists are NOT in the
vicinity. SPA fetches the class list per-catalog on demand
(`/api/catalogs/:name`) when it actually needs it (planner load,
class browser, etc.).

## What this DOES NOT solve

- Mass message broadcast to a 1000-actor room — still bound by the
  room host's `hostQueue`. The earlier scale-analysis fixes
  (subscribers index, sockets-by-actor index, etc.) handle that
  layer; vicinity is orthogonal.
- Cross-host write contention on hot rooms — same.
- Directory write throughput at object-creation storms — see below.

## What this enables but doesn't require

- **Per-actor "houses".** Each actor can have a personal `$space`
  anchored to them. Other actors only encounter it by visiting,
  receiving an invitation, or following a link. No global enumeration
  needed.
- **Sharded Directory.** Total object count grows linearly with
  per-actor objects. Today's single Directory DO holds all routes —
  fine for hundreds of thousands of rows in SQLite, but a real bottleneck
  for create-storms (signup waves, mass imports). Shard by id prefix
  when create rate exceeds ~1k/s sustained. Deferrable: SQLite
  lookup-by-id has no scan cost, and the gateway caches host routes,
  so steady-state read traffic doesn't depend on directory size.
- **Stateless agent traversal.** Agents enumerating "all rooms" can
  no longer do that by reading `world.objects` — they have to walk.
  This is correct for the LambdaMOO-shaped model.

## Migration shape

1. **Add `vicinityState(actor)`** in core. Behavior-tested against the
   walk-through scenarios.
2. **Wire `/api/state` to use it** behind a flag (`?full=1` for legacy).
   Postflight + tests still target the full path.
3. **Update SPA** to consume the vicinity shape. Lazy-expand on demand
   for ids it doesn't have.
4. **Sweep adaptWorld** for "iterate world.objects" patterns and
   replace with vicinity-driven derivations.
5. **Flip default** of `/api/state` to vicinity once SPA + tests are
   green. Remove the flag in a later commit.

Each step is independently shippable; the SPA can run against the
old projection until the vicinity payload is ready.

## Decision needed before implementation

The shape of vicinity payload is the hinge. Strawman fields:

```json
{
  "server_time": 1777929400000,
  "actor": "guest_7",
  "actor_state": { /* full describe + props */ },
  "here": {
    "id": "the_chatroom",
    "title": "Living Room",
    "description": "...",
    "exits": { "se": "exit_living_room_southeast", ... },
    "subscribers": ["guest_5", "guest_7"],
    "contents": [{ "id": "the_couch", "title": "Couch" }, ...]
  },
  "inventory": [{ "id": "the_towel", "title": "Deck Towel" }],
  "focus": [{ "id": "the_pinboard", "title": "Pinboard" }],
  "rooms": [{ "id": "the_chatroom", "name": "Living Room" }, ...],
  "catalogs": { "installed": [{ "catalog": "chat", "version": "0.1.0" }, ...] },
  "object_routes": [...]
}
```

Open questions:

- Does `rooms` (chat-tab list) belong in vicinity, or is that a chat
  catalog concern that should be a separate `/api/catalogs/chat/rooms`
  call? Leaning: keep navigation-shaped lightweight lists in the
  vicinity payload — the SPA needs them to render the tab strip and
  changes are rare.
- How big should `subscribers` go in the vicinity? Currently it's
  the full list, used by chat to render "who's here". For a 1000-
  person room that's a 1000-element list in every refresh. Options:
  truncate to first N + count, or keep full — it's the same data
  the look_self already returns. Leaning: keep, with the lazy scrub
  already trimming stale entries.
- Should `focus` come from `actor.focus_list` or be reduced to ids
  the actor has interacted with recently? The MCP focus_list is
  user-set, so probably yes — it's already a curated list.
