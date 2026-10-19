# 2026-10-19 — The harness scanner's Entra, MCP and register sources, its container, and the retirement of `/1`

**Pull requests:** #3767 (a, the Entra source), #3768 (b, the MCP source), #3769
(c, the register read tool and source), and (d), the container and the
retirement of `/1`, which closes #3686.

## Design

#3686 was re-scoped onto `packages/agent-harness-scanner` (the reference
scanner from #3678) and delivered in four parts, each a pull request. The owner's
decisions on the issue, 2026-10-19, are numbered 1 to 7 there and cited by
number below.

```
            ┌─────────────────────────── client estate ───────────────────────────┐
            │  agent-harness-scanner container (node, read-only, no npm, uid 1000) │
            │                                                                      │
 Graph ◄─GET┤ entra-sp        own-directory app SPs + managed identities (1)      │
 MCP   ◄─RPC┤ mcp             initialize, notifications/initialized, tools/list   │
            │                 (5), optional read token per server (6)             │
 Inflect◄RPC┤ inflect-register one tools/call: get_harness_register (3, 7)        │
            │ okta / vault / runtime / code   (#3678, #3738, #3737)               │
            │          └──► merged by discoveredId ──► /2 report ──► Ed25519 sign │
            └───────────────────────────────────────────┬──────────────────────────┘
                                                        ▼ POST, /2 only (d)
                                 /api/t/{slug}/admin/agents/harness-scans
```

**(a) Entra.** One client-credentials exchange, then `GET /v1.0/applications`
and `/v1.0/servicePrincipals` with `$select` and `$expand=owners($select=id)`. An
SP is an agent when its application is registered in this directory, or it is
a managed identity (decision 1). Third-party applications are reported only
with `includeThirdPartyApplications`. Microsoft first-party SPs and disabled
SPs are never reported. Credentials are references
(`entra://<dir>/applications/<appId>/password/<keyId>`). Credentials on an
application with no SP are `/2`'s `unboundCredentials[]`, claimed only after
both listings were read in full.

**(b) MCP.** The wire the source holds has `open` and `listTools` and no method
parameter. It sends `initialize`, the initialized notification and `tools/list`
(decision 5), reads a JSON or SSE answer under the byte cap, and cancels the
stream once answered. A tool is reported by name with the hash of its
definition. `pinned` is true only when the server's configured
`pinnedManifestHash` equals the hash of the whole listing read live. The
server's tools reach the agents the configuration lists, and replace a `code`
agent's `<key>:*` placeholder for the same URL, but only from a server read in
full (decision 2).

**(c) The register.** A new MCP tool, `get_harness_register`, is authorized on
`admin.agent_harness_ingest` and scoped `{admin, harness_ingest}`. So the
scanner's one key (`mcp:read` + `admin:harness_ingest`, decision 3) reads its
own tenant's register and nothing else. It returns live agents with their keys,
policy-card state, tier freshness and person-confirmed principals. The
`inflect-register` source turns each into observations under the confirmed
principal's own id, so they merge with Entra's (decision 4). It is the only
source whose `registeredAgentId` reaches the report.

**(d) The container** is `packages/agent-harness-scanner/Dockerfile`, built
and smoke-tested in CI and not published. It holds the scanner, the eight
application modules it imports, and tsx, typescript and zod pinned exactly in
its own manifest and lockfile (`container/`). `node --import tsx` runs as
process 1. CI's `Scanner image` job runs `container/smoke.sh` and gates on
Trivy. **`/1` is retired:** `HARNESS_CONTRACT_IDS` holds `/2` alone, and a `/1`
report is a `SCHEMA` refusal naming the retirement, with nothing written.

## Files

| File | Role |
|---|---|
| `packages/agent-harness-scanner/src/sources/entra.ts` | The Entra source (a) |
| `packages/agent-harness-scanner/src/sources/mcp.ts`, `src/http.ts` | The MCP source and its two-function wire (b) |
| `src/app-layer/usecases/agent-harness-register-read.ts`, `src/lib/mcp/tools/harness-tools.ts` | The register read and its MCP tool (c) |
| `packages/agent-harness-scanner/src/sources/inflect-register.ts` | The register source (c) |
| `packages/agent-harness-scanner/src/report.ts` | Placeholder replacement, `registeredAgentId` from the register only |
| `packages/agent-harness-scanner/src/scanner-surface.ts` | Every request the scanner can make; its hash is the report's manifest hash |
| `packages/agent-harness-scanner/Dockerfile`, `Dockerfile.dockerignore` | The image and its allowlisted build context (d) |
| `packages/agent-harness-scanner/container/` | The image's manifest, lockfile, tsconfig, smoke test and in-image verifier (d) |
| `.github/workflows/ci.yml` (`scanner-image`), `.github/dependabot.yml` | The CI build, smoke and Trivy gate; updates for the digest and packages (d) |
| `src/lib/agentic/harness-contract*.ts`, `harness-findings.ts`, `usecases/agent-harness-scans.ts` | `/1` retired: one accepted id, the orphan logic no longer branches on it (d) |

## Decisions

- **The scanner is process 1 and handles SIGTERM itself.** Process 1 is not
  stopped by a signal it has no handler for, so `docker stop` would wait out the
  grace period. A wrapper (tini) would be one more package in the client's
  image. A scan cut short posts nothing, so the CLI exits at once.
- **The base image is pinned by digest, the packages exactly, and Dependabot
  moves both.** The image runs in a client's estate holding the signing key, so
  the bytes a client builds should be the bytes CI scanned. The cost is that a
  newly fixed CVE in the pinned base turns the non-required `Scanner image` job
  red until the weekly Dependabot bump. The application image takes the other
  side of that trade (a floating tag).
- **The image's import closure is held by a test, computed with esbuild.**
  esbuild is the transform tsx runs, so the closure it reports, type-only
  imports erased, is exactly what the image needs. The COPY lines and the
  context allowlist are two hand-kept copies of it. The test fails when either
  drifts in either direction, so a contract module gaining an import fails Jest
  before it fails a client's first start.
- **The CI job runs on every pull request, not behind a path filter.** A path
  filter would be a third hand-kept copy of the same closure.
- **The smoke test verifies inside the image.** `smoke-verify.ts` is mounted
  read-only and runs on the image's own node and contract module. So a pass
  shows that the image signs what the ingest's verifier accepts, without
  installing the repository on the runner.
- **`/1`'s retirement refuses the id, not the content.** A report that was
  valid under `/1` is refused only for naming `/1`. The same body under `/2`,
  with an empty `unboundCredentials`, verifies. The refusal names the retired id,
  which is the module's constant rather than signer text, so it tells an
  operator what to do. Stored `/1` scans still read, because `/2`'s kinds and
  reasons contain `/1`'s. That is why `SOURCE_KINDS_V2` keeps every `/1` kind,
  and why the stored readers did not change.
- **The planner's and ingest's `/2`-only branches were removed, not kept.** With
  one accepted id they were always true, and a reader would take a dead branch
  for a live distinction. The fake scanner keeps `retiredV1ReportBody` as the
  one place a `/1` body still exists, to prove the refusal.
