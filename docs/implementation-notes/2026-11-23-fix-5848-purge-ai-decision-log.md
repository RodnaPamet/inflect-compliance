# 2026-11-23 — tenant purge vs the AI decision log's append-only trigger (#5848)

**Issue:** #5848

## Design

The tenant purge deletes `AiSystem` and retains `AiDecisionLog`. Their FK is
`ON DELETE SET NULL ("aiSystemId")`, the column-scoped shape a retained table's
FK to a purged one must have. But a SET NULL is an UPDATE of the retained row,
and `ai_decision_log_immutable()` refused any UPDATE that moved `aiSystemId`.
So the FK action raised "AiDecisionLog is append-only; only humanOutcome may
transition" and the purge's per-tenant transaction rolled back. Every
registered agent's decision rows name an AI system, so no tenant that had ever
run an agent could be purged.

Migration `20261123120000_ai_decision_log_admit_fk_set_null` re-creates the
function with one early `RETURN NEW` in front of the old body. It admits a row
only when all three of these hold:

- `pg_trigger_depth() > 1`: the UPDATE was issued from inside a trigger. That
  is where Postgres runs a referential action: the RI trigger on `AiSystem`
  runs the SET NULL, and this row trigger fires one level deeper. No other
  trigger in the schema writes to `AiDecisionLog`.
- `OLD."aiSystemId" IS NOT NULL AND NEW."aiSystemId" IS NULL`.
- Every other column is `IS NOT DISTINCT FROM` its old value, `humanOutcome`
  included. The column list is the one `20261114120000` installed.

Every other UPDATE falls through to the old body, unchanged. So the old
refusals all stand, with the same messages: a re-point (including the FK's own
`ON UPDATE CASCADE`), NULL to a value, a NULL that moves any other column, a
person's direct `SET "aiSystemId" = NULL`, and the one-way `humanOutcome` stamp.

The cascade guard reads `onDelete: Cascade` only, and so stayed green through
this. A second guard, DB-backed because it needs the real triggers, is
`tests/integration/tenant-purge-retained-set-null-admitted.test.ts`:

- It takes its population from the live catalogue, with no allowlist. That is
  every `confdeltype = 'n'` FK from a `TENANT_PURGE_RETAINED` table to a table
  the purge removes, on a retained table that has a non-internal UPDATE
  trigger.
- For each FK, it builds a temp copy of the table (`LIKE … INCLUDING
  DEFAULTS`) with a real `ON DELETE SET NULL (col)` FK to a temp parent, and
  inserts a row. It then re-creates the table's own UPDATE triggers on the copy
  from `pg_get_triggerdef` and deletes the parent.
- It runs this twice, once with a sparse row and once with a full row, and
  always rolls back.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261123120000_ai_decision_log_admit_fk_set_null/migration.sql` | The trigger re-created to admit exactly the FK's SET NULL |
| `tests/integration/tenant-purge-ai-decision-log.test.ts` | The reproduction (real purge), plus every refusal that must stand |
| `tests/integration/tenant-purge-retained-set-null-admitted.test.ts` | The guard: every retained SET NULL FK is exercised against its table's real triggers |
| `tests/integration/tenant-fks-composite-batch2.test.ts` | Its "AiSystem delete is refused" case now asserts the link is nulled |
| `tests/guardrails/tenant-purge-retained-never-cascades.test.ts` | Header points at the new sibling |
| `CLAUDE.md`, `docs/data-retention.md` | The retained-FK rule now names the trigger half |

## Decisions

- **Admit the FK's write; do not retain `AiSystem`.** The column-scoped
  `SET NULL` already records the schema's choice to keep the record and drop
  the link. Retaining `AiSystem` would be a new retention decision.
- **`pg_trigger_depth() > 1`, beyond what the issue proposed.** Without it, a
  direct `UPDATE … SET "aiSystemId" = NULL` from anyone with write access would
  also detach a decision from its system. With it, only a nested write gets
  through, and in this schema that is only the FK action. The tenant purge is
  the only code path that deletes an `AiSystem`.
- **A plain `CREATE OR REPLACE FUNCTION`.** The trigger binding, columns and
  enums are untouched, and no application code issues the newly admitted
  write. That makes the migration safe in a rolling deploy.
- **The guard exercises the triggers; it does not parse them.** Whether
  PL/pgSQL admits a transition cannot be read reliably off its text, and the
  repo's rule is behaviour over shape. It lives in `tests/integration/` because
  it needs Postgres. The scan project runs without a database, and adding an
  ignore pattern for it, as `rls-coverage` has, would have touched the Jest
  project partition.
- **Its blind spot is stated in its header.** The copy's ids are dummies, so a
  trigger function that looks up OTHER tables by the row's ids would see
  nothing. No function on today's population does.
- **`AccessReviewConnectedDecision.connectedAccountId` is the only other site
  in scope, and it is already correct.** Its trigger refuses a change to that
  column only when the new value `IS NOT NULL`. The guard covers it, and
  removing that clause turns the guard red.
