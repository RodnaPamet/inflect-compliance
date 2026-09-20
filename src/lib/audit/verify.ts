/**
 * Audit Trail — Chain Verification
 *
 * Reusable verification logic for the per-tenant audit hash chain.
 * Recomputes hashes using the same canonical serialization as insertion,
 * validates previousHash linkage, and produces detailed diagnostics.
 *
 * IMPORTANT: This module NEVER mutates audit rows.
 *
 * Usage:
 *   import { verifyTenantChain, verifyAllTenants } from '@/lib/audit/verify';
 *   const report = await verifyTenantChain('tenant-123');
 *   const fullReport = await verifyAllTenants();
 *
 * @module audit/verify
 */
import { PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';
import { computeEntryHash } from './canonical-hash';
import {
    ERASURE_EXECUTED_ACTION,
    collectPseudonymizationTolerances,
    isToleratedPseudonymization,
} from './erasure-record';
import type { ChainRowForTolerance } from './erasure-record';

// ─── Types ──────────────────────────────────────────────────────────

export type BreakType =
    | 'hash_mismatch'          // recomputed hash differs from stored entryHash
    | 'chain_discontinuity'    // previousHash doesn't match prior row's entryHash
    | 'missing_hash';          // entryHash is null on a row that should be hashed

export interface ChainBreak {
    /** 0-indexed position within the hashed rows */
    position: number;
    /** Row ID of the broken entry */
    rowId: string;
    /** Type of break detected */
    breakType: BreakType;
    /** Action field of the broken row */
    action: string;
    /** Entity of the broken row */
    entity: string;
    /** entityId of the broken row */
    entityId: string;
    /** Stored entryHash */
    storedHash: string | null;
    /** Recomputed entryHash (null for chain_discontinuity) */
    recomputedHash: string | null;
    /** Expected previousHash (from prior row) */
    expectedPreviousHash: string | null;
    /** Actual previousHash stored on this row */
    actualPreviousHash: string | null;
    /** When the entry was created */
    createdAt: string;
}

export interface TenantVerificationResult {
    tenantId: string;
    tenantName?: string;
    totalEntries: number;
    hashedEntries: number;
    unhashedEntries: number;
    valid: boolean;
    breaks: ChainBreak[];
    /**
     * Hash mismatches EXCUSED as lawful DSAR erasures (#2682) — counted, not
     * hidden. `valid: true` with a non-zero value here is a different claim
     * from `valid: true` with zero, and the operator reading the verify
     * endpoint is entitled to both numbers.
     */
    toleratedPseudonymizations: number;
    verifiedAt: string;
    durationMs: number;
}

export interface VerificationReport {
    allValid: boolean;
    tenantsVerified: number;
    tenantsWithBreaks: number;
    totalEntriesVerified: number;
    totalBreaks: number;
    results: TenantVerificationResult[];
    verifiedAt: string;
    durationMs: number;
}

export interface VerifyOptions {
    /** Only verify entries created at or after this time */
    from?: Date;
    /** Only verify entries created at or before this time */
    to?: Date;
    /** Maximum number of breaks to report per tenant before stopping */
    maxBreaks?: number;
    /** PrismaClient instance to use (default: global singleton) */
    client?: PrismaClient;
}

// ─── Raw Row Type ───────────────────────────────────────────────────

interface AuditRow {
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
}

// ─── Single Tenant Verification ─────────────────────────────────────

/**
 * Verify the hash chain for a single tenant.
 *
 * Reads all audit entries in chronological order, recomputes each hash
 * using the same canonical serialization used during insertion, and
 * checks the previousHash linkage between consecutive entries.
 *
 * @param tenantId - Tenant to verify
 * @param opts - Optional filters and configuration
 * @returns Detailed verification result with break diagnostics
 */
export async function verifyTenantChain(
    tenantId: string,
    opts: VerifyOptions = {},
): Promise<TenantVerificationResult> {
    const startTime = Date.now();
    const db = opts.client || prisma;
    const maxBreaks = opts.maxBreaks ?? 10;

    // Build WHERE clause with optional range filters
    const conditions = [`"tenantId" = $1`];
    const params: unknown[] = [tenantId];
    let paramIdx = 2;

    if (opts.from) {
        conditions.push(`"createdAt" >= $${paramIdx}`);
        params.push(opts.from);
        paramIdx++;
    }
    if (opts.to) {
        conditions.push(`"createdAt" <= $${paramIdx}`);
        params.push(opts.to);
        paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const rows: AuditRow[] = await db.$queryRawUnsafe(
        `SELECT "id", "tenantId", "userId", "actorType", "entity", "entityId",
                "action", "detailsJson", "previousHash", "entryHash", "version",
                to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAtIso"
         FROM "AuditLog"
         WHERE ${whereClause}
         -- The id tiebreaker matches the order appendAuditEntry chains in.
         -- Without it, rows sharing a millisecond can be walked in a different
         -- order than they were written and a sound chain reads as tampered
         -- with. (No backticks in here: this comment lives INSIDE a JS
         -- template literal, so a backtick is a string delimiter to the
         -- TypeScript parser before it is ever a character to Postgres.)
         ORDER BY "createdAt" ASC, "id" ASC`,
        ...params,
    );

    const totalEntries = rows.length;
    const hashedRows = rows.filter(r => r.entryHash !== null);
    const hashedEntries = hashedRows.length;
    const unhashedEntries = totalEntries - hashedEntries;
    const breaks: ChainBreak[] = [];

    // #2682 — the DSAR erasure records this tenant's chain carries.
    //
    // A RANGE-FILTERED verification is why this is not simply read off
    // `rows`: the erasure entry sits at the tail of the chain, so any window
    // that ends before it would not contain it, and every row it excuses
    // would report `hash_mismatch` — the false positive this fixes, back
    // again for exactly the queries an auditor narrows. So an unfiltered
    // lookup runs when (and only when) a range was asked for; the
    // unrestricted case already has every record in `hashedRows`.
    //
    // It is issued AFTER the main query on purpose, so callers that inspect
    // `$queryRawUnsafe.mock.calls[0]` still see the chain query there.
    //
    // BOTH ARMS ARE RESTRICTED TO HASHED ROWS, for one reason. A record is
    // trustworthy only because the walk below recomputes its hash and breaks
    // there if it does not match — and the walk iterates `hashedRows`. A
    // record with a NULL `entryHash` is never graded by anything, so letting
    // one into this set would let an UNVERIFIED row excuse mismatches on rows
    // the verifier does check. Unhashed rows exist in quantity (that is what
    // `unhashedEntries` counts): `logAudit` and the lifecycle jobs still
    // write `auditLog.create` rows with a caller-supplied `action` and no
    // hash. Hence `IS NOT NULL` in the ranged lookup and `hashedRows` — not
    // `rows` — in the unranged one.
    const toleranceRows: ChainRowForTolerance[] = (opts.from || opts.to)
        ? (await db.$queryRawUnsafe<AuditRow[]>(
            `SELECT "id", "userId", "action", "detailsJson"
               FROM "AuditLog"
              WHERE "tenantId" = $1 AND "action" = $2
                AND "entryHash" IS NOT NULL`,
            tenantId,
            ERASURE_EXECUTED_ACTION,
        ))
        : hashedRows;
    const tolerances = collectPseudonymizationTolerances(toleranceRows);
    let toleratedPseudonymizations = 0;

    let expectedPreviousHash: string | null = null;

    for (let i = 0; i < hashedRows.length; i++) {
        if (breaks.length >= maxBreaks) break;

        const row = hashedRows[i];

        // ── Check previousHash linkage ──
        if (i === 0) {
            // First entry in chain: previousHash should be null
            // (unless range-filtered, in which case we accept whatever it has)
            if (!opts.from && row.previousHash !== null) {
                breaks.push({
                    position: i,
                    rowId: row.id,
                    breakType: 'chain_discontinuity',
                    action: row.action,
                    entity: row.entity,
                    entityId: row.entityId,
                    storedHash: row.entryHash,
                    recomputedHash: null,
                    expectedPreviousHash: null,
                    actualPreviousHash: row.previousHash,
                    createdAt: row.createdAtIso,
                });
            }
        } else if (row.previousHash !== expectedPreviousHash) {
            breaks.push({
                position: i,
                rowId: row.id,
                breakType: 'chain_discontinuity',
                action: row.action,
                entity: row.entity,
                entityId: row.entityId,
                storedHash: row.entryHash,
                recomputedHash: null,
                expectedPreviousHash,
                actualPreviousHash: row.previousHash,
                createdAt: row.createdAtIso,
            });
        }

        // ── Recompute entry hash ──
        const recomputed = computeEntryHash({
            tenantId: row.tenantId,
            actorType: row.actorType,
            actorUserId: row.userId,
            eventType: row.action,
            entityType: row.entity,
            entityId: row.entityId,
            occurredAt: row.createdAtIso,
            detailsJson: row.detailsJson,
            previousHash: row.previousHash,
            version: row.version,
        });

        if (recomputed !== row.entryHash) {
            // #2682 — a lawful erasure is not tampering. Same predicate and
            // same module as `verifyAuditChain`; see `erasure-record.ts` for
            // why the tolerance is `userId`-only rather than row-wide.
            if (isToleratedPseudonymization(row, recomputed, tolerances)) {
                toleratedPseudonymizations++;
                expectedPreviousHash = row.entryHash;
                continue;
            }
            breaks.push({
                position: i,
                rowId: row.id,
                breakType: 'hash_mismatch',
                action: row.action,
                entity: row.entity,
                entityId: row.entityId,
                storedHash: row.entryHash,
                recomputedHash: recomputed,
                expectedPreviousHash: i === 0 ? null : expectedPreviousHash,
                actualPreviousHash: row.previousHash,
                createdAt: row.createdAtIso,
            });
        }

        expectedPreviousHash = row.entryHash;
    }

    return {
        tenantId,
        totalEntries,
        hashedEntries,
        unhashedEntries,
        valid: breaks.length === 0,
        breaks,
        toleratedPseudonymizations,
        verifiedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
    };
}

// ─── All Tenants Verification ───────────────────────────────────────

/**
 * Verify the hash chain for all tenants in the system.
 *
 * @param opts - Optional filters and configuration
 * @returns Aggregate verification report
 */
export async function verifyAllTenants(
    opts: VerifyOptions = {},
): Promise<VerificationReport> {
    const startTime = Date.now();
    const db = opts.client || prisma;

    const tenants: Array<{ id: string; name: string }> = await db.$queryRawUnsafe(
        `SELECT "id", "name" FROM "Tenant" ORDER BY "name"`,
    );

    const results: TenantVerificationResult[] = [];
    let totalEntriesVerified = 0;
    let totalBreaks = 0;
    let tenantsWithBreaks = 0;

    for (const tenant of tenants) {
        const result = await verifyTenantChain(tenant.id, opts);
        result.tenantName = tenant.name;
        results.push(result);
        totalEntriesVerified += result.hashedEntries;
        totalBreaks += result.breaks.length;
        if (!result.valid) tenantsWithBreaks++;
    }

    return {
        allValid: tenantsWithBreaks === 0,
        tenantsVerified: tenants.length,
        tenantsWithBreaks,
        totalEntriesVerified,
        totalBreaks,
        results,
        verifiedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
    };
}
