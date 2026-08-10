/**
 * Epic B.1 + B.2 — Transparent field-level encryption middleware.
 *
 * Installs a Prisma `$use` hook that encrypts manifest fields on
 * write and decrypts them on read. The key used for each operation
 * is resolved at hook entry:
 *
 *   ─ **B.2 path (default):** when `getAuditContext()` carries a
 *     `tenantId` from an authenticated request, the middleware calls
 *     `getTenantKeyManager().getTenantDek(tenantId)` to get the raw
 *     per-tenant DEK and uses `encryptWithKey` / `decryptWithKey`.
 *     Ciphertexts carry the `v2:` envelope prefix.
 *
 *   ─ **B.1 fallback:** when there's no tenant context (seed / job /
 *     system bypass paths, webhook ingest pre-identification, auth
 *     discovery), the middleware falls back to `encryptField` /
 *     `decryptField` under the global KEK. Ciphertexts carry the
 *     `v1:` envelope prefix. Read mixed-state remains safe because
 *     the decrypt path dispatches per-value on the `v1:` / `v2:`
 *     prefix.
 *
 * ## Mixed-state rollout
 *
 * Rows written before B.2 rollout are `v1:`. Rows written after are
 * `v2:`. The read path handles both — `getCiphertextVersion()` picks
 * the right decrypt. A big-bang re-encrypt is unnecessary; rows
 * slowly migrate as they're updated, and the backfill script can
 * force it explicitly later.
 *
 * ## Cross-tenant isolation
 *
 * Each tenant's DEK is independent random bytes wrapped under the
 * global KEK. Decrypting tenant A's `v2:` ciphertext with tenant B's
 * DEK produces an AES-GCM auth-tag failure — the middleware logs the
 * warn, returns the raw ciphertext, and continues. The caller sees
 * undecrypted material (not a decrypt-crash); ops sees the incident
 * via the `decrypt_failed` log line.
 *
 * ## Recursion guard
 *
 * Resolving a tenant's DEK issues `prisma.tenant.findUnique`, which
 * re-enters this middleware. `Tenant` is not in the encrypted-fields
 * manifest, so the inner hook's fan-out finds nothing to process —
 * but we also skip DEK resolution entirely when `params.model ===
 * 'Tenant'` to avoid any risk of infinite recursion.
 *
 * ## Idempotency
 *
 * Every ciphertext carries a `v1:` or `v2:` prefix. Writes skip
 * values that already match either prefix (`isEncryptedValue()`),
 * so nested-write fan-out, test doubles, and concurrent writes
 * never produce double ciphertext.
 *
 * ## Null / empty
 *
 * `null` / `undefined` / `''` pass through unchanged — encrypting
 * an empty string wastes bytes with no security gain.
 */

// PrismaClient import removed — Prisma 7 extensions accept any
// client-with-$extends instead of a typed PrismaClient instance.
import {
    encryptField,
    decryptField,
    encryptWithKey,
    decryptWithKeyOrPrevious,
    isEncryptedValue,
    getCiphertextVersion,
} from '@/lib/security/encryption';
import {
    getEncryptedFields,
    isEncryptedModel,
    ALL_ENCRYPTED_FIELD_NAMES,
    nodeHasAnyEncryptedFieldKey,
} from '@/lib/security/encrypted-fields';
import { getAuditContext } from '@/lib/audit-context';
import { logger } from '@/lib/observability/logger';
import { recordFieldDecryptFailure, recordTenantContextMismatch } from '@/lib/observability/metrics';
// `import * as` (rather than a top-level named import) keeps the
// circular-import escape hatch — `tenant-key-manager` imports
// `@/lib/prisma`, which composes this module — while still exposing
// the symbols at call time. The previous lazy `require('@/lib/...')`
// was invisibly broken by Turbopack's production minifier (resolved
// to `undefined`, surfacing as `"i is not a function"` runtime
// errors). Same pattern as `db/rls-middleware.ts::prismaModule`.
import * as tenantKeyManager from '@/lib/security/tenant-key-manager';
import { env } from '@/env';

// ─── Action buckets ───────────────────────────────────────────────────

const WRITE_ACTIONS: ReadonlySet<string> = new Set([
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'upsert',
]);

const RESULT_DECRYPT_ACTIONS: ReadonlySet<string> = new Set([
    'findFirst',
    'findUnique',
    'findFirstOrThrow',
    'findUniqueOrThrow',
    'findMany',
    'create',
    'update',
    'upsert',
    'createMany',
    'createManyAndReturn',
]);

/**
 * Audit-context `source` values that should fall back to the global
 * KEK (v1) instead of the tenant DEK (v2). These code paths don't
 * speak on behalf of a tenant — they're cross-tenant by design
 * (seeds populate globals, sweep jobs iterate all tenants, system
 * events are infrastructure), and making them write v2 under one
 * tenant's DEK would break their multi-tenant semantics.
 */
const BYPASS_SOURCES: ReadonlySet<string> = new Set([
    'seed',
    'job',
    'system',
]);

// ─── DEK resolution (Epic B.2) ────────────────────────────────────────

/**
 * A resolved tenant-DEK pair. `primary` is the current encryption
 * key (used for new writes and the first decrypt attempt on every
 * v2 ciphertext). `previous` is non-null only while a per-tenant
 * DEK rotation is mid-flight (`Tenant.previousEncryptedDek` is
 * populated) — used as the fallback inside
 * `decryptWithKeyOrPrevious` so reads of rows still under the old
 * DEK keep working until the sweep rewrites them.
 */
interface TenantDekPair {
    primary: Buffer | null;
    previous: Buffer | null;
    /**
     * WHY there is no primary DEK, when there isn't one.
     *
     * `by-design` and `resolve-failed` both produced an identical
     * `NO_DEK_PAIR` before, which meant a real anomaly (the DEK lookup
     * threw) was indistinguishable from routine cross-tenant work that is
     * SUPPOSED to have no tenant DEK. They want opposite handling, so the
     * read path can no longer be written correctly without this.
     */
    reason: 'resolved' | 'by-design' | 'resolve-failed';
}

const NO_DEK_PAIR: TenantDekPair = { primary: null, previous: null, reason: 'by-design' };

/**
 * No DEK because the lookup FAILED, not because none was expected. A
 * tenantId was present and we could not honour it — a transient DB blip, or
 * a tenant with no `encryptedDek` row. Kept distinct from `NO_DEK_PAIR` so
 * the read path can fail open here (nulling an entire list page over a DB
 * blip is its own outage) while failing closed on the by-design case.
 */
const DEK_RESOLVE_FAILED: TenantDekPair = {
    primary: null,
    previous: null,
    reason: 'resolve-failed',
};

/**
 * Resolve the per-tenant DEK pair for the current operation, or the
 * `{ null, null }` sentinel when the middleware should fall back to
 * the global KEK.
 *
 * Returns the empty pair when any of:
 *   - `model === 'Tenant'` — recursion guard. `getTenantDek` reads
 *     the `Tenant` row itself, which re-enters this hook; we must
 *     NOT try to resolve a DEK for a Tenant query.
 *   - no audit context (raw `prisma` calls outside the tenant wrapper)
 *   - `source` is one of the known bypass markers
 *   - the manager throws (missing tenant / DB error)
 *
 * In every empty-pair case, the middleware uses `encryptField` /
 * `decryptField` under the global KEK — same behaviour as Epic B.1.
 *
 * The `previous` slot is independently optional. The primary may
 * resolve while the previous is null (steady state, no rotation in
 * flight). Both null is the global-KEK fallback. Primary null +
 * previous non-null is impossible by construction.
 */
async function resolveTenantDekPair(
    model: string | undefined,
): Promise<TenantDekPair> {
    if (model === 'Tenant') return NO_DEK_PAIR;

    const ctx = getAuditContext();
    const tenantId = ctx?.tenantId;
    if (!tenantId) return NO_DEK_PAIR;
    if (ctx?.source && BYPASS_SOURCES.has(ctx.source)) return NO_DEK_PAIR;

    // Read through the namespace import. The static `import *` at the
    // top of this file is the canonical fix for the circular cycle
    // (`tenant-key-manager` → `@/lib/prisma` → `withEncryptionExtension`)
    // that doesn't trip Turbopack's production minifier — see the
    // import comment block.
    const { getTenantDek, getTenantPreviousDek } = tenantKeyManager;

    let primary: Buffer | null;
    try {
        primary = await getTenantDek(tenantId);
    } catch (err) {
        logger.warn('encryption-middleware.dek_resolve_failed', {
            component: 'encryption-middleware',
            tenantId,
            reason: err instanceof Error ? err.message : 'unknown',
        });
        return DEK_RESOLVE_FAILED;
    }

    // The previous-DEK lookup is cheap in steady state (negative TTL
    // cache short-circuits the DB) and bounded during rotation
    // (cache hit after the first call). A failure here is benign —
    // we proceed with primary-only and accept that mid-rotation
    // reads of stale rows fail in this process until the sweep
    // catches up.
    let previous: Buffer | null = null;
    try {
        previous = await getTenantPreviousDek(tenantId);
    } catch (err) {
        logger.warn('encryption-middleware.previous_dek_resolve_failed', {
            component: 'encryption-middleware',
            tenantId,
            reason: err instanceof Error ? err.message : 'unknown',
        });
    }

    return { primary, previous, reason: 'resolved' };
}

// ─── Encrypt traversal (write path) ──────────────────────────────────

/**
 * Encrypt a single value with either the tenant DEK (v2) or the
 * global KEK (v1). `null` dek → v1 fallback. All other safety
 * checks (null/empty/already-encrypted) are the caller's
 * responsibility.
 */
function encryptValue(plaintext: string, dek: Buffer | null): string {
    if (dek) return encryptWithKey(dek, plaintext);
    return encryptField(plaintext);
}

/**
 * Encrypt manifest fields on a single data node. Mutates in place.
 * Uses `dek` when present (B.2), else falls back to the global KEK.
 */
function encryptDataNode(
    data: Record<string, unknown>,
    modelName: string,
    dek: Buffer | null,
): void {
    const fields = getEncryptedFields(modelName);
    if (!fields) return;
    for (const field of fields) {
        const value = data[field];
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string') continue;
        if (value.length === 0) continue;
        if (isEncryptedValue(value)) continue;
        data[field] = encryptValue(value, dek);
    }
}

/**
 * Fan-out encrypt: applied when a nested node's target model is
 * structurally unknown. Walks the node's OWN keys once and encrypts
 * any key that matches an encrypted field name anywhere in the
 * manifest.
 */
function encryptDataNodeAllModels(
    data: Record<string, unknown>,
    dek: Buffer | null,
): void {
    if (!nodeHasAnyEncryptedFieldKey(data)) return;
    for (const key of Object.keys(data)) {
        if (!ALL_ENCRYPTED_FIELD_NAMES.has(key)) continue;
        const value = data[key];
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string') continue;
        if (value.length === 0) continue;
        if (isEncryptedValue(value)) continue;
        data[key] = encryptValue(value, dek);
    }
}

/**
 * Walk a Prisma write payload and encrypt every manifest field.
 * `modelName === '*'` triggers fan-out across all manifest models.
 */
function walkWriteArgument(
    payload: unknown,
    modelName: string,
    dek: Buffer | null,
): void {
    if (payload === null || payload === undefined) return;
    if (Array.isArray(payload)) {
        for (const item of payload) walkWriteArgument(item, modelName, dek);
        return;
    }
    if (typeof payload !== 'object') return;

    const node = payload as Record<string, unknown>;

    // 1. Encrypt fields on this node (direct or fan-out).
    if (modelName === '*') {
        encryptDataNodeAllModels(node, dek);
    } else {
        encryptDataNode(node, modelName, dek);
    }

    // 2. Descend into nested-writes shapes. Target model is unknown
    //    from structure alone — fan out via '*' but keep the DEK.
    for (const value of Object.values(node)) {
        if (!value || typeof value !== 'object') continue;
        const nested = value as Record<string, unknown>;
        if ('create' in nested) walkWriteArgument(nested.create, '*', dek);
        if ('update' in nested) walkWriteArgument(nested.update, '*', dek);
        if ('upsert' in nested) {
            const u = nested.upsert as Record<string, unknown> | undefined;
            if (u?.create) walkWriteArgument(u.create, '*', dek);
            if (u?.update) walkWriteArgument(u.update, '*', dek);
        }
        if ('connectOrCreate' in nested) {
            const coc = nested.connectOrCreate as
                | Record<string, unknown>
                | undefined;
            if (coc?.create) walkWriteArgument(coc.create, '*', dek);
        }
        if ('createMany' in nested) {
            const cm = nested.createMany as Record<string, unknown> | undefined;
            if (cm?.data) walkWriteArgument(cm.data, '*', dek);
        }
    }
}

// ─── Decrypt traversal (read path) ───────────────────────────────────

/**
 * Decrypt a single value based on its envelope version. v1 → global
 * KEK via `decryptField` (which has its own dual-KEK fallback for
 * master-key rotation). v2 → primary tenant DEK first, falling back
 * to the previous DEK on AES-GCM auth failure. If the ciphertext is
 * v2 but no primary DEK is available (cross-tenant bypass read),
 * the caller is expected to leave the value untouched and log a
 * warning — this function throws in that case so the caller can
 * distinguish "expected pass-through" from "real decrypt failure".
 */
/**
 * No tenant DEK was available for a `v2:` ciphertext.
 *
 * A distinct class rather than a message match: the read path branches on
 * it, and branching on `err.message` is exactly the kind of coupling that
 * survives a refactor as a silent behaviour change.
 */
class NoTenantDekError extends Error {
    constructor(public readonly dekReason: 'by-design' | 'resolve-failed') {
        super(
            `encryption-middleware: v2 ciphertext encountered but no tenant DEK is resolvable (${dekReason})`,
        );
        this.name = 'NoTenantDekError';
    }
}

function decryptValue(ciphertext: string, deks: TenantDekPair): string {
    const version = getCiphertextVersion(ciphertext);
    if (version === 'v1') {
        return decryptField(ciphertext);
    }
    if (version === 'v2') {
        if (!deks.primary) {
            // `resolved` is unreachable here — a resolved pair has a
            // primary — but the compiler cannot narrow that, and defaulting
            // to `resolve-failed` is the safe side of the branch (it fails
            // OPEN rather than nulling a field on an impossible path).
            throw new NoTenantDekError(
                deks.reason === 'by-design' ? 'by-design' : 'resolve-failed',
            );
        }
        // Steady state: deks.previous is null and this is a single
        // primary decrypt attempt with the same shape as before.
        // Mid-rotation: previous is non-null and the helper retries
        // under it on AES-GCM auth failure.
        return decryptWithKeyOrPrevious(deks.primary, deks.previous, ciphertext);
    }
    // Shouldn't happen — caller gates on isEncryptedValue.
    throw new Error('encryption-middleware: unknown ciphertext envelope');
}

/**
 * What a field becomes when it cannot be decrypted.
 *
 * Never throws — a read path that 500s a whole list page over one bad row
 * is its own outage. But "never throw" is not the same as "always hand back
 * the ciphertext", which is what this used to do uniformly, and the three
 * failure classes do not deserve the same answer:
 *
 * **No DEK BY DESIGN → `null`.** The operation legitimately has no tenant
 * DEK: the `Tenant` model itself, no ambient tenantId, or a `BYPASS_SOURCES`
 * caller. These are cross-tenant by construction and have no business
 * reading tenant plaintext. Handing them the ciphertext was the worst
 * available outcome — useless to the caller AND forwardable to every
 * downstream consumer of the row (UI, PDF export, audit-pack share link,
 * SDK), which cannot tell it from plaintext. `null` costs a sweep that only
 * counts or deletes rows nothing, and a sweep that genuinely needed the
 * value has a bug that now surfaces on the next line instead of shipping a
 * `v2:`-prefixed blob into an evidence artefact.
 *
 * Note the deliberate type lie: eight manifest fields are non-nullable in
 * Prisma (`Finding.description`, `TaskComment.body`, `Incident.description`,
 * …), so `null` contradicts their declared `string`. That is the intended
 * outcome, not an oversight. For a field whose type promises a string, the
 * honest representation of "this value could not be produced" is `null`, and
 * a `TypeError` at the first read is strictly better than a ciphertext blob
 * that reads as a valid string all the way into a customer-facing export.
 *
 * **DEK lookup FAILED → unchanged (ciphertext).** A tenantId was present and
 * we could not honour it. Nulling every encrypted field on a page because of
 * a transient DB blip is its own outage, and unlike the by-design case there
 * IS a legitimate reader waiting. Fails open, but now counted separately so
 * it stops hiding inside the by-design noise.
 *
 * **Decrypt FAILED with a DEK → unchanged (ciphertext).** Wrong key, corrupt
 * row, or a write made under a mismatched tenant context. The genuine
 * integrity anomaly. Whether this should throw instead is a posture decision
 * with a real blast radius (one corrupt row would 500 a list page), so it is
 * deliberately left open here and made observable first: flip it once
 * `encryption.field.decrypt_failed{outcome="decrypt_failed"}` is zero in
 * steady state.
 */
/**
 * A value that should have decrypted and did not.
 *
 * Distinct from `NoTenantDekError`: there a DEK was never available, which is
 * either expected (cross-tenant work) or an infrastructure failure. Here the
 * key WAS in hand and the ciphertext still failed authentication — an
 * integrity anomaly about the DATA, not the key lookup.
 *
 * Carries no plaintext and no ciphertext, only the coordinates an operator
 * needs to find the row. The message reaches logs and, via the API error
 * wrapper, potentially a client — so it must not leak the value it failed on.
 */
export class DecryptIntegrityError extends Error {
    constructor(
        public readonly model: string,
        public readonly field: string,
        public readonly version: string,
    ) {
        super(
            `encryption-middleware: failed to decrypt ${model}.${field} (${version}) ` +
                `with an available tenant DEK — wrong key, corrupt row, or a write made ` +
                `under a mismatched tenant context`,
        );
        this.name = 'DecryptIntegrityError';
    }
}

function onDecryptFailure(
    err: unknown,
    ciphertext: string,
    modelName: string,
    field: string,
): string | null {
    const version = getCiphertextVersion(ciphertext);
    const byDesign = err instanceof NoTenantDekError && err.dekReason === 'by-design';
    const outcome =
        err instanceof NoTenantDekError
            ? err.dekReason === 'by-design'
                ? ('no_dek_by_design' as const)
                : ('dek_resolve_failed' as const)
            : ('decrypt_failed' as const);

    logger.warn('encryption-middleware.decrypt_failed', {
        component: 'encryption-middleware',
        model: modelName,
        field,
        version,
        outcome,
        reason: err instanceof Error ? err.message : 'unknown',
    });
    recordFieldDecryptFailure({
        model: modelName,
        field,
        version: version ?? 'unknown',
        outcome,
    });

    if (byDesign) return null;

    // A DEK resolved and AES-GCM still rejected the value: wrong key, corrupt
    // row, or a write made under a mismatched tenant context. There is no safe
    // continuation — either the ciphertext reaches an unknown consumer or the
    // request stops. For a product whose rows land in audit packs and PDF
    // exports, stopping is correct AND recoverable (fix the row); silent
    // ciphertext contaminates exports indefinitely and nobody learns.
    //
    // `dek_resolve_failed` is deliberately NOT included. There a tenantId WAS
    // present and the lookup threw — a transient DB blip, a tenant with no
    // encryptedDek row. Failing the page over infrastructure flap is its own
    // outage, and unlike the by-design case there is a legitimate reader
    // waiting, so it keeps passing the ciphertext through and stays visible
    // through its own `outcome` label.
    if (outcome === 'decrypt_failed' && env.ENCRYPTION_DECRYPT_FAIL_CLOSED !== '0') {
        throw new DecryptIntegrityError(modelName, field, version ?? 'unknown');
    }
    return ciphertext;
}


/**
 * Catch a write that is about to be encrypted under the wrong tenant's DEK.
 *
 * The middleware picks its key from the AMBIENT tenant context and never looks
 * at the row. So `create({ data: { tenantId: B, description } })` executed
 * while the context says A encrypts B's row with A's key, succeeds, and
 * corrupts silently. The failure appears later, on an unrelated read, as
 * `DecryptIntegrityError` — which can name the unreadable row but not the
 * write that produced it. This is the only point where both halves are still
 * in scope, so it is the only place the question is answerable.
 *
 * Observation-only, deliberately: the same posture the read path took for
 * `decrypt_failed`. Several legitimate-looking cross-tenant writers exist
 * today (cross-tenant job sweeps, the public share path); throwing before they
 * are understood would trade a silent corruption for a loud outage. Count
 * first, find the callers, then decide.
 *
 * `tenantId` is read only when it is a plain string — a Prisma filter object
 * (`{ in: [...] }`) is an updateMany predicate, not a row's identity, and
 * comparing against it would be noise.
 */
function checkWriteTenantContext(
    data: unknown,
    model: string,
    operation: string,
): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const row = data as Record<string, unknown>;
    const rowTenantId = row.tenantId;
    if (typeof rowTenantId !== 'string' || rowTenantId.length === 0) return;

    // Only payloads that will ACTUALLY be encrypted are interesting. Tenant
    // bootstrap writes `TenantMembership` and `TenantOnboarding` rows before
    // any context exists — correct, and encrypting nothing, so reporting them
    // buries the real signal under a constant stream. Mirror the write walk's
    // own rule: a model in the manifest, or any payload key that is an
    // encrypted field name under the `*` wildcard.
    const encryptsSomething =
        isEncryptedModel(model)
            ? Object.keys(row).some((k) => getEncryptedFields(model)?.includes(k))
            : Object.keys(row).some((k) => ALL_ENCRYPTED_FIELD_NAMES.has(k));
    if (!encryptsSomething) return;

    const ambient = getAuditContext()?.tenantId;

    if (!ambient) {
        // The row names a tenant; the writer established no context. The value
        // encrypts under the global KEK, so it stays readable — but it is
        // outside per-tenant key isolation and a tenant-DEK rotation will skip
        // it.
        logger.warn('encryption-middleware.write_unscoped', {
            component: 'encryption-middleware',
            model,
            operation,
            rowTenantId,
        });
        recordTenantContextMismatch({ model, operation, outcome: 'unscoped' });
        return;
    }

    if (ambient !== rowTenantId) {
        // The corruption case. Log BOTH ids — the read-side error has neither.
        logger.error('encryption-middleware.write_tenant_mismatch', {
            component: 'encryption-middleware',
            model,
            operation,
            ambientTenantId: ambient,
            rowTenantId,
        });
        recordTenantContextMismatch({ model, operation, outcome: 'mismatch' });
    }
}

function decryptResultNode(
    node: Record<string, unknown>,
    modelName: string,
    deks: TenantDekPair,
): void {
    const fields = getEncryptedFields(modelName);
    if (!fields) return;
    for (const field of fields) {
        const value = node[field];
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string') continue;
        if (value.length === 0) continue;
        if (!isEncryptedValue(value)) continue;
        try {
            node[field] = decryptValue(value, deks);
        } catch (err) {
            node[field] = onDecryptFailure(err, value, modelName, field);
        }
    }
}

function decryptResultNodeAllModels(
    node: Record<string, unknown>,
    deks: TenantDekPair,
): void {
    for (const key of Object.keys(node)) {
        if (!ALL_ENCRYPTED_FIELD_NAMES.has(key)) continue;
        const value = node[key];
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string') continue;
        if (value.length === 0) continue;
        if (!isEncryptedValue(value)) continue;
        try {
            node[key] = decryptValue(value, deks);
        } catch (err) {
            node[key] = onDecryptFailure(err, value, '*', key);
        }
    }
}

/**
 * Walk a Prisma result tree and decrypt every manifest field we
 * find. Handles single objects, arrays, and included relations.
 *
 * Accepts `null` as a shorthand for "no DEKs available" — same
 * semantics as `{ primary: null, previous: null }` (callers that
 * passed plain `null` before the dual-DEK refactor still work).
 */
function walkReadResult(
    result: unknown,
    modelName: string,
    deks: TenantDekPair | null,
): void {
    const pair = deks ?? NO_DEK_PAIR;
    if (result === null || result === undefined) return;
    if (Array.isArray(result)) {
        for (const item of result) walkReadResult(item, modelName, pair);
        return;
    }
    if (typeof result !== 'object') return;

    const node = result as Record<string, unknown>;

    if (modelName === '*') {
        // Fast path: if the node has zero keys matching ANY manifest
        // field name, we can skip the per-key iteration AND the per-
        // field type/prefix checks.
        if (nodeHasAnyEncryptedFieldKey(node)) {
            decryptResultNodeAllModels(node, pair);
        }
    } else {
        decryptResultNode(node, modelName, pair);
    }

    // Walk nested object / array values — might be included relations.
    for (const [key, value] of Object.entries(node)) {
        if (value === null || value === undefined) continue;
        if (typeof value !== 'object') continue;
        if (
            modelName !== '*' &&
            getEncryptedFields(modelName)?.includes(key)
        ) {
            continue;
        }
        walkReadResult(value, '*', pair);
    }
}

// ─── Middleware registration ─────────────────────────────────────────

/**
 * @deprecated v5 mutating shape — Prisma 7 removed `$use`. Use
 * `withEncryptionExtension(client)` instead, which returns a new
 * extended client. This stub remains so existing test files that
 * import the legacy name continue to compile.
 *
 * Production wiring is in `runInTenantContext` (per-transaction);
 * tests that called this on the singleton to test direct prisma
 * calls need to migrate to `withEncryptionExtension` and rebind
 * their `prisma` reference. FIXME — remove once migrated.
 */
export function registerEncryptionMiddleware(_client: unknown): void {
    /* no-op — see docstring */
}

/**
 * Wire the field-level encryption extension onto a Prisma 7 client.
 *
 * Prisma 7 removed `$use`; the same per-action logic now ships as
 * a `$extends({ query })` extension. The handler shape changed from
 * `(params, next)` to `({ model, operation, args, query })`; we
 * adapt the call site and otherwise preserve the encrypt-on-write /
 * decrypt-on-read body byte-for-byte.
 *
 * Idempotency: the original `$use` form had a module-level
 * `installed` flag to prevent double-registration. Extensions don't
 * mutate the client; calling this twice would just produce two
 * stacked extensions. Callers (today: `runInTenantContext` in
 * `rls-middleware.ts`) wire it exactly once on the inner
 * transactional client.
 */
export function withEncryptionExtension<T extends object>(
    client: T,
): T {
    return (client as { $extends: (cfg: unknown) => unknown }).$extends({
        name: 'field-encryption',
        query: {
            $allModels: {
                async $allOperations({
                    model,
                    operation,
                    args,
                    query,
                }: {
                    model: string;
                    operation: string;
                    args: { data?: unknown; create?: unknown; update?: unknown };
                    query: (a: unknown) => Promise<unknown>;
                }) {
                    const isWrite = WRITE_ACTIONS.has(operation);
                    const isRead = RESULT_DECRYPT_ACTIONS.has(operation);

                    // Pre-resolve the DEK pair once for the whole
                    // operation. Cache hit after the first lookup per
                    // tenant in this process for the primary; the
                    // previous slot is null in steady state and only
                    // populated during an in-flight rotation.
                    const deks: TenantDekPair =
                        isWrite || isRead
                            ? await resolveTenantDekPair(model)
                            : NO_DEK_PAIR;

                    // ── Write path ──
                    if (isWrite) {
                        const targetModel = isEncryptedModel(model)
                            ? model
                            : '*';

                        // Writes always use the primary DEK (or fall
                        // back to global KEK when null). The previous
                        // slot is irrelevant for writes — it exists
                        // solely so reads of stale rows can find
                        // their key during a rotation.
                        if (args?.data) {
                            checkWriteTenantContext(args.data, model, operation);
                            walkWriteArgument(
                                args.data,
                                targetModel,
                                deks.primary,
                            );
                        }
                        if (operation === 'upsert') {
                            if (args?.create) {
                                walkWriteArgument(
                                    args.create,
                                    targetModel,
                                    deks.primary,
                                );
                            }
                            if (args?.update) {
                                walkWriteArgument(
                                    args.update,
                                    targetModel,
                                    deks.primary,
                                );
                            }
                        }
                    }

                    const result = await query(args);

                    // ── Read / result-decrypt path ──
                    if (isRead) {
                        const targetModel = isEncryptedModel(model)
                            ? model
                            : '*';
                        walkReadResult(result, targetModel, deks);
                    }

                    return result;
                },
            },
        },
    }) as T;
}

// ─── Test-only helpers ───────────────────────────────────────────────

/**
 * @internal — kept as a no-op so the existing v5 test suite calls
 * still compile. Prisma 7 extensions are stateless re: registration
 * (no `installed` guard), so there's nothing to reset.
 */
export function _resetEncryptionMiddlewareForTests(): void {
    /* no-op — see docstring */
}

/** @internal — exposed for direct unit-testing of the traversal logic. */
export const _internals = {
    checkWriteTenantContext,
    walkWriteArgument,
    walkReadResult,
    encryptDataNode,
    decryptResultNode,
    resolveTenantDekPair,
};
