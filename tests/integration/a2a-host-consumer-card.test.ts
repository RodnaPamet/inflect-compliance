/**
 * THE HOST-CONSUMER AGENT CARD, end to end through both routes (#3862).
 *
 * The assertions that matter here are the NEGATIVE ones, because this card is
 * public and unauthenticated:
 *
 *  - two tenants with DIFFERENT grants serve the SAME skills. That is the owner
 *    decision on #3862 made testable: the card advertises the workflows that
 *    carry reviewed public copy, never `HostConsumer.workflowKeys`, so it
 *    cannot leak one consumer's grant to another or to a passer-by.
 *  - the PEER card is byte-identical whether or not host consumers are enabled.
 *    The roadmap's words are "the card stops being empty for host consumers
 *    only — what a peer sees does not change", and the interesting case is a
 *    tenant that HAS host consumers, not one that hasn't.
 *  - the two well-known paths serve byte-identical documents, because they are
 *    two thin handlers around one usecase and that is the pair that drifts.
 *  - a disabled tenant and an unknown tenant are indistinguishable.
 */
import crypto from 'node:crypto';

import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';

// `env` is validated once at import, so setting `process.env` in a hook comes
// too late — the shape the repo uses for this is a Proxy over the real module
// (see `a2a-host-consumer-admission.test.ts`, which this follows).
const envOverride: { flag: string | undefined; appUrl: string | undefined } = {
    flag: '1',
    appUrl: 'https://app.inflect.test',
};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env');
    return {
        ...actual,
        env: new Proxy(actual.env as Record<string, unknown>, {
            get: (target, prop) => {
                if (prop === 'A2A_HOST_CONSUMERS') return envOverride.flag;
                if (prop === 'APP_URL') return envOverride.appUrl;
                return Reflect.get(target, prop);
            },
        }),
    };
});

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { generateHostConsumerCredentials } from '@/lib/agentic/a2a/host-consumer';
import { rotateTenantA2aSigningKey } from '@/app-layer/usecases/a2a-signing-key';
import { getTenantA2aAgentCard, getTenantA2aHostConsumerCard } from '@/app-layer/usecases/a2a-agent-card';
import { advertisedA2aSkills } from '@/lib/agentic/a2a/host-card-skills';
import { GET as GET_AGENT_JSON } from '@/app/api/a2a/[tenantSlug]/.well-known/agent.json/route';
import { GET as GET_AGENT_CARD_JSON } from '@/app/api/a2a/[tenantSlug]/.well-known/agent-card.json/route';

const prisma: PrismaClient = prismaTestClient();

/** Grants deliberately DIFFER, which is the point of the comparison. */
const GRANTED: Record<string, string[]> = {
    hcard1: ['posture-review'],
    hcard2: ['audit-narrative', 'sap-transaction-review'],
    hcard3: ['posture-review'],
};
const TENANTS = Object.keys(GRANTED);
/** `hcard3` has host consumers switched OFF. */
const ENABLED: Record<string, boolean> = { hcard1: true, hcard2: true, hcard3: false };

const world: Record<string, { ownerUserId: string; agentId: string; toolishAgentName: string }> = {};

const ownerCtx = (t: string) =>
    makeRequestContext('OWNER', { tenantId: t, tenantSlug: t, userId: world[t].ownerUserId });

async function seed(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: `Tenant ${tenantId}`, slug: tenantId } });
    const user = await prisma.user.create({
        data: { email: `owner@${tenantId}.test`, name: 'Owner', passwordHash: 'x' },
    });
    const sys = await prisma.aiSystem.create({ data: { tenantId, name: `sys-${tenantId}` } });
    // A distinctive agent name, so the R19 scan has something real to look for
    // rather than a string that would never appear anyway.
    const agentName = `receiver-${tenantId}-zzq`;
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: agentName,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: user.id,
        },
    });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
    });
    await prisma.tenantSecuritySettings.create({
        data: { tenantId, a2aHostConsumersEnabled: ENABLED[tenantId] },
    });
    const creds = generateHostConsumerCredentials();
    await prisma.hostConsumer.create({
        data: {
            tenantId,
            name: `Joule ${tenantId}`,
            clientId: creds.clientId,
            clientSecretHash: creds.secretHash,
            clientSecretPrefix: creds.secretPrefix,
            receivingAgentId: agent.id,
            workflowKeys: GRANTED[tenantId],
            ownerUserId: user.id,
            createdByUserId: user.id,
        },
    });
    world[tenantId] = { ownerUserId: user.id, agentId: agent.id, toolishAgentName: agentName };
}

beforeAll(async () => {
    // FIRST, and before any parent delete: `rotateTenantA2aSigningKey` writes
    // `AuditLog` rows, and `AuditLog_tenantId_fkey` is ON DELETE RESTRICT — so
    // the tenant delete below would fail, or silently leak a Tenant row, with
    // rows this suite's PREVIOUS run left behind. Held by
    // `tests/guards/integration-suite-audit-teardown.test.ts`, which caught
    // exactly this omission here.
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await resetDatabase(prisma);
    // `User` and `Tenant` deliberately SURVIVE a reset (see `RESET_TABLES`), so
    // a re-run of this file collides on the user's unique email unless its own
    // fixtures are cleared by hand. This is the #3801 class.
    await prisma.user.deleteMany({ where: { email: { in: TENANTS.map((t) => `owner@${t}.test`) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    for (const t of TENANTS) {
        await seed(t);
        await rotateTenantA2aSigningKey(ownerCtx(t));
    }
}, 120_000);

afterAll(async () => {
    await prisma.$disconnect();
});

const req = (slug: string, file: string) =>
    new NextRequest(`https://app.inflect.test/api/a2a/${slug}/.well-known/${file}`, { method: 'GET' });
const params = (slug: string) => ({ params: Promise.resolve({ tenantSlug: slug }) });

async function body(res: Response): Promise<string> {
    return await res.text();
}

describe('both well-known paths serve the host-consumer card', () => {
    it('answers 200 at agent.json — the filename SAP’s toolkit composes', async () => {
        const res = await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1'));
        expect(res.status).toBe(200);
        expect(JSON.parse(await body(res))['protocolVersion']).toBe('0.3.0');
    });

    it('answers 200 at agent-card.json — the v0.3/v1.0 filename', async () => {
        const res = await GET_AGENT_CARD_JSON(req('hcard1', 'agent-card.json'), params('hcard1'));
        expect(res.status).toBe(200);
    });

    it('serves BYTE-IDENTICAL documents at the two paths', async () => {
        const a = await body(await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1')));
        const b = await body(await GET_AGENT_CARD_JSON(req('hcard1', 'agent-card.json'), params('hcard1')));
        expect(a).toBe(b);
        // And the signature covers it, so identical bytes is identical card.
        expect(JSON.parse(a)['x-inflect-signature']).toEqual(JSON.parse(b)['x-inflect-signature']);
    });

    it('advertises the OAuth2 client-credentials flow pointing at the token endpoint', async () => {
        const card = JSON.parse(await body(await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1'))));
        expect(card['securitySchemes']['hostConsumerOAuth2']['flows']['clientCredentials']['tokenUrl']).toBe(
            'https://app.inflect.test/api/a2a/hcard1/token',
        );
    });
});

describe('the card does not depend on the caller’s grant', () => {
    it('serves the SAME skills to two tenants whose consumers are granted different workflows', async () => {
        // The denominator first: the grants really do differ, or this proves
        // nothing. A test that compared two identical configurations would pass
        // for the wrong reason.
        expect(GRANTED['hcard1']).not.toEqual(GRANTED['hcard2']);

        const one = JSON.parse(await body(await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1'))));
        const two = JSON.parse(await body(await GET_AGENT_JSON(req('hcard2', 'agent.json'), params('hcard2'))));
        expect(one['skills']).toEqual(two['skills']);
    });

    it('advertises a workflow NEITHER tenant’s consumer is granted, if it carries public copy', async () => {
        // `hcard1` is granted only `posture-review`, yet the card lists
        // `audit-narrative` too. That is the design, and it is what makes
        // WORKFLOW_NOT_ALLOWED an expected answer rather than a bug.
        const card = JSON.parse(await body(await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1'))));
        const ids = (card['skills'] as Array<{ id: string }>).map((s) => s.id);
        expect(ids).toContain('audit-narrative');
        expect(GRANTED['hcard1']).not.toContain('audit-narrative');
    });

    it('lists exactly the advertisable registry set', async () => {
        const card = JSON.parse(await body(await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1'))));
        expect(card['skills']).toEqual(JSON.parse(JSON.stringify(advertisedA2aSkills())));
    });
});

describe('the peer card is untouched', () => {
    it('is byte-identical for a tenant WITH host consumers and one without', async () => {
        // The strong form. Comparing a host-consumer tenant against a disabled
        // one is the case that could regress; comparing two disabled tenants
        // would pass however the host variant were built.
        const withHost = await getTenantA2aAgentCard({ tenantSlug: 'hcard1', requestId: crypto.randomUUID() });
        const without = await getTenantA2aAgentCard({ tenantSlug: 'hcard3', requestId: crypto.randomUUID() });
        expect(withHost).not.toBeNull();
        expect(without).not.toBeNull();
        // Keys and slug differ by tenant; everything that describes the SHAPE
        // must not.
        expect(withHost!.skills).toEqual([]);
        expect(without!.skills).toEqual([]);
        expect(Object.keys(withHost!).sort()).toEqual(Object.keys(without!).sort());
        expect(withHost!.securitySchemes).toEqual(without!.securitySchemes);
        expect(withHost!.security).toEqual(without!.security);
        expect(withHost!.description).toEqual(without!.description);
    });

    it('still has no skills even though the tenant has an enabled host consumer', async () => {
        const peer = await getTenantA2aAgentCard({ tenantSlug: 'hcard1', requestId: crypto.randomUUID() });
        expect(peer!.skills).toEqual([]);
        expect(JSON.stringify(peer)).not.toContain('posture-review');
    });
});

describe('one 404 for every reason there is no card', () => {
    const notFound = async (res: Response) => ({ status: res.status, body: await res.text() });

    it('404s for a tenant with host consumers DISABLED', async () => {
        const res = await GET_AGENT_JSON(req('hcard3', 'agent.json'), params('hcard3'));
        expect(res.status).toBe(404);
    });

    it('is indistinguishable from an unknown tenant', async () => {
        const disabled = await notFound(await GET_AGENT_JSON(req('hcard3', 'agent.json'), params('hcard3')));
        const unknown = await notFound(await GET_AGENT_JSON(req('nope-xyz', 'agent.json'), params('nope-xyz')));
        expect(disabled).toEqual(unknown);
    });

    it('404s when the deployment flag is off, however the tenant is set', async () => {
        const before = envOverride.flag;
        envOverride.flag = undefined;
        try {
            const res = await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1'));
            expect(res.status).toBe(404);
        } finally {
            envOverride.flag = before;
        }
    });

    it('404s when the deployment has no public https origin', async () => {
        const before = envOverride.appUrl;
        envOverride.appUrl = 'http://not-https.local';
        try {
            const res = await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1'));
            expect(res.status).toBe(404);
        } finally {
            envOverride.appUrl = before;
        }
    });

    it('the enabled tenant still answers 200, so the 404s above are not a dead route', async () => {
        // Positive control for this whole block.
        const res = await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1'));
        expect(res.status).toBe(200);
    });
});

describe('R19 — the card discloses nothing of the tenant', () => {
    it('names no tenant name, no agent name and no tool name', async () => {
        const text = await body(await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1')));
        expect(text).not.toContain(world['hcard1'].toolishAgentName);
        expect(text).not.toContain('Tenant hcard1');
        expect(text).not.toContain('Joule hcard1');
        // Tool names are snake_case identifiers; none belongs on a public card.
        expect(text).not.toMatch(/get_compliance_posture|list_audit_workpapers|list_evidence_expiring/);
    });

    it('carries the slug, which is already in the URL the host was given', async () => {
        const text = await body(await GET_AGENT_JSON(req('hcard1', 'agent.json'), params('hcard1')));
        // Asserted so the test above is understood as "no NAMES", not "no
        // tenant-derived string at all" — the slug is deliberately present.
        expect(text).toContain('hcard1');
    });
});
