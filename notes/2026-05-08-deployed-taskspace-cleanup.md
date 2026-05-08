# Deployed `the_taskspace` cleanup

## Status

The `taskspace` catalog has been removed from the worktree and from the
bundled catalog set. New worlds bootstrap without it.

A live deploy may still have a `the_taskspace` Durable Object instance
(`host_placement: "self"`) holding stored payload (`the_taskspace` itself
plus anchored `$task` instances). The DO has nothing left in code that
references it on the gateway side, so it sits dormant. It does not bill
much, but it is not auto-cleaned by the host-teardown infrastructure
(spec/semantics/recycle.md §RC11) because nothing triggers a recycle of
its root.

## What's already in place

The substrate has the host-teardown machinery:

- A self-hosted DO that recycles its root + anchored payload triggers
  the §RC11 sequence: persist `host_state = tearing_down`, batch the
  tombstone roster to Directory's `inherit-tombstones`, deleteAll.
- A cold-load guard refuses cold-loads against ids in
  `inherited_tombstone.former_host`.

What's missing: a mechanism to *initiate* the recycle on a self-hosted
root from outside the catalog, when the catalog defining the root is
gone.

## Cleanup options

**Option A: Wizard self-destruct endpoint.** Add
`POST /__internal/recycle-self-host` to `PersistentObjectDO`. Handler:

1. Verify internal-auth + body claims this host id.
2. Walk `world.objects.values()` in dependency order (anchored
   descendants first, root last), calling `recycleObjectLocal` on
   each.
3. Return.

The post-handler trigger fires (root recycled, `livePayloadCount == 0`),
host teardown begins automatically. Operator runs

```
curl -X POST .../the_taskspace/__internal/recycle-self-host \
  -H 'x-woo-host-key: the_taskspace' \
  -H '<internal-auth signature>' \
  --data '{"host":"the_taskspace"}'
```

once. The DO tears down, Directory inherits the tombstones, future
requests for `the_taskspace` answer `E_OBJNF` via the inherited-tombstone
authority, the cold-load guard catches any stale stub, the DO is
evicted on next idle.

**Option B: Boot migration on the gateway.** A one-shot gateway boot
migration that, if it sees `the_taskspace` in Directory's `id_route`,
sends a wake-up RPC to the host. The host's host-scoped lifecycle runs
a "self-destruct" migration. This requires the host-scoped migration to
recognize `the_taskspace` by id (since `$taskspace` class is gone), and
the gateway to send the wake. More moving parts than option A.

**Option C: Operator script + manual storage clear.** Operator uses
`wrangler` to inspect / clear the DO's storage manually (no automated
recycle — destructive but immediate).

## Recommendation

Option A. Implement the endpoint, run it once for `the_taskspace`,
verify in production via Directory's `inherited_tombstone` table (now
contains `the_taskspace` and its child task ids).

This is a follow-up to the catalog removal. The catalog removal commits
in this worktree do not include the endpoint or the cleanup operation;
they rely on `the_taskspace` continuing to sit dormant until cleanup
lands.

## Risk if cleanup is deferred indefinitely

- DO storage rows for `the_taskspace` and its tasks remain forever
  (small bytes, modest cost).
- Stale stubs that reach the DO would attempt a cold-load. Without
  `$taskspace` class in the gateway seed, `mergeHostScopedSeed` would
  fail and the cold-load throws. The DO would not respond to requests
  but also wouldn't tear down.

Acceptable as a temporary state; not a long-term outcome.
