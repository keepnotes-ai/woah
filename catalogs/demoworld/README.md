---
name: demoworld
version: 0.1.0
spec_version: v1
license: MIT
description: First-light demo world. Seeds the Living Room / Deck / Hot Tub setting with portable props, a sulphur-crested cockatoo, and the mount-point rooms that other bundled demo apps use.
depends:
  - @local:chat
keywords:
  - demo
  - first-light
  - world
---

# demoworld

The seed catalog for woo's first-light demo. It does not define core
behavior — the chat catalog does that. demoworld only contributes one
class (`$cockatoo`) and a populated room set so the bundled client has
somewhere to land.

What demoworld seeds:

- Four `$chatroom` instances: `the_chatroom` (Living Room), `the_deck`,
  `the_hot_tub`, and `the_garden`.
- `$exit` instances wiring them together, including the steps that lead
  south from the deck into the garden and the gravelled path south from
  the garden to `tasks:the_taskboard` ("Santa's workshop").
- Four `$portable`/`$furniture` props: `the_couch`, `the_lamp`,
  `the_towel`, `the_mug`.
- One `$cockatoo` instance (`the_cockatoo`) on the mantelpiece.
- `$conversational` attached to each of the rooms.

Other demo catalogs (`dubspace`, `pinboard`) mount their own seeded
instances inside these rooms by referencing `demoworld:the_chatroom` /
`demoworld:the_deck`. Those catalogs declare `@local:demoworld` as a
dependency.

A world that wants chat primitives but not the demo populace installs
`@local:chat` alone and skips this catalog.

See [DESIGN.md](DESIGN.md) for the room layout and the rationale for
keeping demo seeds out of the class-library catalogs.
