/**
 * THE UNATTENDED ARM, END TO END, AGAINST A REAL DATABASE (#2861 / #3051).
 *
 * `AUTOMATIC` is the rung with no human in it. Everything that replaces the
 * human is either a row or a trigger, so almost nothing here is observable from
 * TypeScript:
 *
 *   · THE JOURNAL ROW is the audit record of the resolved values (#3051
 *     decision 5) and its content is ENCRYPTED, so "what went out" can only be
 *     read back through a tenant context. A mocked Prisma proves the call shape
 *     and nothing about the record.
 *   · THE ART 12 ROW carries `humanOutcome = 'AUTONOMOUS'`, a Postgres enum
 *     value this branch adds, written at INSERT past an append-only trigger. The
 *     claim "a row can be created terminal" is a claim about that trigger.
 *   · THE TARGET POPULATION is a tenant-scoped read of live rows, and the whole
 *     send-time re-validation turns on it MOVING between the decision and the
 *     send. That is two writes and two reads of real data.
 *   · THE PARAMETER SET cannot be inserted with open fields at all — a BEFORE
 *     INSERT trigger refuses a template created in one step — so the template
 *     this suite dispatches has to be promoted through the real four-eyes flow.
 *
 * ## Nothing leaves this process, and that is asserted, not assumed
 *
 * `callTool` is mocked for the whole file. Every test that expects a refusal
 * asserts the WRITE tool was never passed to it — `writeWasSent()` — rather
 * than asserting a thrown message and leaving the socket question open. The
 * prior-state READ is allowed to be called: reading is owner decision 2's
 * precondition, and a test that forbade it would be forbidding the control.
 *
 * ## The clamp is mocked UP, on purpose
 *
 * `EXTERNAL_MAX_MODE` is `PROPOSE_ONLY` on this branch, so without this mock
 * every assertion below would be a statement about a path the clamp refuses —
 * an empty selection, which passes. The clamp's own behaviour in BOTH
 * directions is the subject of `tests/unit/external-write-automatic-clamp.test.ts`;
 * here it is lifted so the arm can be exercised at all.
 */
const listToolsMock = jest.fn();
const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    listTools: (...a: unknown[]) => listToolsMock(...a),
    callTool: (...a: unknown[]) => callToolMock(...a),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: jest.fn(async () => 'Bearer test-token'),
}));
jest.mock('@/lib/integrations/external-write-ladder', () => ({
    ...jest.requireActual('@/lib/integrations/external-write-ladder'),
    EXTERNAL_MAX_MODE: 'AUTOMATIC',
}));

import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { externalToolName } from '@/lib/mcp/external-tool-name';
import { hashToolManifest } from '@/lib/mcp/tool-manifest';
import { resolveExternalReadTools } from '@/lib/mcp/tools/external-tools';
import { getJournalWrite } from '@/app-layer/usecases/external-write-journal';
import { runExternalWriteDispatch } from '@/app-layer/usecases/external-write-dispatch';
import {
    AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW,
    AUTOMATIC_WRITE_WINDOW_MS,
} from '@/app-layer/usecases/external-write-automatic';
import {
    approveParameterChange,
    proposeParameterChange,
    saveParameterSet,
    signParameterChange,
} from '@/app-layer/usecases/external-tool-parameters';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = 'extauto-tenant';
const PEOPLE = ['proposer', 'approver'] as const;
const users: Record<string, string> = {};

const WRITE_DEF = {
    name: 'set_work_email',
    description: 'Set a worker work email.',
    inputSchema: { type: 'object', properties: { employeeEmail: { type: 'string' } } },
    // NOT read-only, so `declaresWrite` is true and the rung governs the call.
    annotations: { readOnlyHint: false },
};
const READ_DEF = {
    name: 'get_worker',
    description: 'Read a worker.',
    inputSchema: { type: 'object', properties: { employeeEmail: { type: 'string' } } },
    annotations: { readOnlyHint: true },
};

const EMAIL_POP = 'terminated_employee_work_emails';
const LABEL = 'offboard';
const EXACT = { reason: 'offboarding' };
/** The STORED open-field shape of a targeted template — the population is a column. */
const TARGETED = { employeeEmail: { kind: 'target' } };
const PRIOR = { workEmail: 'gone@extauto.test', status: 'active' };

let connectionId = '';
let WRITE = '';
let READ = '';

const ctxFor = (who: (typeof PEOPLE)[number] = 'proposer') =>
    makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: users[who] });

/** Did the WRITE leave? The prior-state READ is allowed; the write is the question. */
const writeWasSent = () => callToolMock.mock.calls.some((c) => c[1] === WRITE_DEF.name);
const readWasRun = () => callToolMock.mock.calls.some((c) => c[1] === READ_DEF.name);

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: T };
    await prisma.externalWriteJournal.deleteMany({ where: t });
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.externalToolPriorStateRead.deleteMany({ where: t });
    await prisma.externalToolParameterSetApproval.deleteMany({ where: t });
    await prisma.externalToolParameterSet.deleteMany({ where: t });
    await prisma.mcpToolManifestPin.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await prisma.employee.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T]);
    // `resetDatabase` does NOT truncate `TenantMembership` — its parents
    // (`Tenant`, `User`) are not roots in `RESET_TABLES`, and the helper says so
    // at length. The surviving row then makes `user.deleteMany` violate
    // `TenantMembership_userId_fkey`, which is what makes a suite un-rerunnable
    // against a database it has already seen. `session_replication_role` is how
    // the sibling target-population suite gets past the last-OWNER trigger.
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: PEOPLE.map((p) => hashForLookup(`${p}@${T}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: T } });
}

/** One TERMINATED worker, i.e. one member of the approved target population. */
async function terminatedWorker(workEmail: string): Promise<void> {
    await prisma.employee.create({
        data: { tenantId: T, fullName: workEmail, workEmail, status: 'TERMINATED' },
    });
}

/**
 * The template the agent dispatches, built the only way the database permits.
 *
 * A set CANNOT be created with open fields — `external_tool_parameter_set_open_fields_four_eyes`
 * refuses that on INSERT, because a template reached in one step is a predicate
 * nobody reviewed. So: save the exact values, propose the open field, have an
 * INDEPENDENT human sign it, and promote. That sequence is the authority the
 * `AUTOMATIC` rung then stands on, which is why the suite pays for it rather
 * than inserting a row.
 */
async function approvedTargetTemplate(label = LABEL): Promise<string> {
    const set = await saveParameterSet(ctxFor('proposer'), {
        toolName: WRITE,
        label,
        parameters: EXACT,
    });
    const proposed = await proposeParameterChange(ctxFor('proposer'), {
        id: set.id,
        parameters: EXACT,
        openFields: TARGETED,
        targetPopulation: EMAIL_POP,
    });
    const hash = proposed.pending!.hash;
    await signParameterChange(ctxFor('approver'), { id: set.id, expectedPendingHash: hash });
    await approveParameterChange(ctxFor('approver'), { id: set.id, expectedPendingHash: hash });
    return set.id;
}

/** The one external tool this invocation may load. */
async function theWriteTool() {
    const tools = await resolveExternalReadTools(
        ctxFor('proposer'),
        new Set([WRITE, READ]),
        NO_POLICY_CARD,
    );
    const tool = tools.find((t) => t.name === WRITE);
    if (!tool) throw new Error(`the write tool did not resolve; got ${tools.map((t) => t.name)}`);
    return tool;
}

const pinFor = (def: typeof WRITE_DEF, toolName: string) => {
    const h = hashToolManifest(def);
    return {
        tenantId: T,
        toolName,
        descriptionHash: h.descriptionHash,
        schemaHash: h.schemaHash,
        manifestHash: h.manifestHash,
        annotationsHash: h.annotationsHash,
        approvalSource: 'APPROVED',
        // NOT NULL, and the database insists: `McpToolManifestPin_approval_accountability`
        // CHECKs that an APPROVED pin names the human who approved it. A pin
        // with no approver would be a definition nobody accepted.
        approvedByUserId: users.approver,
        revision: 1,
    };
};

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    for (const who of PEOPLE) {
        const email = `${who}@${T}.test`;
        const user = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.create({
            data: {
                tenantId: T,
                userId: user.id,
                role: Role.OWNER,
                status: MembershipStatus.ACTIVE,
            },
        });
        users[who] = user.id;
    }
    const conn = await prisma.integrationConnection.create({
        data: {
            tenantId: T,
            provider: 'mcp-server',
            name: 'HRM',
            isEnabled: true,
            configJson: { url: 'https://hrm-mcp.example.test/mcp' },
            externalWriteMode: 'AUTOMATIC',
            externalWriteModeSince: new Date('2026-09-01T00:00:00.000Z'),
        },
    });
    connectionId = conn.id;
    WRITE = externalToolName(connectionId, WRITE_DEF.name);
    READ = externalToolName(connectionId, READ_DEF.name);
    await prisma.mcpToolManifestPin.createMany({
        data: [pinFor(WRITE_DEF, WRITE), pinFor(READ_DEF, READ)],
    });
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(async () => {
    jest.clearAllMocks();
    await prisma.externalWriteJournal.deleteMany({ where: { tenantId: T } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: T } });
    await prisma.externalToolPriorStateRead.deleteMany({ where: { tenantId: T } });
    await prisma.externalToolParameterSetApproval.deleteMany({ where: { tenantId: T } });
    await prisma.externalToolParameterSet.deleteMany({ where: { tenantId: T } });
    await prisma.employee.deleteMany({ where: { tenantId: T } });
    await prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { externalWriteMode: 'AUTOMATIC', isEnabled: true },
    });
    listToolsMock.mockResolvedValue([WRITE_DEF, READ_DEF]);
    // The prior-state read answers; the write answers emptily. Both go through
    // the one mock, discriminated by tool name.
    callToolMock.mockImplementation(async (_t: unknown, name: string) =>
        name === READ_DEF.name ? PRIOR : { content: [] },
    );
    await prisma.externalToolPriorStateRead.create({
        data: { tenantId: T, writeToolName: WRITE, readToolName: READ },
    });
});

// ═════════════════════════════════════════════════════════════════════
// 1. THE HAPPY PATH, IN TWO HALVES — the arm journals, the JOB sends
// ═════════════════════════════════════════════════════════════════════

describe('an unattended write is journalled by the arm and sent by the job', () => {
    it('the arm opens a PENDING row at AUTOMATIC and sends nothing itself', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        const tool = await theWriteTool();

        const answer = (await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        })) as { content: { text: string }[] };

        // THE READ RAN AND THE WRITE DID NOT. Both halves: a test that only
        // asserted the write was absent would pass for a call that never
        // reached the seam at all.
        expect(readWasRun()).toBe(true);
        expect(writeWasSent()).toBe(false);
        expect(answer.content[0].text).toMatch(/QUEUED FOR UNATTENDED DISPATCH/);
        expect(answer.content[0].text).toMatch(/Do not report this as a completed change/);

        const rows = await prisma.externalWriteJournal.findMany({ where: { tenantId: T } });
        expect(rows).toHaveLength(1);
        expect(rows[0].mode).toBe('AUTOMATIC');
        expect(rows[0].outcome).toBe('PENDING');
        expect(rows[0].settledAt).toBeNull();
        // The LABEL, which is what the send-time bound re-check finds the set by.
        expect(rows[0].parameterSetLabel).toBe(LABEL);
        // No human. `actorUserId` is the ctx user here because the funnel runs
        // under a credential, but there is no approval and no proposal.
        expect(await prisma.agentProposal.count({ where: { tenantId: T } })).toBe(0);
    });

    it('records the RESOLVED values on the row, decrypted through a tenant context', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        const tool = await theWriteTool();
        await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        });

        const [row] = await prisma.externalWriteJournal.findMany({ where: { tenantId: T } });
        // `getJournalWrite` DECRYPTS — the columns are in `ENCRYPTED_FIELDS` and
        // the DEK is per-tenant, so this is the only read that can assert
        // content. #3051 decision 5 makes this row the audit record.
        const decrypted = await getJournalWrite(ctxFor('proposer'), row.id);
        expect(JSON.parse(decrypted!.argumentsJson)).toEqual({
            reason: 'offboarding',
            employeeEmail: 'gone@extauto.test',
        });
        expect(JSON.parse(decrypted!.priorStateJson)).toEqual(PRIOR);
    });

    it('writes the Art 12 record stamped AUTONOMOUS, terminal at INSERT', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        const tool = await theWriteTool();
        await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        });

        const logs = await prisma.aiDecisionLog.findMany({ where: { tenantId: T } });
        expect(logs).toHaveLength(1);
        // NOT `PENDING`. A PENDING row here is a review nobody can ever perform,
        // which `buildDecisionArtefact` would report as a growing backlog.
        expect(logs[0].humanOutcome).toBe('AUTONOMOUS');
        expect(logs[0].feature).toBe('external-write-automatic');
        expect(logs[0].inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('the summary carries field NAMES and no value — the Art 12 privacy rule', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        const tool = await theWriteTool();
        await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        });

        const [log] = await prisma.aiDecisionLog.findMany({ where: { tenantId: T } });
        const summary = log.outputSummary ?? '';
        expect(summary).toContain('argumentFields=employeeEmail|reason');
        expect(summary).toContain('humanReview=none');
        // The PAIRED negative. A summary naming the fields is only privacy-safe
        // if it does not also carry what was in them — and the resolved email is
        // a worker's identifier.
        expect(summary).not.toContain('gone@extauto.test');
        expect(summary).not.toContain('offboarding');
    });

    it('the stamp is one-way: the append-only trigger refuses to move AUTONOMOUS', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        const tool = await theWriteTool();
        await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        });
        const [log] = await prisma.aiDecisionLog.findMany({ where: { tenantId: T } });

        // The claim the migration makes: a row born terminal can never be
        // restamped as though a human had reviewed it. The trigger is the
        // control; the TS type on the stamp is the convenience.
        await expect(
            prisma.aiDecisionLog.update({
                where: { id: log.id },
                data: { humanOutcome: 'ACCEPTED' },
            }),
        ).rejects.toThrow(/already recorded|append-only/i);
    });

    it('the JOB is what sends it, and settles the row APPLIED', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        const tool = await theWriteTool();
        await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        });
        expect(writeWasSent()).toBe(false);

        const result = await runExternalWriteDispatch({ tenantId: T });

        expect(result).toMatchObject({ scanned: 1, applied: 1, refused: 0, indeterminate: 0 });
        expect(writeWasSent()).toBe(true);
        // The ARGUMENTS that went out are the resolved ones, not the model's
        // object — which by then carried only the label and the open field.
        const sent = callToolMock.mock.calls.find((c) => c[1] === WRITE_DEF.name);
        expect(sent?.[2]).toEqual({ reason: 'offboarding', employeeEmail: 'gone@extauto.test' });

        const [row] = await prisma.externalWriteJournal.findMany({ where: { tenantId: T } });
        expect(row.outcome).toBe('APPLIED');
        expect(row.settledAt).toBeInstanceOf(Date);
    });

    it('the job does NOT re-read prior state at AUTOMATIC, and never rewrites the stored copy', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        const tool = await theWriteTool();
        await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        });
        callToolMock.mockClear();

        // The far end has MOVED since the arm looked. At PROPOSE_ONLY this is a
        // refusal; at AUTOMATIC nobody reviewed the record, so it is not.
        callToolMock.mockImplementation(async (_t: unknown, name: string) =>
            name === READ_DEF.name ? { workEmail: 'someone.else@extauto.test' } : { content: [] },
        );
        const result = await runExternalWriteDispatch({ tenantId: T });

        expect(result.applied).toBe(1);
        expect(result.refused).toBe(0);
        // The read was not even run — it costs an outbound call whose answer
        // this rung discards.
        expect(readWasRun()).toBe(false);

        const [row] = await prisma.externalWriteJournal.findMany({ where: { tenantId: T } });
        const decrypted = await getJournalWrite(ctxFor('proposer'), row.id);
        // The stored prior state is still what the DECISION was made against.
        expect(JSON.parse(decrypted!.priorStateJson)).toEqual(PRIOR);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. WHAT THE ARM REFUSES BEFORE ANYTHING IS JOURNALLED
// ═════════════════════════════════════════════════════════════════════

describe('the arm refuses a call with no approved parameter set in force', () => {
    it('refuses, journals nothing, and sends nothing', async () => {
        await terminatedWorker('gone@extauto.test');
        // NO template saved: the model would choose every argument, and at this
        // rung there is nobody to notice.
        const tool = await theWriteTool();

        await expect(
            tool.run(ctxFor('proposer'), { employeeEmail: 'gone@extauto.test' }),
        ).rejects.toThrow(/external_write_automatic_requires_parameter_set/);

        expect(writeWasSent()).toBe(false);
        expect(await prisma.externalWriteJournal.count({ where: { tenantId: T } })).toBe(0);
        // No Art 12 row either — the refusal is BEFORE the decision, so there is
        // no decision to record.
        expect(await prisma.aiDecisionLog.count({ where: { tenantId: T } })).toBe(0);
    });

    it('but a set with NO open fields is accepted — the control', async () => {
        // The paired positive, and it is not a formality: a set of exact values
        // is MAXIMALLY bounded (a human typed every byte), so a check that also
        // demanded an open target would refuse the safest template there is.
        await saveParameterSet(ctxFor('proposer'), {
            toolName: WRITE,
            label: 'exact-only',
            parameters: { reason: 'offboarding', employeeEmail: 'typed@extauto.test' },
        });
        const tool = await theWriteTool();

        await tool.run(ctxFor('proposer'), { parameterSet: 'exact-only' });

        const [row] = await prisma.externalWriteJournal.findMany({ where: { tenantId: T } });
        expect(row.mode).toBe('AUTOMATIC');
        expect(row.parameterSetLabel).toBe('exact-only');
    });
});

describe('the target population still bounds the call at the arm', () => {
    it('refuses a row that is not in the population, journalling nothing', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        const tool = await theWriteTool();

        await expect(
            tool.run(ctxFor('proposer'), {
                parameterSet: LABEL,
                employeeEmail: 'still.employed@extauto.test',
            }),
        ).rejects.toThrow(/external_target_not_in_population/);

        expect(writeWasSent()).toBe(false);
        expect(readWasRun()).toBe(false);
        expect(await prisma.externalWriteJournal.count({ where: { tenantId: T } })).toBe(0);
    });

    it('refuses an EMPTY population with its own message, not a value refusal', async () => {
        // No terminated worker at all. "The template is inert" is an operator's
        // problem (a stale feed) and must not read as the model choosing badly.
        await approvedTargetTemplate();
        const tool = await theWriteTool();

        await expect(
            tool.run(ctxFor('proposer'), {
                parameterSet: LABEL,
                employeeEmail: 'gone@extauto.test',
            }),
        ).rejects.toThrow(/external_target_population_empty/);
        expect(writeWasSent()).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. THE ROLLING-WINDOW CAP — a bad population feed, bounded per connection
// ═════════════════════════════════════════════════════════════════════

describe('the per-connection rolling-window cap', () => {
    /** Journal rows already opened at AUTOMATIC inside the window. */
    async function backfillOpenedWrites(n: number): Promise<void> {
        await prisma.externalWriteJournal.createMany({
            data: Array.from({ length: n }, (_, i) => ({
                tenantId: T,
                connectionId,
                connectionName: 'HRM',
                endpointUrl: 'https://hrm-mcp.example.test/mcp',
                toolName: WRITE,
                advertisedToolName: WRITE_DEF.name,
                mode: 'AUTOMATIC',
                argumentsJson: JSON.stringify({ i }),
                priorStateJson: JSON.stringify({}),
                outcome: 'APPLIED' as const,
                attemptedAt: new Date(Date.now() - 60_000),
                settledAt: new Date(),
            })),
        });
    }

    it('refuses the call that would exceed it, with its own code', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        await backfillOpenedWrites(AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW);
        const tool = await theWriteTool();

        await expect(
            tool.run(ctxFor('proposer'), {
                parameterSet: LABEL,
                employeeEmail: 'gone@extauto.test',
            }),
        ).rejects.toThrow(/external_write_automatic_rate_limited/);

        expect(writeWasSent()).toBe(false);
        // Refused rather than trimmed: no new row, and the cap is not a queue.
        expect(await prisma.externalWriteJournal.count({ where: { tenantId: T } })).toBe(
            AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW,
        );
    });

    it('admits the one BELOW the cap — the control that says the bound is not just "no"', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        await backfillOpenedWrites(AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW - 1);
        const tool = await theWriteTool();

        await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        });

        expect(await prisma.externalWriteJournal.count({ where: { tenantId: T } })).toBe(
            AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW,
        );
    });

    it('counts a WINDOW, not a lifetime — rows older than it do not bite', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        await backfillOpenedWrites(AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW);
        // Age every one of them past the window. Same rows, same count, and the
        // call is now admitted — which is what makes this a rolling bound rather
        // than a permanent ceiling on a connection's whole history.
        await prisma.externalWriteJournal.updateMany({
            where: { tenantId: T },
            data: { attemptedAt: new Date(Date.now() - AUTOMATIC_WRITE_WINDOW_MS - 60_000) },
        });
        const tool = await theWriteTool();

        await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        });

        expect(await prisma.externalWriteJournal.count({ where: { tenantId: T } })).toBe(
            AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW + 1,
        );
    });

    it('counts THIS connection only, and only AUTOMATIC rows', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        const other = await prisma.integrationConnection.create({
            data: {
                tenantId: T,
                provider: 'mcp-server',
                name: 'OTHER',
                isEnabled: true,
                configJson: { url: 'https://other.example.test/mcp' },
                externalWriteMode: 'AUTOMATIC',
            },
        });
        // A full allowance on ANOTHER connection, plus a full allowance of
        // DRY_RUN rows on this one. Neither is this connection's unattended
        // volume, and a cap that counted either would refuse legitimate work.
        await prisma.externalWriteJournal.createMany({
            data: [
                ...Array.from({ length: AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW }, () => ({
                    tenantId: T,
                    connectionId: other.id,
                    connectionName: 'OTHER',
                    endpointUrl: 'https://other.example.test/mcp',
                    toolName: 'mcp__other__x',
                    advertisedToolName: 'x',
                    mode: 'AUTOMATIC',
                    argumentsJson: '{}',
                    priorStateJson: '{}',
                    outcome: 'APPLIED' as const,
                })),
                ...Array.from({ length: AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW }, () => ({
                    tenantId: T,
                    connectionId,
                    connectionName: 'HRM',
                    endpointUrl: 'https://hrm-mcp.example.test/mcp',
                    toolName: WRITE,
                    advertisedToolName: WRITE_DEF.name,
                    mode: 'DRY_RUN',
                    argumentsJson: '{}',
                    priorStateJson: '{}',
                    outcome: 'RECORDED_ONLY' as const,
                })),
            ],
        });
        const tool = await theWriteTool();

        await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        });

        expect(
            await prisma.externalWriteJournal.count({
                where: { tenantId: T, connectionId, mode: 'AUTOMATIC' },
            }),
        ).toBe(1);
        await prisma.integrationConnection.delete({ where: { id: other.id } });
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. THE SEND-TIME BOUND RE-CHECK — what drift means at AUTOMATIC
// ═════════════════════════════════════════════════════════════════════

describe('the job re-validates the BOUND, because that is what stood in for the human', () => {
    /** Journal one write, leaving it PENDING for the job. */
    async function queueOne(): Promise<void> {
        const tool = await theWriteTool();
        await tool.run(ctxFor('proposer'), {
            parameterSet: LABEL,
            employeeEmail: 'gone@extauto.test',
        });
        callToolMock.mockClear();
    }

    it('refuses when the TARGET has left the population since the write was opened', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        await queueOne();

        // The data moved. This is the refusal 5c's whole argument demands: a
        // population resolved once and trusted later is a snapshot presented as
        // a live bound.
        await prisma.employee.updateMany({ where: { tenantId: T }, data: { status: 'ACTIVE' } });

        const result = await runExternalWriteDispatch({ tenantId: T });

        expect(result).toMatchObject({ scanned: 1, applied: 0, refused: 1 });
        expect(writeWasSent()).toBe(false);
        const [row] = await prisma.externalWriteJournal.findMany({ where: { tenantId: T } });
        expect(row.outcome).toBe('FAILED');
        const decrypted = await getJournalWrite(ctxFor('proposer'), row.id);
        expect(decrypted!.detail).toMatch(/external_write_automatic_target_population_empty/);
    });

    it('names LEFT THE POPULATION when the population is non-empty but no longer holds this row', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        await queueOne();

        // A DIFFERENT worker is terminated and ours is not: the population is
        // healthy, and this row is simply not in it any more. Distinct from the
        // empty case above, and fixed by a different person.
        await prisma.employee.updateMany({ where: { tenantId: T }, data: { status: 'ACTIVE' } });
        await terminatedWorker('someone.else@extauto.test');

        const result = await runExternalWriteDispatch({ tenantId: T });

        expect(result.refused).toBe(1);
        expect(writeWasSent()).toBe(false);
        const [row] = await prisma.externalWriteJournal.findMany({ where: { tenantId: T } });
        const decrypted = await getJournalWrite(ctxFor('proposer'), row.id);
        expect(decrypted!.detail).toMatch(/external_write_automatic_target_left_population/);
    });

    it('refuses when the approved SET has been withdrawn', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        await queueOne();

        await prisma.externalToolParameterSetApproval.deleteMany({ where: { tenantId: T } });
        await prisma.externalToolParameterSet.deleteMany({ where: { tenantId: T } });

        const result = await runExternalWriteDispatch({ tenantId: T });

        expect(result.refused).toBe(1);
        expect(writeWasSent()).toBe(false);
        const [row] = await prisma.externalWriteJournal.findMany({ where: { tenantId: T } });
        const decrypted = await getJournalWrite(ctxFor('proposer'), row.id);
        expect(decrypted!.detail).toMatch(/external_write_automatic_set_withdrawn/);
    });

    it('refuses when the ROW\'s rung is above the connection\'s CURRENT one', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        await queueOne();

        // The narrowing the old `DISABLED`/`DRY_RUN` pair could not see:
        // PROPOSE_ONLY is neither value, so the row sailed through while being
        // exactly what the operator's instruction was about.
        await prisma.integrationConnection.update({
            where: { id: connectionId },
            data: { externalWriteMode: 'PROPOSE_ONLY' },
        });

        const result = await runExternalWriteDispatch({ tenantId: T });

        expect(result.refused).toBe(1);
        expect(writeWasSent()).toBe(false);
        const [row] = await prisma.externalWriteJournal.findMany({ where: { tenantId: T } });
        const decrypted = await getJournalWrite(ctxFor('proposer'), row.id);
        expect(decrypted!.detail).toMatch(/external_write_automatic_rung_narrowed/);
    });

    it('still refuses a withdrawn prior-state PAIRING, at this rung too', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        await queueOne();

        // The pairing is what makes the write accountable, and that is true
        // whether or not a human reviewed the record.
        await prisma.externalToolPriorStateRead.deleteMany({ where: { tenantId: T } });

        const result = await runExternalWriteDispatch({ tenantId: T });

        expect(result.refused).toBe(1);
        expect(writeWasSent()).toBe(false);
    });

    it('sends when every term still holds — the control for all five above', async () => {
        await terminatedWorker('gone@extauto.test');
        await approvedTargetTemplate();
        await queueOne();

        const result = await runExternalWriteDispatch({ tenantId: T });

        expect(result).toMatchObject({ scanned: 1, applied: 1, refused: 0 });
        expect(writeWasSent()).toBe(true);
    });
});
