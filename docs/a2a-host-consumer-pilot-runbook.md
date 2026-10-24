# A2A host-consumer pilot runbook

How to let an external A2A client — a Microsoft consumer, SAP Joule, or any
other host — call this workspace's agent, and how to take that access away
again. The capability is J1 (#3861); the v1.0 wire binding beside v0.3 is J6
(#3866), whose pilot this runbook exists to serve.

**Read `docs/adr/0003-a2a-host-consumers.md` first.** It records which
threat-model decisions this path waives, re-sites or relaxes, and the reasoning
there governs anything below that looks merely procedural.

## There is no staging environment to pilot in

Checked 2026-10-24 against the live repository rather than the docs:

| claim | reality |
| --- | --- |
| `CLAUDE.md:912` "staging auto-deploys" | nothing in the repo references `docker-compose.staging.yml` — no workflow, script or deploy path |
| `docs/change-management-policy.md:41` "GitHub Environment approval for production" | `GET /repos/.../environments` returns `{"total_count":0}` |
| a deploy workflow | `release.yml` runs `semantic-release` only; images reach the VM through Watchtower |

So `docker-compose.staging.yml` is a self-hosted stack template, not a running
environment, and `npm run smoke:staging` targets `localhost:3000`. A pilot has
two honest options: stand that stack up somewhere a third party can reach, or
run the pilot in production against a dedicated pilot tenant with the scope
below. There is no third option in which staging absorbs the risk.

## The four gates, each independent

A host-consumer call needs every one of these. Any single one closed refuses it.

| # | gate | default | where |
| --- | --- | --- | --- |
| 1 | `A2A_HOST_CONSUMERS` | absent | the deployment env — `/opt/inflect/.env.prod`, read via the app service's `env_file:` |
| 2 | `TenantSecuritySettings.a2aHostConsumersEnabled` | `false` | per tenant |
| 3 | a `HostConsumer` row with its `ifhc_` client id | none exist | `POST /api/t/<slug>/admin/a2a/host-consumers` |
| 4 | the consumer's `workflowKeys` allowlist | — | set at creation, 1..50 keys |

Gate 1 crosses a deployment and gate 2 crosses a tenant, which is the point:
turning this on for one pilot tenant never turns it on for a customer's.

## Enabling

1. **The deployment flag.** Add `A2A_HOST_CONSUMERS=1` to `/opt/inflect/.env.prod`
   and restart the `app` service. Only `'1'` and `'true'` count. Do NOT add it
   to `deploy/docker-compose.prod.yml` — that file is repo-canonical and
   declares no feature flags; the host env file is where they live, and a
   service-level `environment:` entry would override `env_file:` for that key.
2. **The tenant.** Create a tenant for the pilot rather than reusing a
   customer's, and set `a2aHostConsumersEnabled` on its security settings.
3. **A receiving agent.** The credential binds to one `RegisteredAgent`, which
   must exist and must not be `RETIRED`. Whatever the consumer causes is decided
   by that agent through the ordinary authority funnel — the host consumer
   itself carries no authority, exactly as `PeerAgent` carries none.
4. **The credential.** `POST /api/t/<slug>/admin/a2a/host-consumers` with
   `admin.agent_registry` (OWNER, ADMIN or AI_ADMIN — no API key scope reaches
   that key), naming `name`, `ownerUserId`, `receivingAgentId`, `workflowKeys`
   and optionally `inboundMessagesPerHour`.

   **The secret is returned once and never again.** Only its SHA-256 is stored.
   An operator who loses it rotates rather than recovers.

## What to allowlist, and why one key

`workflowKeys` is validated against the live registry — an unknown key is a 400
— and the host-consumer card variant lists **one skill per allowlisted
workflow**, so the allowlist is also the public description of this workspace.

For a wire-binding pilot, allowlist exactly one: `ad-hoc-question`. It is
`readOnly: true`, it answers from records the asking person could read
themselves, and it is the natural target of A2A's `SendMessage` — which is what
the pilot is testing. Six of the ten registered workflows are `readOnly`
(`ad-hoc-question`, `access-posture`, `posture-review`, `audit-narrative`,
`discovered-agent-review`, `sap-transaction-review`); the other four are not,
and none of them belongs in a pilot whose question is "does the wire work".

## What the consumer is handed

For tenant slug `<slug>` on host `<host>`:

```
card      GET  https://<host>/api/a2a/<slug>/.well-known/agent-card.json
token     POST https://<host>/api/a2a/<slug>/token      grant_type=client_credentials
messages  POST https://<host>/api/a2a/<slug>            A2A-Version: 1.0
```

The token endpoint accepts the client id and secret either in the form body or
as HTTP Basic, both per RFC 6749 §2.3.1, because which one a given host sends
is not documented by its toolkit. **Record which form the consumer actually
used** — that is one of the facts the pilot exists to establish.

An absent `A2A-Version` header means 0.3, as the spec requires, so a consumer
that sends nothing is served the old vocabulary rather than refused.

## What the pilot should record

The binding is proved against the vendored proto and our own tests, which is
not the same as having been called by a real v1.0 client. So record:

- whether the consumer sent `A2A-Version` at all, and with what value;
- which credential carriage form the token request used;
- whether it called `SendMessage`/`GetTask`, or something refused —
  `SendStreamingMessage` and the push-notification operations are refused with
  the spec's own capability errors, because the card declares
  `streaming: false` and `pushNotifications: false`. A refusal there is a
  finding about the client, not a defect;
- whether it parsed the card's `supportedInterfaces`, and which interface it
  chose.

## Bounds that hold even if the consumer misbehaves

- Writes from a host-consumer-started run are clamped to `PROPOSE_ONLY`
  (`clampForInboundA2a`, R17), so the worst outcome is a queued proposal a
  person decides.
- No outbound A2A send from a run it started (R14).
- The `workflowKeys` allowlist bounds what can be invoked (R6).
- A per-consumer kill switch, read **uncached** on every message (R11), and an
  hourly quota (R13).
- Receipts are weakened for this path, with no equivalent replacement — this is
  the one decision the ADR records as a genuine reduction rather than a
  re-siting, and it is why the host is expected to be the customer's own tenant
  rather than an arbitrary third party.

## Disabling

Fastest first, because they differ in blast radius:

1. **One consumer** — engage its kill switch:
   `POST /api/t/<slug>/admin/a2a/host-consumers/<id>/kill`. Read uncached, so it
   takes effect on the next message with no deploy and no restart.
2. **One tenant** — set `a2aHostConsumersEnabled` back to `false`.
3. **The whole deployment** — remove `A2A_HOST_CONSUMERS` from `.env.prod` and
   restart `app`. This refuses every host consumer in every tenant, including
   token issuance.

Revoking the receiving agent's registration also works, through the retirement
cascade, but it takes away everything else that agent does — reach for the kill
switch instead.
