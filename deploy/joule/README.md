# Joule capability — Inflect compliance review (BYOA)

What a customer deploys into their own BTP subaccount so a Joule user can ask an
Inflect agent to review SAP documents against their controls.

**The runbook is `docs/runbooks/joule-byoa.md`.** It is the authoritative, ordered
procedure with a verification step for each stage. This file is what the package
IS; that one is how to deploy it.

## Shape

```
deploy/joule/
├── da.sapdas.yaml                        schema 1.4.0 — the deploy entry point
└── capability/
    ├── capability.sapdas.yaml            schema 3.28.0, namespace joule.ext
    ├── capability_context.yaml           REQUIRED: declares contextId / taskId
    ├── functions/call_agent.yaml         the agent-request action
    └── scenarios/invoke_agent.yaml       user intent → function
```

Followed from SAP's toolkit at source (`SAP-samples/joule-a2a-agent-toolkit`,
`skills/joule-a2a-agent/`) rather than from a description of it. Two files here
were absent from the issue's own list — `da.sapdas.yaml` and
`capability_context.yaml` — and the second is one the Joule compiler refuses to
build without.

## What you must change

| Where | Change to |
| --- | --- |
| `capability.sapdas.yaml` → `system_aliases.*.destination` | your BTP destination's exact name, if you rename it |
| the destination itself (in BTP, not here) | URL `https://<origin>/api/a2a/<tenantSlug>`, OAuth2ClientCredentials against `.../token` |

Everything else is intended to ship as-is.

## What you must NOT change, and why

- **`metadata.namespace: joule.ext`** — mandatory. Any other namespace fails
  `joule deploy` with a namespace validation error (`SKILL.md:319`). SAP's own
  reference examples show `com.sap.paa`; following them breaks deploy.
- **The two schema versions** — the capability is `3.28.0` (required for
  `agent-request`) and the DA descriptor is `1.4.0`. Different schemas, easy to
  swap, and the resulting error does not read as a version mix-up.
- **The scenario's `description`** — it is the `a2aSkill.description` of the
  `sap-transaction-review` workflow, **copied verbatim**, and
  `tests/guards/joule-package-matches-the-card.test.ts` fails if they differ.
  Joule routes on this text while a spec-reading host routes on the agent card's
  skill description; two independently edited copies diverge silently, sending
  Joule requests the card does not advertise. Change the workflow's copy and
  bring this along with it.

## Why the function renders text for every state

`call_agent.yaml`'s `message` action emits
`result.body.status.message.parts[0].text` unconditionally — not only for
`completed`. So a response without a text part shows a Joule user **nothing**,
whatever its task state. That is what #3863 exists for: every state now answers
in sentences, including "a person in the Inflect workspace must approve this".

## Not yet proved against a real tenant

#3865 step 3 — the pilot — is open. This package is derived from SAP's published
toolkit and from Inflect's own tests, which is not the same as having run. The
two points most likely to need correcting are the destination's OAuth2 behaviour
on the `agent-request` path, and whether the ten-second synchronous wait fits
Joule's actual request timeout.
