# 2026-11-14 — ASI07: a scheduled A2A integrity check replaces the exemption

**Commit:** `fix(agentic): replace the ASI07 exemption with a scheduled A2A integrity check (#5305)`

## Design

`AGENTIC_CONTROL_EXEMPTIONS` exempted OWASP ASI07 (inter-agent communication)
on the claim that no A2A transport shipped. A2A ships (#3673, #3679), and its
state drifts between messages. Owner decision (2026-11-14, #5305 item 25):
remove the exemption and add a scheduled check.

The check is a fifth agentic control test, `AGENTIC_A2A_INTEGRITY`, on the
runner the other four use. There is no new job, table or migration:

```
ControlTestPlan(INTEGRATION, { check: 'AGENTIC_A2A_INTEGRITY' })
  → control-test-scheduler (when the plan's cron is due)
  → control-test-runner → agenticControlTestHandler → checkA2aIntegrity
  → ControlTestRun(PASS | FAIL | INCONCLUSIVE) + Evidence + on FAIL a Finding (HIGH)
```

`setUpAgentAssuranceChecks` schedules it daily at 06:40 UTC with the other
four, on the control linked to ASI07, and the register's Assurance section
lists it, because both iterate `AGENTIC_CHECK_IDS`.

What it examines:

| Drift | Code | Source |
| --- | --- | --- |
| ACTIVE approved peer whose live card no longer hashes to its pin | `CARD_MOVED_SINCE_PIN` | `recentAgentCard` (admission's ≤15-minute copy) + `compareAgentCard` |
| ACTIVE peer unpinned past `A2A_UNPINNED_GRACE_DAYS` (7) | `PEER_LEFT_UNPINNED` | `PeerAgent` pin columns |
| In-force signing key older than `A2A_SIGNING_KEY_MAX_AGE_DAYS` (365) | `SIGNING_KEY_PAST_ROTATION_AGE` | `TenantA2aSigningKey` |
| A stored receipt, among the newest 200, that no longer verifies | `RECEIPT_DOES_NOT_VERIFY` | `verifyStoredA2aReceipt` |

## Files

| File | Role |
| --- | --- |
| `src/app-layer/services/agent-control-tests.ts` | the check, its constants and config; ASI07 exemption removed |
| `src/lib/agentic/a2a/receipt.ts` | `storedReceiptVerificationKey`, shared with the receipts list |
| `src/lib/agentic/peer-agent-card.ts` | `pinnedCardHashesOf`, moved out of `peer-agents.ts` |
| `src/app-layer/usecases/a2a-messages.ts`, `peer-agents.ts` | use the two shared helpers |
| `tests/unit/agentic/a2a-integrity-check.test.ts` | every branch, in memory |
| `tests/integration/agentic-a2a-integrity.test.ts` | real runner, two tenants plus an empty one |

## Decisions

- **Fail closed.** A pinned peer whose card cannot be read, or a receipt whose
  key id names no key held here, makes the result INCONCLUSIVE
  (`A2A_STATE_UNVERIFIABLE`) when nothing breached, and a breach still FAILS.
  No ACTIVE peer and no stored receipt is `NO_A2A_PEERS`, vacuous, and does not
  stamp `Control.lastTested`.
- **The live card is read through `recentAgentCard`**, the copy admission
  compares against, so the check and the gate agree about what a peer serves.
  This is the only agentic check that reads the network. It does so inside the
  runner's transaction (120 s budget), in parallel, with each read bounded by
  the card fetch's 10 s timeout and at most 100 peers.
- **365 days, not the API-key rotation age.** `apiKeyRotationDays` (default
  90) governs bearer secrets presented on every request. The A2A key is an
  Ed25519 signing key whose private half stays in an encrypted row, and
  rotating it changes the published card, so every peer must re-approve it
  within the seven-day grace. A year is the short end of NIST SP 800-57's
  one-to-three-year cryptoperiod for a private signature key. A plan may set
  `signingKeyMaxAgeDays` in 30..1095.
- **The key age is judged only while an ACTIVE peer exists**, which is when the
  key is in use. A retired key is never judged by age; receipts signed by it
  still verify.
- **Unpinned is a breach only after seven days**, the life of a peer
  invitation code. Inside that window the peer is counted as `awaitingPin`.
- **Receipt keys come from the row's key id, never the row's own public key**,
  through the helper the receipts list now shares, so the two readers cannot
  disagree.
- **Appended last in `AGENTIC_CHECK_IDS`.** The setup reports the first check
  it cannot place, so a tenant that set up the other four hears about those
  first. A tenant with no control linked to ASI07 now gets `CONTROL_MISSING`
  for this check from the setup, as for any other.
