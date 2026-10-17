# 2026-10-17 — The harness ladder and the `inflect-agent-harness/1` contract (#3660)

**Commit:** _(this PR)_ `feat(agentic): the harness ladder and the scanner report contract`

Step `0a` of the agentic AI for IAM roadmap (#3654). It lands the design
document, the ladder every later step scores against, and the report contract
the scanner (`1a`) is built to.

## Design

```
scanner (client environment)                       Inflect
  per-criterion verdicts ──sign──▶ raw report ──▶ verifyAndParseHarnessReport
                                                     size → JSON → signature by a
                                                     TRUSTED key → strict schema
                                                          │
                                                          ▼
                                     scoreHarness(verdicts) → H0..H5 (derived)
                                     isScanComplete(sources) → derived
```

The ladder (`harness-ladder.ts`) is a pure module: six rungs in one const tuple,
a stable id per criterion, and a scorer that returns the highest rung whose
criteria — and every lower rung's — are all met **with evidence**. The contract
(`harness-contract.ts`) is strict Zod over a body the scanner signs with Ed25519,
using the same `canonicalJson` and SHA-256 construction as mediator receipts.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/harness-ladder.ts` | Rungs, criterion ids, the scorer, the report-only shortfall bar |
| `src/lib/agentic/harness-contract.ts` | Contract schemas, bounds, verify-then-parse |
| `tests/helpers/agent-harness-fake-scanner.ts` | Reference scanner: a valid signed report and every refused malformation |
| `eslint.config.mjs` | Error-level ban on importing the ladder from the authority funnel |
| `docs/agentic-iam-roadmap.md` | The living design document |
| `docs/agent-harness-contract.md` | The normative contract |

## Decisions

- **A met verdict without evidence is not met, and a contradiction resolves to
  the worse answer.** Scoring what can be seen and assuming the rest would give
  the least observable agent the best score — the inversion the register already
  refuses for an unscored risk tier.
- **The report cannot carry a level.** The verdicts travel; the conclusion is
  derived here. A self-declared level is an unknown member, so the strict schema
  refuses it rather than ignoring it.
- **Completeness is derived from the sources, and INCOMPLETE must name a
  reason.** A COMPLETE source carrying a reason is refused as a contradiction.
- **Credentials are references, checked twice.** A value fails the
  `scheme://locator` shape first; a secret embedded in a reference fails the
  secret-shape check.
- **The signer must be trusted, not merely valid.** A mathematically valid
  signature from an unregistered scanner is `UNTRUSTED_SIGNER`.
- **Report-only is enforced, not described.** The owner decided the bar never
  gates (2026-10-17), and the cheapest way to break that is an import, so ESLint
  refuses one from the funnel's files at error level.
- **An unknown reach is held to the higher bar.** Unknown is what a write-capable
  agent looks like before anyone has checked.
