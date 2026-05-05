# Tasks, handoff, and workflows — design

## Context

We have a pinboard, a kanban, and a taskspace, all viewing the same
underlying $note. We want a coherent model that lets agents and
authenticated players exchange tasks naturally; lets users build a
custom workflow in about ten seconds; and lets organizations layer
policy ("two reviewers required", "CI must pass", "audit every move")
on top without rewriting the workflow itself.

Two parts to this design: how a single task is modeled, and how
multi-stage workflows compose around it. They share substrate.

## Tasks: the unit

**A task is just a note.** `$task < $note`. The kanban view groups by
location; the pinboard view shows spatial layout; the taskspace view
shows the active queue. All three are projections over the same
objects. There is no "task that isn't a note."

### Fields

| Field | Type | Meaning |
|---|---|---|
| `location` | obj | Where the task currently sits — its current stage (or, in trivial workflows, the board itself). Drives every display. |
| `home` | obj | The board / workflow this task belongs to. Set on creation and immutable. `:drop` returns the task here. |
| `status` | enum (optional) | Trivial-workflow shortcut. For richer workflows the *stage* IS the status, and this field is unused. Kept on `$note` for back-compat with simple boards. |
| `parent` | obj \| null | Parent task ref. Structural; never moves on its own. |

The physical metaphor is honest: `:take` = `moveto(task, actor)`,
`:drop` = `moveto(task, task.home)`. The board's projection iterates
its tasks and groups by `location`:

- `location == home` → "available" (column varies by `status` for
  trivial workflows, by stage for rich ones).
- `location` is an actor → "claimed by *X*."
- `status == done` (or terminal stage) → "done column" regardless.

The board doesn't need a separate `claimed_by` mirror — `location`
already tells it.

### Subtasks

A task can be parent of others, but the children aren't *physically
inside* the parent — they have their own `location`. Two relations:

- `parent: obj | null` — points to the parent task. Structural.
- `location: obj` — where the task sits right now. Independent.

Default behavior on `:take` of a parent: subtasks **stay where they
are** (default-stay). Claiming a parent task does not vacuum up its
children. "I'm responsible for this work item" is finer-grained than
"I'm responsible for this whole feature." This cuts against the pure
LambdaMOO box-of-things metaphor, but matches how task management
actually works — agents and humans alike split work and pass pieces
between each other independently.

Reviewers finding three issues during review = create three child
tasks with `parent = task_under_review`. The parent stays put until
its children resolve (predicate: `all_children_done(task)`).

### The actor's queue

Already exists: `actor.focus_list`. Re-use it as an ordered list of
"current attention" task refs. The actor's *inventory* is the
unordered set of held tasks; *focus_list* is their priority order
over a subset. No new "queue" property needed — this is exactly what
focus_list is for.

### Handoff

Already covered: `:give task to agent` works today. Recipient's
`:acceptable` may refuse — task becomes the rejection signal at the
substrate level.

### Durability

Authenticated players don't get reaped on disconnect. A task in a
player's inventory just sits there across sessions. No special
on-disconnect rule. Stale claims (player held a task and never came
back) are the price of persistence; mitigations:

- **Idle reclaim**: a `:reclaim` verb on the workflow/board, allowed
  when `idle_seconds(holder)` exceeds a configurable threshold
  (default 14 days). Substrate primitive already shipped.
- **Wizard `:eject`**: manual override regardless of holder.

Guests are explicitly out of scope for this design — once user
onboarding lands, guests lose privileges anyway. The model assumes
real authenticated principals.

## Workflows: the state machine reduction

### Insight

Every object in woo *is already* a node in a state graph. Properties
are state. Verbs are transitions. `:acceptable` is the gate.
`enterfunc`/`exitfunc` are side-effects. Observations are outputs.
The substrate IS a state machine. `$workflow` doesn't invent
machinery — it's a *naming convention* over what's already there.

### Shape

- **`$workflow < $space`** — a container of stages. Represents one
  "machine."
- **`$stage < $space`** — a node in the graph. Holds tasks whose
  `location` is this stage. Stages are spaces because that gives
  them contents, presence, observations, and audience routing for
  free.
- **`stage.transitions: map<verb_name, target_stage>`** — the only
  data the workflow needs on top of vanilla spaces. The edges of
  the graph.

A task moving through a workflow is `moveto(task, next_stage)`. The
state machine *is* the substrate's normal mechanics applied with the
constraint that `task.location` is always a `$stage`.

### What the kanban view becomes

A flat projection: iterate the workflow's stages in order, render
each as a column, group its tasks by location. Reordering inside a
column is the existing pinboard `x/y` (or a simple `priority` int).
Status enums are gone — the column IS the status.

For free-form pinboard-style notes, the workflow has three stages
(`Todo`, `Doing`, `Done`) and trivial transitions. For
spec→build→merge work the workflow has six stages and richer gates.
Both use the same primitive at different setup levels.

## Constructing a workflow in 10 seconds

The catalog gives `$workflow` a tiny construction surface:

```
@create $workflow as ship_thing
ship_thing:add_stages(["draft", "review", "build", "merged"])
ship_thing:wire("draft", "submit", "review")
ship_thing:wire("review", "approve", "build")
ship_thing:wire("review", "reject", "draft")
ship_thing:wire("build", "ship", "merged")
```

Six lines, ten seconds. `:wire(from, verb, to)` adds a verb to the
source stage whose body is `moveto(task, to)`. Defaults: every stage
gets `:acceptable` returning true (no gate) and `:enterfunc` is a
no-op. That is a working workflow — take/drop a task through it
right after the last `:wire` returns.

A `:from_text(spec)` helper that parses a single DSL string is a
nice-to-have if we want it even shorter, but six explicit calls is
already self-documenting.

## Policy as features

Per-stage rules — gates, signoffs, side-effects — are *features*
attached to stages or to the workflow itself. Same feature mechanism
already used by `$conversational`. A feature is a bundle of verbs and
properties that attaches to any space and contributes behavior; the
substrate's feature-dispatch chain stacks features in order.

Examples:

- **`$ci_gate`** — feature with property `required_checks` that
  overrides `stage:acceptable` to consult CI status. Attach to any
  stage where CI gating matters.
- **`$two_reviewer_signoff`** — feature on a review stage. Tracks
  an approvers set per (task, visit_count) and overrides
  `stage:approve` to require N distinct callers before firing the
  approve transition.
- **`$auto_assign`** — feature whose `enterfunc` pushes a
  notification or `:give`s the task to the stage's next assignee.
- **`$audit_log`** — feature that observes every transition
  into/out of any stage it's attached to, writing to a separate
  space-log for compliance.

A workflow becomes "stages + transitions + features attached at each
stage." Features don't know about each other; substrate dispatch
stacks them deterministically. Removing policy = detach. Reusing
policy across workflows = attach the same feature to many stages.

This is exactly the LambdaCore "behavior composes via features"
pattern, applied to coordination instead of conversation.

## What this gives free

- **Inspect**: `look at review_stage` shows its features and
  transitions. Workflow is self-documenting.
- **Override per instance**: a project's review stage can attach
  extra features beyond the default; everyone else keeps defaults.
- **Layered policy**: company-wide audit-log feature + team-specific
  signoff feature + project-specific CI feature, all stacking. No
  central registry — features compose where attached.
- **Discoverability**: `objectsByParent($workflow)` enumerates
  workflows. `space.features` enumerates the policies on each stage.
  An agent (human or otherwise) can introspect a workflow they've
  never seen and immediately know its rules.

## Constraints / open questions

### Workflow-level vs stage-level invariants

Some rules cross stages: "every task that lands in `merged` must
have passed through `build`." That's a workflow-level invariant, not
a stage gate. Model it as a `$workflow_invariant` feature attached
to the workflow, whose `enterfunc` on terminal-stage entry checks
the task's history.

Distinct from per-stage policy. Worth being explicit about which
features attach to *stages* and which to *workflows*. Probably encode
it via a feature property `attach_to: "stage" | "workflow"` so
attachment errors are caught at attach time, not runtime.

### History

A task in `merged` doesn't carry its trail today. If invariants or
audits need it, the `$audit_log` feature appends to a per-task
`history: list<{stage, ts, actor, transition}>` on every entry/exit.
Opt-in via feature attach. Adds storage cost proportional to
transitions × tasks, but capped by the audit feature's retention
policy.

### Substages and side-quests

"Spec" might break into "drafting" → "draft review" with the parent
task pinging back and forth. That's nested stages: a workflow can
contain sub-workflows. Recursive shape; no new mechanism. The kanban
view has to choose flatten-or-nest. Default flatten; advanced views
opt into the tree.

### Approval state on rework loops

If `$two_reviewer_signoff` tracks approvers per task, a task that
travels back through review needs the approver set cleared per
visit. Track approvals as `(task, visit_count) → approvers` rather
than `task → approvers`. The visit_count is bumped by the stage's
`enterfunc` on each entry.

### Default-stay for subtasks

The chosen default. Cuts against the LambdaMOO box-of-things
metaphor; aligns with task-management practice. Document loudly so
users aren't surprised when "take parent" doesn't grab children.

## What this requires

**Substrate (already shipped):**

- `$space` with contents, presence, audience routing.
- `moveto` with the `:acceptable` / `:enterfunc` / `:exitfunc` chain.
- Feature attachment via `$conversational`-style mechanism (already
  used by chat).
- Idle/connected primitives (`is_connected`, `idle_seconds`) for
  reclaim policy.
- `:give` for handoff.

**Catalog (new):**

- `$workflow < $space` with `:add_stages`, `:wire`, `:reclaim`.
- `$stage < $space` with `transitions: map<str, obj>`,
  default `:acceptable` and `:enterfunc`.
- `$task < $note` with `home`, `parent`. Reuse `$note` for everything
  else.
- A small library of stock features: `$ci_gate`,
  `$two_reviewer_signoff`, `$auto_assign`, `$audit_log`.
- A `$default_workflow` instance preset with `Todo / Doing / Done`
  for the trivial-list case, so users who don't want to design a
  workflow get one for free.

**SPA (new):**

- Workflow view: list stages in transition order, render tasks per
  column, drag/drop = `:wire` transition verb call. Reuses pinboard
  drag-drop primitives.
- Task detail view: show parent / children, history (if audit
  feature attached), current stage, applicable transitions
  (`stage.transitions` mapped to buttons).

**Spec (new):**

- A workflow.md spec section in `spec/discovery/` or
  `spec/semantics/`, normative shape of `$workflow`, `$stage`,
  feature attachment rules, and the invariant about
  `task.location ∈ workflow.stages` (or its parents).

## Migration shape

1. Define `$workflow` and `$stage` classes in a `workflow` catalog.
2. Define `$task` extending `$note` with `home` and `parent`.
3. Migrate the existing taskspace's flat-status model: each task's
   `status` becomes its `location` in a stock 4-stage workflow
   (`Open`, `In Progress`, `Blocked`, `Done`). Migration is per
   taskspace instance; existing kanban views keep rendering the
   same columns.
4. Build the SPA workflow view as an alternative to the kanban view.
   Kanban becomes a flat projection over a workflow's stages.
5. Ship one stock feature (`$auto_assign`) as a reference. Add
   others as users demand.

Each step independently shippable; the existing taskspace keeps
working while the workflow catalog grows next to it.
