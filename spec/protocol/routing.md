---
date: 2026-05-03
status: draft
---

# Object addressing and routing

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

How woo objects are addressed via URL, how clients dispatch renderers
from class hierarchy, how URL state and per-actor MCP focus mirror
each other, and the verb conventions that let cross-object navigation
generalize across bundled and third-party content.

The substrate primitives this depends on (object id forms, corenames,
actor focus list) are normative in
[semantics/objects.md](../semantics/objects.md),
[semantics/identity.md](../semantics/identity.md), and
[semantics/features.md](../semantics/features.md). The wire endpoints
this builds on are normative in [protocol/rest.md](rest.md). This
document defines the URL-shaped client view and the navigation
conventions on top of those substrates.

---

## AR1. Motivation

Today's bundled SPA holds per-tab state in memory: the selected task,
focused pin, current dubspace scene. None of it survives a refresh,
none of it is shareable as a link, and none of it is addressable from
MCP. Cross-tab navigation (kanban card → task in taskspace) is
hardcoded in the SPA — there's no mechanism for a third-party catalog
or an external agent to express the same jump.

Goal: a single addressing model that

- gives every navigation a URL,
- maps URL ↔ MCP focus state 1:1,
- lets new catalog classes acquire rendering and linking without an
  SPA code change,
- stays human-readable when the object has a corename or seed name,
- promotes cleanly to ULIDs once the substrate's deterministic id
  allocator lands.

---

## AR2. URL form

The canonical URL is `/objects/<id>` with an optional view hint.

```
/                                          client root / dashboard
/objects/$wiz                              corename
/objects/the_pinboard                      catalog-seed instance name
/objects/01H7QXKM6Z3KS9F2YR5W8ABCDE         ULID (post-allocator)
/objects/$me                               dynamic corename → actor
/objects/obj_pin_3?view=kanban             same pin, kanban renderer
```

The `<id>` segment is one of the four address forms enumerated in
[rest.md §R3](rest.md#r3-object-addresses):

- `$<name>` — corename. URL-safe; no percent-encoding.
- `<seed_name>` — catalog-seed instance name (`the_pinboard`,
  `the_chatroom`, `obj_pin_3`).
- `<ulid>` — Crockford base32, when the deterministic allocator lands
  (per [reference/cloudflare.md §R14.5](../reference/cloudflare.md#r145-id-determinism-status)).
- `<runtime_counter>` — current `obj_*` / `the_*` runtime-counter form;
  honoured for compatibility, gradually displaced by ULIDs.

All four resolve through the same path the REST surface uses today
(`resolveRestObject`). URLs that arrive through a corename remain
correct when the underlying object's id changes — the corename is the
indirection.

The corresponding API path for a client to fetch the object's state is
`/api/objects/<id>` ([rest.md §R6](rest.md#r6-object-shape)). The
client-facing URL is `/objects/<id>` (no `/api` prefix); the worker
serves the SPA bundle for any non-API path via the existing
`not_found_handling = "single-page-application"` policy in
`wrangler.toml`.

---

## AR3. View hint

`?view=<name>` is an optional client hint about which renderer to use
when an object supports more than one. The runtime ignores it; the
client dispatches locally.

```
/objects/the_pinboard                      default renderer (board view)
/objects/the_pinboard?view=list            same object, list view
/objects/obj_pin_3                         pin detail in pinboard
/objects/obj_pin_3?view=kanban             same pin, kanban renderer
```

Unknown view values fall back to the class default (AR4). The query
string does not propagate to API calls — the API is view-agnostic.

---

## AR4. Renderer dispatch

A client picks a renderer from the addressed object's class hierarchy.
The class → renderer mapping is **client-side state**; the substrate
neither tracks it nor enforces it. The bundled SPA ships a default
table approximately:

| Class chain | Default renderer |
|---|---|
| `$chatroom`, `$persistent_chatroom` | chat |
| `$pinboard` | pinboard (spatial) |
| `$kanban_board` | kanban |
| `$taskspace`, `$task` | taskspace |
| `$dubspace` | dubspace |
| `$generic_editor`, `$verb_editor` | editor |
| `$builder`, `$programmer` | IDE / authoring |
| (anything else) | fallback: `:describe()` + verb list |

For an object whose class isn't recognised, the fallback renderer
surfaces the standard introspection output and the actor-callable verb
set. This means addressing an unknown object never 404s in the client;
it degrades to a generic view.

A `?view=` value the client knows about overrides the default. Values
the client doesn't recognise fall back to the class default rather
than failing.

---

## AR5. URL ↔ MCP focus

`$actor.focus_list` is the canonical "what am I looking at" state per
actor (per [features.md / mcp.md](../protocol/mcp.md)). URL state in
any client is a presentation of focus:

- A client navigating to `/objects/X` SHOULD call `$me:focus(X)` (or
  the equivalent) before rendering, so the actor's focus reflects the
  navigation.
- An agent calling `$me:focus(X)` causes any client connected as the
  same actor to navigate to `/objects/X` (subject to that client's
  own UX — a paused or backgrounded tab MAY queue rather than jump).

Two consequences worth pinning:

- **Bidirectional unification.** SPA URL changes and MCP focus changes
  drive the same per-actor state. An agent and a human sharing an
  actor see the same world position.
- **Primary vs. auxiliary focus.** The focus list is bounded (default
  32 per `$actor.focus_list` semantics). The URL reflects only the
  *primary* focus — typically the most recently navigated-to object.
  Agents that focus additional objects (peripheral monitoring) keep
  those in the focus list without affecting the URL.

A future refinement separates "primary focus" (URL-bound) from
"auxiliary focus" (additional reachability) explicitly. For v1, the
client implements primary-focus tracking locally; the substrate's
`focus_list` carries everything.

---

## AR6. The `:locate()` verb convention

Every renderable class SHOULD define a direct-callable `:locate()`
verb that returns a navigation hint:

```woo
verb $task:locate() rxd {
  return {
    object: this,
    view: "taskspace",
    parent: this.taskspace,
    title: this.title
  };
}

verb $pin:locate() rxd {
  return {
    object: this,
    view: "pinboard",
    parent: location(this),
    title: this.name
  };
}
```

Return-shape contract:

| Field | Required | Purpose |
|---|---|---|
| `object` | yes | The object's own id (typically `this`). What the URL addresses. |
| `view` | optional | Hint mapping to a renderer or `?view=` value. Default if omitted: the class's renderer. |
| `parent` | optional | The "containing" object for breadcrumbs and back-navigation. Often the room or space the object lives in. |
| `title` | optional | Short label for navigation UI (link text, tab title). |

Callers with an objref that want to construct a navigation target —
the SPA emitting a "share link," an MCP agent surfacing a result —
call `:locate()` and build the URL from the result. The convention
keeps URL construction off the client side: the class decides what
"a link to me" means.

`:locate()` is direct-callable: navigation generation should be cheap
and side-effect-free.

---

## AR7. Cross-view bridge verbs

Some navigations are between *different objects* that share a domain
relationship — a kanban card and the task it represents, a pinboard
note and an associated $forum_post, a dubspace control and the
preset it currently embodies. These are per-class and optional.

Convention: `:open_in_<view>()` returns the related object's id (or
its `:locate()` hint).

```woo
verb $kanban_card:open_in_taskspace() rxd {
  return this.task_id;
}

verb $pin:open_in_taskspace() rxd {
  // Pins do not bridge to taskspace.
  return null;
}
```

Return:

- An objref → client navigates to `/objects/<that-id>`.
- A locate-shaped map (with `object` and optional `view`) → client
  uses it directly without re-resolving via `:locate()`.
- `null` → no related object; the bridge isn't applicable for this
  instance.

The client's "open in X" affordance is dispatched by checking which
`:open_in_<view>()` verbs the current object exposes (via
`:describe()` or `match_verb`). Class authors advertise their bridges
without the client needing per-class wiring.

The view name in the verb name (`taskspace`, `kanban`, etc.) matches
the renderer registry's view ids (AR4). New views land by adding to
the registry and (optionally) implementing bridges from related
classes.

---

## AR8. Default-object resolution

`/objects/<class_name>` for "show me a default instance of this
class" is tempting but ambiguous (which instance?). For v1, URLs MUST
address concrete objects: `/objects/the_pinboard`, not
`/objects/$pinboard`.

Convenience aliases (e.g. `/chat` → `/objects/the_chatroom`) MAY be
implemented as client-side redirects. They're not normative in this
spec; treat them as SPA UX sugar.

---

## AR9. ULID surfacing

When the deterministic allocator lands (per [reference/cloudflare.md
§R14.5](../reference/cloudflare.md#r145-id-determinism-status)):

- Catalog seeds and corenames keep their names. URLs that addressed
  `the_pinboard` or `$wiz` continue to work.
- Runtime-created persistent objects emit ULIDs as their canonical
  id. URLs for those objects start showing the ULID form.
- `:describe()` returns the ULID in its `id` field; clients display
  it in detail panes and "copy link" affordances.
- The "share link" affordance prefers the most stable form available
  for the object — corename if present, else seed name, else ULID,
  else the runtime counter form.

URLs are **the** primary surface where ULIDs become user-visible.
Today's `obj_the_pinboard_3`-style ids are deployment-local; ULIDs
are globally unique and survive world resets and snapshot moves.
Bookmarking `/objects/01H7QXKM…` is durable across that lifecycle in
a way bookmarking `/objects/obj_the_pinboard_3` is not.

The URL bar may show whichever form the user navigated through; the
*share / copy link* affordance emits the canonical form from
`:locate().object`. Class authors who want the share link to be a
specific form override `:locate()` to return the preferred id.

---

## AR10. Identity and access

URLs require an authenticated session to resolve any object the actor
can read. Hitting `/objects/X` without a session falls through to the
client's auth flow; on success the client navigates to the requested
URL.

Sharing a URL does NOT share the session. Recipients authenticate as
themselves and see the addressed object subject to their own read
permissions. A URL that resolves an object the recipient can't read
SHOULD render a "no access" view (the URL is valid; the actor's
authority is what's missing) rather than a hard 403 page. This avoids
leaking object existence as an authorization-side oracle.

URL contents do not carry actor-scoped data. `/objects/$me` resolves
*per-recipient* — sharing it gives the recipient a link to their own
actor, not the sharer's.

---

## AR11. History and back/forward

Clients SHOULD use the browser History API (`pushState` /
`replaceState`) so back / forward work natively. No additional
substrate hooks are needed; navigation is purely client state plus a
focus update on the server.

Restoring a tab from history MUST re-fetch the object's current state
(the world may have moved since the URL was first visited). Clients
SHOULD NOT cache `/api/objects/<id>` responses in URL-restoration
flows for longer than a few seconds.

---

## AR12. Conformance

A client conforms to this section if:

1. URL form `/objects/<id>` resolves the addressed object and
   dispatches to the matching renderer (AR2, AR4).
2. In-app navigation updates the URL via History API or equivalent
   (AR11).
3. URL changes update `$actor.focus_list` to include the addressed
   object as the primary focus (AR5).
4. `?view=<name>` is honoured when the renderer recognises the value;
   unknown values fall back to the class default (AR3, AR4).
5. Navigation generation for "share link" and cross-view jumps
   consults `:locate()` rather than constructing URLs locally (AR6).
6. "Open in X" affordances dispatch via `:open_in_<view>()` rather
   than per-class hardcoding (AR7).

A class conforms to this section if:

1. It defines `:locate()` returning at minimum `{object: this}`
   (AR6).
2. It MAY define `:open_in_<view>()` per AR7 for cross-view bridges
   it supports.

The substrate is unchanged by this spec — every requirement is on
clients and class authors.

---

## AR13. What's not in v1

Each item below is identified, deferred, and noted with the reason it
isn't in this revision.

- **Class → renderer registry as a runtime mechanism.** The bundled
  SPA hardcodes its registry. A pluggable mechanism — per-catalog
  `ui_manifest.json` declaring `class → renderer` mappings, or a
  `.ui_renderer` property the SPA reads — is deferred until
  third-party catalogs need their own renderers. For v1, adding a new
  bundled-catalog class requires an SPA update.

- **Default-instance resolution from a class URL.**
  `/objects/$pinboard` ("show me a default pinboard") is not
  normative; clients MUST address concrete instances. Convenience
  aliases live in client-side redirect tables (AR8). A spec-level
  convention can be added if the pattern proves consistent across
  catalogs.

- **ULID-canonical IDs.** Awaits the substrate-level deterministic
  allocator (`reference/cloudflare.md §R14.5`). All other parts of
  this spec are forward-compatible: when ULIDs land, URLs auto-track
  via the existing four-form id resolution (AR2).

- **`:locate()` and `:open_in_<view>()` in catalog tooling.** Class
  authors hand-write these verbs today. A catalog-manifest field that
  auto-generates them from declared metadata would be useful but
  isn't speced.

- **URL fragments (`#` anchors).** Used today only for in-page
  navigation; not part of this contract. A future spec MAY define
  `#section-<id>` for deep-linking inside a renderer.

- **Cross-deployment URL portability.** `/objects/the_pinboard` means
  a different object on a different deployment. URL portability is
  federation-v2 territory.

- **Backward-compatible URL aliases for renamed or recycled objects.**
  If `the_pinboard` is recycled and the corename is reassigned, old
  URLs go to the new object. No alias / redirect ledger is
  maintained.

- **MCP-side bookmarks / saved-URLs.** Could be a future
  `$actor.bookmarks` property; not in v1. Per-actor state already
  exists for focus; bookmarks are a separate persistent store.

- **Primary-vs-auxiliary focus split (AR5).** v1 clients implement
  primary-focus tracking locally; the substrate's `focus_list`
  carries everything. A clean substrate split into "primary" and
  "auxiliary" focus is a follow-up.

- **Server-side rendering / SEO.** A non-SPA HTML response for
  `/objects/<id>` (so crawlers and link-preview unfurlers get
  metadata) is not in scope. The class's `:describe()` output is the
  natural data source if it ever lands.

- **Auth-bypassed public-share URLs.** "Anyone with this link can
  see this object" requires a separate sharing capability (token in
  URL, capability ledger). Not in v1; current rule is recipient
  authenticates and reads under their own permissions (AR10).
