# Immutable Audit Trail

> **Epic 9** — Technical documentation for the append-only, hash-chained audit trail.

## Table of Contents

- [Schema](#schema)
- [Append-Only Enforcement](#append-only-enforcement)
- [Hash Chain Model](#hash-chain-model)
- [Canonical Serialization](#canonical-serialization)
- [Structured Event Schema](#structured-event-schema)
- [Historical Row Strategy](#historical-row-strategy)
- [Verification Tooling](#verification-tooling)
- [Regression Guards](#regression-guards)

---

## Schema

The `AuditLog` table stores all audit events with the following key columns:

| Column | Type | Description |
|--------|------|-------------|
| `id` | `String` | CUID primary key |
| `tenantId` | `String` | Tenant scope (FK) |
| `userId` | `String?` | Actor user (nullable for SYSTEM/JOB actors) |
| `actorType` | `String` | `USER`, `SYSTEM`, `JOB` or `API_KEY`. `API_KEY` means an API key (`iflk_…`) acted, over REST or `/api/mcp`; `userId` is then the key's creator, not a person acting (#5786) |
| `entity` | `String` | Entity type (e.g., `Control`, `Policy`) |
| `entityId` | `String` | Entity primary key |
| `action` | `String` | Event type (e.g., `POLICY_CREATED`, `UPDATE`) |
| `details` | `String?` | Legacy human-readable text (preserved for backward compat) |
| `detailsJson` | `Json?` | **Structured JSON payload** — source of truth |
| `previousHash` | `String?` | SHA-256 hash of the prior entry in this tenant's chain |
| `entryHash` | `String?` | SHA-256 hash of this entry's canonical representation |
| `version` | `Int` | Hash schema version (currently `1`) |
| `requestId` | `String?` | Correlation ID for request tracing |
| `diffJson` | `Json?` | Prisma middleware field-level diffs. A field in the Epic B encryption manifest never appears in `before` or `after` and is never compared: it is listed in `undiffableFields` instead, because the column is not encrypted and the prior read is decrypted (#5420) |
| `metadataJson` | `Json?` | Middleware metadata |
| `createdAt` | `DateTime` | Insertion timestamp |

---

## Append-Only Enforcement

### Database Trigger

A PostgreSQL `BEFORE UPDATE OR DELETE` trigger blocks all mutations:

```sql
CREATE OR REPLACE FUNCTION audit_log_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'IMMUTABLE_AUDIT_LOG: % operations on "AuditLog" are forbidden.',
        TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_immutable
    BEFORE UPDATE OR DELETE ON "AuditLog"
    FOR EACH ROW
    EXECUTE FUNCTION audit_log_immutable_guard();
```

### Privilege Hardening

The `app_user` database role has `INSERT` + `SELECT` only — `UPDATE` and `DELETE` are explicitly revoked.

### Application-Level Guards

Static analysis tests in `tests/guards/audit-immutability-guardrails.test.ts` scan the entire `src/` directory for:
- `auditLog.update` / `auditLog.updateMany` calls
- `auditLog.delete` / `auditLog.deleteMany` calls
- Raw SQL `UPDATE "AuditLog"` / `DELETE FROM "AuditLog"` statements

---

## Hash Chain Model

### Per-Tenant Chain

Each tenant maintains an **independent** hash chain:

- **First entry**: `previousHash = null`
- **Subsequent entries**: `previousHash = entryHash` of the prior row (same tenant)
- **Concurrency**: PostgreSQL advisory locks (`pg_advisory_xact_lock(hashtext(tenantId))`) serialize per-tenant appends

This model ensures:
- Tenant isolation (one tenant's chain cannot affect another's)
- Parallel inserts across tenants are unblocked
- Chain verification is scoped per-tenant (operationally practical)

### Hash Computation

```
entryHash = SHA-256(canonicalJSON(hashPayload))
```

Where `hashPayload` includes exactly these fields (lexicographically sorted):

```
actorType, actorUserId, detailsJson, entityId, entityType,
eventType, occurredAt, previousHash, tenantId, version
```

**Excluded** from hash: `id`, `requestId`, `recordIds`, `metadataJson`, `diffJson`, `details`, `createdAt`.

Two rules keep the stored chain verifiable (#5441), in both the tenant and the
org writer:

- **The hash covers what is stored.** `detailsJson` is JSON round-tripped once
  (`toStoredAuditJson` in `src/lib/audit/canonical-hash.ts`) before it is both
  hashed and written, so a `Date` or `Decimal` is hashed in the same form the
  column holds, and the verifier recomputes the same hash from the row.
- **Timestamp order is chain order.** The append timestamp is taken inside the
  advisory lock and strictly after the predecessor's (`nextChainTimestamp`), so
  two appends in one millisecond are walked in the order they were chained.

Every audit row a usecase writes goes through `logEvent`, so it is chained and
streamed; tenant data export and import rows included.

---

## Canonical Serialization

Defined in `src/lib/audit/canonical-hash.ts`:

1. **Object keys**: sorted lexicographically at every depth (recursive)
2. **Arrays**: order preserved
3. **null**: serialized as `null` (never omitted)
4. **undefined**: omitted from output
5. **No whitespace**: compact JSON (no spaces, no newlines)
6. **Timestamps**: ISO-8601 UTC with millisecond precision (`YYYY-MM-DDTHH:mm:ss.SSSZ`)

> **Breaking change warning**: Any modification to the serialization rules invalidates all existing hash chains. Bump the `version` field when making breaking changes.

---

## Structured Event Schema

All `detailsJson` payloads are **discriminated unions** on the `category` field. Zod schemas are defined in `src/lib/audit/event-schema.ts`:

| Category | Used For | Key Fields |
|----------|----------|------------|
| `entity_lifecycle` | CRUD operations | `entityName`, `operation`, `changedFields`, `before`, `after` |
| `status_change` | Workflow transitions | `entityName`, `fromStatus`, `toStatus`, `reason` |
| `relationship` | Link / unlink between entities | `operation` (`linked`/`unlinked`), `sourceEntity`, `sourceId`, `targetEntity`, `targetId`, `relation` |
| `access` | Auth & permissions | `operation`, `targetUserId`, `detail` |
| `data_lifecycle` | Retention, purge, archive | `operation`, `model`, `reason`, `recordCount` |
| `custom` | Domain-specific events | `category: 'custom'` + arbitrary keys |

### Coverage

All **58+ audit event sites** across **16 domain usecase files** now emit structured `detailsJson`. The Prisma audit middleware also auto-generates `entity_lifecycle` payloads for every DB write.

---

## Historical Row Strategy

### Decision: Chain Starts at Migration Point

Pre-existing audit rows (created before the hash chain migration) are treated as **legacy/unverified**:

- They have `entryHash = null` and `previousHash = null`
- They still have `detailsJson = null` (no structured payload)
- The verification script counts them as `unhashedEntries` and **does not attempt to verify them**
- The first hash-chained entry in each tenant's chain has `previousHash = null`

### Rationale

Backfilling hashes for historical rows would require:
1. **Deterministic reconstruction** of `detailsJson` from free-form `details` strings — unreliable
2. **Replaying timestamps** with millisecond precision from PostgreSQL — format-sensitive
3. **Risk of creating a false sense of integrity** for data that was never cryptographically verified

The chosen approach is **honest and explicit**: old rows exist as a readable historical record, and the verified chain starts from the point of migration.

### Verification Report

```
✅ Tenant tenant-001 (Acme Corp):
   Entries:   1,247 total, 891 hashed, 356 legacy
   Status:    VALID
```

---

## Verification Tooling

### CLI Script

```bash
# Verify all tenants
npx ts-node scripts/verify-audit-chain.ts

# Single tenant
npx ts-node scripts/verify-audit-chain.ts --tenant <tenantId>

# Date range
npx ts-node scripts/verify-audit-chain.ts --from 2024-01-01 --to 2024-12-31

# JSON output (for CI/CD)
npx ts-node scripts/verify-audit-chain.ts --json

# Limit break reports
npx ts-node scripts/verify-audit-chain.ts --max-breaks 5
```

**Exit codes**: `0` = all valid, `1` = chain broken, `2` = script error.

### Admin API Endpoint

```
GET /api/t/[tenantSlug]/audit-log/verify
```

ADMIN-only. Accepts `?from=` and `?to=` query parameters. Returns `TenantVerificationResult` JSON.

### Reusable Library

```typescript
import { verifyTenantChain, verifyAllTenants } from '@/lib/audit/verify';

const result = await verifyTenantChain('tenant-id', { from: new Date('2024-01-01') });
const report = await verifyAllTenants();
```

---

## Regression Guards

| Guard | Location | What It Checks |
|-------|----------|----------------|
| **Immutability** | `tests/guards/audit-immutability-guardrails.test.ts` | No `update`/`delete` on AuditLog in code |
| **Structured Events** | `tests/guards/audit-structured-events.test.ts` | All `logEvent` calls have `detailsJson` |
| **Raw INSERT** | `tests/guards/audit-structured-events.test.ts` | No raw INSERT outside `audit-writer.ts` |
| **Script Exists** | `tests/guards/audit-structured-events.test.ts` | `verify-audit-chain.ts` exists with required flags |
| **Schema Validation** | `tests/guards/audit-structured-events.test.ts` | 5 of the 6 event categories validate via Zod (the `relationship` schema exists but is absent from this guard's fixture set) |
| **Hash Stability** | `tests/unit/audit-trail-canonical-hash.test.ts`, `tests/unit/audit-trail-org-canonical-hash.test.ts` | Canonical serialization is deterministic |
| **Chain Integrity** | `tests/unit/audit-trail-chain-verify.test.ts` | Tampering and discontinuity detection |
| **Stored form and order** | `tests/integration/audit-chain-stored-form-and-order.test.ts` | The stored `detailsJson` re-hashes, and same-millisecond appends verify in chain order |
| **Integration** | `tests/integration/audit-hash-chain.test.ts` | Full chain lifecycle against PostgreSQL |
