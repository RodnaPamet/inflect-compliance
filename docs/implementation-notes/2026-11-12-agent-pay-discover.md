# 2026-11-12 — Discover payment capability the register does not know (Agent Pay Phase 2)

**Commit:** `feat(agentic): find agents whose code can pay, and raise SPENDING_AGENT_UNDECLARED (Agent Pay Phase 2)`

Phase 2 of `docs/ai-architecture/mastercard-agent-pay.md`, sub-phases 2.1, 2.2,
2.3 and 2.5. No migration: the fact travels in the signed report and lands as a
harness finding, so this change adds no column, table or enum value.

## Design

```
scanned file ──► code/payment.ts ─────► CodeAgent.paymentCalls (same file's agents)
  (imports resolved,         │                      │
   never run)                │ dynamic import in a  ▼
                             │ payment-naming file  observation.paymentCapabilities  ([] stated)
                             ▼                      │
                        UNPARSEABLE                 ▼
                                         report.ts ─► inflect-agent-harness/4 (signed)
                                                     │
                     ingest: verify /4 strict schema ▼
                     + read AgentSpendingAuthority standing per linkable register row
                                                     │
                                planHarnessScan ─────► SPENDING_AGENT_UNDECLARED:<registeredAgentId>
```

- **The fact** is a call to a recognised payment CLIENT entry point, or an alias
  bound to one, resolved through the file's own imports (`recognize.ts`'s rule:
  a local function with the same name is not the library's). An import never
  called is nothing. A dynamic import (`import(x)`, an inline `require`,
  `__import__`, `importlib.import_module`) in a file that names a payment
  library makes the `code` source INCOMPLETE `UNPARSEABLE` at that line, so a
  hidden payment path makes the read stop vouching for the file rather than
  report it clean.
- **The contract** `/4` is `/3` plus the optional per-agent
  `paymentCapabilities[]`: closed enums for protocol and library, and a
  `code://` locator. Three states as `models[]` has: absent (no code read),
  `[]` (read, none), entries. Only an agent discovered via `code` may carry it.
- **The planner** keys the finding by the REGISTER ROW, never the discovered
  id: the register decides. It opens when a linked agent pays and the row holds
  no live envelope; an envelope awaiting review holds it; it closes on a
  reviewed envelope or on a COMPLETE code read that reports every linked agent
  of the row with `[]`.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/harness-contract-rules.ts` | `HARNESS_CONTRACT_V4`, `PAYMENT_PROTOCOLS`, `PAYMENT_CLIENT_LIBRARIES` |
| `src/lib/agentic/harness-contract.ts` | `/4` agent and body schemas, accepted beside `/2` and `/3`; the `/1` refusal now names `/4` |
| `src/lib/agentic/harness-findings.ts` | `SPENDING_AGENT_UNDECLARED`, `spendingAuthorityStandingOf`, `PriorHarnessState.spendingAuthority`, `PlannedAgent.paymentCapabilities` |
| `src/app-layer/usecases/agent-harness-scans.ts` | Reads the spending-authority standing of every register row the scan can link (read only; Phase 1's usecase stays the only writer) |
| `packages/agent-harness-scanner/src/sources/code/payment.ts` | The recogniser and its entry-point table |
| `packages/agent-harness-scanner/src/sources/code/javascript.ts` | A dynamic `import(…)` is lowered to a call of `import`, so a reader can tell it from any other unresolvable call |
| `packages/agent-harness-scanner/src/sources/langchain.ts`, `source.ts`, `report.ts`, `scan.ts`, `scanner-surface.ts`, `container/smoke-verify.ts` | Attribution to the file's agents, the observation member, the report merge, `/4` (scanner 0.13.0) |
| `tests/fixtures/agent-pay-scanner/payment-capability-record.json` | The evaluation record (2.5, G11): fifteen synthetic repositories and their expected facts |
| `tests/helpers/agent-harness-fake-scanner.ts` | `validV4ReportBody` and six `/4` malformations |
| `docs/agent-harness-contract.md` | `/4` |

## Decisions

- **x402 only, because nothing else was confirmed.** Phase 0.1 found no
  Mastercard Agent Pay client package (its API is OpenAPI-generated per
  client). x402, the protocol AP4M is built on, has public payer clients; their
  names and exported entry points were read from the npm and PyPI registries on
  2026-11-12 (`x402-fetch` 1.2.0, `x402-axios` 1.2.1, `@x402/fetch` and
  `@x402/axios` 2.30.0, PyPI `x402` 2.27.0, and the 1.x Python module path
  `x402.clients`). The seller-side middleware (`x402-express`, `-hono`,
  `-next`) accepts payments and initiates none, so it is not a spending
  capability and has a case in the record saying so. A Mastercard value is a
  new contract id later, not a guess in this one.
- **Not added to `FRAMEWORK_MARKERS`**, contrary to the roadmap's wording, and
  the roadmap now says so. The capability is attributed to the agents the SAME
  file defines, and such a file already carries a framework marker; making
  every x402 helper file a parse candidate would only add UNPARSEABLE noise from
  files that can define no agent. Cross-file attribution (a helper module that
  wraps the client for an agent defined elsewhere) is a stated limit.
- **Attribution is per file, to every agent in it.** Following which agent a
  wrapped `fetch` is handed to needs data flow the reader does not model; per
  file errs toward reporting a capability, which is the side that asks a person
  to look.
- **Opens on any read, closes only on a complete one.** What was read is real,
  so an incomplete `code` read that saw a payment still opens the finding; only
  a complete read that reports `[]` may close it. An absent member never closes
  it (the agent's code was not read).
- **An unreviewed envelope holds the finding.** Its declaration exists, and
  Phase 1's activation precondition already refuses the agent until a second
  person reviews it; raising a second finding for the same gap would duplicate
  the register's own rule. A review, or a withdrawal followed by a clean
  complete read, ends it.
- **Rail-agnostic.** A reviewed envelope on any rail closes the finding. The
  register declares an envelope per token rail, and the code fact names a
  protocol, not a token; matching them would need a mapping (x402 ↔ AP4M or
  OTHER) the owner has not decided.
- **The finding never carries a value.** It names the library and the locator,
  which the contract already holds to the reference shape and the secret walk.

## Risk assessment

No schema change. The scanner moves from `/3` to `/4`; the ingest keeps
accepting `/2` and `/3`, so a scanner not yet upgraded is unaffected, and a
`/4` scanner against an ingest not yet upgraded is refused `SCHEMA` and writes
nothing (the scanner image ships after the app). One more indexed read per
ingest (`AgentSpendingAuthority` by tenant and agent), bounded by linkable rows
× rails.

## Not built

- **2.4** — the Know Your Agent key-directory check. It reuses Web Bot Auth
  Phase 3.1–3.2's `verifySignedRequest` pieces and cached `safeFetch` directory
  reader, which are not on this base (`src/lib/web-bot-auth/` holds the outbound
  key, directory and signer only). It also needs a register column for the
  agent's directory URL (a migration) and the `AGENT_SIGNING_DIRECTORY_INVALID`
  finding.
- **Phase 3** — 3.1 `AGENT_SPENDING_AUTHORITY_PER_AGENT` needs a migration
  widening the `AgenticEvidenceArtefact_kind_known` and `_agent_scope` CHECKs
  and the per-agent retired-agent trigger, `EVIDENCE_TARGETS` rows for the 0.4
  mapping, and an emitter path in the per-agent pass; 3.2 the governance-pack
  report; 3.3 waits for 1.4's recertification pack section, which is Phase 1
  work and not built either.
