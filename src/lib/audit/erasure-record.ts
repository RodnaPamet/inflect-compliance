/**
 * Audit Trail — the ERASURE_EXECUTED record, and the ONE mismatch it excuses.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS EXISTS FOR (#2682)
 * ═══════════════════════════════════════════════════════════════════
 *
 * DSAR erasure pseudonymizes by setting `AuditLog.userId -> NULL`. But
 * `actorUserId` is one of the ten `HASH_FIELDS` (canonical-hash.ts), and both
 * chain verifiers RECOMPUTE each `entryHash` from the row's CURRENT columns
 * with `actorUserId: row.userId`. So after a lawful erasure:
 *
 *   stored chain      INTACT    — the immutability trigger refuses any UPDATE
 *                                 that rewrites a hash, so every `entryHash`
 *                                 and `previousHash` survives byte-for-byte.
 *   recomputed chain  BROKEN    — `valid: false` at the first pseudonymized
 *                                 row, which is the exact signature
 *                                 `audit-hash-chain.test.ts` uses to PROVE
 *                                 tampering is detectable.
 *
 * A lawful erasure looked identical to a forged row. Owner decision
 * (2026-09-20, issue #2682): record the erasure IN THE CHAIN and teach the
 * verifiers to consult it.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY THE TOLERANCE IS NOT A BLANKET ONE — read this before widening it
 * ═══════════════════════════════════════════════════════════════════
 *
 * The obvious implementation is "ignore hash mismatches on rows the erasure
 * entry names". That is WORSE THAN THE BUG: it lets a tamperer hide arbitrary
 * edits behind a lawful erasure — null a `userId` on a named row, then change
 * its `action` to whatever they like, and the verifier waves both through.
 *
 * The decision states the tolerance must be `userId`-ONLY. The difficulty is
 * that we cannot verify that directly: proving "the only change is `userId`
 * going from X to NULL" would need X, and X is precisely what erasure
 * destroys. SHA-256 is not invertible, so the stored hash does not yield it.
 *
 * THE COMMITMENT. So the erasure entry records, for each row it names, the
 * hash that row WILL recompute to once `userId` is NULL:
 *
 *     postErasureHash = H(actorUserId: null, + the row's nine other hashed
 *                         fields, exactly as they stood at erasure time)
 *
 * and the tolerance accepts a mismatch only when the verifier's own
 * recomputation — which already uses `actorUserId: row.userId`, i.e. NULL —
 * equals that recorded value. Because `postErasureHash` commits to all nine
 * other hashed fields, ANY other edit to a named row changes the
 * recomputation and the tolerance refuses it. That is the `userId`-only
 * property, enforced rather than asserted.
 *
 * IT LEAKS NOTHING. `postErasureHash` is computed with `actorUserId: null`,
 * so it is a function of the POST-erasure row alone — anyone holding the
 * pseudonymized row can recompute it. It carries zero information about the
 * subject. What it adds is WHEN it was computed: inside the erasure
 * transaction, hash-chained, so it testifies to what the row's other fields
 * were at that moment.
 *
 * NO SECOND SOURCE OF TRUTH. The record is an `AuditLog` row like any other —
 * chained, immutable, inside the protection it is helping to interpret. A
 * tamperer who nulls a `userId` on a row no erasure entry names still breaks
 * the chain; one who forges the record's own hash breaks the chain at the
 * record.
 *
 * THAT LAST SENTENCE IS THE LOAD-BEARING ONE, AND IT ONLY HOLDS FOR A HASHED
 * RECORD. `AuditLog.entryHash` is nullable and unhashed rows are ordinary —
 * `logAudit` (src/lib/audit-log.ts) and the lifecycle jobs `auditLog.create`
 * with a caller-supplied `action` and no hash, and pre-chain rows have none.
 * Both verifiers walk only the hashed subset, so a record with a NULL
 * `entryHash` is never recomputed and never breaks anything: it would be a
 * tolerance grantor that nothing grades. Both therefore build this map from
 * hashed rows ONLY (`audit-writer.ts` passes `hashedRows`; `verify.ts` passes
 * `hashedRows` and adds `AND "entryHash" IS NOT NULL` to its ranged lookup).
 * The collector below cannot enforce that itself — it is handed rows and a
 * `ChainRowForTolerance` carries no hash — so the restriction lives at both
 * call sites, and `audit-trail-verify.test.ts` pins each one.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT THIS DOES NOT CLAIM
 * ═══════════════════════════════════════════════════════════════════
 *
 * The chain is KEYLESS. Anyone who can append to `AuditLog` can append a
 * well-formed ERASURE_EXECUTED entry at the tail and name rows they then
 * pseudonymize. That capability is not created here — it is the capability to
 * write audit entries at all, which the privilege gate (`app_user` has UPDATE
 * on `AuditLog` revoked; erasure runs via `runInGlobalContext`) is what
 * restricts. What this module removes is the FALSE POSITIVE, not the need for
 * that gate.
 *
 * Rows whose pre-erasure hash did NOT verify get no tolerance recorded (see
 * `dsar-erasure.ts`), so an already-broken chain stays broken through an
 * erasure rather than being laundered by one.
 *
 * @module audit/erasure-record
 */

/** `AuditLog.action` of the record. The verifiers select on this. */
export const ERASURE_EXECUTED_ACTION = 'ERASURE_EXECUTED';

/** `AuditLog.entity` of the record — the table whose rows it names. */
export const ERASURE_RECORD_ENTITY = 'AuditLog';

/**
 * `AuditLog.entityId` of the record. A CONSTANT, deliberately: the natural
 * candidate is the erased subject's id, and writing that here would
 * re-identify the subject in the very entry that records their erasure.
 */
export const ERASURE_RECORD_ENTITY_ID = 'pseudonymization';

/** `detailsJson.schema` — bump if the payload shape below changes. */
export const ERASURE_RECORD_SCHEMA = 1;

/** One pseudonymized row, and the hash it must recompute to. */
export interface ErasureRecordRow {
    /** `AuditLog.id` of a row whose `userId` this erasure set to NULL. */
    id: string;
    /**
     * `H(actorUserId: null, + that row's nine other hashed fields as they
     * stood at erasure time)`. Derivable from the post-erasure row; its value
     * is the COMMITMENT, its provenance is the evidence.
     */
    postErasureHash: string;
}

/**
 * `detailsJson` of an ERASURE_EXECUTED entry. `category: 'custom'` because
 * that is the one `AuditDetailsSchema` member that accepts domain keys
 * (`event-schema.ts` — every other category is `.strict()`).
 */
export interface ErasureRecordDetails {
    category: 'custom';
    event: typeof ERASURE_EXECUTED_ACTION;
    schema: number;
    /** How many `AuditLog` rows this erasure pseudonymized IN THIS TENANT. */
    auditRowsPseudonymized: number;
    /** The named rows, sorted by id. */
    pseudonymizedRows: ErasureRecordRow[];
    /**
     * Pseudonymized rows that got NO tolerance because their stored hash did
     * not recompute BEFORE the erasure. Recorded rather than dropped: a
     * non-zero value here means the chain was already broken at those rows and
     * still is, which is the correct outcome and must not look like an erasure
     * that under-reported.
     */
    rowsWithoutTolerance: number;
}

/** Build the record payload. Rows are sorted by id so the shape is stable. */
export function buildErasureRecordDetails(
    rows: ErasureRecordRow[],
    options: { auditRowsPseudonymized: number; rowsWithoutTolerance: number },
): ErasureRecordDetails {
    return {
        category: 'custom',
        event: ERASURE_EXECUTED_ACTION,
        schema: ERASURE_RECORD_SCHEMA,
        auditRowsPseudonymized: options.auditRowsPseudonymized,
        pseudonymizedRows: [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        rowsWithoutTolerance: options.rowsWithoutTolerance,
    };
}

/** The shape a verifier reads out of the chain. */
export interface ChainRowForTolerance {
    id: string;
    userId: string | null;
    action: string;
    detailsJson: unknown;
}

/**
 * Read the named rows out of one candidate record's `detailsJson`.
 *
 * Returns `[]` for anything that is not a well-formed ERASURE_EXECUTED
 * payload. Every field is checked: a row that merely CARRIES the action string
 * grants no tolerance, and a malformed entry grants none either — ignoring a
 * shape we do not understand is the safe direction, because the consequence is
 * "the chain reports broken", which is the pre-#2682 behaviour rather than a
 * new blindness.
 */
export function parseErasureRecordRows(row: ChainRowForTolerance): ErasureRecordRow[] {
    if (row.action !== ERASURE_EXECUTED_ACTION) return [];
    const details = row.detailsJson;
    if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
    const d = details as Record<string, unknown>;
    if (d.event !== ERASURE_EXECUTED_ACTION) return [];
    if (!Array.isArray(d.pseudonymizedRows)) return [];

    const out: ErasureRecordRow[] = [];
    for (const entry of d.pseudonymizedRows) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.id !== 'string' || e.id.length === 0) continue;
        if (typeof e.postErasureHash !== 'string' || e.postErasureHash.length === 0) continue;
        out.push({ id: e.id, postErasureHash: e.postErasureHash });
    }
    return out;
}

/**
 * Every tolerance declared by the ERASURE_EXECUTED entries in one tenant's
 * chain: `AuditLog.id` -> the hash that row must recompute to.
 *
 * A row named TWICE with DIFFERENT hashes is dropped entirely rather than
 * resolved to one of them — two records disagreeing about what a row looked
 * like is not a state a lawful erasure can produce (the trigger permits
 * `value -> NULL` once and nothing else), and picking a winner would let a
 * later forged entry overwrite an earlier honest one.
 */
export function collectPseudonymizationTolerances(
    rows: ChainRowForTolerance[],
): Map<string, string> {
    const tolerances = new Map<string, string>();
    const conflicted = new Set<string>();

    for (const row of rows) {
        for (const named of parseErasureRecordRows(row)) {
            const existing = tolerances.get(named.id);
            if (existing !== undefined && existing !== named.postErasureHash) {
                conflicted.add(named.id);
                continue;
            }
            tolerances.set(named.id, named.postErasureHash);
        }
    }
    for (const id of conflicted) tolerances.delete(id);
    return tolerances;
}

/**
 * Is this row's hash mismatch the expected consequence of a lawful erasure?
 *
 * Call this ONLY after `recomputed !== row.entryHash`. All three conditions
 * must hold, and each excludes a different attack:
 *
 *   1. `userId IS NULL`        — the row is actually de-attributed. A named
 *                                row that still identifies someone is not a
 *                                completed erasure, whatever the record says.
 *   2. the row is NAMED        — a `userId` nulled on any row no erasure entry
 *                                names still breaks the chain. This is the
 *                                property the owner decision turns on.
 *   3. `recomputed === the recorded postErasureHash`
 *                              — the nine other hashed fields are unchanged
 *                                since the erasure committed. THIS is what
 *                                makes the tolerance `userId`-only; without
 *                                it, (1)+(2) would excuse arbitrary edits to a
 *                                named row.
 */
export function isToleratedPseudonymization(
    row: { id: string; userId: string | null },
    recomputed: string,
    tolerances: Map<string, string>,
): boolean {
    if (row.userId !== null) return false;
    const expected = tolerances.get(row.id);
    if (expected === undefined) return false;
    return expected === recomputed;
}
