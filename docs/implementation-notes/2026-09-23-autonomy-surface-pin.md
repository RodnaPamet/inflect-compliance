# 2026-09-23 — The rung shown and the rung enforced are pinned together

**Commit:** `<sha>` test(agentic): pin the Tools-tab autonomy rung against the funnel's

Phase 1 audit point **2d**, and it resolves as a PIN rather than a fix. Audit
point **1c** is recorded here too, as a verified non-finding.

## 2d — a divergence that is harmless today

`requiredAutonomyFor(capabilityClass, declared?)` returns a tool's own declared
override when it has one and the class default otherwise. Both enforcement
seams in `authorize.ts` pass **both** arguments, as does the Flue adapter. The
agent Tools tab passes **one**:

```ts
requiredAutonomyFor(mcpToolCapabilityClass(name))
```

**And it has to.** That surface builds its map from `MCP_TOOL_NAMES`, a leaf
catalogue with no imports at all — which is the entire reason the catalogue
exists, so an admin route learning eleven strings does not drag the tool graph,
the dashboard cache and the proposal queue in behind it. A leaf holding only
names cannot read `authorize.autonomy` off a tool object it does not have.

So it is not an arity to correct. It is a divergence that becomes a wrong
answer on a governance surface the moment one tool declares an override: the
tab would show the class default (the *lower* number), `aboveCeiling` would
answer `false` and render no warning, and the funnel would refuse every call at
a rung the tab never mentioned. An operator would grant a tool the UI said was
within reach and watch it 403 forever.

**Zero shipped tools declare one today**, so the guard asserts exactly that.
It is green now and goes red on the one diff that makes the surface start
lying — which is the only moment anybody could act on it. The test says what
to do when it fires, because "delete the assertion" is the cheapest wrong
answer to a red pin.

## 1c — verified, and not a defect

`assertGrantWithinTier` returns early for a NULL `riskTier`, so an UNSCORED
agent may be *granted* a tool. That is deliberate — preparing a DRAFT agent's
tool list before assessing it is an ordinary workflow, and the function's own
docstring says so.

The audit's concern is that the comment might be discharging its duty against
a backstop that does not exist. It does exist, and there are two:

- `activateRegisteredAgent` throws `conflict` when `riskTier === null`, so an
  unscored agent **cannot become ACTIVE**;
- `riskTierCeilingFor` maps UNSCORED to `DENY_CEILING`, so it is refused every
  tool at the boundary regardless.

There is even an `activeUnscored` metric for the residual case — an agent
already ACTIVE before the requirement, whose credential reaches nothing while
the register advertises it as running.

Checked rather than assumed, because three findings in this audit turned out to
rest on premises that had moved.
