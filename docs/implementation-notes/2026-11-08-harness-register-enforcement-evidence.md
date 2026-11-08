# 2026-11-08 — The register's enforcement facts, and the scanner's tokens

**Commit:** _(this change)_ — #5004 part B, on top of part A
(`2026-11-08-api-key-requires-token-exchange.md`).

## Design

The estate scanner's `inflect-register` source evidenced H1 and four of H2. It
could say nothing about `H2.audience_tokens` or most of H3, so the scanner
could not report itself at H3 (#3665's exit). The owner decided on 2026-11-08
how each is evidenced (#5004). This change carries those decisions:

```
get_harness_register (server)                    inflect-register (scanner)
  per key:   mcpCapable, requiresTokenExchange  →  H2.audience_tokens
  enforcement.manifestsPinned                   →  H3.manifests_pinned
  enforcement: proposeRefused, orchestrateRefused,
    grants {read, propose, external},
    profileInForce, skillsMounted               →  the read-only bound →
                                                     H3.propose_not_commit, prior_state_reads,
                                                     skills_declared, delegation_narrows
  (the scanner's own program)                   →  H3.payloads_guarded, own agent only
```

- **The server decides every fact; the scanner only maps them.** This is the
  rule `get_harness_register` already followed for its flags. The ceiling is
  the funnel's `resolveAutonomyCeiling` over the agent's autonomy and its
  tier cap. A pin "verifies" by the funnel's `verifyToolManifest`, using this
  build's own definitions. The registry imports the tool file, so the tool
  loads those definitions on call and hands them to the usecase.
- **The four no-write criteria are met only on the whole enforced bound**
  (decision 1). The ceiling must refuse propose and orchestrate. There must be
  no propose or external grant and no profile in force. Every run must have
  been read and none mounted a skill. Short of the whole bound, they are left
  unanswered rather than answered "no": a "no" would outvote a source that
  evidences them, because a doubly-reported criterion is judged on its worse
  answer.
- **An external grant is never vouched for.** Its live definition is its
  server's to state, and a stored-rows read cannot ask the server. So an
  external grant counts as external for the bound, and leaves
  `manifestsPinned` false.
- **`H3.payloads_guarded` is a fact about the scanner program** (decision 2).
  The scanner refuses to sign a report with a secret-shaped member, and the
  ingest refuses one again with the same check. So the verdict sits on the
  scanner's own agent only, and only as "met": OpenShell also reports this
  criterion, and a "no" from here would outvote it.
- **The scanner exchanges its key** (decision 3). The register wire posts the key
  to the same tenant's `/api/mcp/token` for a token whose audience is
  `get_harness_register` alone. It refuses anything that is not an `ifxt_`
  token, and sends `/api/mcp` only that token. The report upload stays a
  raw-key REST call. The exchange is declared on the scanner surface, so the
  manifest hash moves (`SCANNER_VERSION` 0.11.0).

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/agent-harness-register-read.ts` | The per-key flags and the `enforcement` block |
| `src/lib/mcp/tools/harness-tools.ts` | The description, and this build's definitions passed in |
| `packages/agent-harness-scanner/src/sources/inflect-register.ts` | The strict schema and the verdicts |
| `packages/agent-harness-scanner/src/http.ts` | The exchange before the register call |
| `packages/agent-harness-scanner/src/scanner-surface.ts` | The exchange declared; version 0.11.0 |
| `docs/agentic-harness-scanner-dpia.md` and three operator docs | The read described as it now happens |

## Decisions

- **The existing tool is extended rather than a second one added.** DPIA
  condition 2 (owner decision 7 on #3686) lets the scanner call exactly one
  named tool. A new tool would have amended that condition, and extending this
  one does not. The price is paid once, at deploy:
  - The new description drifts the tool's pin, so the tool is refused until
    a person re-approves it on each tenant that uses it.
  - The scanner image already running parses the old shape strictly. It reads
    the new payload as `PAGINATION_TORN`, an incomplete scan that says so,
    until the VM runs the new image.
  
  Both are #5004 part D.
- **"Mounted nothing" is read, not assumed.** `skillsMounted` is false only when
  every run of the agent that recorded a mount was read and each mounted `[]`.
  A read past its cap is `null`, and the bound does not hold on `null`.
