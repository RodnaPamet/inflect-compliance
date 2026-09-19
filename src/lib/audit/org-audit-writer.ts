/**
 * Org Audit Trail — Hash-Chained Writer
 *
 * Central function for appending org audit entries with per-organization
 * hash chaining. Mirrors `appendAuditEntry` in `audit-writer.ts` but
 * targets the dedicated `OrgAuditLog` table.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CHAIN MODEL: Per-Organization
 * ═══════════════════════════════════════════════════════════════════
 *
 * Each organization has an independent hash chain:
 *   - First entry: previousHash = null
 *   - Subsequent:  previousHash = entryHash of the prior row (same org)
 *
 * CONCURRENCY: PostgreSQL advisory locks (per-organization)
 *   - pg_advisory_xact_lock(hashtext('org:' || organizationId))
 *     serializes appends per organization
 *   - The supported queue depth and every timeout around it are
 *     DECLARED in `src/lib/db/concurrency-limits.ts` (#2653, #2661),
 *     not inherited from Prisma / node-postgres defaults
 *   - The 'org:' prefix namespaces the lock so it can NEVER collide
 *     with the per-tenant lock used by appendAuditEntry — `hashtext`
 *     of 'org:abc123' and of tenantId 'abc123' produce different
 *     32-bit ints by construction.
 *   - Auto-released on transaction commit/rollback
 *   - Does NOT block inserts for other orgs
 *
 * HASH COMPUTATION: Application-side (Node.js)
 *   - Uses org-canonical-hash.ts: SHA-256 of deterministic JSON
 *   - Computed INSIDE the advisory-locked transaction
 *
 * APPEND-ONLY: enforced at the DB layer (immutability trigger +
 *   REVOKE UPDATE,DELETE FROM app_user) — see migration
 *   20260430052807_epic_b_org_audit_log.
 *
 * @module audit/org-audit-writer
 */
import { createHash } from 'crypto';
import { PrismaClient, OrgAuditAction } from '@prisma/client';
import * as prismaModule from '../prisma';
import { computeOrgEntryHash } from './org-canonical-hash';
import { toCanonicalTimestamp } from './canonical-hash';
import { AUDIT_APPEND_TX_OPTIONS } from '../db/concurrency-limits';

/**
 * Lazy getter for the default PrismaClient singleton.
 *
 * Same pattern as audit-writer.ts — `import * as prismaModule`
 * gives a live namespace binding; reading `prismaModule.prisma`
 * inside the function defers the dereference to call-time, which
 * dodges Turbopack's unreliable production-build resolution of
 * dynamic TS-module `require()`. See the longer note in
 * `audit-writer.ts` for the historical context.
 */
function getDefaultPrisma(): PrismaClient {
    return prismaModule.prisma as unknown as PrismaClient;
}

// ─── Types ──────────────────────────────────────────────────────────

export interface AppendOrgAuditInput {
    organizationId: string;
    actorUserId: string | null;
    actorType?: string; // defaults to 'USER'
    action: OrgAuditAction;
    targetUserId?: string | null;
    detailsJson?: unknown;
    requestId?: string | null;
    version?: number;
}

export interface AppendOrgAuditResult {
    id: string;
    entryHash: string;
    previousHash: string | null;
}

// ─── ID Generator ───────────────────────────────────────────────────

function generateCuid(): string {
    const uuid = createHash('md5').update(
        Date.now().toString() + Math.random().toString(),
    ).digest('hex');
    return 'c' + uuid.substring(0, 24);
}

// ─── Core Writer ────────────────────────────────────────────────────

/**
 * Append a hash-chained org audit entry inside an advisory-locked
 * transaction.
 *
 * Flow:
 *   1. Open transaction
 *   2. Acquire per-org advisory lock (namespaced 'org:<id>')
 *   3. Fetch the latest entryHash for this org's chain
 *   4. Compute entryHash = SHA-256(canonical(fields + previousHash))
 *   5. INSERT the row with previousHash + entryHash
 *   6. Commit (auto-releases advisory lock)
 *
 * @param input  Org audit entry data
 * @param client Optional PrismaClient — pass the test client when
 *               running outside the production singleton context.
 */
export async function appendOrgAuditEntry(
    input: AppendOrgAuditInput,
    client?: PrismaClient,
): Promise<AppendOrgAuditResult> {
    const id = generateCuid();
    const actorType = input.actorType || 'USER';
    const version = input.version ?? 1;

    // detailsJson canonicalisation — null when caller omitted it so
    // the hash is stable across "explicit null" and "undefined" call
    // shapes.
    const detailsForHash: unknown = input.detailsJson ?? null;
    const targetUserId = input.targetUserId ?? null;

    const db = client || getDefaultPrisma();

    // AUDIT_APPEND_TX_OPTIONS is DECLARED, not inherited (#2661).
    //
    // The same three limits, the same mechanism, one file over from
    // `audit-writer.ts`. The advisory lock below is taken INSIDE the
    // transaction, so N concurrent appends for one organization each
    // hold a pooled connection and an open transaction while idling on
    // the lock — which is what makes the inherited defaults binding
    // rather than theoretical:
    //   • `maxWait` (default 2000) — time to acquire the connection.
    //   • `timeout` (default 5000) — time the BODY may run, and the
    //     lock queue is charged HERE, not to maxWait. Declaring only
    //     maxWait would leave the larger half of the wait on a default
    //     the stated design point cannot fit inside.
    //
    // Deliberately the SAME constants as the tenant path rather than a
    // second set: both serialise on a per-key advisory lock held for
    // the same body, and two sources of truth for one property is how
    // they drift. Derivations live in `src/lib/db/concurrency-limits.ts`.
    return db.$transaction(async (tx) => {
        // 1. Per-org advisory lock — 'org:' prefix namespaces against
        //    the per-tenant locks used by AuditLog.
        await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            'org:' + input.organizationId,
        );

        // 2. Timestamp AFTER lock so concurrent appends serialize
        //    with strictly-monotonic occurredAt within an org.
        const occurredAt = toCanonicalTimestamp(new Date());

        // 3. Latest entryHash for this org chain
        const lastRows: Array<{ entryHash: string }> = await tx.$queryRawUnsafe(
            `SELECT "entryHash" FROM "OrgAuditLog"
             WHERE "organizationId" = $1
             ORDER BY "occurredAt" DESC, "id" DESC
             LIMIT 1`,
            input.organizationId,
        );
        const previousHash: string | null = lastRows.length > 0 ? lastRows[0].entryHash : null;

        // 4. Compute entry hash
        const entryHash = computeOrgEntryHash({
            organizationId: input.organizationId,
            actorType,
            actorUserId: input.actorUserId,
            action: input.action,
            targetUserId,
            occurredAt,
            detailsJson: detailsForHash,
            previousHash,
            version,
        });

        // 5. INSERT — pass `action` as text and cast on the DB side so
        //    we don't have to import the runtime enum binding.
        await tx.$executeRawUnsafe(
            `INSERT INTO "OrgAuditLog" (
                "id", "organizationId", "actorUserId", "actorType",
                "action", "targetUserId",
                "detailsJson", "requestId",
                "occurredAt", "entryHash", "previousHash", "version"
            ) VALUES (
                $1, $2, $3, $4,
                $5::"OrgAuditAction", $6,
                $7::jsonb, $8,
                $9::timestamp, $10, $11, $12
            )`,
            id,
            input.organizationId,
            input.actorUserId,
            actorType,
            input.action,
            targetUserId,
            JSON.stringify(detailsForHash),
            input.requestId ?? null,
            occurredAt,
            entryHash,
            previousHash,
            version,
        );

        return { id, entryHash, previousHash };
    }, AUDIT_APPEND_TX_OPTIONS);
}

// ─── Chain Verification ─────────────────────────────────────────────

export interface OrgChainVerificationResult {
    organizationId: string;
    totalEntries: number;
    valid: boolean;
    firstBreakAt?: number;
    firstBreakId?: string;
}

/**
 * Verify the hash chain integrity for a given org.
 *
 * Reads all entries in chronological order, recomputes each entryHash
 * from its canonical fields, and checks that previousHash linkages
 * match. Used by compliance-verification jobs and the test suite.
 */
export async function verifyOrgAuditChain(
    organizationId: string,
    client?: PrismaClient,
): Promise<OrgChainVerificationResult> {
    const db = client || getDefaultPrisma();

    const rows: Array<{
        id: string;
        organizationId: string;
        actorUserId: string | null;
        actorType: string;
        action: string;
        targetUserId: string | null;
        detailsJson: unknown;
        previousHash: string | null;
        entryHash: string;
        version: number;
        occurredAtIso: string;
    }> = await db.$queryRawUnsafe(
        `SELECT "id", "organizationId", "actorUserId", "actorType", "action"::text AS "action",
                "targetUserId", "detailsJson", "previousHash", "entryHash", "version",
                to_char("occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAtIso"
         FROM "OrgAuditLog"
         WHERE "organizationId" = $1
         ORDER BY "occurredAt" ASC, "id" ASC`,
        organizationId,
    );

    let valid = true;
    let firstBreakAt: number | undefined;
    let firstBreakId: string | undefined;
    let expectedPreviousHash: string | null = null;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        if (row.previousHash !== expectedPreviousHash) {
            if (!(i === 0 && row.previousHash === null)) {
                valid = false;
                firstBreakAt = i;
                firstBreakId = row.id;
                break;
            }
        }

        const recomputed = computeOrgEntryHash({
            organizationId: row.organizationId,
            actorType: row.actorType,
            actorUserId: row.actorUserId,
            action: row.action,
            targetUserId: row.targetUserId,
            occurredAt: row.occurredAtIso,
            detailsJson: row.detailsJson,
            previousHash: row.previousHash,
            version: row.version,
        });

        if (recomputed !== row.entryHash) {
            valid = false;
            firstBreakAt = i;
            firstBreakId = row.id;
            break;
        }

        expectedPreviousHash = row.entryHash;
    }

    return {
        organizationId,
        totalEntries: rows.length,
        valid,
        firstBreakAt,
        firstBreakId,
    };
}
