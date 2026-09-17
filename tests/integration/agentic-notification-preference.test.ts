/**
 * THE MUTE REACHES THE EMITTER — #2564.
 *
 * `AGENT_KILL_SWITCH_ENGAGED` and `AGENT_PROPOSAL_QUARANTINED` shipped as bell
 * + SSE notifications with NO preference surface behind them. The one switch
 * that looked like it might govern them, `TenantNotificationSettings.enabled`,
 * is read only by email paths (`enqueue`, `digest-dispatcher`,
 * `retention-notifications`, `policyReviewReminder`, `action-executor`), so a
 * workspace that had switched notifications off still rang the agentic bell
 * and had no narrower control that would stop it.
 *
 * ## Why each block is shaped this way
 *
 * The property under test is "a muted type writes NO ROW", and the way to get
 * that wrong is to assert it somewhere the emitter was never reached. A test
 * that mutes a type and then counts zero notifications passes identically when
 * the kill switch threw, when the recipient list was empty, when the agent did
 * not resolve, and when nothing was ever wired up at all. Zero is the value
 * this suite would read if the whole subsystem were deleted.
 *
 * So every muted assertion is paired:
 *
 *   • **The audit row lands either way.** `engageKillSwitch` writes its
 *     `AGENT_KILL_ENGAGED` audit entry BEFORE the bell and outside its
 *     try/catch. Asserting it in the muted case proves the usecase ran to
 *     completion — that the zero is a suppressed notification and not a
 *     usecase that threw on the way in.
 *
 *   • **An unmuted type writes exactly one.** Same tenant shape, same seed,
 *     same call, mute list empty. Without it, "0" and "the emitter is
 *     unreachable" are the same observation.
 *
 *   • **Two tenants.** A mute in one workspace must not quiet another's bell.
 *     A guard that read the flag from the wrong row — or from no row, and
 *     failed closed — would pass both blocks above and fail only here.
 *
 * Each block seeds its OWN tenant and its own agent. The dedupe key is
 * `{tenantId}:{TYPE}:{entityId}:{userId}:{day}` and `engageKillSwitch` is
 * idempotent per (tenant, agent) while a switch stands, so sharing a tenant
 * across blocks would let one block's row decide the next block's count.
 *
 * THE ACTOR IS NEVER NOTIFIED, so every agent here is owned by a DIFFERENT
 * user than the one engaging the switch. An agent owned by the actor would
 * make the emitter return `created: 0` for a reason that has nothing to do
 * with the preference, and the muted block would pass without the guard.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { engageKillSwitch } from '@/app-layer/usecases/agent-kill-switch';
import { makeRequestContext } from '../helpers/make-context';
import type { RequestContext } from '@/app-layer/types';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `np-${randomUUID().slice(0, 8)}`;
const KILL_TYPE = 'AGENT_KILL_SWITCH_ENGAGED';
const tenants: string[] = [];

/**
 * A tenant with an OWNER (who will engage the switch) and an agent owned by a
 * SECOND user (who will be told about it).
 *
 * `muted` is written straight onto `TenantNotificationSettings` rather than
 * through the PUT, so this file tests the EMITTER's reading of the column and
 * not the route's writing of it — the route is covered in the rendered suite.
 */
async function seedTenant(
    tag: string,
    muted: string[],
): Promise<{ tenantId: string; actorUserId: string; recipientUserId: string; agentId: string }> {
    const tenantId = `${SUITE}-${tag}`;
    tenants.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });

    const actorUserId = `${tenantId}-actor`;
    const recipientUserId = `${tenantId}-owner`;
    for (const [userId, local] of [[actorUserId, 'actor'], [recipientUserId, 'owner']] as const) {
        const email = `${tenantId}-${local}@example.test`;
        await prisma.user.create({
            data: { id: userId, email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.create({
            data: { tenantId, userId, role: 'OWNER', status: 'ACTIVE' },
        });
    }

    await prisma.tenantNotificationSettings.create({
        data: {
            tenantId,
            // Deliberately TRUE in every fixture, including the muted one.
            // `enabled` is the email switch; if the new guard were accidentally
            // wired to it instead of to the mute list, every block here would
            // still see a bell and the suite would say so.
            enabled: true,
            defaultFromEmail: `noreply@${tenantId}.example.test`,
            mutedInAppTypes: muted as never,
        },
    });

    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId, name: `${tenantId} host`, ownerUserId: recipientUserId },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: aiSystem.id,
            name: `${tenantId} agent`,
            autonomyLevel: 4,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            // The accountable owner, and NOT the actor — see the file header.
            ownerUserId: recipientUserId,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    return { tenantId, actorUserId, recipientUserId, agentId: agent.id };
}

function actorCtx(tenantId: string, actorUserId: string): RequestContext {
    return makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: actorUserId });
}

/** Bell rows this tenant holds for the kill-switch type. */
function bellRows(tenantId: string) {
    return prisma.notification.count({ where: { tenantId, type: KILL_TYPE } });
}

/** The durable half: the audit entry the usecase writes before the bell. */
function auditRows(tenantId: string) {
    return prisma.auditLog.count({ where: { tenantId, action: 'AGENT_KILL_ENGAGED' } });
}

describeFn('agentic notification preferences reach the emitter (#2564)', () => {
    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, tenants);
        await prisma.notification.deleteMany({ where: { tenantId: { in: tenants } } });
        await prisma.agentKillSwitch.deleteMany({ where: { tenantId: { in: tenants } } });
        await prisma.registeredAgent.deleteMany({ where: { tenantId: { in: tenants } } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: { in: tenants } } });
        await prisma.tenantNotificationSettings.deleteMany({ where: { tenantId: { in: tenants } } });
        // `tenant_membership_last_owner_guard` raises P0001 on removing the
        // last ACTIVE OWNER, and every fixture here has exactly two. `SET
        // LOCAL` keeps the bypass inside this transaction so it cannot leak to
        // a parallel worker — same shape as digest-recipient-membership.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(
                `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
                tenants,
            );
        });
        await prisma.user.deleteMany({ where: { id: { startsWith: SUITE } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
        await prisma.$disconnect();
    });

    it('with AGENT_KILL_SWITCH_ENGAGED muted, engaging a kill switch writes zero Notification rows', async () => {
        const t = await seedTenant('muted', [KILL_TYPE]);

        await engageKillSwitch(actorCtx(t.tenantId, t.actorUserId), {
            agentId: t.agentId,
            reason: 'muted-type check',
        });

        expect(await bellRows(t.tenantId)).toBe(0);
        // The zero above is a SUPPRESSED notification, not a usecase that
        // never ran. Without this line the assertion passes on a throw.
        expect(await auditRows(t.tenantId)).toBe(1);
    });

    it('with the type unmuted, the same call writes exactly one row to the accountable owner', async () => {
        const t = await seedTenant('unmuted', []);

        await engageKillSwitch(actorCtx(t.tenantId, t.actorUserId), {
            agentId: t.agentId,
            reason: 'unmuted-type control',
        });

        expect(await bellRows(t.tenantId)).toBe(1);
        expect(await auditRows(t.tenantId)).toBe(1);

        // Named recipient, not just a count: a row addressed to the actor
        // would satisfy `toBe(1)` while breaking the emitter's own rule.
        const row = await prisma.notification.findFirstOrThrow({
            where: { tenantId: t.tenantId, type: KILL_TYPE },
            select: { userId: true },
        });
        expect(row.userId).toBe(t.recipientUserId);
    });

    it('muting in one tenant leaves another tenant\'s bell ringing', async () => {
        const quiet = await seedTenant('two-quiet', [KILL_TYPE]);
        const loud = await seedTenant('two-loud', []);

        for (const t of [quiet, loud]) {
            await engageKillSwitch(actorCtx(t.tenantId, t.actorUserId), {
                agentId: t.agentId,
                reason: 'two-tenant check',
            });
        }

        expect(await bellRows(quiet.tenantId)).toBe(0);
        expect(await bellRows(loud.tenantId)).toBe(1);
    });

    it('a tenant with no settings row at all is still notified', async () => {
        // Fails OPEN. A notification subsystem that goes quiet because a row is
        // missing is the failure nobody notices, and the type in question is a
        // stop control. This is the arm a `?? []` typo would break.
        const t = await seedTenant('no-row', []);
        await prisma.tenantNotificationSettings.deleteMany({ where: { tenantId: t.tenantId } });

        await engageKillSwitch(actorCtx(t.tenantId, t.actorUserId), {
            agentId: t.agentId,
            reason: 'absent-settings-row check',
        });

        expect(await bellRows(t.tenantId)).toBe(1);
    });
});
