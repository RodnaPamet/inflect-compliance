/**
 * Recomputing a snapshot's payload hash from the rows in the database.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE POINT OF THE HASH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A hash we merely stored alongside the rows proves nothing: whoever could change
 * the rows could change the hash. What makes it evidence is that it is
 * RE-DERIVABLE — an auditor, holding only the stored accounts and the published
 * canonicalisation, arrives at the same sixty-four characters. This function is
 * that derivation, and the test that it agrees with the stored value is the only
 * thing that keeps the canonicalisation and the pull from drifting apart.
 *
 * Two rules it must obey, both learned the hard way elsewhere in this codebase:
 *
 * - **It reads `payloadHashAlgorithmVersion` from the ROW** and refuses a version
 *   it does not implement. Assuming the current algorithm would report every
 *   snapshot taken before a canonicalisation fix as corrupt — on the day somebody
 *   fixes a bug, every historical snapshot would start failing verification, which
 *   is the opposite of what integrity evidence is for.
 * - **It pages in `accountKey` order and feeds the hasher incrementally**, rather
 *   than loading the population to sort it. The ordering is the index's job.
 *
 * @module app-layer/usecases/legacy-access-verify
 */

import { runInTenantContext } from '@/lib/db-context';
import {
    PAYLOAD_HASH_ALGORITHM_VERSION,
    createPayloadHasher,
    type CanonicalAccount,
} from '@/lib/legacy-access/canonical';
import type { RequestContext } from '../types';
import { assertCanAudit } from '../policies/common';

/** One page of accounts per round trip. Bounded so memory does not track the snapshot. */
const VERIFY_PAGE_SIZE = 1_000;

export interface VerifyResult {
    readonly snapshotId: string;
    /** Null when the snapshot stores no hash — every non-COMPLETE snapshot. */
    readonly storedHash: string | null;
    readonly recomputedHash: string | null;
    readonly rowCount: number;
    /**
     * True only when a stored hash exists, this process implements its algorithm
     * version, and the recomputation matches. Never true for a snapshot that
     * stores no hash — "nothing to compare" is not "verified".
     */
    readonly verified: boolean;
    readonly reason: string | null;
}

/**
 * Verify one snapshot.
 *
 * `assertCanAudit` rather than `assertCanRead`: this is the integrity check an
 * auditor runs, and it is the one read in the subsystem whose answer is a claim
 * about whether the product's own records are trustworthy.
 */
export async function verifySnapshotPayloadHash(
    ctx: RequestContext,
    snapshotId: string
): Promise<VerifyResult> {
    assertCanAudit(ctx);

    const snapshot = await runInTenantContext(ctx, (db) =>
        db.legacyAccessSnapshot.findFirstOrThrow({
            where: { id: snapshotId, tenantId: ctx.tenantId },
            select: {
                id: true,
                status: true,
                payloadHash: true,
                payloadHashAlgorithmVersion: true,
                rowCount: true,
            },
        })
    );

    if (snapshot.payloadHash === null) {
        return {
            snapshotId: snapshot.id,
            storedHash: null,
            recomputedHash: null,
            rowCount: snapshot.rowCount,
            verified: false,
            reason:
                `snapshot is ${snapshot.status} and stores no payload hash — a hash over a `
                + 'population that was never read whole would certify the wrong thing',
        };
    }

    if (snapshot.payloadHashAlgorithmVersion !== PAYLOAD_HASH_ALGORITHM_VERSION) {
        // Refused, not attempted. Recomputing with today's canonicalisation would
        // produce a mismatch and report a sound snapshot as corrupt.
        return {
            snapshotId: snapshot.id,
            storedHash: snapshot.payloadHash,
            recomputedHash: null,
            rowCount: snapshot.rowCount,
            verified: false,
            reason:
                `snapshot was hashed with algorithm version `
                + `${snapshot.payloadHashAlgorithmVersion}; this build implements `
                + `${PAYLOAD_HASH_ALGORITHM_VERSION}`,
        };
    }

    const hasher = createPayloadHasher();
    let seen = 0;
    let cursor: string | null = null;

    // This is cursor PAGINATION, not a per-item read. Each
    // iteration fetches VERIFY_PAGE_SIZE accounts in one query, which is the
    // opposite of the pattern Layer D1 hunts; the loop count is
    // ceil(rowCount / 1000), not one query per account. The alternative the guard
    // would prefer — a single unbounded findMany — is what the incremental hasher
    // exists to avoid, because it would hold a 50,000-row snapshot in memory to
    // sort rows the index already returns in order.
    for (;;) { // guardrail-allow: n+1 — cursor pagination; see the note above
        const page: readonly StoredAccountRow[] = await runInTenantContext(ctx, (db) =>
            db.legacyAccount.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    snapshotId: snapshot.id,
                    ...(cursor === null ? {} : { accountKey: { gt: cursor } }),
                },
                // The order the hash is defined over, served by
                // `LegacyAccount_snapshotId_accountKey_key`.
                orderBy: { accountKey: 'asc' },
                take: VERIFY_PAGE_SIZE,
                select: ACCOUNT_SELECT,
            })
        );
        if (page.length === 0) break;
        for (const row of page) {
            hasher.update(toCanonical(row));
            seen += 1;
        }
        cursor = page[page.length - 1].accountKey;
        // A short page is the last page. Checked rather than relying on the
        // cursor returning nothing next time, which costs one extra round trip
        // per verification.
        if (page.length < VERIFY_PAGE_SIZE) break;
    }

    const recomputedHash = hasher.digest();
    const countAgrees = seen === snapshot.rowCount;
    const hashAgrees = recomputedHash === snapshot.payloadHash;

    return {
        snapshotId: snapshot.id,
        storedHash: snapshot.payloadHash,
        recomputedHash,
        rowCount: seen,
        // BOTH. A hash match over the wrong number of rows cannot happen for
        // SHA-256, but the count is what an operator reads, and reporting
        // `verified` while the stored count disagrees would leave the mismatch
        // invisible. Two independent facts, one verdict.
        verified: hashAgrees && countAgrees,
        reason: hashAgrees && countAgrees
            ? null
            : !countAgrees
                ? `snapshot records ${snapshot.rowCount} accounts, ${seen} are stored`
                : 'recomputed payload hash does not match the stored hash',
    };
}

const ACCOUNT_SELECT = {
    accountKey: true,
    username: true,
    displayName: true,
    givenName: true,
    familyName: true,
    email: true,
    employeeNumber: true,
    department: true,
    title: true,
    managerRef: true,
    status: true,
    lastLoginAt: true,
    sourceCreatedAt: true,
    expiresAt: true,
    entitlements: true,
    isPrivileged: true,
    accountType: true,
} as const;

interface StoredAccountRow {
    readonly accountKey: string;
    readonly username: string | null;
    readonly displayName: string | null;
    readonly givenName: string | null;
    readonly familyName: string | null;
    readonly email: string | null;
    readonly employeeNumber: string | null;
    readonly department: string | null;
    readonly title: string | null;
    readonly managerRef: string | null;
    readonly status: CanonicalAccount['status'];
    readonly lastLoginAt: Date | null;
    readonly sourceCreatedAt: Date | null;
    readonly expiresAt: Date | null;
    readonly entitlements: string[];
    readonly isPrivileged: boolean | null;
    readonly accountType: CanonicalAccount['accountType'];
}

/**
 * Database row → canonical account.
 *
 * The INVERSE of `toAccountRow` in the pull, and the only other place the
 * `createdAt` / `sourceCreatedAt` rename appears. If the two ever disagree the
 * recompute fails, which is exactly the failure a verification is for — so this
 * being a second mapping is a feature, not duplication to collapse.
 */
function toCanonical(row: StoredAccountRow): CanonicalAccount {
    return {
        accountKey: row.accountKey,
        username: row.username,
        displayName: row.displayName,
        givenName: row.givenName,
        familyName: row.familyName,
        email: row.email,
        employeeNumber: row.employeeNumber,
        department: row.department,
        title: row.title,
        managerRef: row.managerRef,
        status: row.status,
        lastLoginAt: row.lastLoginAt,
        createdAt: row.sourceCreatedAt,
        expiresAt: row.expiresAt,
        entitlements: row.entitlements,
        isPrivileged: row.isPrivileged,
        accountType: row.accountType,
    };
}
