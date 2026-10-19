# 2026-10-19 — The harness report contract `inflect-agent-harness/2`

**Commit:** `feat(agentic): harness report contract inflect-agent-harness/2 — a code source, UNPARSEABLE, unbound credentials (#3754)`

A Phase 4 follow-up of step 4a (#3678, Phase 4 #3659). One shared contract bump
(owner decision, 2026-10-19) for two consumers: the LangChain and LangGraph
detector (#3737) needs a `code` source kind and a reason for a definition it
cannot resolve, and #3686 asked whether the scanner can report what the ingest
would need to derive `ORPHAN_CREDENTIAL` itself.

## Design

```
            signed report (raw bytes)
                     │
   size ─► JSON ─► signature by a trusted key ─► contract id ─┬─► /1 schema (strict, /1 lists)
                                                             ├─► /2 schema (strict, /2 lists + unboundCredentials[])
                                                             └─► any other id: SCHEMA, value not repeated
                     │
              planHarnessScan(body, prior)          prior.openOrphanCredentials ◄── ingest reads this
                     │                                                             scanner's open
   /2 only: unboundCredentials[] whose source is COMPLETE ─► assert ORPHAN_CREDENTIAL  ORPHAN_* rows
            open ORPHAN_* of THIS scanner whose source is COMPLETE
            and no longer listed                     ─► resolve
```

`/2` is `/1` plus the source kind `code`, the INCOMPLETE reason `UNPARSEABLE`,
the member `unboundCredentials[]` of `{ ref, sourceKind }`, and — a second
owner decision the same day — optional per-tool `calls` with `windowDays`, and
optional per-agent `models[]` of `{ endpoint, model }`. Both schemas are built by one function
(`bodyMembersOver`) over each id's kind and reason lists, so the shared part
cannot drift between them; `/2` adds its member and its cross-member rules.

The verifier keeps its order. The contract id is body content, so it is read
only after the signature has verified, and it picks the schema from a `Map`
(no prototype key can name one).

The planner derives `ORPHAN_CREDENTIAL`, keyed
`ORPHAN_CREDENTIAL:<scanner>:<kind>:<ref>`. It opens on an entry whose source is
`COMPLETE`; it closes an open finding of the same scanner only when that
finding's source is `COMPLETE` in this scan and the entry is gone. The ingest
supplies the open findings it may close (`PriorHarnessState.openOrphanCredentials`),
read only for a `/2` report, by the scanner's prefix, bounded at two reports'
worth.

The reference scanner emits `/2`. A source may return
`SourceRead.unboundCredentials`; the builder drops any reference a merged
principal holds (kept or cut by a cap), dedups per source, sorts, and caps at
10,000 with the overflow's source marked `BYTE_CAP`. Okta and Key Vault return
none: both report every credential against its principal.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/harness-contract-rules.ts` | The two ids and `HARNESS_CONTRACT_IDS`, in the client-safe leaf so the planner can narrow on the id without importing `crypto` |
| `src/lib/agentic/harness-contract.ts` | Per-id kind and reason lists, the schema factory, the `/1` and `/2` body schemas, the unbound-credential rules, the verifier's dispatch; stored sources re-read against the union |
| `src/lib/agentic/harness-findings.ts` | `ORPHAN_CREDENTIAL` in the planner; `orphanCredentialRefOf`, `orphanCredentialRefPrefix`; `PriorHarnessState.openOrphanCredentials` |
| `src/app-layer/usecases/agent-harness-scans.ts` | Reads this scanner's open orphan findings for a `/2` report; writes through the existing seam |
| `prisma/migrations/20261019070000_agent_harness_estate_code_source/` | Widens `AgentHarnessEstateSource_kind_known` to the eight kinds |
| `packages/agent-harness-scanner/src/{report,source,scan,scanner-surface}.ts` | Emits `/2`; `SourceRead.unboundCredentials`; version `0.2.0` |
| `tests/helpers/agent-harness-fake-scanner.ts` | `validV2ReportBody` beside the `/1` body; ten new malformations |
| `messages/{en,bg}.json` | The `UNPARSEABLE` reason's label |
| `docs/agent-harness-contract.md`, `docs/agentic-harness-scanner-dpia.md`, `docs/agentic-iam-roadmap.md`, `CLAUDE.md` | The transition rule, the DPIA amendment and condition 15, Current state |

## Decisions

- **Two strict schemas, not one lenient one.** A `/1` report with `/2`'s member,
  kind or reason is refused. Accepting it would let a scanner speak `/2` while
  claiming `/1`, and the planner narrows on the id: a `/1` report must never be
  read as having said anything about unbound credentials.
- **`unboundCredentials` is required in `/2`**, empty when the scanner saw none,
  so an omission is a refusal rather than a silent "none".
- **A `/1` report closes no orphan.** Its silence is not a statement. Without
  this, a scanner downgraded to `/1` would close every orphan it had raised.
- **Keyed by scanner as well as source kind.** Two scanners' `vault` sources can
  be two different vaults; one scanner's complete read is no evidence about the
  other's. The cost is that two scanners seeing one orphan raise two findings.
- **Opening needs the credential's source COMPLETE, as the owner decision
  states — not the whole scan.** An incomplete identity source could hide the
  agent that binds the credential; the finding then closes on the next
  complete read. Recorded as an owner question on the pull request.
- **A report that contradicts itself is refused.** An unbound entry from a source
  the report does not list, the same (source, reference) twice, or a reference an
  agent in the same report holds is `SCHEMA`.
- **`MEDIUM` `OBSERVATION`**, as the hygiene pass's credential findings are
  observations: the remedy is to retire or bind the credential, after a look.
- **The estate CHECK follows the contract.** The 4a migration pinned estate
  kinds to `SOURCE_KINDS` "so a source the contract cannot report can never be
  declared"; with `code` reportable, an estate may declare it. Widening only, so
  a rolling deploy is unaffected; a unit test reads the newest migration's
  CHECK and holds it to `SOURCE_KINDS`.
- **No column for the contract id.** Nothing reads it back: stored sources are
  re-read against the union of the ids' lists, which is all a reader needs.
- **The `code` source's use of shared members is defined here**, not in #3737,
  because #3737 may change nothing beyond this contract: a tool served from no
  server has `server` = the `code://` locator of its definition or
  construction, an MCP server's run-time tool set is one `<server key>:*`
  entry, and a credential is `env://<NAME>` or `code://<path>#L<line>`, never
  the value.
- **Call counts live on the tool, with their window** — both or neither. On
  the tool they round-trip in `toolsJson` with no column added, and a count
  never stands without the window that makes it mean something; an agent-level
  window would have had no stored field to land in.
- **Model endpoints are verified and not stored.** No column holds them, and
  adding one is a migration the decision did not ask for. An endpoint is a
  `scheme://locator` or a bare host; any userinfo is refused, not only a
  password with a known shape, and the ingest's secret walk reaches it.
- **Stored tools are re-read against `/2`'s tool**, which every `/1` tool is,
  so a scan item carrying counts reads back rather than going unreadable.
