---
date: 2026-05-13
status: archived
---

# V2 Turn Network Protocol

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

This document is an archived design note. The v2 node-network prototype
that originally accompanied this draft was rolled back, including the
shadow-world, browser-node, commit-scope, and turn-recorder substrate
code and tests. The current implementation is the v1 host-per-object
runtime described by [hosts.md](hosts.md), [host-seeds.md](host-seeds.md),
and [cloudflare.md](../reference/cloudflare.md).

The archived intent was to explore a future distribution strategy where:

- deterministic VM turns, not object placement, are the atomic execution
  unit;
- actor-local shards can cache executable state;
- browser-hosted nodes can hold narrow authority;
- accepted turn transcripts can drive verifiable state transfer;
- durable commits remain separate from live-only UI/session events.

Those goals remain possible future research, but no normative protocol
or implementation requirement lives here. Any revived v2 work must start
from a fresh design and explicitly update the protocol index, tests, and
runtime substrate together.
