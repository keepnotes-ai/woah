Looking at it as durable risk surfaces — places where each new feature will rediscover the same class of problem until you put structure there.

The deepest seam: cross-host transparency at the value layer

Where it lives: the substrate / DO layer — every builtin, every property read, every implicit object-graph walk.

We patched isa() and current_location propagation. The next ones in line, predictably, are parent(), contents(), feature_list(), match_object() (already half
cross-host via objectLocationChecked), the verb compiler's literal $ref resolutions inside cross-host call frames, and any future "tell me about this object"
primitive. Each one independently asks "does this read through the host bridge?" and the answer is set per-builtin, not by a general policy.

The fragile pattern: a verb author writes if (!isa(x, $note)) and gets E_OBJNF from a layer-three builtin when they expected a value. Three failure modes follow:

1. Verb authors guard with try/except for E_OBJNF — silently masking real bugs.
2. Catalogs end up host-place-aware ("only put $notes on the same host as the actor"), which leaks a substrate concern up the stack.
3. The substrate accumulates ad-hoc cross-host shims — one per builtin, each with a different staleness story.

Long-term fix shape: an explicit RemoteValue discipline. Builtins that read object identity/relations either return synchronously for local + perform a host RPC
for remote (the new isa() model), or they raise a typed E_REMOTE that verb authors are expected to handle. Pick one rule and apply it uniformly. Today there's no
rule, so each builtin's behavior is folklore. The deferHostEffect flush ordering (the enrichScopedMoveResult issue I just flagged) is a symptom of the same
disease.

This is the seam that will accumulate the most patch traffic over time if left unstructured.

Second-deepest: catalog UI runs in the SPA process

Where it lives: client components and client logic.

Every catalog ships JS that registers custom elements, projection reducers, observation handlers, and direct-call invocations into a single SPA process. There is
no structural isolation between catalogs:

- A bad reducer in catalog A can corrupt projection state catalog B reads.
- Custom elements share the global custom-elements registry.
- ui.observe(ref) is global — any component can read any object's projection.
- The call APIs (woo.directCall, woo.send) are uncurated handles; component A can call verbs on objects scoped to catalog B's surface.

For first-party catalogs this is fine — you trust everyone. The day someone wants to install a third-party catalog, the threat model is "this catalog can scrape
every observation, intercept any direct call, and crash any other surface." Mitigation paths are all expensive: per-catalog Web Workers (loses DOM access — needs a
render proxy), <iframe> per surface (sandboxes well, isolates badly), or a tightly curated component context that forbids global reads. None are nearly free, and
the longer you wait the more catalog code assumes the global model.

The forcing function: when does a third-party catalog story become real? If never, this isn't a problem. If "soon," start now — define the curated component
context API and migrate first-party catalogs onto it before more components ship.

The observation contract is informal

Where it lives: the boundary between world components (verbs that mutate) and client logic (reducers that derive UI from observations).

The contract today is: "any visible mutation must observe with sufficient data." Enforcement is "people remember to call observe() and tests catch the cases
someone wrote tests for." Predictably, gaps will land:

- A new property added to a $space descendant that's read by here.props but mutated without an observation. UI snaps back via /api/me until that gets re-fetched
(which after Phase 5 won't happen).
- A verb that mutates a foreign object via cross-host RPC and forgets to observe at the foreign space.
- A future feature where a property changes ambiently (timer-driven, e.g. dubspace transport tick, idle reaping) — does the verb that wrote it observe? Often no.

Structural fix: make the observation a property of the property declaration. defineProperty(name, …, observe: { type: "described", projection: { description } })
and have the substrate emit the observation automatically on any actor-visible write. You lose verb-authored richness for some cases, but you stop the silent
erosion. Pair this with a verb-compile-time check: any tool-exposed verb's body that writes to a defineProperty(observe)-marked field automatically gets the
observation, and any field without observe: in a verb body that's also exposed in here.props raises a lint warning.

Without something like this, the projection's drift from canonical state is a Schrödinger bug — invisible until someone notices a UI doesn't update.

Property and identity namespacing

Where it lives: the substrate and catalog manifests.

Property names on classes are flat. subscribers, next_seq, host_placement, aliases, home, description — global on $space and below. Two catalogs can't both define
a property called settings on $space. Catalog object IDs are also global (the_chatroom, the_pinboard — instance_self_host doesn't help because the IDs are still
single-keyspace). LATER.md flags alias-scoped class allocation as deferred.

This will bite when:
- A second pinboard-like catalog wants to coexist with the first.
- A vendor catalog ships properties whose names collide with first-party ones.
- A migration renames a property (rename_class is E_NOT_IMPLEMENTED).

Structural fix path: property keys become (catalog_alias, name) tuples in storage but presented as pinboard.notes / dubspace.transport to authors. Object IDs
become catalog_alias:name (the alias mechanism is half there for resolution; extend it to allocation). Land this before third-party catalogs are realistic —
retrofitting a namespace later is migration-grade pain.

Native↔DSL boundary is mobile

Where it lives: src/core/bootstrap.ts native() calls and the verb-source mirror in catalogs.

The arrow says woocode-ward: every native() carries a doc-string of the equivalent DSL signature, and the goal is to retire natives as the DSL gains primitives.
But each retirement is a behavior shift — the woocode replacement is the source of truth, but third-party catalogs may have called the native expecting native
semantics (e.g., wall-time bounds, error variants, perm checks at slightly different points).

There's no published "native deprecation" channel. Today the catalogs are first-party and the migration is internal. With third parties:
- A catalog written against native room_take will see different timing, different error shapes, when it becomes woocode.
- Cross-version catalogs assume substrate behavior frozen at install time.

Fix: version every native explicitly, and when retiring one, leave a shim that preserves the old observable behavior for catalogs whose spec_version predates the
retirement. Plus a deprecation log surfacing as a /api/state-debug or /api/diagnostics line so operators see "catalog X still uses retired native Y."

Catalog versioning topology is multi-dimensional

Where it lives: the migration table in AGENTS.md.

Five independent ledgers: catalog vN→vN+1, world spec_version, CF DO class, bootstrap local-boot, worktree schema. Each is a linear chain; the combination is
N-dimensional and untested. A world is a tuple (spec=0.4, cf-do=0014, chat=0.1.1, dubspace=0.8.1, pinboard=0.3, taskspace=0.5, …). Combinations not in the test
matrix are real worlds in production. As catalogs grow (each independently versioned), the combinatorial space outpaces test coverage.

Mitigation: declare compatibility ranges in catalog manifests (requires_spec_version: ">=0.4 <0.6", compatible_with: { dubspace: ">=0.7" }) and have catalog
install reject incompatible combinations. Doesn't eliminate the space — but turns silent runtime failures into install-time errors, which is the tractable form.

WS/MCP protocol has no schema

Where it lives: src/core/protocol.ts and the MCP tool surface.

Frame shapes ({op, id, …}) are documented prose. New frame types (event, task, replay, applied, result, error) accreted over time. SPA, agents, and tests all
depend on the union; there's no codegen, no version negotiation. Every direct-callable verb is an MCP tool whose name+args are public API for agents.

Two specific risks:
- Renaming a verb (or changing arg order) silently breaks agents that cached the tool list.
- Adding an op like "resumable live frames" requires updating substrate, SPA, MCP, and every agent client.

Fix: generate WS frame types from a single schema (Zod, Valibot, or a TS-only declaration with a version field), version-tag the protocol at WS connect, and send
tool-list deltas with explicit deprecation markers rather than the implicit "the tool is gone" signal.

DO eviction + mid-RPC durability

Where it lives: the worker layer.

LATER.md flags it: a verb doing many cross-host RPCs that sees its origin host evict mid-flight loses the in-memory awaiting task. v1 trades durability for
simplicity. As verbs get fancier (multi-step workflows, long-running tasks), the probability that some in-flight verb eats an eviction grows monotonically.
Symptoms: silent partial mutations, observed only by the client noticing missing observations or stale state.

Fix path is non-trivial: persist awaiting_call records before suspending a frame, replay on rehydration, idempotency tokens for cross-host RPCs. Spec already
references this. Worth elevating before workflows lean on cross-host orchestration.

Gateway routing cache freshness

Where it lives: the gateway worker.

Object→host routing is consulted on nearly every cross-host call. The cache invalidation story is "catalog install updates routes, which propagate." When a
host_placement: "self" is added to a class mid-life, existing instances need rerouting; that's a manifest-migration problem (LATER.md notes it). Until then, routes
can be stale at gateway level, and a stale route gets a wrong-DO call that falls back. Fallbacks are slow and exercise rarely-tested paths.

Less catastrophic than the others, but a pattern that recurs whenever a DO topology changes.

Where I'd actually invest, ranked

If you only do three things in the next quarter:

1. Cross-host value-layer discipline. Pick one rule (isa-style transparent or E_REMOTE typed). Apply it to every value-level builtin in one pass. Document it as a
substrate invariant. Stops the worst recurring bug class.
2. Observation contract structure. Property-declared observations + verb-compile lint. Stops projection drift before it becomes "no one can audit this."
3. Catalog UI isolation story. Decide first-party-only forever (and document it) or start the per-catalog component-context curation now, while there are five
catalogs.

Two and three are about what kind of system this becomes when it scales. One is about whether the current system stays correct as it scales. Skip any of them and
the next year's bug list will look like the last week's, just larger.

The rest — namespacing, native deprecation, version compatibility ranges, protocol schema, mid-RPC durability — are real but each takes longer to bite. You can
defer them one at a time as the use case forces them.
