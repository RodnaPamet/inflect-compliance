# 2026-10-20 — the host-consumer agent card, and what it deliberately does not say (#3862)

J2 of the SAP agent integration roadmap (#3859). J1 (#3861) admitted a host
consumer as a second kind of inbound principal; this makes that principal able
to find us without anyone handing it a URL out of band.

## The decision that shaped everything else

**The card advertises the advertisable REGISTRY SET, not the caller's grant.**
Owner decision, taken interactively and recorded on #3862.

The issue's own prompt said the opposite — "one A2A skill per workflowKey
enabled for host consumers", with a test reading "skills equal the enabled
workflows exactly; disabling one removes its skill". That test is replaced, and
the reason is a shape the prompt did not account for:

- `workflowKeys` lives on `HostConsumer`, **one row per consumer**;
- nothing limits a tenant to one consumer — the unique key is
  `(tenantId, clientId)`;
- the card is **public, unauthenticated, and one per tenant**.

So a card built from grants would have had to publish the *union* across a
tenant's active consumers. That discloses two things the peer card is held away
from: consumer A learns what consumer B may call, and an anonymous reader learns
which workflows this tenant has wired. Neither is something "an operator would
otherwise hand the peer out of band", which is the standard `own-card.ts` is
written to.

The registry set discloses nothing tenant-specific. The only tenant fact the
route reveals is "host consumers are enabled here", and the 200-vs-404 already
reveals exactly that.

### What makes it safe, verified rather than assumed

The grant is enforced from the **row**, not the token, on every call:

```
a2a-inbound.ts:566   if (!grants.workflowKeys.includes(request.workflowKey))
                         return refuse('WORKFLOW_NOT_ALLOWED', request.rpcId);
```

That line is inside the shared `startInboundRun` (declared `:548`), which both
principals route through, and the host path supplies `grants.workflowKeys` from
`consumer.workflowKeys`, read uncached per request by `tryAdmitHostConsumer`.

**A consequence worth stating loudly, because it looks like a bug:** the card
advertises more than most callers may invoke, so `WORKFLOW_NOT_ALLOWED` is an
EXPECTED answer to a well-formed request. Do not "fix" it by narrowing the card
back to the grants — that is the disclosure this design exists to avoid.

## Which path serves which variant

| Path | Variant | Why |
| --- | --- | --- |
| `/api/a2a/{slug}/agent-card.json` | PEER, unchanged | This URL **is** the tenant's A2A identity — `inflectA2aIdentity`, the sender of every receipt it signs and the thing peers pin. Changing what it serves would change the identity's own document and every peer's pin with it. |
| `/api/a2a/{slug}/.well-known/agent.json` | HOST CONSUMER | The pre-0.3 filename SAP's Joule toolkit composes. |
| `/api/a2a/{slug}/.well-known/agent-card.json` | HOST CONSUMER | The v0.3/v1.0 filename. Byte-identical to the above, asserted by test. |

Both variants carry the same `CARD_MEMBERS`, so `verifyInflectAgentCard`
verifies either and the signing path is one generic function. They differ in
exactly two values: `skills`, and `securitySchemes` (OAuth2 client-credentials
instead of a peer's bearer).

## Three things found by building it

**1. The prompt's skill fields were missing one the spec requires.** It listed
"id, name, description, examples"; A2A v0.3.0 has
`AgentSkill.required = ["description","id","name","tags"]`. A card built to the
prompt's list alone fails validation. This is the whole argument for validating
against the vendored spec rather than against a reading of it — the omission was
found by the schema, not by review.

**2. `skills` already meant something else.** `WorkflowDefinition.skills` is
**Agent Skills** — prompt material mounted on the Flue engine. The new field is
`a2aSkill`, and both docblocks say so, because the collision is the protocol's
and will otherwise be re-discovered by whoever reads it next.

**3. The skill id is not authored.** It is taken from the workflow `key` by
`advertisedA2aSkills`. A host sends the id back as `workflowKey`, so an authored
id that drifted from the key would advertise a skill nobody can invoke. Making
it underivable is better than testing that it matches.

## `.well-known` as a route segment — checked, not assumed

A directory whose name starts with a dot is the kind of thing a toolchain
silently skips, and a route nothing serves would have failed only in production,
while a route our own guards could not see would have been **unchecked and
green** — the worse outcome. Both were verified before the files were written:

- Next's app-router discovery filters on `part.startsWith('_')` only
  (`next/dist/build/route-discovery.js:100`), not on `.`;
- `normalizeAppPath` returns the dot segment intact;
- `git check-ignore` exits 1 for the path and `git ls-files -co
  --exclude-standard` lists it — which matters because the repo's guards take
  their file population from exactly that command (`tests/helpers/repo-files.ts`).

The positive control came for free: all three route registries **did** discover
the new files and fail until they were registered.

## The spec fixture and the validator's vocabulary

`tests/fixtures/a2a/a2a-spec-v0.3.0.json` is the upstream schema at tag
`v0.3.0`, vendored whole. Its blob sha is recorded in `PROVENANCE.md` and
matches `gh api .../contents/specification/json/a2a.json?ref=v0.3.0 --jq .sha`,
so "unmodified" is checkable rather than asserted.

The repo has no JSON Schema validator and this did not add a dependency.
Measured on the fixture, the `AgentCard` subtree reaches 17 definitions and uses
**nine** keywords (`$ref`, `additionalProperties`, `anyOf`, `const`, `enum`,
`items`, `properties`, `required`, `type`) over four types, so
`tests/helpers/json-schema-subset.ts` implements exactly those.

The danger with a small validator is **blindness**, not wrongness: one that does
not understand `oneOf` ignores it and passes everything. So the helper publishes
`IMPLEMENTED_KEYWORDS`, the test re-derives the keywords the spec actually uses,
and asserts the second is a subset of the first. Refresh the fixture to a
protocol version that uses a tenth keyword and that assertion fails — rather
than the card quietly ceasing to be validated.

## Registries this joined

Three, all found by running them rather than by memory:

| Registry | What it wanted |
| --- | --- |
| `tests/guards/machine-caller-paths-self-authenticate.test.ts` | A fourth kind beside inbound / token / peer card. Its well-known branch must come **first** — `.well-known/agent-card.json` also ends with `/agent-card.json/route.ts`, so the peer branch would otherwise claim it and demand the wrong usecase. |
| `tests/guards/agentic-route-inbound-links.test.ts` | Both route files declared. |
| `tests/guardrails/api-route-has-some-authorization.test.ts` | Both handlers triaged `PUBLIC_UNAUTHENTICATED`, with the disclosure argument written out. |

## Not done here

- **No schema change and no migration.** The card needs no tenant data beyond
  the admission gate, which reads the existing
  `TenantSecuritySettings.a2aHostConsumersEnabled`. This was a consequence of
  the disclosure decision, not an independent goal.
- **Only two workflows carry public copy** — `posture-review` and
  `audit-narrative`, chosen because both are `readOnly` and neither needs an
  internal id. `discovered-agent-review` and `agent-recertification-pack` are
  read-only too but require ids a host cannot know, so advertising them would
  have put uncallable skills on the card. `access-posture` is read-only and
  needs nothing, and was still left off: it is the one definition that reaches
  OUTSIDE the product, and letting an external host trigger that reach is a
  separate decision from publishing a card.
- **J4's `sap-transaction-review` is not here.** It does not exist yet; it
  arrives with its own copy on #3864.
- The card is not per consumer and there is no authenticated extended card
  (`supportsAuthenticatedExtendedCard` is absent). If a host ever needs to see
  its own grant, that is the member to reach for, and it is a new decision.
