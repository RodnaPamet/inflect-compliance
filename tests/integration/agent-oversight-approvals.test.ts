/**
 * The two second-person rules an owner sets (round 15), against a real
 * database:
 *
 *   - #4895: a request with a recorded composer is refused to that composer
 *     while `agentComposeNeedsSecondApprover` is on (the default), and allowed
 *     when an owner turns it off. Anybody else approves it either way.
 *   - #4900: an exact-value parameter edit is refused to its proposer while
 *     `agentExactParameterEditNeedsSecondApprover` is on, and allowed when it
 *     is off (the default, and the rule before this change).
 *
 *   - #4896–#4898: an Auditor reads the decision log, receipts and quarantine
 *     only while an owner has turned that surface's switch on, one switch per
 *     surface.
 *
 * Each refusal writes a hash-chained AUTHZ_DENIED row.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { approveAgentProposal, createAgentProposal } from '@/app-layer/usecases/agent-proposals';
import {
    approveParameterChange,
    proposeParameterChange,
    saveParameterSet,
} from '@/app-layer/usecases/external-tool-parameters';
import { setAgentOversightSettings } from '@/app-layer/usecases/agent-oversight-settings';
import { listAiDecisions } from '@/app-layer/usecases/ai-decision-log';
import { listReceipts } from '@/app-layer/usecases/agent-action-receipt';
import { listQuarantinedAgentProposals } from '@/app-layer/usecases/agent-proposals';
import { externalToolName } from '@/lib/mcp/external-tool-name';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = 'oversight-approvals';
const PEOPLE = ['composer', 'other'] as const;
type Person = (typeof PEOPLE)[number];
const TOOL = externalToolName('cmconnoversight', 'update_user');

const users: Partial<Record<Person, string>> = {};
const ctxFor = (who: Person) =>
    makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: users[who] as string });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: T };
    await prisma.externalToolParameterSetApproval.deleteMany({ where: t });
    await prisma.externalToolParameterSet.deleteMany({ where: t });
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.risk.deleteMany({ where: t });
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: PEOPLE.map((p) => hashForLookup(`${p}@${T}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: T } });
}

async function denials(reason: string): Promise<number> {
    const rows = await prisma.auditLog.findMany({
        where: { tenantId: T, action: 'AUTHZ_DENIED' },
        select: { detailsJson: true },
    });
    return rows.filter((r) => (r.detailsJson as { reason?: string } | null)?.reason === reason).length;
}

async function composedProposal(): Promise<string> {
    const p = await createAgentProposal(ctxFor('composer'), {
        kind: 'RISK',
        payload: { title: 'Access reviews are behind', description: 'Two weeks behind schedule.' },
        rationale: 'composed for the oversight test',
        policyCardVersion: NO_POLICY_CARD,
        composedByUserId: users.composer,
    });
    if (p.status !== 'PENDING') throw new Error(`fixture: expected PENDING, got ${p.status}`);
    return p.id;
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    for (const who of PEOPLE) {
        const email = `${who}@${T}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: T, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        users[who] = user.id;
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('a composed request (#4895)', () => {
    it('records who composed it', async () => {
        const id = await composedProposal();
        const row = await prisma.agentProposal.findUniqueOrThrow({ where: { id } });
        expect(row.composedByUserId).toBe(users.composer);
    });

    it('is refused to its composer by default, with an AUTHZ_DENIED row', async () => {
        const id = await composedProposal();
        const before = await denials('agent_proposal_composer');
        await expect(approveAgentProposal(ctxFor('composer'), id)).rejects.toMatchObject({
            status: 403,
            details: expect.objectContaining({ reason: 'COMPOSER_MAY_NOT_APPROVE' }),
        });
        expect(await denials('agent_proposal_composer')).toBe(before + 1);
        const row = await prisma.agentProposal.findUniqueOrThrow({ where: { id } });
        expect(row.status).toBe('PENDING');
    });

    it('is approved by somebody else', async () => {
        const id = await composedProposal();
        const outcome = await approveAgentProposal(ctxFor('other'), id);
        expect(outcome).toMatchObject({ status: 'ACCEPTED' });
    });

    it('may be approved by its composer once an owner turns the rule off', async () => {
        await setAgentOversightSettings(ctxFor('other'), { composeNeedsSecondApprover: false });
        try {
            const id = await composedProposal();
            const outcome = await approveAgentProposal(ctxFor('composer'), id);
            expect(outcome).toMatchObject({ status: 'ACCEPTED' });
        } finally {
            await setAgentOversightSettings(ctxFor('other'), { composeNeedsSecondApprover: true });
        }
    });
});

describe('an exact-value parameter edit (#4900)', () => {
    let seq = 0;
    async function pendingExactEdit(): Promise<{ id: string; hash: string }> {
        seq += 1;
        const saved = await saveParameterSet(ctxFor('composer'), {
            toolName: TOOL,
            label: `exact-${seq}`,
            parameters: { userId: '7' },
        });
        const proposed = await proposeParameterChange(ctxFor('composer'), {
            id: saved.id,
            parameters: { userId: '8' },
            openFields: null,
            targetPopulation: null,
        });
        if (!proposed.pending) throw new Error('fixture: no pending edit');
        return { id: saved.id, hash: proposed.pending.hash };
    }

    it('may be approved by its proposer while the rule is off (the default)', async () => {
        const { id, hash } = await pendingExactEdit();
        const state = await approveParameterChange(ctxFor('composer'), { id, expectedPendingHash: hash });
        expect(state.pending).toBeNull();
    });

    it('is refused to its proposer once an owner turns the rule on, and approved by somebody else', async () => {
        await setAgentOversightSettings(ctxFor('other'), { exactParameterEditNeedsSecondApprover: true });
        try {
            const { id, hash } = await pendingExactEdit();
            const before = await denials('external_tool_parameters_exact_edit_proposer');
            await expect(
                approveParameterChange(ctxFor('composer'), { id, expectedPendingHash: hash }),
            ).rejects.toMatchObject({
                status: 403,
                details: expect.objectContaining({ reason: 'PROPOSER_MAY_NOT_APPROVE_EXACT_EDIT' }),
            });
            expect(await denials('external_tool_parameters_exact_edit_proposer')).toBe(before + 1);

            const state = await approveParameterChange(ctxFor('other'), { id, expectedPendingHash: hash });
            expect(state.pending).toBeNull();
        } finally {
            await setAgentOversightSettings(ctxFor('other'), { exactParameterEditNeedsSecondApprover: false });
        }
    });
});

describe('Auditor reads (#4896–#4898)', () => {
    const auditor = () => makeRequestContext('AUDITOR', { tenantId: T, tenantSlug: T, userId: users.other as string });
    const reads = {
        decisions: () => listAiDecisions(auditor()),
        receipts: () => listReceipts(auditor(), { limit: 10 }),
        quarantine: () => listQuarantinedAgentProposals(auditor(), { take: 10 }),
    } as const;
    const switchOf = {
        decisions: 'auditorReadsDecisionLog',
        receipts: 'auditorReadsReceipts',
        quarantine: 'auditorReadsQuarantine',
    } as const;

    it('are refused by default, each with an AUTHZ_DENIED row', async () => {
        const before = await denials('agent_oversight_surface');
        for (const read of Object.values(reads)) {
            await expect(read()).rejects.toMatchObject({ status: 403 });
        }
        expect(await denials('agent_oversight_surface')).toBe(before + 3);
    });

    it.each(['decisions', 'receipts', 'quarantine'] as const)(
        'turning on %s opens that read and no other',
        async (surface) => {
            await setAgentOversightSettings(ctxFor('other'), { [switchOf[surface]]: true });
            try {
                await expect(reads[surface]()).resolves.toEqual(expect.any(Array));
                for (const other of Object.keys(reads) as Array<keyof typeof reads>) {
                    if (other !== surface) await expect(reads[other]()).rejects.toMatchObject({ status: 403 });
                }
            } finally {
                await setAgentOversightSettings(ctxFor('other'), { [switchOf[surface]]: false });
            }
        },
    );

    it('an owner reads all three whatever the switches say', async () => {
        await expect(listAiDecisions(ctxFor('other'))).resolves.toEqual(expect.any(Array));
        await expect(listReceipts(ctxFor('other'), { limit: 10 })).resolves.toEqual(expect.any(Array));
        await expect(listQuarantinedAgentProposals(ctxFor('other'), { take: 10 })).resolves.toEqual(expect.any(Array));
    });
});
