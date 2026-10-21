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
import { env } from '@/env';
import { runInGlobalContext } from '@/lib/db/rls-middleware';
import { runInTenantContext } from '@/lib/db-context';
import { inflectA2aOrigin } from '@/lib/agentic/a2a/origin';
import { hostConsumersAdmitted } from '@/lib/agentic/a2a/host-consumer';
import { advertisedA2aSkills } from '@/lib/agentic/a2a/host-card-skills';
import {
    buildInflectAgentCard,
    buildInflectHostConsumerCard,
    inflectA2aIdentity,
    signInflectAgentCard,
    type InflectAgentCard,
    type InflectHostConsumerCard,
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
 * THE HOST-CONSUMER CARD (#3862), served at the two well-known paths.
 *
 * ## Which path serves which variant
 *
 * | Path | Variant |
 * | --- | --- |
 * | `/api/a2a/{slug}/agent-card.json` | PEER — unchanged, and it is the tenant's signed identity |
 * | `/api/a2a/{slug}/.well-known/agent.json` | HOST CONSUMER |
 * | `/api/a2a/{slug}/.well-known/agent-card.json` | HOST CONSUMER |
 *
 * The existing path keeps serving the peer card because that URL IS the
 * tenant's A2A identity — `inflectA2aIdentity`, the sender of every receipt it
 * signs and what peers pin. Changing what it serves would change the identity's
 * own document and every peer's pin with it. The well-known paths are new, so
 * they are free to carry the new variant, and they are where a host looks.
 *
 * ## One more reason for a 404 than the peer card has
 *
 * Everything that 404s the peer card 404s this one, plus: host consumers not
 * admitted, which is the deployment's `A2A_HOST_CONSUMERS` and the tenant's
 * `a2aHostConsumersEnabled` — both, via `hostConsumersAdmitted`, the single
 * spelling of that gate. A tenant that has not enabled host consumers is
 * indistinguishable from a tenant that does not exist, as it already is on the
 * token endpoint.
 *
 * The card is NOT per consumer and reads no `HostConsumer` row. See
 * `host-card-skills.ts` for why, and what still enforces the grant.
 */
export async function getTenantA2aHostConsumerCard(input: {
    tenantSlug: string;
    requestId: string;
    now?: Date;
}): Promise<InflectHostConsumerCard | null> {
    const origin = inflectA2aOrigin();
    if (!origin) return null;
    const tenant = await runInGlobalContext((db) =>
        db.tenant.findFirst({ where: { slug: input.tenantSlug, deletedAt: null }, select: { id: true, slug: true } }),
    );
    if (!tenant) return null;
    const sys = buildSystemContext({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        job: 'a2a-host-consumer-card',
        requestId: input.requestId,
        permissions: READ_ONLY,
    });
    const settings = await runInTenantContext(sys, (db) =>
        db.tenantSecuritySettings.findFirst({
            where: { tenantId: tenant.id },
            select: { a2aHostConsumersEnabled: true },
        }),
    );
    if (!hostConsumersAdmitted({ envValue: env.A2A_HOST_CONSUMERS, tenantEnabled: settings?.a2aHostConsumersEnabled })) {
        return null;
    }
    const key = await resolveTenantA2aSigningKey(sys);
    if (!key) return null;
    const previous = await lastRetiredTenantA2aKey(sys);
    const card = buildInflectHostConsumerCard({
        origin,
        tenantSlug: tenant.slug,
        current: { publicKeyHex: key.publicKeyHex, fingerprint: key.fingerprint },
        previous,
        now: input.now ?? new Date(),
        skills: advertisedA2aSkills(),
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
