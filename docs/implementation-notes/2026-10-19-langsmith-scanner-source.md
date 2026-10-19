# 2026-10-19 — LangSmith as a read-only scanner source (#3738)

**Commit:** `feat(agentic): LangSmith as a read-only runtime source in the reference scanner (#3738)`

## Design

A follow-up of step `4a` (#3678) under the owner's decisions of 2026-10-19 on
#3738: LangSmith is the `runtime` source kind of `inflect-agent-harness/1`, on
LangSmith's US or EU cloud host or the customer's self-hosted LangSmith, and the
scanner DPIA names it.

```
packages/agent-harness-scanner
  config: { kind: runtime, product: langsmith,
            endpoint: { cloud: us|eu }
                    | { selfHosted: https://…, egressPrivateCidrAllowlist?: [CIDR] },
            apiKeyEnv, workspaceId?, windowDays (7, ≤30), readDeployments (false) }
  sources/langsmith.ts
    (self-hosted only) assertResolvesReachable(host, allowlist) ── before EVERY request
    1. only with readDeployments: true
       GET /v2/deployments          (/api-host/v2/deployments self-hosted)
         → { id, tracer_session_id } per deployment, nothing else
    2. GET /api/v1/sessions?reference_free&include_stats&facets
           &stats_start_time=asOf−window&stats_filter=eq(run_type,"tool")
           &stats_select=run_count&stats_select=run_facets
         → per project: run_count (tool calls), facets keyed `name` (calls by tool)
         → Σ name facets must equal run_count, else PAGINATION_TORN
    observations:
      langsmith:project:<id>     a project with ≥1 tool call that no listed deployment writes to
      langsmith:deployment:<id>  (opt-in) every deployment, tools of its project
  report.ts   tools merged per agent by (server, name); count stays on the observation
  scan.ts     log line carries toolCalls (the one place the count may go)
```

Deployments are read before projects so that a read stopping part-way never
reports a deployment's tracing project as an agent of its own; on the next
complete scan it would reappear as the deployment, and the stray project row
would hold a `SHADOW_AGENT` finding nothing could close.

## Files

| File | Role |
| --- | --- |
| `packages/agent-harness-scanner/src/sources/langsmith.ts` | the source: endpoint table, window, aggregate parse, tool-name digest |
| `packages/agent-harness-scanner/src/customer-host.ts` | a customer-named host: checked at configuration, re-resolved before each request, against the estate's private-range allowlist |
| `eslint.config.mjs` | the scanner may import `@/lib/security/cidr`, the pure CIDR parser, besides the wire contract |
| `packages/agent-harness-scanner/src/config.ts` | the `runtime` source's strict schema; `sourceCredentialEnv` |
| `packages/agent-harness-scanner/src/source.ts` | `Observation.tools` (`ObservedToolUse`: the tool and its call count) |
| `packages/agent-harness-scanner/src/report.ts` | merges tools per agent, caps them at `MAX_TOOLS_PER_AGENT` as `BYTE_CAP` |
| `packages/agent-harness-scanner/src/scan.ts`, `scanner-surface.ts` | construction, the `resolveHost` test seam, the declared paths, version 0.2.0 |
| `tests/helpers/agent-harness-source-fakes.ts` | a LangSmith workspace fake that computes the window's aggregates from runs, and answers the run endpoints with their content |
| `docs/agentic-harness-scanner-dpia.md` | the source, what is read, kept and never read; R15, R16; the sign-off |

## Decisions

- **GET only, so aggregates rather than runs.** LangSmith's run query and run
  stats endpoints are POSTs, and the source has no POST. The projects listing is
  a GET that takes `stats_filter` and `stats_select`, so the tool-call count and
  its split by run name come from there, and no run is ever requested. Not
  reading runs is also what keeps run inputs, outputs and metadata — the
  customer's data, possibly personal — in the estate.
- **The facet shape is the one unconfirmed assumption.** The paths and every
  query parameter are in LangSmith's published OpenAPI documents; the members of
  a run facet (`key`, `value`, `n`) are typed there only as an object. So the
  parse is strict in the direction that fails closed: a `name` facet that is not
  a count, missing facets, or facets that do not sum to `run_count` stop the read
  as `PAGINATION_TORN`. A wrong assumption therefore shows as an INCOMPLETE
  source with a reason, never as an agent with fewer tools than it called. The
  sum check also catches a top-k facet list that was cut short.
- **The count has no member in `/1`, so it is not reported.** `ToolSchema` is
  strict and carries no count; inventing a member is a new contract id. The count
  stays on the observation, is asserted by the tests, and reaches the log as a
  per-source total. The owner placed counts and model endpoints in contract
  `/2` (#3754); the source fills them in a follow-up once `/2` lands.
- **Tool fields say what LangSmith cannot.** `pinned: false`, `manifestHash:
  null`, `readOnlyHint: null`: nothing the scanner saw pins a definition or
  declares a hint, and the contract counts an undeclared hint as a write. The
  ingest therefore raises `UNPINNED_WRITE_TOOL` for each agent that called a
  tool, and only an MCP source read in full can close one. The owner confirmed
  this is intended (2026-10-19): a tool seen only by LangSmith is unpinned and
  undeclared until an MCP read or a registration proves otherwise. `server` is the
  tracing project the calls were seen in, because LangSmith does not record a
  tool's server.
- **A run name can carry content; a tool name in the report cannot.** A model
  calls a tool by an identifier, so a name outside `[A-Za-z0-9_.:-]{1,128}`, or
  one with a secret's shape, is a run name set at call time and is reported as
  `tool-sha256:<16 hex>`. Refusing it instead would leave such an estate
  permanently INCOMPLETE over a name the customer may not control.
- **Deployments are agents by existence; projects by behaviour.** Every listed
  deployment is reported, idle or not. A project is reported only when it called
  a tool in the window; a project that only called a model is counted in `rows`.
  An empty window reports no agent and the ingest raises `EMPTY_SCAN`.
- **The self-hosted host copies the application's check rather than importing
  it.** `eslint.config.mjs` holds the package to the wire contract, so
  `checkWebhookUrl`'s rules and `isPrivateAddress` are copied into
  `customer-host.ts`, and a test holds the copy to the application's answer on
  every address in a table. The re-resolution runs before each request; pinning
  the connection to the checked address needs an undici dispatcher, which the
  scanner does not take, so that gap is DPIA residual R16.
- **Deployments are opt-in** (owner decision, 2026-10-19).
  - **Why.** LangSmith's deployments listing documents each deployment's
    `secrets` with their values. A scanner that does not need the listing
    should not receive it.
  - **Default.** `readDeployments` defaults to false, so the source reads
    projects only. An estate that wants its deployments listed opts in, and
    the source then keeps each deployment's id and tracing project.
  - **Self-hosted.** The same switch serves a self-hosted LangSmith that runs
    no deployment control plane, where the listing would answer 404. That is
    the operator's statement in the configuration, never inferred from a 404.
- **A private-range allowlist for a self-hosted LangSmith** (owner decision,
  2026-10-19). It mirrors the application's `EGRESS_PRIVATE_CIDR_ALLOWLIST`
  (#3328) in name (`egressPrivateCidrAllowlist`) and in its three properties:
  - It lives in the estate's own file, never a tenant column.
  - The application's never-allowlistable ranges (metadata, loopback,
    link-local) are checked first.
  - It removes no other check.

  The configuration check and the per-request check both apply it.

  The CIDR parser is imported from `@/lib/security/cidr` (pure, import-free)
  rather than copied, which widened the scanner's ESLint import boundary by
  exactly that module. The never-allowlistable list is copied, because its
  module reads the environment. A test holds the copy to the application's
  answer.
- **Offset paging, and its residual.** Both listings page by an offset the source
  computes, so no next link is server-supplied. A project created mid-read
  pushes the rest down a place, so one is listed twice and the repeat is
  `PAGINATION_TORN`; one deleted mid-read pulls the rest up a place, so one is
  skipped unseen, which no offset listing can detect.
