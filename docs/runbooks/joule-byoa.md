# Runbook — connecting SAP Joule to an Inflect workspace (BYOA)

Deploying the Joule capability in `deploy/joule/` so a Joule user can ask an
Inflect agent to review SAP documents against their controls.

Every step says **how to verify it**, because the failures on this path are
mostly silent: a wrong namespace, a destination in the wrong subaccount or an
alias that does not match all deploy or call cleanly and fail somewhere else.

> **Inflect reads no SAP system on this route.** Joule holds the SAP access and
> passes facts in the request. That is not a promise in prose — the receiving
> agent is refused the call if it holds any external tool grant
> (`a2a-host-consumer-policy.ts`, and the reasoning on #3860/#3864). If you are
> looking for a route where Inflect calls SAP APIs, this is not it.

## Before you start

| Need | Note |
| --- | --- |
| A Joule tenant, and a BTP subaccount where Joule is provisioned | the destination must live in **that** subaccount |
| BTP roles `extensibility_developer` and `capabilityadmin` | confirmed from SAP's toolkit, `skills/joule-a2a-agent/SKILL.md:46,315` |
| `@sap/joule-cli` | `npm install -g @sap/joule-cli` |
| An Inflect workspace with A2A host consumers enabled | step 1 |
| The deployment's public https origin | Inflect signs its identity from `APP_URL`; a deployment without one refuses every A2A path as `NO_PUBLIC_ORIGIN` |

## 1. Enable host consumers for the workspace

Two switches, and **both** are required (`hostConsumersAdmitted`): the
deployment's `A2A_HOST_CONSUMERS` and the workspace's own
`a2aHostConsumersEnabled`.

**Verify:** fetch the card at
`https://<origin>/api/a2a/<tenantSlug>/.well-known/agent.json`. A 200 with a
`skills` array means both switches are on. A **404 means either switch is off,
the slug is unknown, or there is no signing key** — deliberately
indistinguishable, so the route is no oracle for which workspaces have set this
up. If you get a 404 and expected a card, check the switches before suspecting
the URL.

## 2. Create the host consumer in Inflect

Admin → the A2A host-consumers surface, under `admin.agent_registry`. You give
it a name, the **receiving agent**, and the **workflow keys** it may call — for
this package, `sap-transaction-review`.

You also name an **accountable person**. That is not bookkeeping: a run this
consumer starts carries that person's authority, resolved through the same
membership check a peer's owner goes through, so the consumer can never reach
further than they could.

**The client secret is shown once.** Copy it now; it is stored only as a
SHA-256 hash and cannot be retrieved.

**Verify:** the consumer appears in the list with status `ACTIVE`, its secret
prefix visible and the secret itself not.

## 3. Create the BTP destination

In the **same subaccount as Joule**.

| Property | Value |
| --- | --- |
| Name | `INFLECT_COMPLIANCE_REVIEW_A2A` — must match `system_aliases.*.destination` exactly |
| Type | HTTP |
| URL | `https://<origin>/api/a2a/<tenantSlug>` — the **base**, with no `/.well-known/...` suffix |
| Proxy Type | Internet |
| Authentication | **OAuth2ClientCredentials** |
| Token Service URL | `https://<origin>/api/a2a/<tenantSlug>/token` |
| Client ID / Secret | the host consumer's, from step 2 |

Plus `HTML5.DynamicDestination: true` and `WebIDEEnabled: true`.

Two points where SAP's own documentation will mislead you:

- **The URL is the base.** Joule appends `/.well-known/agent.json` itself
  (`references/joule-capability.md`, section 9: "without
  `/.well-known/agent.json`").
- **Authentication is OAuth2ClientCredentials, not NoAuthentication.** The
  toolkit's sample destination table shows `NoAuthentication` because its sample
  agent is unauthenticated. Inflect is not: every inbound call needs a token.
  Both are permitted — `SKILL.md:316` says destinations "must use
  NoAuthentication or OAuth2ClientCredentials" — but only one works here.

**Verify:** use the destination's own "Check Connection". Then confirm the token
endpoint directly:

```
curl -s -X POST https://<origin>/api/a2a/<tenantSlug>/token \
  -d grant_type=client_credentials -d client_id=<id> -d client_secret=<secret>
```

A token comes back. **Every failure returns `invalid_client`** and nothing else —
a wrong id, a wrong secret, a revoked consumer and a workspace with the switch
off are indistinguishable to the caller on purpose. The specific reason is in
the Inflect audit row, so look there rather than guessing from the response.

## 4. Deploy the capability

```bash
cd deploy/joule
joule login                 # or: joule login --use-env
joule deploy ./da.sapdas.yaml --compile -n "<assistant_name>"
```

**Verify:** `joule list` shows the capability.

If deploy fails, check these first — each has a specific error that does not
obviously name the cause:

| Symptom | Cause |
| --- | --- |
| namespace validation error | `metadata.namespace` is not `joule.ext`. It is mandatory, and SAP's own reference examples show `com.sap.paa`, which will fail |
| compiler error naming `contextId`/`taskId` | `capability_context.yaml` is missing or does not declare them |
| schema errors on the DA descriptor | `enable_native_agenticness` or `conversational_search` present — both need schema 1.5.0-beta, and this descriptor is 1.4.0 |

## 5. Confirm a first call reached Inflect

Ask Joule something the scenario description routes here — for example *"Did
anyone approve a purchase order they raised themselves?"* with document facts.

**Verify in Inflect, not in Joule.** The evidence row J1 writes is the
authoritative record: a `HostConsumerMessage` carrying the exact request bytes,
the client id and the token `jti`. It is write-once and survives the consumer
being deleted, so it is the thing to check.

Then the workflow run itself: a `WorkflowRun` for `sap-transaction-review`
attributed to the receiving agent, with the host-consumer origin columns set.

### What a Joule user sees, and what it means

Joule renders the answer text for **every** state, so the words are the
interface. Each comes from `a2a-run-answer.ts`:

| State | What the words say |
| --- | --- |
| `completed` | the review itself, or that it finished recording no written findings |
| `working` — still running | it is still running, and the task id to ask again with |
| `working` — waiting on a person | **a person inside the Inflect workspace must approve**, and nobody outside it can |
| `failed` / `canceled` | it could not be completed or was stopped, that nothing changed, and the run id to quote |

A run waiting for approval reports `working`, **not** `input-required`, and that
is deliberate (owner decision on #3863): `input-required` means the *client*
must supply something, and here the approval can only come from inside the
Inflect workspace. The words name the right actor where the state code would
have named the wrong one.

## Known limits

- **The synchronous wait is ten seconds.** A review that takes longer answers
  `working` with its task id, and Joule's next turn carries `contextId`/`taskId`
  so the follow-up returns the settled answer. The bound is an assumption
  documented in `a2a-synchronous-wait.ts`: SAP's toolkit does not publish
  Joule's request timeout, and thirty seconds is inferred from the
  `timeout=30` its own scaffold uses. **If a pilot shows Joule waits longer,
  that constant is the one place to change.**
- **The card advertises more than any one consumer may call.** Skills are the
  workflows carrying reviewed public copy, identical for every workspace, so a
  `WORKFLOW_NOT_ALLOWED` refusal is an expected answer to a well-formed request
  rather than a misconfiguration (#3862).
- **No pilot against a real Joule tenant has run yet.** #3865 step 3 is open.
  Everything above is derived from SAP's published toolkit and from Inflect's
  own tests; the points most likely to be wrong are the destination's OAuth2
  behaviour and the wait bound.
