/**
 * THE TENANT'S OWN A2A SIGNING KEY (#3679; owner decision 2026-10-19).
 *
 * Every task a tenant sends an A2A peer, and every answer it gives one, is
 * signed with that tenant's Ed25519 key. This module is the ONLY reader and
 * writer of `TenantA2aSigningKey` (`tests/guards/agent-harness-single-write-seam.test.ts`).
 *
 * ## Custody
 *
 * The seed is stored encrypted under the tenant's DEK by the Epic B manifest
 * (`ENCRYPTED_FIELDS.TenantA2aSigningKey`), so the tenant-DEK rotation, the
 * master-KEK rotation and a tenant's crypto-erasure all cover it with no code
 * of their own. It is decrypted only in `resolveTenantA2aSigningKey`, to sign,
 * and leaves this module only as a `KeyObject`. No response, audit row or log
 * line carries it.
 *
 * ## Who may change it
 *
 * Generating and rotating are `admin.tenant_lifecycle` — OWNER only, the key
 * that rotates the tenant's DEK — and refused to an API key. A signing key
 * speaks for the whole tenant to another organisation, so replacing it is the
 * same tier of act as replacing the tenant's encryption key, and above the
 * agent register key, which ADMIN and AI_ADMIN hold. READING the public half is
 * `admin.agent_registry`, because the person who hands a peer its credential
 * must also hand it the key the answers will be signed with.
 *
 * ## Rotation keeps the previous public key
 *
 * Retire-then-create, in one transaction: the key in force is stamped retired
 * and its seed NULLed (a CHECK holds "in force ⇔ seed present", a trigger makes
 * retirement final), and a fresh key takes its place. The retired row keeps its
 * public key and fingerprint, and every receipt names the fingerprint that
 * signed it, so a receipt signed before the rotation still verifies after it.
 */
import { a2aSigningKeyFromSeed, mintA2aSigningSeed, type A2aSigningKey } from '@/lib/agentic/a2a/signing-key';
import { runInTenantContext } from '@/lib/db-context';
import { conflict, forbidden, internal } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { logEvent } from '../events/audit';
import type { RequestContext } from '../types';

/** A key a tenant can sign with now, with its id. */
export interface TenantA2aSigningKeyInForce extends A2aSigningKey {
    readonly keyId: string;
}

const PUBLIC_SELECT = {
    id: true,
    publicKey: true,
    fingerprint: true,
    createdByUserId: true,
    createdAt: true,
    retiredAt: true,
    retiredByUserId: true,
} as const;

/** How many retired keys the read returns. A tenant rotates rarely. */
const RETIRED_KEYS_SHOWN = 20;

function assertMayRead(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Reading the A2A signing key requires admin.agent_registry');
    }
}

function assertMayRotate(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.tenant_lifecycle) {
        throw forbidden('Generating or rotating the A2A signing key requires admin.tenant_lifecycle');
    }
    if (ctx.apiKeyId) throw forbidden('The A2A signing key is generated and rotated by a person, not by an API key');
}

/**
 * The public half of the tenant's keys: the one in force (or `null` — A2A then
 * refuses both ways) and the retired ones, newest first.
 */
export async function getTenantA2aSigningKeys(ctx: RequestContext) {
    assertMayRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const current = await db.tenantA2aSigningKey.findFirst({
            where: { tenantId: ctx.tenantId, retiredAt: null },
            select: PUBLIC_SELECT,
        });
        const retired = await db.tenantA2aSigningKey.findMany({
            where: { tenantId: ctx.tenantId, retiredAt: { not: null } },
            orderBy: { retiredAt: 'desc' },
            take: RETIRED_KEYS_SHOWN,
            select: PUBLIC_SELECT,
        });
        return { current, retired, canRotate: Boolean(ctx.appPermissions.admin.tenant_lifecycle) };
    });
}

/**
 * Generate the tenant's first key, or rotate to a fresh one. Audited either
 * way; the audit row carries fingerprints, never key material.
 */
export async function rotateTenantA2aSigningKey(ctx: RequestContext) {
    assertMayRotate(ctx);
    const seed = mintA2aSigningSeed();
    const key = a2aSigningKeyFromSeed(seed);
    if (!key) throw internal('A freshly minted A2A signing seed did not build a key');

    return runInTenantContext(ctx, async (db) => {
        const previous = await db.tenantA2aSigningKey.findFirst({
            where: { tenantId: ctx.tenantId, retiredAt: null },
            select: { id: true, fingerprint: true },
        });
        if (previous) {
            // A claim, not a blind write: of two rotations racing, one retires
            // the key and the other is told so, rather than tripping the
            // "retired stays retired" trigger as a 500.
            const claimed = await db.tenantA2aSigningKey.updateMany({
                where: { id: previous.id, tenantId: ctx.tenantId, retiredAt: null },
                data: { retiredAt: new Date(), retiredByUserId: ctx.userId, privateKeySeed: null },
            });
            if (claimed.count !== 1) throw conflict('The signing key was rotated by somebody else first');
        }
        const created = await db.tenantA2aSigningKey.create({
            data: {
                tenantId: ctx.tenantId,
                publicKey: key.publicKeyHex,
                fingerprint: key.fingerprint,
                privateKeySeed: seed,
                createdByUserId: ctx.userId,
            },
            select: PUBLIC_SELECT,
        });
        await logEvent(db, ctx, {
            action: previous ? 'TENANT_A2A_SIGNING_KEY_ROTATED' : 'TENANT_A2A_SIGNING_KEY_GENERATED',
            entityType: 'TenantA2aSigningKey',
            entityId: created.id,
            details: previous
                ? `Rotated the tenant's A2A signing key to ${created.fingerprint}`
                : `Generated the tenant's A2A signing key ${created.fingerprint}`,
            detailsJson: {
                category: 'access',
                entityName: 'TenantA2aSigningKey',
                operation: previous ? 'rotated' : 'created',
                ...(previous ? { before: { keyId: previous.id, fingerprint: previous.fingerprint } } : {}),
                after: { keyId: created.id, fingerprint: created.fingerprint },
            },
        });
        return { current: created, retiredKeyId: previous?.id ?? null };
    });
}

/**
 * The key this tenant signs with now, or `null`, which every A2A path treats
 * as `NO_SIGNING_KEY`. Called under a system context by the inbound endpoint
 * and the dispatch pass; it decrypts the seed and nothing outside this call
 * ever holds it.
 */
export async function resolveTenantA2aSigningKey(ctx: RequestContext): Promise<TenantA2aSigningKeyInForce | null> {
    const row = await runInTenantContext(ctx, (db) =>
        db.tenantA2aSigningKey.findFirst({
            where: { tenantId: ctx.tenantId, retiredAt: null },
            select: { id: true, fingerprint: true, privateKeySeed: true },
        }),
    );
    if (!row?.privateKeySeed) return null;
    const key = a2aSigningKeyFromSeed(row.privateKeySeed);
    if (!key || key.fingerprint !== row.fingerprint) {
        // A seed that does not rebuild the key it was stored with is corrupt or
        // was not decrypted. Refuse rather than sign with something else.
        logger.error('a2a signing key could not be rebuilt from its stored seed', {
            component: 'a2a-signing-key',
            tenantId: ctx.tenantId,
            keyId: row.id,
        });
        return null;
    }
    return { ...key, keyId: row.id };
}

/**
 * Public keys this tenant has held, by fingerprint — the in-force key and every
 * retired one. What a stored OUTBOUND receipt is re-verified against.
 */
export async function tenantA2aPublicKeysByFingerprint(
    ctx: RequestContext,
    fingerprints: readonly string[],
): Promise<Map<string, string>> {
    if (fingerprints.length === 0) return new Map();
    const rows = await runInTenantContext(ctx, (db) =>
        db.tenantA2aSigningKey.findMany({
            where: { tenantId: ctx.tenantId, fingerprint: { in: [...new Set(fingerprints)] } },
            select: { fingerprint: true, publicKey: true },
            take: 200,
        }),
    );
    return new Map(rows.map((r) => [r.fingerprint, r.publicKey]));
}

/**
 * The keys the tenant's published agent card names (#3742): the most recently
 * retired one, with when it was retired. The card decides whether that is
 * still within its grace period; this only reads. The key in force comes from
 * `resolveTenantA2aSigningKey`, because the card is signed with it.
 */
export async function lastRetiredTenantA2aKey(ctx: RequestContext) {
    const row = await runInTenantContext(ctx, (db) =>
        db.tenantA2aSigningKey.findFirst({
            where: { tenantId: ctx.tenantId, retiredAt: { not: null } },
            orderBy: { retiredAt: 'desc' },
            select: { publicKey: true, fingerprint: true, retiredAt: true },
        }),
    );
    if (!row?.retiredAt) return null;
    return { publicKeyHex: row.publicKey, fingerprint: row.fingerprint, retiredAt: row.retiredAt };
}

/** The in-force public key only — what a peer is handed. `null` when none. */
export async function currentTenantA2aPublicKey(ctx: RequestContext) {
    return runInTenantContext(ctx, (db) =>
        db.tenantA2aSigningKey.findFirst({
            where: { tenantId: ctx.tenantId, retiredAt: null },
            select: { publicKey: true, fingerprint: true },
        }),
    );
}
