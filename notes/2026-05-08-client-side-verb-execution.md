# 2026-05-08 — client-side verb execution

A design conversation that's worth picking back up later, not now.

## Origin

Coming out of the tasks UI work, where the kanban + admin client code
has accumulated a lot of class-specific knowledge that arguably
belongs near the `$task` / `$task_registry` definitions:

- Status copy ("ready", "complete", "dropped", "held by X").
- Verb names ("claim", "release", "drop_terminal", "set_name").
- Per-verb argument shapes and validation messages.
- Display formatting for cursor badges, log entries, obligation rows.
- The decision rules in `stateColumnFor` (which column does this task
  live in?) — basically a tiny version of `:cursor` + terminal/complete
  state, hand-coded in TS.
- Optimistic-update logic that mirrors what the server's verb does
  (e.g., flipping `task.location = actor` for `:claim`, dropping a
  task from the local listing on `:drop_terminal`).

## The proposal

> Run a subset of object verbs in the browser to validate user input
> and update local state, before the server roundtrip. The "subset" is
> the verbs that don't need cross-object messaging — pure shape and
> permission checks against projected state.

Possible benefits:

- One source of truth for invariants. Catalog authors declare them
  once in woocode; both server and client honour the same rules.
- Latency: synchronous client-side validation is instant, the server
  roundtrip is 50–200ms.
- Pulls user-facing strings (and the predicates that pick which one
  applies) back into the object, where they belong.
- Levels up the expressiveness of woocode for validation — gives
  authors a real reason to write rich constraint code.

Possible costs:

- A TinyVM-in-browser is a real chunk of code (interpreter, builtins,
  DSL compiler if we ship `compile_source`). Bundle size grows.
- Two execution environments means two bug surfaces. Anywhere the
  server and client builtins drift (`now()`, casefolding, randomness,
  ambient `actor`, projection freshness vs. authoritative state), you
  get "passes locally, rejected by server" failure modes that are
  hard to debug.
- The verbs that benefit are exactly the ones that *don't* need
  cross-object reach — i.e. mostly cheap shape checks. Permission
  checks (`is_writable_by`, "do you hold the cursor role") usually
  need more than the projection.
- Doesn't help with the genuinely hard validations: picking users
  for owner, group resolution, anything that needs a search or a
  remote read.

## Compromise stack (cheaper to costlier)

When the topic comes back, evaluate in this order:

1. **Server-rendered strings on the wire.** The server pre-computes
   user-facing strings (`status_text`, `holder_label`, `kind_label`)
   and ships them as fields on the listing/detail response. Client
   becomes a thinner shell with no interpreter. Covers most of the
   "should be in the object" complaint for tasks today.
2. **Declarative validation metadata in `arg_spec`.** Add length
   caps, type, regex, set-membership, etc. to the verb metadata.
   Server validates from it; client generates JS validators from
   the same source. Covers the easy validation cases without any
   in-browser substrate.
3. **TinyVM in browser.** Only if (1) and (2) leave a meaningful
   chunk of catalog logic still stuck in client code. At that point
   the ROI is clear and the investment justified.

The risk in jumping to (3) without (1)/(2) is that you build a
heavy mechanism mostly to replace cheap JS validators that already
work fine.

## Where the empirical answer comes from

The fastest experiment is step 1: pick the worst offender (probably
`stateColumnFor` + the `status` text in `renderDetailPanel`), move
the computation into a `:status_summary` verb on `$task` that returns
a small struct, and have the listing/detail row carry the result.
If the catalog can absorb that cleanly, the same pattern likely
covers most of the kanban's class-specific code — and we'll have
a much better feel for what's left over for (3) to address.

## Counter-argument

Hugh's pushback (worth keeping): the client *already* embeds a lot
of user-facing class-specific text and behaviour, so we're already
paying the divergence cost. Running verbs locally doesn't introduce
a new failure mode; it formalises the seam we've been crossing
informally. That argument carries weight if the long-term direction
is "the client is a thinner shell over the catalog manifest" rather
than "the client is its own UI codebase that talks to the world."
