/**
 * The keys that may AUTHORISE a probe engagement (active flavour, step 8a) —
 * the ONLY writer of `ProbeApproverKey`.
 *
 * An engagement scope (`scanent-engagement-scope/1`) is signed by an approver
 * key the estate holds, never by the prober. Inflect accepts a probe report
 * only when its `engagement.scopeSignerFingerprint` is a LIVE key here (owner
 * decision, 2026-11-25): who may authorise probing this tenant's agents is the
 * tenant owner's decision, so every verb takes `admin.tenant_lifecycle`, and a
 * credential, an agent or a job is refused outright — a key is registered by a
 * person in person.
 *
 * A key belongs to no agent: a person approves, never a prober. A key live in
 * the prober register is refused here, and the reverse
 * (`probe_key_registers_disjoint()`). A revoked key authorises nothing from
 * then on — a report arriving after the revocation is refused, whenever its
 * run began — and its row stays, because the runs it authorised name it.
 */
import { z } from 'zod';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';
import { isProbeKeyOverlapDbRefusal } from './agent-prober-keys';
import type { ApproverKeysView } from '@/lib/agentic/probe-run-read-model';

/** How many approver keys the card lists. */
const APPROVER_KEY_CARD_CAP = 200;

export const AddProbeApproverKeySchema = z
    .object({
        label: z.string().trim().min(1).max(120),
        publicKey: z.string().min(1).max(256),
    })
    .strict();

const IN_PROBER_REGISTER_MESSAGE =
    'This key is registered as a prober key: the party that runs probes never authorises them';

function assertMayManageApprovers(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.tenant_lifecycle) {
        throw forbidden('Managing probe approver keys requires admin.tenant_lifecycle');
    }
}

/** Writes are a person's, in person: never a key, an agent or a job. */
function assertPerson(ctx: RequestContext): void {
    if (ctx.apiKeyId || ctx.agentId || (ctx.actorType !== undefined && ctx.actorType !== 'USER')) {
        throw forbidden('A probe approver key is registered or revoked by a person, not a credential');
    }
}

export async function addProbeApproverKey(ctx: RequestContext, input: z.infer<typeof AddProbeApproverKeySchema>) {
    assertMayManageApprovers(ctx);
    assertPerson(ctx);
    const fingerprint = harnessKeyFingerprint(input.publicKey);
    if (!fingerprint) throw badRequest('publicKey is not an Ed25519 public key (raw 32 bytes, hex or base64)');
    const label = sanitizePlainText(input.label).trim();
    if (label.length === 0) throw badRequest('label is required');

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.probeApproverKey.findFirst({
            where: { tenantId: ctx.tenantId, keyFingerprint: fingerprint },
            select: { id: true },
        });
        if (existing) throw conflict('This key is already registered as a probe approver key for this tenant');
        const prober = await db.agentProberKey.findFirst({
            where: { tenantId: ctx.tenantId, keyFingerprint: fingerprint, revokedAt: null },
            select: { id: true },
        });
        if (prober) throw conflict(IN_PROBER_REGISTER_MESSAGE);

        let key;
        try {
            key = await db.probeApproverKey.create({
                data: {
                    tenantId: ctx.tenantId,
                    label,
                    publicKey: input.publicKey.trim(),
                    keyFingerprint: fingerprint,
                    createdByUserId: ctx.userId,
                },
                select: { id: true, label: true, keyFingerprint: true, createdAt: true },
            });
        } catch (err) {
            if (isProbeKeyOverlapDbRefusal(err)) throw conflict(IN_PROBER_REGISTER_MESSAGE);
            throw err;
        }
        await logEvent(db, ctx, {
            action: 'PROBE_APPROVER_KEY_ADDED',
            entityType: 'ProbeApproverKey',
            entityId: key.id,
            details: `Registered a probe approver key ${key.keyFingerprint.slice(0, 16)}`,
            detailsJson: {
                category: 'access',
                entityName: 'ProbeApproverKey',
                operation: 'created',
                after: { keyFingerprint: key.keyFingerprint },
            },
        });
        return key;
    });
}

export async function listProbeApproverKeys(ctx: RequestContext) {
    assertMayManageApprovers(ctx);
    return runInTenantContext(ctx, (db) =>
        db.probeApproverKey.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: {
                id: true,
                label: true,
                keyFingerprint: true,
                createdByUserId: true,
                createdAt: true,
                revokedAt: true,
                revokedByUserId: true,
            },
        }),
    );
}

export async function revokeProbeApproverKey(ctx: RequestContext, input: { keyId: string }) {
    assertMayManageApprovers(ctx);
    assertPerson(ctx);
    return runInTenantContext(ctx, async (db) => {
        const revoked = await db.probeApproverKey.updateMany({
            where: { id: input.keyId, tenantId: ctx.tenantId, revokedAt: null },
            data: { revokedAt: new Date(), revokedByUserId: ctx.userId },
        });
        if (revoked.count === 0) throw notFound('Active probe approver key not found');
        await logEvent(db, ctx, {
            action: 'PROBE_APPROVER_KEY_REVOKED',
            entityType: 'ProbeApproverKey',
            entityId: input.keyId,
            details: `Revoked probe approver key ${input.keyId}`,
            detailsJson: { category: 'access', entityName: 'ProbeApproverKey', operation: 'revoked' },
        });
        return { id: input.keyId, revoked: true };
    });
}

/** The approver-key card's read (step 8b), OWNER-only as every verb here is. */
export async function getProbeApproverKeysView(ctx: RequestContext): Promise<ApproverKeysView> {
    assertMayManageApprovers(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.probeApproverKey.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: APPROVER_KEY_CARD_CAP + 1,
            select: { id: true, label: true, keyFingerprint: true, createdAt: true, revokedAt: true },
        });
        return {
            rows: rows.slice(0, APPROVER_KEY_CARD_CAP).map((k) => ({
                id: k.id,
                label: k.label,
                keyFingerprint: k.keyFingerprint,
                createdAt: k.createdAt.toISOString(),
                revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
            })),
            truncated: rows.length > APPROVER_KEY_CARD_CAP,
        };
    });
}
