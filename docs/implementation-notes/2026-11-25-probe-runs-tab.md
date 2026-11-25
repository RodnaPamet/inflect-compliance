# 2026-11-25 — The Probes tab and the probe key cards, step 8b of the active flavour

**Commit:** `feat(agents): the Probes tab and the prober and approver key cards (step 8b)`

## Design

Step 8a made `scanent-probes/1` reports ingestible through the API alone. This
step is the surface: a **Probes** tab on `/agents/reports`, beside Agent
surface, and the cards that manage the two key registers.

```
/agents/reports?tab=probes            (inventory rule: view key or register key)
  ├─ getProbeRunInventory             per prober: recent runs (counts only) + open findings
  ├─ getProberKeysView                only for admin.agent_registry        → Prober keys card
  ├─ getProbeApproverKeysView         only for admin.tenant_lifecycle      → Approver keys card
  └─ ?run=<id> → getProbeRunDetail    targets + outcomes; endpoint and excerpt decrypted
                                      only for admin.agent_registry, audited when returned
```

The run detail is read by the PAGE on the server, not by a new API route: a row
click navigates to `?tab=probes&run=<id>` and the sheet renders what the server
read. That keeps the excerpt decision in one usecase, adds no route, edge path or
OpenAPI entry, and leaves the AUDITOR edge allowlist untouched.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/probe-run-read-model.ts` | Plain types for the tab, and the pure `probeRunState` |
| `src/app-layer/usecases/probe-runs.ts` | `getProbeRunInventory`, `getProbeRunDetail` (reads; the file stays the only writer of the run tables) |
| `src/app-layer/usecases/agent-prober-keys.ts`, `probe-approver-keys.ts` | The two card reads |
| `src/app/t/[tenantSlug]/(app)/agents/reports/page.tsx`, `ReportsClient.tsx` | The `probes` tab branch, loaded with `dynamic()` |
| `src/app/t/[tenantSlug]/(app)/agents/reports/probes/` | Tab, run sheet, the two key cards |
| `src/app/t/[tenantSlug]/(app)/agents/reports/keys/RegisterSigningKeyModal.tsx` | The register dialog all three key cards share (was the harness tab's own) |
| `docs/user/how-to/set-up/connect-a-prober.md` | The help-site how-to |

## Decisions

- **The endpoint is withheld with the excerpt.** The owner decided excerpts are
  for register-key holders; a URL's path can carry a token, so the full endpoint
  follows the same rule, and everybody sees the origin. A withheld field is null
  with `excerptsShown: false`, and the sheet says "withheld", never "empty".
- **An excerpt read is audited** (`PROBE_RUN_EXCERPTS_READ`), every time it is
  returned, naming the run and nothing it read. A read through the view key alone
  returns no excerpt and writes no row.
- **"Every probe resisted" is one expression** (`probeRunState`): an agent that
  acted or disclosed first; then no agent reached, stopped, nothing concluded;
  and RESISTED only with `outcomeCount > 0 && resistedCount === outcomeCount`.
- **Each card is read only for the key its register takes**, so a viewer without
  it gets no card rather than one whose every button is refused.
- **One register dialog for all three signing-key registers.** The harness
  tab's scanner-key dialog became `agents/reports/keys/RegisterSigningKeyModal.tsx`:
  scanner and prober keys pick an agent, an approver key names who holds it, and
  all three take the same public key field and show the server's refusal
  (including a key held in the other probe register). It keeps each card's
  element and test ids. The primary-button ceiling did not move: the dialog's one
  primary submit is the one the scanner dialog already had.
