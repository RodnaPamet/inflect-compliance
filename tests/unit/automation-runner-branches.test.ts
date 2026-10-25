/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Automation Runner — branch coverage for the orchestration surface.
 *
 * The companion `automation-runner.test.ts` (if/when present) covers the pure
 * helpers `getFrequencyIntervalMs` / `computeNextDueAt`. This file targets the
 * previously-uncovered functions:
 *
 *   - findDueAutomationControls  (where-clause shaping, window filtering)
 *   - executeControlAutomation   (every early-return + success/failure path)
 *   - runScheduledAutomations    (dryRun, skip, result tallying, throw)
 *
 * Pure UNIT test — no DB. `@/lib/prisma`, the integration `registry`,
 * `runJob`, the logger and `decryptField` are all mocked. Each test names
 * the branch class it protects.
 */

// ─── Mocks (declared before imports) ───

jest.mock('@/lib/prisma', () => ({
    prisma: {
        control: {
            findMany: jest.fn(),
            update: jest.fn(),
        },
        integrationExecution: {
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
        integrationConnection: {
            findFirst: jest.fn(),
        },
        evidence: {
            create: jest.fn(),
        },
        // Evidence↔Control is a many-to-many join now; integration evidence
        // is attached to the control via an EvidenceControlLink row.
        evidenceControlLink: {
            create: jest.fn(),
        },
        finding: {
            findFirst: jest.fn(),
            create: jest.fn(),
            updateMany: jest.fn(),
        },
    },
}));

// runJob just invokes the inner fn — strip the observability wrapper.
jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => any) => fn()),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock('@/app-layer/integrations/bootstrap', () => ({}));
jest.mock('../../src/app-layer/integrations/registry', () => ({
    registry: {
        resolveByAutomationKey: jest.fn(),
        canHandle: jest.fn(),
    },
}));

jest.mock('@/lib/security/encryption', () => ({
    decryptField: jest.fn(),
}));

import { prisma } from '@/lib/prisma';
import { registry } from '../../src/app-layer/integrations/registry';
import { decryptField } from '@/lib/security/encryption';
import {
    findDueAutomationControls,
    executeControlAutomation,
    runScheduledAutomations,
} from '@/app-layer/jobs/automation-runner';

const mPrisma = prisma as any;
const mRegistry = registry as any;
const mDecrypt = decryptField as jest.Mock;

const NOW = new Date('2026-06-01T00:00:00.000Z');

/** Build a scheduled-check provider stub. */
function makeProvider(over: Partial<any> = {}): any {
    return {
        id: 'github',
        runCheck: jest.fn(),
        mapResultToEvidence: jest.fn(),
        ...over,
    };
}

/** A DueControl shape. */
function makeDueControl(over: Partial<any> = {}): any {
    return {
        id: 'ctrl-1',
        tenantId: 'tenant-1',
        automationKey: 'github.branch_protection',
        frequency: 'DAILY',
        nextDueAt: NOW,
        name: 'Branch protection',
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── findDueAutomationControls ───

describe('findDueAutomationControls', () => {
    test('scopes WHERE to a specific tenantId when provided', async () => {
        // Branch: tenantId truthy → where.tenantId = tenantId
        mPrisma.control.findMany.mockResolvedValue([]);

        await findDueAutomationControls(NOW, 'tenant-77');

        const arg = mPrisma.control.findMany.mock.calls[0][0];
        expect(arg.where.tenantId).toBe('tenant-77');
        expect(arg.where.evidenceSource).toBe('INTEGRATION');
        expect(arg.where.applicability).toBe('APPLICABLE');
        expect(arg.take).toBe(500);
    });

    test('scopes WHERE to all tenant-scoped controls when tenantId omitted', async () => {
        // Branch: tenantId falsy → where.tenantId = { not: null }
        mPrisma.control.findMany.mockResolvedValue([]);

        await findDueAutomationControls(NOW);

        const arg = mPrisma.control.findMany.mock.calls[0][0];
        expect(arg.where.tenantId).toEqual({ not: null });
    });

    test('skips controls missing tenantId or automationKey', async () => {
        // Branch: !ctrl.tenantId || !ctrl.automationKey → continue
        mPrisma.control.findMany.mockResolvedValue([
            { id: 'a', tenantId: null, automationKey: 'github.x', frequency: 'DAILY', nextDueAt: NOW, name: 'A' },
            { id: 'b', tenantId: 't', automationKey: null, frequency: 'DAILY', nextDueAt: NOW, name: 'B' },
        ]);

        const result = await findDueAutomationControls(NOW);

        expect(result).toEqual([]);
        expect(mPrisma.integrationExecution.findFirst).not.toHaveBeenCalled();
    });

    test('skips controls whose frequency has no interval', async () => {
        // Branch: !interval → continue (AD_HOC / unknown frequency)
        mPrisma.control.findMany.mockResolvedValue([
            { id: 'c', tenantId: 't', automationKey: 'github.x', frequency: 'AD_HOC', nextDueAt: NOW, name: 'C' },
            { id: 'd', tenantId: 't', automationKey: 'github.x', frequency: 'NONSENSE', nextDueAt: NOW, name: 'D' },
        ]);

        const result = await findDueAutomationControls(NOW);

        expect(result).toEqual([]);
        expect(mPrisma.integrationExecution.findFirst).not.toHaveBeenCalled();
    });

    test('excludes controls with a recent execution in the window', async () => {
        // Branch: recentExecution truthy → not pushed
        mPrisma.control.findMany.mockResolvedValue([makeDueControl()]);
        mPrisma.integrationExecution.findFirst.mockResolvedValue({ id: 'exec-recent' });

        const result = await findDueAutomationControls(NOW);

        expect(result).toEqual([]);
        // window start = now - DAILY interval
        const ff = mPrisma.integrationExecution.findFirst.mock.calls[0][0];
        expect(ff.where.executedAt.gte).toEqual(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));
    });

    test('includes controls with no recent execution', async () => {
        // Branch: !recentExecution → pushed to dueControls
        mPrisma.control.findMany.mockResolvedValue([makeDueControl({ id: 'due-1' })]);
        mPrisma.integrationExecution.findFirst.mockResolvedValue(null);

        const result = await findDueAutomationControls(NOW);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ id: 'due-1', tenantId: 'tenant-1', automationKey: 'github.branch_protection' });
    });
});

// ─── executeControlAutomation ───

describe('executeControlAutomation', () => {
    test('returns ERROR for an invalid automationKey', async () => {
        // Branch: parseAutomationKey → null
        const control = makeDueControl({ automationKey: 'noseparator' });

        const out = await executeControlAutomation(control, 'job-1', NOW);

        expect(out).toEqual({ status: 'ERROR', executionId: '' });
        expect(mRegistry.resolveByAutomationKey).not.toHaveBeenCalled();
    });

    test('returns ERROR when no provider resolves', async () => {
        // Branch: registry.resolveByAutomationKey → null
        mRegistry.resolveByAutomationKey.mockReturnValue(null);

        const out = await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(out).toEqual({ status: 'ERROR', executionId: '' });
    });

    test('returns ERROR when provider does not support scheduled checks', async () => {
        // Branch: isScheduledCheckProvider → false (no runCheck fn)
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider: { id: 'github' } });

        const out = await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(out).toEqual({ status: 'ERROR', executionId: '' });
    });

    test('returns ERROR when no active connection exists', async () => {
        // Branch: connection → null
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider: makeProvider() });
        mPrisma.integrationConnection.findFirst.mockResolvedValue(null);

        const out = await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(out).toEqual({ status: 'ERROR', executionId: '' });
    });

    test('records ERROR when provider.runCheck throws (Error instance)', async () => {
        // Branch: catch → err instanceof Error
        const provider = makeProvider({ runCheck: jest.fn().mockRejectedValue(new Error('boom')) });
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider });
        mPrisma.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', secretEncrypted: null, configJson: {} });
        mPrisma.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
        mPrisma.integrationExecution.update.mockResolvedValue({});

        const out = await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(out).toEqual({ status: 'ERROR', executionId: 'exec-1' });
        const upd = mPrisma.integrationExecution.update.mock.calls[0][0];
        expect(upd.data.status).toBe('ERROR');
        expect(upd.data.errorMessage).toBe('boom');
    });

    test('records ERROR when provider.runCheck throws a non-Error', async () => {
        // Branch: catch → String(err) (non-Error rejection)
        const provider = makeProvider({ runCheck: jest.fn().mockRejectedValue('stringfail') });
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider });
        mPrisma.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', secretEncrypted: null, configJson: {} });
        mPrisma.integrationExecution.create.mockResolvedValue({ id: 'exec-2' });
        mPrisma.integrationExecution.update.mockResolvedValue({});

        const out = await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(out.status).toBe('ERROR');
        expect(mPrisma.integrationExecution.update.mock.calls[0][0].data.errorMessage).toBe('stringfail');
    });

    test('PASSED check with evidence + decrypted secrets + advanced schedule', async () => {
        // Branches: secretEncrypted present (decrypt OK) + evidencePayload present
        //           + result.durationMs present + nextDueAt computed (DAILY)
        mDecrypt.mockReturnValue(JSON.stringify({ token: 'sekret' }));
        const provider = makeProvider({
            runCheck: jest.fn().mockResolvedValue({
                status: 'PASSED',
                summary: 'ok',
                details: { foo: 'bar' },
                durationMs: 42,
            }),
            mapResultToEvidence: jest.fn().mockReturnValue({
                title: 'E', content: 'C', type: 'CONFIGURATION', category: 'integration',
            }),
        });
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider });
        mPrisma.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', secretEncrypted: 'cipher', configJson: { region: 'eu' },
        });
        mPrisma.integrationExecution.create.mockResolvedValue({ id: 'exec-3' });
        mPrisma.integrationExecution.update.mockResolvedValue({});
        mPrisma.evidence.create.mockResolvedValue({ id: 'ev-1' });
        mPrisma.control.update.mockResolvedValue({});

        const out = await executeControlAutomation(makeDueControl({ frequency: 'DAILY' }), 'job-1', NOW);

        expect(out).toEqual({ status: 'PASSED', executionId: 'exec-3' });
        // decrypted secrets merged into connectionConfig
        expect(mDecrypt).toHaveBeenCalledWith('cipher');
        expect(provider.runCheck.mock.calls[0][0].connectionConfig).toMatchObject({ region: 'eu', token: 'sekret' });
        // evidence created and linked
        expect(mPrisma.evidence.create).toHaveBeenCalled();
        expect(mPrisma.integrationExecution.update.mock.calls[0][0].data.evidenceId).toBe('ev-1');
        // duration came from result
        expect(mPrisma.integrationExecution.update.mock.calls[0][0].data.durationMs).toBe(42);
        // schedule advanced one day
        expect(mPrisma.control.update.mock.calls[0][0].data.nextDueAt).toEqual(
            new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
        );
    });

    test('FAILED check without evidence; default category fallback NOT taken; no nextDueAt for AD_HOC frequency', async () => {
        // Branches: evidencePayload null → no evidence row
        //           result.durationMs undefined → fallback to elapsed
        //           computeNextDueAt → null (AD_HOC) → control.update omits nextDueAt
        //           decryptSecrets: secretEncrypted null → {}
        const provider = makeProvider({
            runCheck: jest.fn().mockResolvedValue({
                status: 'FAILED',
                summary: 'nope',
                details: {},
                // no durationMs
            }),
            mapResultToEvidence: jest.fn().mockReturnValue(null),
        });
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider });
        mPrisma.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', secretEncrypted: null, configJson: {},
        });
        mPrisma.integrationExecution.create.mockResolvedValue({ id: 'exec-4' });
        mPrisma.integrationExecution.update.mockResolvedValue({});
        mPrisma.control.update.mockResolvedValue({});

        const out = await executeControlAutomation(makeDueControl({ frequency: 'AD_HOC' }), 'job-1', NOW);

        expect(out).toEqual({ status: 'FAILED', executionId: 'exec-4' });
        expect(mDecrypt).not.toHaveBeenCalled();
        expect(mPrisma.evidence.create).not.toHaveBeenCalled();
        // AD_HOC → no interval → nextDueAt not written
        expect(mPrisma.control.update.mock.calls[0][0].data.nextDueAt).toBeUndefined();
        expect(mPrisma.control.update.mock.calls[0][0].data.lastTested).toBe(NOW);
    });

    test('evidencePayload without category falls back to "integration"', async () => {
        // Branch: evidencePayload.category ?? 'integration'
        const provider = makeProvider({
            runCheck: jest.fn().mockResolvedValue({ status: 'PASSED', summary: 'ok', details: {}, durationMs: 1 }),
            mapResultToEvidence: jest.fn().mockReturnValue({ title: 'E', content: 'C', type: 'LOG' }),
        });
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider });
        mPrisma.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', secretEncrypted: null, configJson: {} });
        mPrisma.integrationExecution.create.mockResolvedValue({ id: 'exec-5' });
        mPrisma.integrationExecution.update.mockResolvedValue({});
        mPrisma.evidence.create.mockResolvedValue({ id: 'ev-2' });
        mPrisma.control.update.mockResolvedValue({});

        await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(mPrisma.evidence.create.mock.calls[0][0].data.category).toBe('integration');
    });

    test("stores the provider's text sanitised, as the manual run does", async () => {
        // Branch class: the scheduled writer composes the same row as the manual
        // one, from the same third-party answer, and must sanitise it the same
        // way — title, body, category, and the JSON block value by value.
        const provider = makeProvider({
            runCheck: jest.fn().mockResolvedValue({ status: 'FAILED', summary: 'x', details: {}, durationMs: 1 }),
            mapResultToEvidence: jest.fn().mockReturnValue({
                title: 'Branch Protection: acme/repo:<img src=x onerror=alert(1)>main',
                content: 'Status checks: <script>alert(1)</script>Build, Lint',
                contentJson: {
                    examples: [{ number: 'CHG<b>7</b> a<b' }],
                    link: 'https://acme.example/change?a=1&region=us',
                },
                type: 'CONFIGURATION',
                category: '<i>integration</i>',
            }),
        });
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider });
        mPrisma.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', secretEncrypted: null, configJson: {} });
        mPrisma.integrationExecution.create.mockResolvedValue({ id: 'exec-s' });
        mPrisma.integrationExecution.update.mockResolvedValue({});
        mPrisma.evidence.create.mockResolvedValue({ id: 'ev-s' });
        mPrisma.control.update.mockResolvedValue({});
        mPrisma.finding.findFirst.mockResolvedValue({ id: 'open-finding' });

        await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        const data = mPrisma.evidence.create.mock.calls[0][0].data;
        expect(data.title).toBe('Branch Protection: acme/repo:main');
        expect(data.category).toBe('integration');
        const head = 'Status checks: Build, Lint\n\n';
        expect(data.content.startsWith(head)).toBe(true);
        expect(JSON.parse(data.content.slice(head.length))).toEqual({
            examples: [{ number: 'CHG7 a' }],
            link: 'https://acme.example/change?a=1&region=us',
        });
    });

    test('decryptSecrets swallows malformed JSON and returns {}', async () => {
        // Branch: JSON.parse throws → catch → {}
        mDecrypt.mockReturnValue('not-json{');
        const provider = makeProvider({
            runCheck: jest.fn().mockResolvedValue({ status: 'PASSED', summary: 'ok', details: {}, durationMs: 1 }),
            mapResultToEvidence: jest.fn().mockReturnValue(null),
        });
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider });
        mPrisma.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', secretEncrypted: 'cipher', configJson: { a: 1 } });
        mPrisma.integrationExecution.create.mockResolvedValue({ id: 'exec-6' });
        mPrisma.integrationExecution.update.mockResolvedValue({});
        mPrisma.control.update.mockResolvedValue({});

        const out = await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(out.status).toBe('PASSED');
        // connectionConfig is just configJson (secrets parsed to {})
        expect(provider.runCheck.mock.calls[0][0].connectionConfig).toEqual({ a: 1 });
    });
});

// ─── runScheduledAutomations ───

describe('runScheduledAutomations', () => {
    test('dryRun returns counts without executing', async () => {
        // Branch: dryRun true → early return, skipped = totalDue
        mPrisma.control.findMany.mockResolvedValue([makeDueControl({ id: 'd1' })]);
        mPrisma.integrationExecution.findFirst.mockResolvedValue(null);

        const res = await runScheduledAutomations({ dryRun: true, now: NOW });

        expect(res).toMatchObject({ totalDue: 1, executed: 0, skipped: 1, dryRun: true });
        expect(mRegistry.canHandle).not.toHaveBeenCalled();
    });

    test('skips controls with no registered provider', async () => {
        // Branch: !registry.canHandle → skipped++ + continue
        mPrisma.control.findMany.mockResolvedValue([makeDueControl({ id: 'd1' })]);
        mPrisma.integrationExecution.findFirst.mockResolvedValue(null);
        mRegistry.canHandle.mockReturnValue(false);

        const res = await runScheduledAutomations({ now: NOW });

        expect(res).toMatchObject({ totalDue: 1, executed: 0, skipped: 1, dryRun: false });
    });

    test('tallies PASSED / FAILED / ERROR results across controls', async () => {
        // Branch: switch arms PASSED / FAILED / ERROR
        mPrisma.control.findMany.mockResolvedValue([
            makeDueControl({ id: 'p' }),
            makeDueControl({ id: 'f' }),
            makeDueControl({ id: 'e' }),
        ]);
        mPrisma.integrationExecution.findFirst.mockResolvedValue(null);
        mRegistry.canHandle.mockReturnValue(true);

        // Drive executeControlAutomation outcomes via runCheck per call.
        const statuses = ['PASSED', 'FAILED', 'PASSED'] as const;
        let i = 0;
        const provider = makeProvider({
            runCheck: jest.fn().mockImplementation(async () => ({
                status: statuses[i++], summary: 's', details: {}, durationMs: 1,
            })),
            mapResultToEvidence: jest.fn().mockReturnValue(null),
        });
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider });
        // third control: no connection → ERROR
        mPrisma.integrationConnection.findFirst
            .mockResolvedValueOnce({ id: 'c1', secretEncrypted: null, configJson: {} })
            .mockResolvedValueOnce({ id: 'c2', secretEncrypted: null, configJson: {} })
            .mockResolvedValueOnce(null);
        mPrisma.integrationExecution.create.mockResolvedValue({ id: 'ex' });
        mPrisma.integrationExecution.update.mockResolvedValue({});
        mPrisma.control.update.mockResolvedValue({});

        const res = await runScheduledAutomations({ now: NOW });

        expect(res).toMatchObject({
            totalDue: 3, executed: 3, passed: 1, failed: 1, errors: 1, skipped: 0, dryRun: false,
        });
    });

    test('counts a thrown executeControlAutomation as an error and continues', async () => {
        // Branch: catch in batch loop → errors++
        mPrisma.control.findMany.mockResolvedValue([makeDueControl({ id: 'boom' })]);
        mPrisma.integrationExecution.findFirst.mockResolvedValue(null);
        mRegistry.canHandle.mockReturnValue(true);
        // Force a throw deep inside executeControlAutomation: create() rejects.
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider: makeProvider({ runCheck: jest.fn() }) });
        mPrisma.integrationConnection.findFirst.mockResolvedValue({ id: 'c', secretEncrypted: null, configJson: {} });
        mPrisma.integrationExecution.create.mockRejectedValue(new Error('db down'));

        const res = await runScheduledAutomations({ now: NOW });

        expect(res).toMatchObject({ totalDue: 1, executed: 0, errors: 1 });
    });

    test('non-Error thrown in batch loop is wrapped via String(err)', async () => {
        // Branch: catch → err instanceof Error ? err : new Error(String(err)) (else side)
        mPrisma.control.findMany.mockResolvedValue([makeDueControl({ id: 'boom2' })]);
        mPrisma.integrationExecution.findFirst.mockResolvedValue(null);
        mRegistry.canHandle.mockReturnValue(true);
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider: makeProvider({ runCheck: jest.fn() }) });
        mPrisma.integrationConnection.findFirst.mockResolvedValue({ id: 'c', secretEncrypted: null, configJson: {} });
        // Reject with a non-Error value so the ternary takes its else branch.
        mPrisma.integrationExecution.create.mockRejectedValue('plain string failure');

        const res = await runScheduledAutomations({ now: NOW });

        expect(res).toMatchObject({ totalDue: 1, executed: 0, errors: 1 });
    });

    test('defaults now and dryRun when options omitted (no due controls)', async () => {
        // Branch: options.now ?? new Date() + options.dryRun ?? false + empty batch
        mPrisma.control.findMany.mockResolvedValue([]);

        const res = await runScheduledAutomations();

        expect(res).toMatchObject({ totalDue: 0, executed: 0, dryRun: false });
        expect(typeof res.jobRunId).toBe('string');
    });
});

// ─── PR-1: FAILED → Finding materialize + reconcile ───

describe('reconcileFindingForCheck (via executeControlAutomation)', () => {
    /** Wire a provider that returns the given status and an evidence payload. */
    function wire(status: 'PASSED' | 'FAILED') {
        const provider = makeProvider({
            runCheck: jest.fn().mockResolvedValue({ status, summary: `sum-${status}`, details: { passed: 1, failed: status === 'FAILED' ? 2 : 0 } }),
            mapResultToEvidence: jest.fn().mockReturnValue({ title: 'E', content: 'C', type: 'CONFIGURATION', category: 'integration' }),
        });
        mRegistry.resolveByAutomationKey.mockReturnValue({ provider });
        mPrisma.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', secretEncrypted: null, configJson: {} });
        mPrisma.integrationExecution.create.mockResolvedValue({ id: 'exec-x' });
        mPrisma.integrationExecution.update.mockResolvedValue({});
        mPrisma.evidence.create.mockResolvedValue({ id: 'ev-1' });
        mPrisma.control.update.mockResolvedValue({});
        return provider;
    }

    test('FAILED opens a de-duplicated Finding tagged INTEGRATION_CHECK', async () => {
        wire('FAILED');
        mPrisma.finding.findFirst.mockResolvedValue(null); // none open yet
        mPrisma.finding.create.mockResolvedValue({ id: 'find-1' });

        await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(mPrisma.finding.findFirst).toHaveBeenCalledTimes(1);
        const where = mPrisma.finding.findFirst.mock.calls[0][0].where;
        expect(where).toMatchObject({
            tenantId: 'tenant-1',
            sourceKind: 'INTEGRATION_CHECK',
            sourceRef: 'ctrl-1:github.branch_protection',
            status: { not: 'CLOSED' },
        });
        expect(mPrisma.finding.create).toHaveBeenCalledTimes(1);
        const data = mPrisma.finding.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            tenantId: 'tenant-1',
            controlId: 'ctrl-1',
            severity: 'MEDIUM',
            type: 'NONCONFORMITY',
            status: 'OPEN',
            sourceKind: 'INTEGRATION_CHECK',
            sourceRef: 'ctrl-1:github.branch_protection',
        });
        expect(data.description).toBe('sum-FAILED');
    });

    test('FAILED stores the provider summary as plain text on the Finding', async () => {
        const provider = wire('FAILED');
        provider.runCheck.mockResolvedValue({
            status: 'FAILED',
            summary: 'Branch <img src=x onerror=alert(1)>main is unprotected',
            details: {},
        });
        mPrisma.finding.findFirst.mockResolvedValue(null);
        mPrisma.finding.create.mockResolvedValue({ id: 'find-1' });

        await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        const data = mPrisma.finding.create.mock.calls[0][0].data;
        expect(data.description).toBe('Branch main is unprotected');
    });

    test('FAILED with an existing open Finding does NOT create a duplicate', async () => {
        wire('FAILED');
        mPrisma.finding.findFirst.mockResolvedValue({ id: 'existing-find' });

        await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(mPrisma.finding.create).not.toHaveBeenCalled();
    });

    test('PASSED reconciles (auto-closes) any still-open Finding for the source', async () => {
        wire('PASSED');
        mPrisma.finding.updateMany.mockResolvedValue({ count: 1 });

        await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(mPrisma.finding.create).not.toHaveBeenCalled();
        expect(mPrisma.finding.updateMany).toHaveBeenCalledTimes(1);
        const call = mPrisma.finding.updateMany.mock.calls[0][0];
        expect(call.where).toMatchObject({
            tenantId: 'tenant-1',
            sourceKind: 'INTEGRATION_CHECK',
            sourceRef: 'ctrl-1:github.branch_protection',
            status: { not: 'CLOSED' },
        });
        expect(call.data.status).toBe('CLOSED');
    });

    test('a Finding-side error never fails the run (fail-safe)', async () => {
        wire('FAILED');
        mPrisma.finding.findFirst.mockRejectedValue(new Error('db down'));

        const out = await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(out.status).toBe('FAILED'); // run still reports the check outcome
    });

    test('auto-created Evidence is mapped to EvidenceType.TEXT (no wider-vocab cast)', async () => {
        wire('PASSED');
        mPrisma.finding.updateMany.mockResolvedValue({ count: 0 });

        await executeControlAutomation(makeDueControl(), 'job-1', NOW);

        expect(mPrisma.evidence.create).toHaveBeenCalledTimes(1);
        // provider.mapResultToEvidence returned type 'CONFIGURATION', but the
        // runner forces the narrow Prisma EvidenceType.TEXT.
        expect(mPrisma.evidence.create.mock.calls[0][0].data.type).toBe('TEXT');
    });
});
