# Runbook — wiring an SAP MCP connection

Connecting an Inflect agent to an MCP server the customer hosts in front of
their SAP system, and the three constraints the platform holds on that
connection whatever the server advertises.

Every step says **how to verify it**, because the failures on this path are
quiet by design: a tool withheld from a model looks identical to a tool the
model chose not to call, and a refused run looks like a model that had nothing
to say.

> **Inflect does not supply the SAP-side server.** This runbook is about the
> Inflect end of an `mcp-server` connection — the customer hosts the far end.
> The three read-only SAP tools and their BTP skillset belong to step M4
> (#3871), which is open: the repository contains neither. If you are looking
> for the route where Joule holds the SAP access and Inflect reads nothing,
> that is
> [`joule-byoa.md`](joule-byoa.md) — a different route with different
> properties.

## Before you start

| Need | Note |
| --- | --- |
| An MCP server reachable over https | the origin is checked at save time and re-resolved at use time |
| The `mcp-server` connection created under Admin → Integrations | `admin.manage` |
| An ACTIVE registered agent, scored, with a policy card | the register's own preconditions |
| `RegisteredAgentTool` grants for the tools the agent may call | deny-by-default: an agent granted nothing settles `EMPTY_CATALOGUE` |

## 1 · The connection's rung decides what a write tool can do

`IntegrationConnection.externalWriteMode` is the external-write ladder:
`DISABLED` → `DRY_RUN` → `PROPOSE_ONLY` → `AUTOMATIC`. A connection with no
rung recorded reads as `DISABLED`.

At `DISABLED`, a write-classified tool is **not offered to the model at all**,
and the withholding is recorded on the run as the omission
`CONNECTION_READ_ONLY`. That is deliberate: the dispatch would refuse the call
anyway, and advertising a tool whose every call is refused teaches a model to
retry something that cannot work.

A tool counts as a write when its MCP annotations do **not** say
`readOnlyHint: true`. An absent or unparseable annotation counts as a write —
the inconvenient direction on purpose.

**Verify it.** Open the run's record and read the omitted list. A write tool on
a `DISABLED` connection appears there with `CONNECTION_READ_ONLY`; its read
tools are still offered. If you expected a write tool to be callable, raise the
rung one step — the ladder refuses multi-rung widening, and leaving `DRY_RUN`
requires seven days in it.

## 2 · An empty catalogue is a failure, not a quiet answer

A run that resolved no tools settles `EMPTY_CATALOGUE` and says why: the agent
holds no MCP tool grants, so the run had nothing to read and its conclusion
would be based on no data.

**Verify it.** Start a run for an agent with no grants and read the status. It
is `EMPTY_CATALOGUE`, never `COMPLETED`. If you see `COMPLETED` with an empty
answer, that is a different fault and worth reporting.

## 3 · Business data leaving the deployment needs an acknowledgement

Mark the connection as reaching a business system when it carries third-party
business or personal data — an ERP, a finance or HR system of record. The field
has three states and the difference matters: `true` and `false` are reviewed
claims, and unset means nobody has said.

While the workspace's AI residency is `EXTERNAL`, a run that is offered a tool
on a connection marked `true` **refuses** unless the transfer has been
acknowledged. Reading an ERP's rows and handing them to a model provider
outside the deployment is a transfer, and the platform does not make it on a
default.

Two ways to proceed, and they are genuinely alternatives:

- **Acknowledge it.** `PUT /api/t/{slug}/admin/security-settings/external-ai-acknowledgement`
  with `{"acknowledged": true}`. It takes `admin.manage` **and** a person — a
  credential, an agent or a job is refused, because accepting a transfer on a
  company's behalf is not something an API key does. The acknowledgement is
  recorded with its author and its date, is audited, and can be withdrawn with
  `{"acknowledged": false}`.
- **Set AI residency to `LOCAL_ONLY`.** Inference then runs on the workspace's
  own gateway and nothing is transferred, so no acknowledgement is needed.

**Verify it.** With the connection marked and residency `EXTERNAL`, start a run
before acknowledging: it settles with
`flue_external_ai_business_data_unacknowledged`, naming the connections that
caused it. Acknowledge, start it again, and it proceeds. Withdraw, and it
refuses again — the acknowledgement is a live term, not a one-way latch.

## What is counted

Every external tool call at the dispatch stage increments
`agentic.external_tool.call`, by outcome (`DONE` / `FAILED` / `REFUSED`),
whether the tool was write-classified, and whether the connection is marked as
reaching a business system. The connection itself is not a metric label — the
per-call record is the `AiDecisionLog` row, which carries
`provider: mcp:<connectionId>`.

A rising `REFUSED` rate for write tools is worth looking at: since those tools
are withheld from the offer on a read-only connection, a sustained rate means
the offer and the dispatch disagree about something.

## When nothing happens

The causes are numerous and present identically as a run that did little. In
rough order of likelihood:

| Symptom | Likely cause |
| --- | --- |
| Status `EMPTY_CATALOGUE` | no `RegisteredAgentTool` grants for this agent |
| A write tool never called, omission `CONNECTION_READ_ONLY` | the connection is at `DISABLED` |
| A write tool never called, omission `AUTONOMY` | the tool's required rung exceeds the agent's autonomy ceiling |
| A write tool never called, omission `READ_ONLY_WORKFLOW` | the workflow declares `readOnly` |
| `flue_external_ai_business_data_unacknowledged` | section 3 |
| `flue_no_tools_granted` | the pre-`EMPTY_CATALOGUE` form of the same cause, on older runs |

## Related

- [`docs/rate-limiting.md`](../rate-limiting.md) — the `/api/mcp` budgets
- [`docs/runbooks/joule-byoa.md`](joule-byoa.md) — the A2A route, where Inflect reads no SAP system
- [`docs/sap-agent-integration-roadmap.md`](../sap-agent-integration-roadmap.md) — the intent, and which steps are built
