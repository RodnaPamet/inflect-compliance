/**
 * THE TENANT'S PUBLISHED A2A AGENT CARD, and the identity it carries (#3742;
 * threat-model R19; owner decisions 2026-10-20).
 *
 * `GET /api/a2a/{tenantSlug}/agent-card.json` serves what `getTenantA2aAgentCard`
 * returns. The route is public by necessity: a peer fetches the card before it
 * holds any credential, to pin it. So the card names only what a peer could
 * already be handed out of band — the endpoint, the identity, the receipt
 * format and the public keys — and `own-card.ts` holds it to that member set.
 *
 * `null` means "serve a 404", and the four reasons are not told apart to the
 * caller: an unknown slug, a soft-deleted tenant, a tenant with no signing key,
 * and a deployment with no public https origin. Telling them apart would make
 * the route an oracle for which slugs exist and which tenants have set up A2A.
 *
 * `ownA2aIdentity` is what every A2A path signs as and expects to be addressed
 * as. It is built from the deployment's origin and the tenant's slug, and never
 * from a request.
 */
import { runInGlobalContext } from '@/lib/db/rls-middleware';
import { runInTenantContext } from '@/lib/db-context';
import { inflectA2aOrigin } from '@/lib/agentic/a2a/origin';
import {
    buildInflectAgentCard,
    inflectA2aIdentity,
    signInflectAgentCard,
    type InflectAgentCard,
} from '@/lib/agentic/a2a/own-card';

import { buildSystemContext } from '../context-system';
import type { RequestContext } from '../types';
import { lastRetiredTenantA2aKey, resolveTenantA2aSigningKey } from './a2a-signing-key';

/** The card reads two key rows and writes nothing, so its context can do no more. */
const READ_ONLY: RequestContext['permissions'] = {
    canRead: true,
    canWrite: false,
    canAdmin: false,
    canAudit: false,
    canExport: false,
};

export async function getTenantA2aAgentCard(input: {
    tenantSlug: string;
    requestId: string;
    now?: Date;
}): Promise<InflectAgentCard | null> {
    const origin = inflectA2aOrigin();
    if (!origin) return null;
    const tenant = await runInGlobalContext((db) =>
        db.tenant.findFirst({ where: { slug: input.tenantSlug, deletedAt: null }, select: { id: true, slug: true } }),
    );
    if (!tenant) return null;
    const sys = buildSystemContext({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        job: 'a2a-agent-card',
        requestId: input.requestId,
        permissions: READ_ONLY,
    });
    const key = await resolveTenantA2aSigningKey(sys);
    if (!key) return null;
    const previous = await lastRetiredTenantA2aKey(sys);
    const card = buildInflectAgentCard({
        origin,
        tenantSlug: tenant.slug,
        current: { publicKeyHex: key.publicKeyHex, fingerprint: key.fingerprint },
        previous,
        now: input.now ?? new Date(),
    });
    return signInflectAgentCard(card, key);
}

/**
 * The tenant's A2A identity — its card URL — or `null` when the deployment has
 * no public https origin, which every A2A path refuses as `NO_PUBLIC_ORIGIN`.
 * The slug comes from the context when it carries one, else from the tenant row.
 */
export async function ownA2aIdentity(ctx: RequestContext): Promise<string | null> {
    const origin = inflectA2aOrigin();
    if (!origin) return null;
    const slug =
        ctx.tenantSlug ??
        (await runInTenantContext(ctx, (db) =>
            db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { slug: true } }),
        ))?.slug;
    return slug ? inflectA2aIdentity(origin, slug) : null;
}
