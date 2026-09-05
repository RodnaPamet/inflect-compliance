/**
 * THE PROMPT-INJECTION CORPUS — end to end, against the real MCP route, a real
 * API key, real RLS, and the real approval usecase.
 *
 * ═══ WHAT IT ASSERTS, AND WHY THAT SHAPE ═══
 *
 * A payload is planted where a customer's data actually arrives from — an
 * uploaded evidence document, a vendor questionnaire answer, a ServiceNow
 * ticket body, a policy, a task comment, scanner output, a tool result. Then
 * the agent is assumed FULLY COMPROMISED: the test submits, through the real
 * `propose_risks` tool, exactly what the agent would submit if it had obeyed.
 *
 * The assertion is that IC refuses to queue it. Nothing here depends on a model
 * resisting an instruction, because a test that asserted "the model ignored it"
 * would be testing the model and would pass or fail with the weather.
 *
 * ═══ THE TENANT IS IN THE MOST PERMISSIVE GUARD MODE ═══
 *
 * `aiGuardMode = 'AUDIT'` — the per-tenant posture that turns the EXISTING
 * `guardUntrustedInput` enforcement off entirely ("log only → ALLOW"). Every
 * quarantine below therefore comes from the agentic output guard, and none of
 * it can be attributed to the mode-driven helper. It also pins the property
 * that matters operationally: a tenant cannot switch quarantine off, because
 * the mode governs whether IC will call a MODEL, not whether untrusted text may
 * become a compliance record.
 *
 * Adding a case is one entry in `INJECTION_CASES`
 * (`tests/fixtures/prompt-injection-corpus.ts`). There is no per-case test body.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST } from '@/app/api/mcp/route';
import {
    approveAgentProposal,
    listAgentProposals,
    listQuarantinedAgentProposals,
    rejectAgentProposal,
} from '@/app-layer/usecases/agent-proposals';
import { makeRequestContext } from '../helpers/make-context';
import {
    CLEAN_PROPOSAL,
    INJECTION_CASES,
    type InjectionCase,
    type InjectionSurface,
} from '../fixtures/prompt-injection-corpus';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `inj-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;

let key = '';
let taskId = '';
let questionnaireId = '';

const humanCtx = () => makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

async function rpc(token: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    let json: unknown = null;
    try { json = await res.json(); } catch { /* noop */ }
    return { status: res.status, json };
}

interface ProposeResult {
    proposed: number;
    quarantined: number;
    proposalIds: string[];
    quarantinedProposalIds: string[];
}

function proposeResultOf(json: unknown): ProposeResult {
    const r = (json as { result?: { content: Array<{ text: string }> } }).result;
    if (!r) throw new Error('RPC returned no result: ' + JSON.stringify(json));
    return JSON.parse(r.content[0].text) as ProposeResult;
}

let rpcId = 100;
function proposeRisk(item: { title: string; description: string }) {
    return rpc(key, {
        jsonrpc: '2.0', id: rpcId++, method: 'tools/call',
        params: { name: 'propose_risks', arguments: { items: [item] } },
    });
}

/**
 * Plant one payload where that kind of content really lands. Returns a handle
 * the test can read back, so "it is in the corpus" is a fact about the database
 * rather than an assumption about the fixture.
 */
async function plant(surface: InjectionSurface, payload: string, tag: string): Promise<void> {
    switch (surface) {
        case 'evidence-document':
            await prisma.evidence.create({
                data: { tenantId: TENANT, type: 'FILE', title: `${tag} evidence`, content: payload, fileName: `${tag}.pdf` },
            });
            return;
        case 'vendor-questionnaire-answer':
            await prisma.inboundQuestionnaireItem.create({
                data: {
                    tenantId: TENANT,
                    questionnaireId,
                    questionText: `${tag} — do you hold ISO 27001?`,
                    acceptedAnswer: payload,
                },
            });
            return;
        case 'servicenow-ticket-description':
            await prisma.task.create({
                data: { tenantId: TENANT, title: `${tag} synced ticket`, description: payload, createdByUserId: USER },
            });
            return;
        case 'policy-body':
            await prisma.policy.create({
                data: { tenantId: TENANT, slug: `${tag}-policy`, title: `${tag} policy`, description: payload },
            });
            return;
        case 'task-comment':
            await prisma.taskComment.create({
                data: { tenantId: TENANT, taskId, body: payload, createdByUserId: USER },
            });
            return;
        case 'scanner-finding-description':
            await prisma.finding.create({
                data: { tenantId: TENANT, severity: 'HIGH', type: 'NONCONFORMITY', title: `${tag} scanner finding`, description: payload },
            });
            return;
        case 'mcp-tool-result':
            // A "tool result" is not a table — it is what a read tool RETURNS.
            // Planting it in a risk description is what makes the injection
            // reach the agent through `list_risks`, which is the real path.
            await prisma.risk.create({
                data: { tenantId: TENANT, title: `${tag} risk`, description: payload },
            });
            return;
    }
}

describeFn('prompt-injection corpus — an obeyed injection never reaches the review queue', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT }, update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        const email = `${USER}@example.test`;
        await prisma.user.upsert({
            where: { id: USER }, update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: USER } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        await prisma.tenantSecuritySettings.upsert({
            where: { tenantId: TENANT },
            // `requireRegisteredAgent: false` — same opt-out the other MCP
            // fixtures take; the register's own behaviour is proved elsewhere.
            // `aiGuardMode: 'AUDIT'` — see the header.
            update: { requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
            create: { tenantId: TENANT, requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
        });

        const { plaintext, keyHash, keyPrefix } = generateApiKey();
        await prisma.tenantApiKey.create({
            data: {
                tenantId: TENANT, name: 'corpus', keyPrefix, keyHash,
                scopes: ['mcp:read', 'mcp:propose', 'risks:read'], createdById: USER,
            },
        });
        key = plaintext;

        const task = await prisma.task.create({
            data: { tenantId: TENANT, title: `${SUITE} host task`, createdByUserId: USER },
        });
        taskId = task.id;
        const q = await prisma.inboundQuestionnaire.create({
            data: { tenantId: TENANT, name: `${SUITE} vendor questionnaire`, createdByUserId: USER },
        });
        questionnaireId = q.id;
    }, 60_000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    // ─────────────────────────────────────────────────────────────────
    describe.each(
        INJECTION_CASES.map(
            (c) =>
                [c.id, c.technique, c.surface, c] as [
                    string,
                    string,
                    InjectionSurface,
                    InjectionCase,
                ],
        ),
    )(
        '%s — %s planted in a %s',
        (id, _technique, surface, testCase) => {
            let quarantinedId = '';

            beforeAll(async () => {
                await plant(surface, testCase.payload, `${SUITE}-${id}`);
                const { status, json } = await proposeRisk(testCase.obeyedProposal);
                expect(status).toBe(200);
                const result = proposeResultOf(json);
                expect(result.quarantined).toBe(1);
                expect(result.proposed).toBe(0);
                expect(result.proposalIds).toStrictEqual([]);
                quarantinedId = result.quarantinedProposalIds[0];
            }, 60_000);

            it('the obeyed proposal is QUARANTINED, never PENDING', async () => {
                const row = await prisma.agentProposal.findFirst({ where: { id: quarantinedId } });
                expect(row?.status).toBe('QUARANTINED');
                expect(row?.guardVerdict).toBe('QUARANTINED');
            });

            it('the verdict is persisted with rule ids and a digest — and no content', async () => {
                const row = await prisma.agentProposal.findFirst({ where: { id: quarantinedId } });
                expect(row!.guardRuleIds.length).toBeGreaterThan(0);
                expect(row!.guardInputDigest!.startsWith('sha256:')).toBe(true);
                expect(row!.guardProvenance).toBe('THIRD_PARTY_INGESTED');
                // The digest is a digest: it carries nothing of the payload.
                expect(row!.guardInputDigest).not.toContain(testCase.obeyedProposal.title);
            });

            it('the quarantine itself is audited, and the audit row validated', async () => {
                // `appendAuditEntry` validates `detailsJson` against the
                // canonical Zod union and the call site swallows failures, so
                // a rejected payload would leave NO row and no error. Reading
                // the row back from the DB is the only thing that tells the
                // two apart.
                const row = await prisma.auditLog.findFirst({
                    where: { tenantId: TENANT, entityId: quarantinedId, action: 'AGENT_PROPOSAL_QUARANTINED' },
                });
                expect(row).toBeTruthy();
                const details = row!.detailsJson as { guardVerdict?: string; ruleIds?: string[] };
                expect(details.guardVerdict).toBe('QUARANTINED');
                expect(details.ruleIds!.length).toBeGreaterThan(0);
                expect(JSON.stringify(row)).not.toContain(testCase.obeyedProposal.title);
            });

            it('it is absent from the NORMAL review queue', async () => {
                const listed = await listAgentProposals(humanCtx(), { take: 200 });
                expect(listed.map((p) => p.id)).not.toContain(quarantinedId);
            });

            it('asking the queue for it BY STATUS does not widen the filter', async () => {
                await expect(
                    listAgentProposals(humanCtx(), { status: 'QUARANTINED', take: 200 }),
                ).rejects.toThrow(/proposal status/i);
            });

            it('it IS visible to the quarantine-triage listing', async () => {
                const triage = await listQuarantinedAgentProposals(humanCtx(), { take: 200 });
                expect(triage.map((p) => p.id)).toContain(quarantinedId);
            });

            it('the USECASE refuses to approve it', async () => {
                await expect(approveAgentProposal(humanCtx(), quarantinedId)).rejects.toThrow(
                    'agent_proposal_quarantined',
                );
            });

            it('the refusal is audited as a hash-chained AUTHZ_DENIED row', async () => {
                await approveAgentProposal(humanCtx(), quarantinedId).catch(() => undefined);
                const denial = await prisma.auditLog.findFirst({
                    where: { tenantId: TENANT, entity: 'AgentProposal', entityId: quarantinedId, action: 'AUTHZ_DENIED' },
                });
                expect(denial).toBeTruthy();
                // Hash-chained: `appendAuditEntry` links each row to the one
                // before it. An unchained row would carry neither field.
                expect(denial!.entryHash).toBeTruthy();
                const details = denial!.detailsJson as { reason?: string; ruleIds?: string[] };
                expect(details.reason).toBe('agent_proposal_quarantined');
                expect(details.ruleIds!.length).toBeGreaterThan(0);
                // The trail carries rule ids, never the payload.
                expect(JSON.stringify(denial)).not.toContain(testCase.obeyedProposal.title);
            });

            it('rejection is refused too — QUARANTINED is terminal', async () => {
                await expect(rejectAgentProposal(humanCtx(), quarantinedId)).rejects.toThrow(
                    'agent_proposal_quarantined',
                );
                const row = await prisma.agentProposal.findFirst({ where: { id: quarantinedId } });
                expect(row?.status).toBe('QUARANTINED');
            });

            it('no real risk was created from the injected instruction', async () => {
                const risk = await prisma.risk.findFirst({
                    where: { tenantId: TENANT, title: testCase.obeyedProposal.title },
                });
                expect(risk).toBeNull();
            });
        },
    );

    // ─────────────────────────────────────────────────────────────────
    describe('the positive companion — the guard is not simply refusing everything', () => {
        it('a clean compliance proposal queues as PENDING and can be approved into a real risk', async () => {
            const { status, json } = await proposeRisk(CLEAN_PROPOSAL);
            expect(status).toBe(200);
            const result = proposeResultOf(json);
            expect(result.quarantined).toBe(0);
            expect(result.proposed).toBe(1);

            const id = result.proposalIds[0];
            const row = await prisma.agentProposal.findFirst({ where: { id } });
            expect(row?.status).toBe('PENDING');
            expect(row?.guardVerdict).toBe('CLEAN');
            expect(row!.guardRuleIds).toStrictEqual([]);

            const listed = await listAgentProposals(humanCtx(), { take: 200 });
            expect(listed.map((p) => p.id)).toContain(id);

            const created = await prisma.auditLog.findFirst({
                where: { tenantId: TENANT, entityId: id, action: 'AGENT_PROPOSAL_CREATED' },
            });
            expect(created).toBeTruthy();
            expect((created!.detailsJson as { guardVerdict?: string }).guardVerdict).toBe('CLEAN');

            const approved = await approveAgentProposal(humanCtx(), id);
            expect(approved.status).toBe('ACCEPTED');
            const risk = await prisma.risk.findFirst({ where: { id: approved.createdEntityId } });
            expect(risk?.tenantId).toBe(TENANT);
        }, 60_000);
    });

    // ─────────────────────────────────────────────────────────────────
    describe('the read side — planted content reaches the agent LABELLED', () => {
        it('a read tool result carries a provenance envelope marking it data-only', async () => {
            const { status, json } = await rpc(key, {
                jsonrpc: '2.0', id: rpcId++, method: 'tools/call',
                params: { name: 'list_risks', arguments: { limit: 50 } },
            });
            expect(status).toBe(200);
            const content = (json as { result: { content: Array<{ text: string }> } }).result.content;
            // content[0] is still the exact JSON payload every existing agent
            // parses — the envelope is appended, never wrapped around it.
            expect(Array.isArray(JSON.parse(content[0].text))).toBe(true);
            const envelope = JSON.parse(content[1].text) as {
                kind: string; provenance: string; mayCarryInstruction: boolean; handling: string;
            };
            expect(envelope.kind).toBe('content-provenance');
            expect(envelope.provenance).toBe('THIRD_PARTY_INGESTED');
            expect(envelope.mayCarryInstruction).toBe(false);
            expect(envelope.handling).toContain('DATA ONLY');
        }, 60_000);

        it('the planted tool-result payload really is in the corpus the tool returns', async () => {
            const { json } = await rpc(key, {
                jsonrpc: '2.0', id: rpcId++, method: 'tools/call',
                params: { name: 'list_risks', arguments: { limit: 50 } },
            });
            const content = (json as { result: { content: Array<{ text: string }> } }).result.content;
            // The point of the corpus: the injected sentence IS reachable. What
            // is guarded is what the agent does next, not whether it can read.
            expect(content[0].text).toContain('inj-007');
        }, 60_000);
    });
});
