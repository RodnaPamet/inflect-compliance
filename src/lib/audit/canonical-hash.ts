/**
 * Audit Trail — Canonical Hashing
 *
 * Implements deterministic SHA-256 hashing for the immutable audit chain.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CANONICAL SERIALIZATION RULES
 * ═══════════════════════════════════════════════════════════════════
 *
 * The entryHash is computed as:
 *
 *   entryHash = SHA-256(canonicalJSON(hashPayload))
 *
 * Where hashPayload includes EXACTLY these fields (in sorted order):
 *   - actorType       : string ("USER" | "SYSTEM" | "JOB")
 *   - actorUserId     : string | null (null → JSON null)
 *   - detailsJson     : object (canonical JSON, keys sorted recursively)
 *   - entityId        : string | null
 *   - entityType      : string
 *   - eventType       : string
 *   - occurredAt      : string (ISO-8601 UTC, millisecond precision)
 *   - previousHash    : string | null (null for first entry per tenant)
 *   - tenantId        : string
 *   - version         : number
 *
 * EXCLUDED from hash (mutable/non-deterministic):
 *   - id              (auto-generated, not known at build time)
 *   - requestId       (operational correlation, not audit content)
 *   - recordIds       (middleware metadata)
 *   - metadataJson    (middleware metadata)
 *   - diffJson        (middleware diff capture)
 *   - details         (legacy free-form text)
 *   - createdAt       (DB-generated; occurredAt is the canonical timestamp)
 *
 * CANONICAL JSON RULES:
 *   1. Keys sorted lexicographically at EVERY depth (recursive)
 *   2. No whitespace (compact serialization)
 *   3. null values are preserved (never omitted)
 *   4. Dates must be pre-formatted as ISO-8601 strings before passing in
 *   5. Numbers are serialized without unnecessary precision (1.0 → 1)
 *
 * HASH CHAIN MODEL:
 *   - Per-tenant chain: each tenant has an independent chain
 *   - First entry: previousHash = null
 *   - Subsequent entries: previousHash = entryHash of the preceding entry
 *   - Verification: recompute entryHash from canonical fields and compare
 *
 * ═══════════════════════════════════════════════════════════════════
 *
 * @module audit/canonical-hash
 */
import { createHash } from 'crypto';

/**
 * The exact set of fields included in hash computation.
 * Order must be lexicographic — this constant documents the contract.
 */
export const HASH_FIELDS = [
    'actorType',
    'actorUserId',
    'detailsJson',
    'entityId',
    'entityType',
    'eventType',
    'occurredAt',
    'previousHash',
    'tenantId',
    'version',
] as const;

/**
 * Input shape for hash computation.
 * All values must be in their canonical form (strings, not Date objects).
 */
export interface HashInput {
    tenantId: string;
    actorType: string;
    actorUserId: string | null;
    eventType: string;
    entityType: string;
    entityId: string | null;
    occurredAt: string;    // ISO-8601 UTC string
    detailsJson: unknown;  // Must be a plain JSON-serializable object
    previousHash: string | null;
    version: number;
}

// ─── Canonical JSON ─────────────────────────────────────────────────

/**
 * Produce a deterministic JSON string with recursively sorted keys.
 * This is the foundation of the hash chain — identical input MUST
 * always produce identical output, byte-for-byte.
 *
 * Rules:
 *   - Objects: keys sorted lexicographically
 *   - Arrays: order preserved (arrays are ordered data structures)
 *   - null: serialized as `null` (not omitted)
 *   - undefined: omitted (should never appear in audit payloads)
 *   - No whitespace
 */
export function canonicalJsonStringify(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'null'; // safety fallback

    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);

    if (Array.isArray(value)) {
        const items = value.map((item) => canonicalJsonStringify(item));
        return '[' + items.join(',') + ']';
    }

    if (typeof value === 'object') {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const pairs = keys.map((key) => {
            const v = (value as Record<string, unknown>)[key];
            // Skip undefined values entirely
            if (v === undefined) return null;
            return JSON.stringify(key) + ':' + canonicalJsonStringify(v);
        }).filter(Boolean);
        return '{' + pairs.join(',') + '}';
    }

    // Fallback for unknown types
    return JSON.stringify(value);
}

// ─── Hash Computation ───────────────────────────────────────────────

/**
 * Build the canonical hash payload from a HashInput.
 * Returns the object with fields in the exact order defined by HASH_FIELDS.
 */
export function buildHashPayload(input: HashInput): Record<string, unknown> {
    return {
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        detailsJson: input.detailsJson,
        entityId: input.entityId,
        entityType: input.entityType,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        previousHash: input.previousHash,
        tenantId: input.tenantId,
        version: input.version,
    };
}

/**
 * Compute the SHA-256 hash for an audit entry.
 *
 * @param input - The hash input with all required fields
 * @returns Lowercase hex-encoded SHA-256 hash string (64 chars)
 */
export function computeEntryHash(input: HashInput): string {
    const payload = buildHashPayload(input);
    const canonical = canonicalJsonStringify(payload);
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Format a Date as a canonical ISO-8601 UTC string with millisecond precision.
 * Always produces the format: YYYY-MM-DDTHH:mm:ss.SSSZ
 *
 * @param date - Date object or ISO string
 * @returns Canonical ISO-8601 string
 */
export function toCanonicalTimestamp(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toISOString(); // Always produces YYYY-MM-DDTHH:mm:ss.SSSZ
}

/**
 * The value an audit append both hashes and stores (#5069).
 *
 * `canonicalJsonStringify` walks an object's own keys, so a `Date` (or a
 * Prisma `Decimal`, or anything with `toJSON`) hashed as `{}`, while
 * `JSON.stringify` stored its `toJSON` form. The verifier recomputes from the
 * STORED jsonb, so such a row reported a hash mismatch: a forgery that never
 * happened, and every later row went unverified. A JSON round trip makes the
 * hashed value exactly what is stored.
 */
export function toStoredAuditJson(value: unknown): unknown {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/**
 * The append's timestamp, strictly after the chain's last one (#5180).
 *
 * Appends are serialised by the advisory lock but not distinct: two inside
 * one millisecond shared a timestamp, the predecessor was then chosen by a
 * random id tie-break, and the verifier could walk them in an order other
 * than the one they were chained in. Taken inside the lock, this keeps each
 * chain's timestamps strictly increasing, so timestamp order IS chain order.
 */
export function nextChainTimestamp(lastMs: number | string | null | undefined, now: Date = new Date()): Date {
    if (lastMs === null || lastMs === undefined) return now;
    const last = Math.round(Number(lastMs));
    if (!Number.isFinite(last)) return now;
    return now.getTime() > last ? now : new Date(last + 1);
}

