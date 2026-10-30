# OpenShell: the prover and the gateway speak different policy schemas

Part of #3924, closing out 5.3 (#3973). **This supersedes §5 of
`2026-10-29-openshell-0-1-6-upgrade.md`**, which said three checklist items were
"deferred because they need credentials or a run this repository cannot perform
on its own". That was wrong about all three, and a new note rather than an edit
because `docs/implementation-notes/` is historical-by-path.

## 1. The three items, as they actually stand

| Item | Claimed | Measured |
|---|---|---|
| Policy prover re-run | deferred, needs a run we cannot do | **Unsatisfiable as written** — the prover cannot read a gateway policy at all |
| `npm run skills:evaluate` | needs the owner's key | **Needs no owner action, and had nothing to do** |
| Scanner contract tests | deferred | **Done — 2 suites / 143 tests pass** under the v0.1.6 pin |

## 2. The prover accepts policy version 1; the gateway emits version 2

Measured with the checksum-verified `openshell-prover 0.1.6`
(sha256 `dafef6f11802a697786f5b67846c424a2193a2c29ccad7036a0985eaaa9b63ae`,
archive verified against the published `openshell-prover-checksums-sha256.txt`):

```
$ openshell-prover check --boundary p.json p.json        # {"version":2}
openshell-prover: invalid candidate policy: invalid policy:
  unsupported policy version 2; expected version 1
```

The gateway's schema is **version 2**. That is 0.1a's established fact and
`gateway.toml` sets `[openshell] version = 2`. So the prover cannot be pointed
at the thing this deployment runs.

They are not two revisions of one format. The single field name they share
disagrees on type — in the prover's format `network_policies` is a **mapping**;
in the gateway's, and in `collectorSandboxPolicy`, it is a **sequence**:

```
network_policies: type mismatch: expected mapping, found sequence
```

**Long-standing, not a 0.1.6 regression.** The 0.1.5 prover rejects version 2
with the identical message, so the two components have never agreed. Both
binaries were run against the same input to establish this rather than inferring
it from the newer one.

### The prover is not broken, and that distinction matters

A `version 1` policy returns a real verdict:

```
result: within_boundary
coverage: domains=filesystem,network_l4,network_rest,process,landlock
```

So the finding is a **schema divergence**, not a dead tool. The checklist item
should be read as "write a v2→v1 translation, or drop the item" — a piece of
work, not a tick. No such translation exists here and none is published
upstream.

### An asymmetry to carry forward

**The prover rejects unknown fields; the gateway's parser does not.** The prover
answers `unknown field 'process.allow_root' in authored policy`. Meanwhile
`agent-sandbox-policy-review/SKILL.md` records, about the gateway, that "the
policy parser does not reject unknown keys… a field it does not recognise is
discarded without error, so the policy in force can be narrower than the policy
on disk".

Both statements are true of their own component. The consequence is that
**agreement between prover and gateway can never be inferred from either one
passing** — a policy the gateway silently narrows is a policy the prover may
refuse outright, and vice versa. The skill's claim was checked against this
measurement and left alone: it is about the gateway, and the section before it is
explicitly about the prover, so the skill already keeps them apart.

## 3. `skills:evaluate` needed no owner action, and no run

Two separate errors in the earlier claim.

**The key.** `ANTHROPIC_API_KEY` is on the production VM at
`/opt/inflect/.env.prod` — the same credential the Flue runtime's external
provider already uses, and one the owner authorised for roadmap work. Not on the
development host, which is what produced the mistaken belief.

**The need.** A record goes stale when a skill's **evaluation set** changes, not
when a release does. `checkEvaluationRecord` fails on `MALFORMED`,
`SET_MISMATCH`, an unknown, duplicate or unanswered answer, or
`BELOW_THRESHOLD` — and it does **not** hash the instructions. All eleven skills
carry a passing record, every one naming `claude-sonnet-5-5`, which is still
`AGENT_FLUE_MODEL`'s default. The v0.1.6 upgrade changed no evaluation set.

Verified rather than assumed: the five suites that read the record or the mount
gate pass — 143 tests — after catching the shared test database up by one
migration (`20261029170000_agent_driver_mode_tool_runner`, a peer's).

So a re-run would have spent credits rewriting eleven passing records against the
same model, with one real downside: the script refuses to write a record that
would not pass, so a run scoring worse leaves answers in
`skill-evaluation-failures/` and no improvement anywhere. **Re-run it when a set
changes, not when a release does** — which is now what
`deploy/openshell/README.md` says.

## 4. Why this happened

The "needs the owner's key" belief came from a phase-2.1 blocker that was true
when written and was resolved at some point by the records being committed. I
carried it forward across a compaction and repeated it as current fact,
including to the owner, without checking. The check that would have caught it was
one `ls` of the skills directories.

The general form: **a blocker is a measurement with a date on it.** A summary
carries the claim but not the date, so the claim outlives the condition. Before
reporting anything as blocked, re-establish the block — and before spending
someone's money on it, re-establish it twice.
