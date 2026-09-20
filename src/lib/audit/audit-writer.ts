/**
 * Audit Trail — Hash-Chained Writer
 *
 * Central function for appending audit entries with per-tenant hash chaining.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CHAIN MODEL: Per-Tenant
 * ═══════════════════════════════════════════════════════════════════
 *
 * Each tenant has an independent hash chain:
 *   - First entry: previousHash = null
 *   - Subsequent:  previousHash = entryHash of the prior row (same tenant)
 *
 * CONCURRENCY: PostgreSQL advisory locks (per-tenant)
 *   - pg_advisory_xact_lock(hashtext(tenantId)) serializes appends per tenant
 *   - Automatically releases when the transaction commits/rolls back
 *   - Does NOT block inserts for other tenants
 *   - The supported queue depth and every timeout around it are
 *     DECLARED in `src/lib/db/concurrency-limits.ts` (#2653), not
 *     inherited from Prisma / node-postgres defaults
 *
 * HASH COMPUTATION: Application-side (Node.js)
 *   - Uses canonical-hash.ts: SHA-256 of deterministic JSON serialization
 *   - Computed INSIDE the advisory-locked transaction for consistency
 *
 * @module audit/audit-writer
 */
import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import * as prismaModule from '../prisma';
import { computeEntryHash, toCanonicalTimestamp } from './canonical-hash';
import {
    collectPseudonymizationTolerances,
    isToleratedPseudonymization,
} from './erasure-record';
import { AUDIT_APPEND_TX_OPTIONS } from '../db/concurrency-limits';

/**
 * Lazy getter for the default PrismaClient singleton.
 *
 * ARCHITECTURE NOTE: audit-writer.ts and prisma.ts form a cyclic
 * graph at runtime:
 *
 *   prisma.ts → require('./audit/audit-writer') (inside the audit
 *               extension's handler — only runs at request time)
 *   audit-writer.ts → import * as prismaModule from '../prisma'
 *
 * The cycle is resolved by deferring the dereference of
 * `prismaModule.prisma` to function-call time. The static
 * `import * as` form gives us a live namespace binding; reading
 * `prismaModule.prisma` inside `getDefaultPrisma()` happens after
 * both modules have finished evaluating, so we always observe the
 * fully-constructed extended client.
 *
 * Why this changed: the previous form was
 * `require('../prisma').prisma` inside the function. That worked
 * under Webpack but Turbopack's production bundle resolves dynamic
 * TS-module `require()` unreliably — it returned `undefined`,
 * surfacing as "Cannot read properties of undefined (reading
 * '$transaction')" on the first audit write under prod. Static
 * import + deferred read fixes it without re-introducing the cycle
 * at module-init time.
 */
function getDefaultPrisma(): PrismaClient {
    return prismaModule.prisma as unknown as PrismaClient;
}

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Input for appending a hash-chained audit entry.
 *
 * This covers both structured (new-style) and legacy audit write paths.
 * For structured entries, provide `detailsJson` with a valid category.
 * For legacy/middleware entries, provide `details` as free-form text.
 */
export interface AppendAuditInput {
    tenantId: string;
    userId: string | null;
    actorType?: string;           // defaults to 'USER'
    entity: string;               // e.g., 'Control', 'Asset'
    entityId: string;             // e.g., 'ctrl-123' or 'batch'
    action: string;               // e.g., 'CONTROL_CREATED', 'UPDATE'

    // Content — at least one should be provided
    details?: string | null;      // Legacy free-text
    detailsJson?: unknown;        // Structured payload (AuditDetails)

    // Optional metadata
    requestId?: string | null;
    recordIds?: unknown;          // For *Many operations
    metadataJson?: unknown;       // Middleware context
    diffJson?: unknown;           // Update diffs

    // Hash chain version (default 1)
    version?: number;
}

/**
 * Result of a hash-chained audit append.
 */
export interface AppendAuditResult {
    id: string;
    entryHash: string;
    previousHash: string | null;
}

/**
 * The slice of a Prisma client `appendAuditEntryWithin` needs.
 *
 * Narrow on purpose: an interactive `PrismaTx` satisfies it, which is what
 * lets a caller append INSIDE a transaction it already owns, and the two
 * methods listed are the whole set of statements the append issues.
 */
export interface AuditAppendClient {
    $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
    $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}

// ─── ID Generator ───────────────────────────────────────────────────

function generateCuid(): string {
    const uuid = createHash('md5').update(
        Date.now().toString() + Math.random().toString()
    ).digest('hex');
    return 'c' + uuid.substring(0, 24);
}

// ─── Core Writer ────────────────────────────────────────────────────

/**
 * Append a hash-chained audit entry within an advisory-locked transaction.
 *
 * This is the ONLY function that should insert into AuditLog. All other
 * audit write paths (logEvent, Prisma middleware, data-lifecycle,
 * evidence-maintenance) must route through this function.
 *
 * Flow:
 *   1. Open transaction
 *   2. Acquire per-tenant advisory lock (blocks other appends for same tenant)
 *   3. Fetch the latest entryHash for this tenant
 *   4. Compute entryHash = SHA-256(canonical(fields + previousHash))
 *   5. INSERT the row with previousHash + entryHash
 *   6. Commit (auto-releases advisory lock)
 *
 * @param input - Audit entry data
 * @returns The appended entry's id, entryHash, and previousHash
 */
export async function appendAuditEntry(input: AppendAuditInput, client?: PrismaClient): Promise<AppendAuditResult> {
    // Capture the wall-clock timestamp here for the streamer payload.
    // The actual hash-chain `occurredAt` is recomputed inside the
    // transaction (after the advisory lock) — using a slightly earlier
    // timestamp for the streamed copy is acceptable; it only changes
    // the SIEM-visible "sent at" by milliseconds.
    const streamOccurredAt = new Date().toISOString();

    const db = client || getDefaultPrisma();

    // AUDIT_APPEND_TX_OPTIONS is DECLARED, not inherited (#2653).
    //
    // Prisma's defaults here were maxWait 2000 / timeout 5000, and the
    // 2000 is the number the observed CI failure exceeded: five
    // concurrent appends for one tenant serialise on the advisory lock
    // below, and the last could not START inside 2000 ms.
    //
    // Both fields matter, and for different halves of the wait:
    //   • `maxWait`  — time to acquire the transaction (a pooled
    //     connection). Binds when the pool is saturated.
    //   • `timeout`  — time the BODY may run, and the advisory lock is
    //     acquired inside the body, so the whole lock queue is charged
    //     here. Declaring only `maxWait` would have left the larger
    //     half of the wait on a 5000 ms default that the stated design
    //     point cannot fit inside.
    //
    // Numbers, their arithmetic, and the fact that per-append latency
    // is a LOWER BOUND rather than a measured p99, are all in
    // `src/lib/db/concurrency-limits.ts`.
    const result = await db.$transaction(
        async (tx) => appendAuditEntryWithin(tx as unknown as AuditAppendClient, input),
        AUDIT_APPEND_TX_OPTIONS,
    );

    // Epic C.4 — best-effort outbound streaming. The audit row is
    // already committed at this point, so a thrown error in the
    // streamer must not propagate. The streamer enqueues into a
    // per-tenant in-memory buffer and returns synchronously; HTTP
    // POSTs happen out-of-band on a 5s / 100-event flush.
    try {
        // Lazy import: the streamer pulls in node:crypto + a logger
        // chain; loading it here keeps the cold-start cost off the
        // happy path for tenants that don't use streaming.
        const { streamAuditEvent } = await import(
            '@/app-layer/events/audit-stream'
        );
        streamAuditEvent({
            id: result.id,
            entryHash: result.entryHash,
            previousHash: result.previousHash,
            tenantId: input.tenantId,
            userId: input.userId,
            actorType: input.actorType || 'USER',
            entity: input.entity,
            entityId: input.entityId,
            action: input.action,
            // `details` is intentionally NOT forwarded — it can carry
            // human-readable PII. SIEMs consume `detailsJson`.
            detailsJson: input.detailsJson ?? null,
            metadataJson: input.metadataJson ?? null,
            requestId: input.requestId ?? null,
            occurredAt: streamOccurredAt,
        });
    } catch {
        // Streamer is fail-safe; this catch is belt-and-braces.
    }

    return result;
}

/**
 * The append itself, against a client that is ALREADY inside a transaction.
 *
 * `appendAuditEntry` is this function plus a transaction plus the outbound
 * stream. It is split out for callers that must write an audit entry in the
 * SAME transaction as the work it records — #2682's `ERASURE_EXECUTED` is the
 * first: an erasure record that could commit separately from the erasure it
 * describes reintroduces the bug it exists to fix.
 *
 * WHAT YOU GIVE UP BY CALLING THIS DIRECTLY, said plainly:
 *
 *   - NO OUTBOUND STREAM. `appendAuditEntry` streams to the SIEM after the
 *     commit, which is the only point at which the row is real. This function
 *     cannot know when (or whether) its caller's transaction commits, and
 *     streaming a row that then rolls back would tell a SIEM about an event
 *     that never happened. A caller that needs the stream must arrange it
 *     after its own commit.
 *   - THE ADVISORY LOCK IS THE CALLER'S NOW. `pg_advisory_xact_lock` releases
 *     with the TRANSACTION, so the per-tenant append lock is held for the rest
 *     of the caller's transaction rather than for the append alone. That is
 *     correct (it serialises the whole unit against other appends) but it is a
 *     longer hold, and a caller that opens a long transaction is holding up
 *     every other append for that tenant.
 */
export async function appendAuditEntryWithin(
    tx: AuditAppendClient,
    input: AppendAuditInput,
): Promise<AppendAuditResult> {
    const id = generateCuid();
    const actorType = input.actorType || 'USER';
    const version = input.version ?? 1;

    // Build the structured detailsJson for hashing.
    // If caller provides detailsJson, use it directly.
    // If only legacy details text is provided, wrap it in a custom payload.
    const detailsForHash: unknown = input.detailsJson ?? {
        category: 'custom',
        legacyText: input.details || null,
    };

    // 1. Acquire per-tenant advisory lock
    //    hashtext() returns a 32-bit int from a string — perfect for advisory locks
    await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        input.tenantId,
    );

    // Create timestamp AFTER lock acquisition so concurrent inserts
    // get distinct, ordered timestamps (lock serializes them).
    const now = new Date();
    const occurredAt = toCanonicalTimestamp(now);

    // 2. Fetch the latest entryHash for this tenant's chain
    //
    // `, "id" DESC` IS LOAD-BEARING, and its absence was a latent bug.
    // The advisory lock above serialises appends, and the comment at the
    // timestamp assignment says that gives "distinct, ordered timestamps".
    // Serialised is not distinct: `new Date()` is millisecond resolution
    // and `createdAt` is `DateTime @default(now())`, so appends that each
    // take under a millisecond — which is what a fast machine does — share
    // a `createdAt`. `ORDER BY "createdAt" DESC LIMIT 1` then has no
    // defined winner among the tied rows and an append can chain off the
    // wrong predecessor, forking the chain.
    //
    // The tiebreaker's job is not to be chronological — cuid is not
    // time-ordered — but to be a TOTAL ORDER that this query and the
    // verifier both compute identically. `org-audit-writer.ts` has carried
    // exactly this form since it was written; the tenant writer did not.
    const lastRows: Array<{ entryHash: string | null }> = await tx.$queryRawUnsafe(
        `SELECT "entryHash" FROM "AuditLog"
         WHERE "tenantId" = $1 AND "entryHash" IS NOT NULL
         ORDER BY "createdAt" DESC, "id" DESC
         LIMIT 1`,
        input.tenantId,
    );

    const previousHash: string | null = lastRows.length > 0
        ? lastRows[0].entryHash
        : null;

    // 3. Compute entry hash
    const entryHash = computeEntryHash({
        tenantId: input.tenantId,
        actorType,
        actorUserId: input.userId,
        eventType: input.action,
        entityType: input.entity,
        entityId: input.entityId,
        occurredAt,
        detailsJson: detailsForHash,
        previousHash,
        version,
    });

    // 4. INSERT with all fields including hash chain
    //    Uses the same canonical timestamp for createdAt as was used for hashing.
    //    We pass the ISO string directly (not a Date object) to avoid timezone
    //    conversion issues when the PG server timezone differs from UTC.
    await tx.$executeRawUnsafe(
        `INSERT INTO "AuditLog" (
            "id", "tenantId", "userId", "actorType",
            "entity", "entityId", "action",
            "details", "detailsJson",
            "requestId", "recordIds", "metadataJson", "diffJson",
            "previousHash", "entryHash", "version",
            "createdAt"
        ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7,
            $8, $9::jsonb,
            $10, $11::jsonb, $12::jsonb, $13::jsonb,
            $14, $15, $16,
            $17::timestamp
        )`,
        id,
        input.tenantId,
        input.userId,
        actorType,
        input.entity,
        input.entityId,
        input.action,
        input.details ?? null,
        JSON.stringify(detailsForHash),
        input.requestId ?? null,
        input.recordIds ? JSON.stringify(input.recordIds) : null,
        input.metadataJson ? JSON.stringify(input.metadataJson) : null,
        input.diffJson ? JSON.stringify(input.diffJson) : null,
        previousHash,
        entryHash,
        version,
        occurredAt,
    );

    return { id, entryHash, previousHash };
}

// ─── Chain Verification ─────────────────────────────────────────────

export interface ChainVerificationResult {
    tenantId: string;
    totalEntries: number;
    hashedEntries: number;
    unhashedEntries: number;
    valid: boolean;
    firstBreakAt?: number; // 0-indexed position of first chain break
    firstBreakId?: string;
    /**
     * Rows whose recomputation mismatched and was EXCUSED as a lawful DSAR
     * erasure (#2682). Reported rather than silent: `valid: true` with a
     * non-zero count here says "the chain holds AND n rows were lawfully
     * pseudonymized", which is a different statement from "nothing happened",
     * and an auditor is entitled to see which one they are being told.
     */
    toleratedPseudonymizations: number;
}

/**
 * Verify the hash chain integrity for a given tenant.
 *
 * Reads all hashed audit entries in chronological order, recomputes
 * each entryHash, and checks that previousHash links match.
 *
 * LAWFUL ERASURE IS NOT TAMPERING (#2682). A DSAR erasure sets
 * `AuditLog.userId -> NULL`, and `actorUserId` is a hashed field, so the
 * recomputation below cannot match the stored hash for a pseudonymized row.
 * Before #2682 that made every compliant erasure report `valid: false` at the
 * first affected row — the exact signature of a forgery. The erasure now
 * writes an `ERASURE_EXECUTED` entry into this same chain naming the rows it
 * touched, and the walk consults it. `erasure-record.ts` holds the reasoning
 * and, in particular, why the tolerance is `userId`-only and not a blanket
 * "ignore these rows".
 *
 * @param tenantId - The tenant to verify
 * @returns Verification result with chain validity
 */
export async function verifyAuditChain(tenantId: string, client?: PrismaClient): Promise<ChainVerificationResult> {
    const db = client || getDefaultPrisma();

    const rows: Array<{
        id: string;
        tenantId: string;
        userId: string | null;
        actorType: string;
        entity: string;
        entityId: string;
        action: string;
        detailsJson: unknown;
        previousHash: string | null;
        entryHash: string | null;
        version: number;
        createdAtIso: string;
    }> = await db.$queryRawUnsafe(
        `SELECT "id", "tenantId", "userId", "actorType", "entity", "entityId",
                "action", "detailsJson", "previousHash", "entryHash", "version",
                to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAtIso"
         FROM "AuditLog"
         WHERE "tenantId" = $1
         -- Same total order as the append above, and for the same reason: a
         -- verifier that walks tied rows in a different order than they were
         -- chained reports a VALID chain as broken.
         ORDER BY "createdAt" ASC, "id" ASC`,
        tenantId,
    );

    const totalEntries = rows.length;
    const hashedRows = rows.filter(r => r.entryHash !== null);
    const hashedEntries = hashedRows.length;
    const unhashedEntries = totalEntries - hashedEntries;

    // Every tolerance the tenant's own ERASURE_EXECUTED entries declare,
    // built from the rows ALREADY fetched above — no second query, and no
    // second source of truth. Scanning all rows (not just hashed ones) is
    // deliberate: the map is keyed by the row a record NAMES, and whether the
    // record itself is honest is settled by the walk below, which reaches it
    // like any other row and breaks there if its own hash does not recompute.
    const tolerances = collectPseudonymizationTolerances(rows);

    // Verify the hashed subset
    let valid = true;
    let firstBreakAt: number | undefined;
    let firstBreakId: string | undefined;
    let expectedPreviousHash: string | null = null;
    let toleratedPseudonymizations = 0;

    for (let i = 0; i < hashedRows.length; i++) {
        const row = hashedRows[i];

        // Check previousHash linkage
        if (i === 0) {
            // First hashed entry: previousHash should be null (or the chain just started)
            // We accept whatever previousHash the first entry has
            expectedPreviousHash = null;
        }

        if (row.previousHash !== expectedPreviousHash) {
            // Check if this is the absolute first in the chain (previousHash = null is OK)
            if (!(i === 0 && row.previousHash === null)) {
                valid = false;
                firstBreakAt = i;
                firstBreakId = row.id;
                break;
            }
        }

        // Recompute entry hash and verify
        const detailsForHash = row.detailsJson;
        const recomputed = computeEntryHash({
            tenantId: row.tenantId,
            actorType: row.actorType,
            actorUserId: row.userId,
            eventType: row.action,
            entityType: row.entity,
            entityId: row.entityId,
            occurredAt: row.createdAtIso,
            detailsJson: detailsForHash,
            previousHash: row.previousHash,
            version: row.version,
        });

        if (recomputed !== row.entryHash) {
            // #2682 — the ONE excused mismatch. `recomputed` was computed with
            // `actorUserId: row.userId`, so for a pseudonymized row it IS the
            // post-erasure hash, and comparing it against the value the
            // erasure entry committed to is what makes this `userId`-only:
            // any other edit to a named row changes `recomputed` and fails
            // here. See `erasure-record.ts` for why nothing weaker will do.
            if (isToleratedPseudonymization(row, recomputed, tolerances)) {
                toleratedPseudonymizations++;
                // The chain continues on the STORED hash, which the
                // immutability trigger has preserved byte-for-byte — the link
                // structure is untouched by an erasure and is still checked in
                // full for every following row.
                expectedPreviousHash = row.entryHash;
                continue;
            }
            valid = false;
            firstBreakAt = i;
            firstBreakId = row.id;
            break;
        }

        expectedPreviousHash = row.entryHash;
    }

    return {
        tenantId,
        totalEntries,
        hashedEntries,
        unhashedEntries,
        valid,
        firstBreakAt,
        firstBreakId,
        toleratedPseudonymizations,
    };
}
