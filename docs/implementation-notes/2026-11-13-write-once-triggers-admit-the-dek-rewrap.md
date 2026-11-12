# 2026-11-13 — Two write-once triggers admit the key-rotation re-wrap

Closes #5065, an `audit-2026-11` finding (severity: high).

## Design

CLAUDE.md states the rule: *"Write-once triggers on encrypted columns must
admit the re-wrap … A new write-once table with an encrypted column needs the
same exception."* `AgentHarnessAcceptance.justification` and
`AuditWorkpaperNarrative.text` are both in the Epic B manifest and neither
trigger carried it. No later migration added one.

`tenant-dek-rotation` sweeps the manifest with a raw
`UPDATE "<model>" SET "<field>" = $1 WHERE id = $2` and counts a throw as an
error. It clears `Tenant.previousEncryptedDek` only on `totalErrors === 0`, and
`rotateTenantDek`'s atomic swap is predicated on that column being NULL. So for
a tenant holding one acceptance or one narrative: every run errors, the old —
possibly compromised — DEK stays live in the decrypt fallback for good, those
rows stay under the old key, and every later rotation is refused with
"concurrent rotation detected" by a sweep that can never complete. The tenant
can never rotate its DEK again, and a DEK rotation is precisely what an OWNER
reaches for on a suspected compromise.

The fix is the exception `peer_agent_message_is_immutable` already carries:
every other column byte-identical, the encrypted column moving from a v1/v2
ciphertext to a v2 one, nothing else. On the harness trigger it must run FIRST,
because the identity check below it names `justification`.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261113010000_write_once_triggers_admit_the_dek_rewrap/migration.sql` | Both functions replaced with the exception; post-conditions assert the clause and that both triggers are still attached |
| `tests/integration/write-once-triggers-admit-the-dek-rewrap.test.ts` | The sweep's exact statement is admitted (v2→v2 and v1→v2), a plaintext write and a re-wrap that also changes another column are still refused, and the definitions carry the clause |

## Decisions

- **Only the encrypted column is subtracted from the `to_jsonb` comparison.**
  The sweep's UPDATE is raw, so it never touches `updatedAt`; admitting an
  `updatedAt` change too would widen the exception to any Prisma-mediated write
  of the column, which is the edit these triggers exist to refuse.

- **No static guard scanning every trigger for the exception, deliberately.**
  I wrote one as an exploratory scan and it reported **31** offenders across 12
  models. Narrowing it twice brought that to 5, and reading all 5 brought it to
  the 2 the issue named. The three false positives are each a different lesson:

  - **A column-scoped trigger cannot fire on a re-wrap.**
    `BEFORE UPDATE OF "controlId","tenantId"` only fires when one of those
    columns is in the SET list, so `control_tenant_agreement` can never block a
    re-wrap of `Finding.description`. This accounted for most of the 31.
  - **The exception has more than one valid spelling.**
    `tenant_a2a_signing_key_is_final` carries it inline as
    `AND NOT (OLD."privateKeySeed" ~ '^v[12]:' AND NEW."privateKeySeed" ~ '^v2:')`
    rather than with the `to_jsonb` subtraction. A scan keyed on one spelling
    calls a correct trigger broken.
  - **A refusal can be role-gated.** `tenant_skill_version_lifecycle` refuses an
    `instructions` change only when `current_setting('role') = 'app_user'`, and
    the sweep is not that role — which is what CLAUDE.md means by "the encrypted
    column cannot be frozen against the DEK rotation sweep".

  So the robust axis is behavioural, not textual: issue the statement the sweep
  issues and see whether it is admitted. A grep over trigger bodies would have
  produced 29 false findings, and a guard that cries wolf 29 times out of 31
  gets suppressed rather than obeyed.

- **The fixture seeds under `session_replication_role = 'replica'`.** These are
  write-once tables with insert guards and real parent graphs; building each
  legitimate graph would make the fixture the thing under test. The role is
  reset before every assertion, so the UPDATE path runs with all triggers live.
  Two rounds of fixture failures were my own uniqueness assumptions, both real
  constraints worth knowing: `AgentHarnessAcceptance` is unique on
  `(id, tenantId)` and `AuditWorkpaperNarrative` on `(tenantId, workpaperId)` —
  one narrative per workpaper, which is right for a write-once narrative.
