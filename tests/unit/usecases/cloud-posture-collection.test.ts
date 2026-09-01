/**
 * Behavioural coverage for `runCloudPostureCollection` — the cloud-agnostic
 * collector behind the `azure-posture-collect` / `gcp-posture-collect`
 * scheduled jobs.
 *
 * Same argument as `aws-posture-collection.test.ts`: this runs unattended, and
 * its only artefacts are one `IntegrationExecution` row and the auto-collected
 * `Evidence` it attaches. The cloud-specific half is what is worth pinning
 * here — every persisted string (`automationKey`, evidence `category`, the
 * back-reference `note`) is derived from the injected `cloud` prefix, so a
 * regression there cross-labels Azure evidence as GCP with nothing to notice.
 */
import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';

jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantContext: jest.fn(),
}));
jest.mock('@/lib/security/encryption', () => ({
    ...jest.requireActual('@/lib/security/encryption'),
    decryptField: jest.fn(),
}));
jest.mock('@/app-layer/integrations/connection-health', () => ({
    markAuthFailure: jest.fn(),
    clearAuthFailure: jest.fn(),
}));

import { runInTenantContext } from '@/lib/db-context';
import { decryptField } from '@/lib/security/encryption';
import { markAuthFailure, clearAuthFailure } from '@/app-layer/integrations/connection-health';
import { IntegrationRateLimitedError } from '@/app-layer/integrations/http-resilience';
import { runCloudPostureCollection } from '@/app-layer/usecases/cloud-posture';
import type { CloudPostureControlMapEntry } from '@/app-layer/integrations/cloud-posture/powerpipe-core';
import type { CheckResult } from '@/app-layer/integrations/types';

const runInTenant = runInTenantContext as unknown as jest.Mock;
const decrypt = decryptField as unknown as jest.Mock;
const markAuth = markAuthFailure as unknown as jest.Mock;
const clearAuth = clearAuthFailure as unknown as jest.Mock;

const CLOUD = 'azure-posture';
const TENANT = 'tenant-cloud-1';
const CONN = 'conn-az-1';
const NOW = new Date('2026-03-01T12:00:00.000Z');
/** EVIDENCE_FRESHNESS_DAYS = 30 after NOW. */
const THIRTY_DAYS = new Date('2026-03-31T12:00:00.000Z');

/** Crosswalk injected by the caller — the collector itself is map-agnostic. */
const DUAL = 'storage_account_encryption_enabled';
const SOC2_ONLY = 'keyvault_logging_enabled';
const CONTROL_MAP: Record<string, CloudPostureControlMapEntry> = {
    [DUAL]: { label: 'Storage encrypted', soc2: ['CC6.1'], nistCsf: ['PR.DS-01'] },
    [SOC2_ONLY]: { label: 'Key Vault logging', soc2: ['CC7.1'] },
};

interface Conn {
    id: string;
    configJson: Record<string, unknown> | null;
    secretEncrypted: string | null;
}

function makeDb(conn: Conn | null) {
    let evSeq = 0;
    return {
        integrationConnection: { findFirst: jest.fn(async () => conn) },
        integrationExecution: {
            create: jest.fn(async () => ({ id: 'exec-9' })),
            update: jest.fn(async () => ({ id: 'exec-9' })),
        },
        controlRequirementLink: {
            findFirst: jest.fn(async () => null as { controlId: string | null } | null),
        },
        evidence: {
            findFirst: jest.fn(async () => null as { id: string } | null),
            create: jest.fn(async () => ({ id: `ev-${++evSeq}` })),
            update: jest.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })),
        },
        evidenceControlLink: { create: jest.fn(async () => ({ id: 'ecl-1' })) },
        controlEvidenceLink: { create: jest.fn(async () => ({ id: 'cel-1' })) },
    };
}

type Db = ReturnType<typeof makeDb>;

function bind(db: Db) {
    runInTenant.mockImplementation(
        (_ctx: RequestContext, cb: (d: PrismaTx) => Promise<unknown>) =>
            cb(db as unknown as PrismaTx),
    );
}

function providerReturning(result: CheckResult) {
    return { runCheck: jest.fn(async () => result) };
}
function providerThrowing(err: unknown) {
    return {
        runCheck: jest.fn(async () => {
            throw err;
        }),
    };
}
function checkResult(over: Partial<CheckResult> = {}): CheckResult {
    return { status: 'PASSED', summary: 's', details: {}, ...over };
}

/** Every call needs the same four injected inputs; only the deltas vary. */
function run(over: Partial<Parameters<typeof runCloudPostureCollection>[0]> = {}) {
    return runCloudPostureCollection({
        cloud: CLOUD,
        tenantId: TENANT,
        connectionId: CONN,
        provider: providerReturning(checkResult()),
        controlMap: CONTROL_MAP,
        now: NOW,
        ...over,
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    decrypt.mockReturnValue('{}');
    markAuth.mockResolvedValue(false);
    clearAuth.mockResolvedValue(undefined);
});

describe('runCloudPostureCollection — connection resolution', () => {
    it('scopes the lookup to the tenant AND the cloud, and records an ERROR row when it misses', async () => {
        // Regression class: dropping `provider` from the where would let the
        // Azure job pick up (and run its Azure benchmark against) a GCP
        // connection's credentials.
        const db = makeDb(null);
        bind(db);

        const res = await run();

        expect(db.integrationConnection.findFirst).toHaveBeenCalledWith({
            where: { id: CONN, tenantId: TENANT, provider: CLOUD },
            select: { id: true, configJson: true, secretEncrypted: true },
        });
        expect(db.integrationExecution.create).toHaveBeenCalledWith({
            data: {
                tenantId: TENANT,
                provider: CLOUD,
                automationKey: `${CLOUD}.unknown`,
                status: 'ERROR',
                errorMessage: 'Connection not found',
                triggeredBy: 'scheduled',
                completedAt: NOW,
            },
        });
        expect(res).toStrictEqual({
            executionId: 'exec-9',
            status: 'ERROR',
            counts: null,
            evidenceCreated: 0,
            errorMessage: 'Connection not found',
        });
        expect(clearAuth).not.toHaveBeenCalled();
    });

    it('builds the JOB context from the caller tenant and the cloud label', async () => {
        // Regression class: the RLS binding + the greppable job identity that is
        // the only way to tell an Azure pass from a GCP pass in the logs.
        const db = makeDb(null);
        bind(db);

        // `now` omitted on purpose — exercises the injection default too.
        await run({ cloud: 'gcp-posture', now: undefined });

        const ctx = runInTenant.mock.calls[0][0] as RequestContext;
        expect(ctx.tenantId).toBe(TENANT);
        expect(ctx.requestId).toBe(`gcp-posture-posture-${TENANT}`);
        expect(ctx.actorType).toBe('JOB');
        expect(db.integrationExecution.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ completedAt: expect.any(Date) }) }),
        );
    });

    it('defaults an absent configJson to the soc2 benchmark with no secrets', async () => {
        const db = makeDb({ id: CONN, configJson: null, secretEncrypted: null });
        bind(db);
        const provider = providerReturning(checkResult());

        const res = await run({ provider });

        expect(db.integrationExecution.create).toHaveBeenCalledWith({
            data: {
                tenantId: TENANT,
                connectionId: CONN,
                provider: CLOUD,
                automationKey: `${CLOUD}.soc2`,
                status: 'RUNNING',
                triggeredBy: 'scheduled',
                executedAt: NOW,
            },
        });
        expect(provider.runCheck).toHaveBeenCalledWith({
            automationKey: `${CLOUD}.soc2`,
            parsed: { provider: CLOUD, checkType: 'soc2', raw: `${CLOUD}.soc2` },
            tenantId: TENANT,
            connectionConfig: {},
            triggeredBy: 'scheduled',
        });
        expect(decrypt).not.toHaveBeenCalled();
        expect(res.counts).toBeNull();
    });

    it('coerces a non-string benchmark and lowercases it before building the automation key', async () => {
        // Regression class: `configJson` is untyped JSON. Without the String()
        // coercion a numeric benchmark throws OUTSIDE the try block, so the
        // RUNNING execution row is never completed and the job dies silently.
        const db = makeDb({ id: CONN, configJson: { benchmark: 2 }, secretEncrypted: null });
        bind(db);

        await run();

        expect(db.integrationExecution.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ automationKey: `${CLOUD}.2` }) }),
        );
    });

    it('lowercases the benchmark and merges the decrypted secrets into the provider config', async () => {
        const db = makeDb({ id: CONN, configJson: { benchmark: 'CIS', subscriptionId: 'sub-1' }, secretEncrypted: 'cipher-blob' });
        bind(db);
        decrypt.mockReturnValue(JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }));
        const provider = providerReturning(checkResult());

        await run({ provider });

        expect(decrypt).toHaveBeenCalledWith('cipher-blob');
        expect(provider.runCheck).toHaveBeenCalledWith(
            expect.objectContaining({
                automationKey: `${CLOUD}.cis`,
                connectionConfig: { benchmark: 'CIS', subscriptionId: 'sub-1', clientId: 'cid', clientSecret: 'csecret' },
            }),
        );
    });
});

describe('runCloudPostureCollection — provider throw', () => {
    it('truncates the persisted error, marks the credential with the cloud label, and blocks the retry', async () => {
        // Regression class: `noRetry` must follow the error class. A rate-limit
        // past the absorb budget re-queued immediately hammers the provider.
        const db = makeDb({ id: CONN, configJson: {}, secretEncrypted: null });
        bind(db);
        const err = new IntegrationRateLimitedError(`https://management.azure.com/${'x'.repeat(700)}`, 30_000);
        expect(err.message.length).toBeGreaterThan(500);

        const res = await run({ provider: providerThrowing(err) });

        expect(markAuth).toHaveBeenCalledWith(db, CONN, err, NOW, CLOUD);
        expect(db.integrationExecution.update).toHaveBeenCalledWith({
            where: { id: 'exec-9' },
            data: { status: 'ERROR', errorMessage: err.message.slice(0, 500), durationMs: expect.any(Number), completedAt: expect.any(Date) },
        });
        expect(res).toStrictEqual({
            executionId: 'exec-9',
            status: 'ERROR',
            counts: null,
            evidenceCreated: 0,
            errorMessage: err.message.slice(0, 500),
            noRetry: true,
        });
        expect(res.errorMessage).toHaveLength(500);
        expect(clearAuth).not.toHaveBeenCalled();
    });

    it('stringifies a non-Error throw and leaves the queue free to retry', async () => {
        const db = makeDb({ id: CONN, configJson: {}, secretEncrypted: null });
        bind(db);

        const res = await run({ provider: providerThrowing({ toString: () => 'weird failure' }) });

        expect(res).toStrictEqual({
            executionId: 'exec-9',
            status: 'ERROR',
            counts: null,
            evidenceCreated: 0,
            errorMessage: 'weird failure',
            noRetry: false,
        });
    });
});

describe('runCloudPostureCollection — evidence collection', () => {
    const passing = checkResult({
        status: 'PASSED',
        details: {
            counts: { ok: 2, alarm: 0, skip: 0, error: 0, total: 2 },
            controls: [{ id: DUAL, status: 'ok' }],
        },
    });

    function connDb() {
        const db = makeDb({ id: CONN, configJson: { benchmark: 'soc2' }, secretEncrypted: null });
        bind(db);
        return db;
    }

    it('labels every persisted string with the injected cloud prefix', async () => {
        // Regression class: `category`, `content` and the back-reference `note`
        // are the ONLY thing distinguishing Azure evidence from GCP evidence on
        // the same control. A hard-coded prefix cross-labels them silently.
        const db = connDb();
        db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: 'ctl-shared' });

        const res = await run({ provider: providerReturning(passing) });

        expect(res.evidenceCreated).toBe(1);
        expect(db.evidence.create).toHaveBeenCalledWith({
            data: {
                tenantId: TENANT,
                type: 'TEXT',
                title: `Automated evidence — ${DUAL}`,
                content: `${CLOUD} check "${DUAL}" PASSED (${CLOUD}.soc2) on 2026-03-01. Machine-collected via Powerpipe; execution exec-9.`,
                category: `${CLOUD}:${DUAL}`,
                dateCollected: NOW,
                reviewCycle: 'MONTHLY',
                nextReviewDate: THIRTY_DAYS,
                status: 'APPROVED',
            },
        });
        expect(db.evidenceControlLink.create).toHaveBeenCalledWith({
            data: { tenantId: TENANT, evidenceId: 'ev-1', controlId: 'ctl-shared', createdByUserId: null },
        });
        expect(db.controlEvidenceLink.create).toHaveBeenCalledWith({
            data: { tenantId: TENANT, controlId: 'ctl-shared', kind: 'INTEGRATION_RESULT', integrationResultId: 'exec-9', note: `${CLOUD}: ${DUAL}` },
        });
        expect(db.integrationExecution.update).toHaveBeenCalledWith({
            where: { id: 'exec-9' },
            data: {
                status: 'PASSED',
                resultJson: passing.details,
                evidenceId: 'ev-1',
                errorMessage: null,
                durationMs: expect.any(Number),
                completedAt: expect.any(Date),
            },
        });
        expect(clearAuth).toHaveBeenCalledWith(db, CONN, CLOUD);
    });

    it('fans a dual-framework control out to both installed frameworks and pins the first evidence row', async () => {
        // Regression class: the injected map drives WHICH requirement codes are
        // looked up. `firstEvidenceId ?? ev.id` must keep the first, not the last.
        const db = connDb();
        db.controlRequirementLink.findFirst
            .mockResolvedValueOnce({ controlId: 'ctl-soc2' })
            .mockResolvedValueOnce({ controlId: 'ctl-nist' });

        const res = await run({ provider: providerReturning(passing) });

        expect(db.controlRequirementLink.findFirst).toHaveBeenNthCalledWith(1, {
            where: { tenantId: TENANT, requirement: { framework: { key: 'SOC2' }, code: { in: ['CC6.1'] } } },
            select: { controlId: true },
        });
        expect(db.controlRequirementLink.findFirst).toHaveBeenNthCalledWith(2, {
            where: { tenantId: TENANT, requirement: { framework: { key: 'NIST-CSF-2.0' }, code: { in: ['PR.DS-01'] } } },
            select: { controlId: true },
        });
        expect(res.evidenceCreated).toBe(2);
        expect(db.integrationExecution.update).toHaveBeenCalledWith({
            where: { id: 'exec-9' },
            data: expect.objectContaining({ evidenceId: 'ev-1' }),
        });
    });

    it('keeps evidencing the controls that FOLLOW a failing one, honouring their own map entry', async () => {
        // Regression class: `continue` vs `break` in the pass-only filter — a
        // `break` under-collects everything after the first alarm while still
        // reporting a well-formed result. The trailing control is SOC2-only, so
        // this also pins that a single-framework map entry triggers exactly one
        // requirement lookup rather than a speculative NIST one.
        const db = connDb();
        db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: 'ctl-after' });
        const trailing = checkResult({
            status: 'FAILED',
            details: {
                counts: { ok: 1, alarm: 1, skip: 0, error: 0, total: 2 },
                controls: [
                    { id: DUAL, status: 'alarm' },
                    { id: SOC2_ONLY, status: 'ok' },
                ],
            },
        });

        const res = await run({ provider: providerReturning(trailing) });

        expect(res.evidenceCreated).toBe(1);
        expect(db.controlRequirementLink.findFirst).toHaveBeenCalledTimes(1);
        expect(db.controlRequirementLink.findFirst).toHaveBeenCalledWith({
            where: { tenantId: TENANT, requirement: { framework: { key: 'SOC2' }, code: { in: ['CC7.1'] } } },
            select: { controlId: true },
        });
        expect(db.evidence.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ category: `${CLOUD}:${SOC2_ONLY}` }) }),
        );
    });

    it('never evidences an alarming, skipped, or unmapped control', async () => {
        const db = connDb();
        db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: 'ctl-soc2' });
        const mixed = checkResult({
            status: 'FAILED',
            details: {
                counts: { ok: 1, alarm: 1, skip: 1, error: 0, total: 3 },
                controls: [
                    { id: DUAL, status: 'alarm' },
                    { id: SOC2_ONLY, status: 'skip' },
                    { id: 'absent_from_the_injected_map', status: 'ok' },
                ],
            },
        });

        const res = await run({ provider: providerReturning(mixed) });

        expect(db.controlRequirementLink.findFirst).not.toHaveBeenCalled();
        expect(db.evidence.create).not.toHaveBeenCalled();
        expect(res).toStrictEqual({
            executionId: 'exec-9',
            status: 'FAILED',
            counts: { ok: 1, alarm: 1, skip: 1, error: 0, total: 3 },
            evidenceCreated: 0,
            errorMessage: undefined,
        });
    });

    it('skips a framework with no covering control, whether the link or its controlId is null', async () => {
        const db = connDb();
        db.controlRequirementLink.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ controlId: null });

        const res = await run({ provider: providerReturning(passing) });

        expect(db.evidence.findFirst).not.toHaveBeenCalled();
        expect(res.evidenceCreated).toBe(0);
    });

    it('evidences a control covered under both frameworks exactly once', async () => {
        const db = connDb();
        db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: 'ctl-shared' });

        const res = await run({ provider: providerReturning(passing) });

        expect(db.controlRequirementLink.findFirst).toHaveBeenCalledTimes(2);
        expect(res.evidenceCreated).toBe(1);
        expect(db.evidence.create).toHaveBeenCalledTimes(1);
    });

    it('refreshes the existing rolling row instead of creating a duplicate', async () => {
        const db = connDb();
        db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: 'ctl-shared' });
        db.evidence.findFirst.mockResolvedValue({ id: 'ev-existing' });

        const res = await run({ provider: providerReturning(passing) });

        expect(db.evidence.findFirst).toHaveBeenCalledWith({
            where: {
                tenantId: TENANT,
                evidenceControlLinks: { some: { controlId: 'ctl-shared' } },
                category: `${CLOUD}:${DUAL}`,
                type: 'TEXT',
                isArchived: false,
                deletedAt: null,
            },
            select: { id: true },
        });
        expect(db.evidence.update).toHaveBeenCalledWith({
            where: { id: 'ev-existing' },
            data: {
                title: `Automated evidence — ${DUAL}`,
                content: `${CLOUD} check "${DUAL}" PASSED (${CLOUD}.soc2) on 2026-03-01. Machine-collected via Powerpipe; execution exec-9.`,
                dateCollected: NOW,
                nextReviewDate: THIRTY_DAYS,
                status: 'APPROVED',
            },
        });
        expect(db.evidence.create).not.toHaveBeenCalled();
        expect(db.evidenceControlLink.create).not.toHaveBeenCalled();
        expect(db.controlEvidenceLink.create).not.toHaveBeenCalled();
        expect(res.evidenceCreated).toBe(1);
    });

    it('keeps the FIRST refreshed row as the execution evidence when several are refreshed', async () => {
        // Regression class: the update arm carries its own `firstEvidenceId ??`.
        const db = connDb();
        db.controlRequirementLink.findFirst
            .mockResolvedValueOnce({ controlId: 'ctl-soc2' })
            .mockResolvedValueOnce({ controlId: 'ctl-nist' });
        db.evidence.findFirst
            .mockResolvedValueOnce({ id: 'ev-old-a' })
            .mockResolvedValueOnce({ id: 'ev-old-b' });

        const res = await run({ provider: providerReturning(passing) });

        expect(db.evidence.update).toHaveBeenCalledTimes(2);
        expect(db.evidence.create).not.toHaveBeenCalled();
        expect(res.evidenceCreated).toBe(2);
        expect(db.integrationExecution.update).toHaveBeenCalledWith({
            where: { id: 'exec-9' },
            data: expect.objectContaining({ evidenceId: 'ev-old-a' }),
        });
    });

    it('completes the run when the control↔execution back-reference is a duplicate', async () => {
        const db = connDb();
        db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: 'ctl-shared' });
        db.controlEvidenceLink.create.mockRejectedValue(new Error('Unique constraint failed'));

        const res = await run({ provider: providerReturning(passing) });

        expect(res.evidenceCreated).toBe(1);
        expect(res.status).toBe('PASSED');
        expect(db.integrationExecution.update).toHaveBeenCalledTimes(1);
    });

    it('collects no evidence from an ERRORed run and records the truncated provider error', async () => {
        // Regression class: an ERROR result means the subscription was never
        // observed. Evidencing its `controls` asserts a pass nobody saw.
        const db = connDb();
        db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: 'ctl-shared' });
        const errored = checkResult({
            status: 'ERROR',
            errorMessage: `collector error; stderr: ${'z'.repeat(600)}`,
            details: { counts: { ok: 1, alarm: 0, skip: 0, error: 0, total: 1 }, controls: [{ id: DUAL, status: 'ok' }] },
        });

        const res = await run({ provider: providerReturning(errored) });

        expect(db.controlRequirementLink.findFirst).not.toHaveBeenCalled();
        expect(db.evidence.create).not.toHaveBeenCalled();
        expect(res.evidenceCreated).toBe(0);
        expect(res.status).toBe('ERROR');
        const persisted = `collector error; stderr: ${'z'.repeat(600)}`.slice(0, 500);
        expect(persisted).toHaveLength(500);
        expect(db.integrationExecution.update).toHaveBeenCalledWith({
            where: { id: 'exec-9' },
            data: expect.objectContaining({ status: 'ERROR', evidenceId: null, errorMessage: persisted }),
        });
    });
});
