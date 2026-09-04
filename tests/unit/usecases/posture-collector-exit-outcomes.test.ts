/**
 * The posture chain END TO END, from the collector's exit status to the
 * `Evidence` rows a tenant actually gets.
 *
 * WHY A SEPARATE FILE. The two collector suites next to this one inject a fake
 * `provider`, so they can prove what the usecase does with a `CheckResult` but
 * nothing about which runs produce one. The provider suites mock `execFile`, so
 * they prove the verdict but stop before the evidence. Neither could see the
 * defect in #2284, which lived exactly in the join: powerpipe returns exit 1
 * for "one or more alarms" — the routine outcome of any benchmark with a single
 * failing control — the collectors refused every non-zero exit before parsing,
 * and so NO posture evidence was ever created for a real account, and the
 * FAILED arm of the verdict ladder was unreachable in production.
 *
 * Every test here therefore drives the REAL provider with a mocked `execFile`
 * and reads the fake db the usecase wrote to. The two halves that must stay
 * true together are (a) a completed run is scored and evidenced, and (b) a run
 * that did not complete still yields ERROR and no evidence at all.
 */
const execFileMock = jest.fn();
jest.mock('node:child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));
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

import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db-context';
import { decryptField } from '@/lib/security/encryption';
import { runAwsPostureCollection } from '@/app-layer/usecases/aws-posture';
import { runCloudPostureCollection } from '@/app-layer/usecases/cloud-posture';
import { GcpPostureProvider } from '@/app-layer/integrations/providers/gcp-posture-provider';
import { GCP_POSTURE_CONTROL_MAP } from '@/data/integrations/gcp-posture-control-map';
import {
    powerpipeBenchmarkJson,
    powerpipeControl,
    powerpipeErroredControl,
} from '../../helpers/powerpipe-benchmark-fixture';

const runInTenant = runInTenantContext as unknown as jest.Mock;
const decrypt = decryptField as unknown as jest.Mock;

const TENANT = 'tenant-exit-1';
const CONN = 'conn-exit-1';
const EXEC = 'exec-exit-1';
const CTL = 'ctl-covering';
const NOW = new Date('2026-09-04T03:00:00.000Z');

/** A control the AWS crosswalk covers, so a PASS on it mints evidence. */
const AWS_MAPPED = 'iam_root_user_mfa_enabled';
/** The GCP equivalent. */
const GCP_MAPPED = 'iam_service_account_no_user_managed_key';

type Cb = (err: unknown, stdout: string, stderr: string) => void;

/** Resolve the next `execFile` call the way Node would for this outcome. */
function collectorRun(opts: { err?: unknown; stdout?: string; stderr?: string }) {
    execFileMock.mockImplementationOnce(
        (_file: string, _args: string[], _o: unknown, cb: Cb) => {
            cb(opts.err ?? null, opts.stdout ?? '', opts.stderr ?? '');
        },
    );
}

const exitedWith = (code: number) => Object.assign(new Error('exited'), { code });
const killedBy = (signal: string) => Object.assign(new Error('killed'), { signal });

function makeDb() {
    let evSeq = 0;
    const db = {
        integrationConnection: {
            findFirst: jest.fn(async () => ({
                id: CONN,
                configJson: { benchmark: 'soc2', projectId: 'p' },
                secretEncrypted: 'blob',
                isEnabled: true,
            })),
        },
        integrationExecution: {
            create: jest.fn(async () => ({ id: EXEC })),
            update: jest.fn(async () => ({ id: EXEC })),
        },
        controlRequirementLink: {
            findFirst: jest.fn(async () => ({ controlId: CTL })),
        },
        evidence: {
            findFirst: jest.fn(async () => null as { id: string } | null),
            create: jest.fn(async () => ({ id: `ev-${++evSeq}` })),
            update: jest.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })),
        },
        evidenceControlLink: { create: jest.fn(async () => ({ id: 'ecl-1' })) },
        controlEvidenceLink: { create: jest.fn(async () => ({ id: 'cel-1' })) },
    };
    runInTenant.mockImplementation(
        (_ctx: RequestContext, cb: (d: PrismaTx) => Promise<unknown>) => cb(db as unknown as PrismaTx),
    );
    return db;
}

/** What the execution row was finally updated with. */
function persisted(db: ReturnType<typeof makeDb>) {
    const calls = db.integrationExecution.update.mock.calls as unknown as Array<
        [{ data: { status: string; resultJson: Record<string, unknown>; evidenceId: string | null } }]
    >;
    return calls[calls.length - 1][0].data;
}

beforeEach(() => {
    jest.clearAllMocks();
    decrypt.mockReturnValue('{}');
});

// ═══ AWS ═════════════════════════════════════════════════════════════

describe('aws-posture — a benchmark that ALARMED reaches the tenant', () => {
    /** The shape every real account produces: something passes, something does not. */
    const alarming = powerpipeBenchmarkJson('aws_compliance.benchmark.soc_2', {
        controls: [
            powerpipeControl(AWS_MAPPED, 'ok'),
            powerpipeControl('s3_bucket_public_access_blocked', 'alarm'),
        ],
    });

    it('exit 1 produces a FAILED verdict AND creates the passing control\'s evidence', async () => {
        // Before #2284 this exact input returned ERROR with zero evidence: the
        // `!res.ok` gate refused the run before `JSON.parse`, so the alarm was
        // never counted and the passing control was never evidenced. A tenant
        // saw the same thing as a dead collector host.
        const db = makeDb();
        collectorRun({ err: exitedWith(1), stdout: alarming });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('FAILED');
        expect(res.counts).toMatchObject({ ok: 1, alarm: 1, error: 0, total: 2 });
        expect(res.evidenceCreated).toBe(1);
        expect(db.evidence.create).toHaveBeenCalledTimes(1);
        expect(db.evidenceControlLink.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ controlId: CTL, evidenceId: 'ev-1' }) }),
        );
    });

    it('the alarming control is NOT evidenced — only the passing one is', async () => {
        // Parsing exit 1 must not turn into evidencing everything the run
        // mentioned. The pass-only rule in the usecase is what keeps a failing
        // control from being filed as proof it passed.
        const db = makeDb();
        collectorRun({ err: exitedWith(1), stdout: alarming });

        await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        const created = db.evidence.create.mock.calls as unknown as Array<[{ data: { content: string; category: string } }]>;
        expect(created).toHaveLength(1);
        expect(created[0][0].data.category).toBe(`aws-posture:${AWS_MAPPED}`);
        expect(created[0][0].data.content).toContain(AWS_MAPPED);
        expect(created[0][0].data.content).not.toContain('s3_bucket_public_access_blocked');
    });

    it('the persisted execution row carries the verdict and the collector exit code', async () => {
        // `resultJson` is the only durable record of the run, so the code the
        // collector reported has to survive into it — otherwise an operator
        // reading the execution ledger cannot tell an exit 1 from an exit 2.
        const db = makeDb();
        collectorRun({ err: exitedWith(1), stdout: alarming });

        await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        const data = persisted(db);
        expect(data.status).toBe('FAILED');
        expect(data.evidenceId).toBe('ev-1');
        expect(data.resultJson).toMatchObject({
            counts: { ok: 1, alarm: 1, skip: 0, error: 0, unknown: 0, total: 2 },
            collectorExitCode: 1,
        });
    });

    it('exit 0 on an all-passing benchmark PASSES and evidences, with no exit code recorded', async () => {
        // The counterweight: a clean run is unchanged by all of this, and its
        // summary carries no collector diagnostics because there are none.
        const db = makeDb();
        collectorRun({
            stdout: powerpipeBenchmarkJson('aws_compliance.benchmark.soc_2', {
                controls: [powerpipeControl(AWS_MAPPED, 'ok')],
            }),
        });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('PASSED');
        expect(res.evidenceCreated).toBe(1);
        expect(persisted(db).resultJson).not.toHaveProperty('collectorExitCode');
    });
});

describe('aws-posture — a run that did NOT complete still yields nothing', () => {
    /** Valid, all-passing JSON: a leak past the gate would show as PASSED + evidence. */
    const wouldHavePassed = powerpipeBenchmarkJson('aws_compliance.benchmark.soc_2', {
        controls: [powerpipeControl(AWS_MAPPED, 'ok')],
    });

    it('a SIGTERM (the 15-minute timeout) → ERROR, and no evidence is created', async () => {
        const db = makeDb();
        collectorRun({ err: killedBy('SIGTERM'), stdout: wouldHavePassed });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('ERROR');
        expect(res.evidenceCreated).toBe(0);
        expect(db.evidence.create).not.toHaveBeenCalled();
        expect(db.controlRequirementLink.findFirst).not.toHaveBeenCalled();
        expect(persisted(db).resultJson).toMatchObject({ collectorSignal: 'SIGTERM' });
    });

    it('an exit code outside {0,1,2} → ERROR, and no evidence is created', async () => {
        const db = makeDb();
        collectorRun({ err: exitedWith(137), stdout: wouldHavePassed, stderr: 'OOM-killed' });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('ERROR');
        expect(res.evidenceCreated).toBe(0);
        expect(db.evidence.create).not.toHaveBeenCalled();
        expect(persisted(db).resultJson).toMatchObject({ collectorExitCode: 137 });
    });

    it('a missing powerpipe binary → ERROR, and no evidence is created', async () => {
        const db = makeDb();
        collectorRun({ err: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), stdout: wouldHavePassed });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('ERROR');
        expect(res.evidenceCreated).toBe(0);
        expect(db.evidence.create).not.toHaveBeenCalled();
    });
});

describe('aws-posture — exit 2, the collector reporting control errors', () => {
    it('an errored control alongside a passing one → ERROR, and nothing is evidenced', async () => {
        // The run completed, so its JSON is read rather than discarded — and
        // the existing ladder does the rest: an errored control is not a
        // passing one, and an ERROR verdict evidences nothing at all.
        const db = makeDb();
        collectorRun({
            err: exitedWith(2),
            stdout: powerpipeBenchmarkJson('aws_compliance.benchmark.soc_2', {
                controls: [powerpipeControl(AWS_MAPPED, 'ok'), powerpipeErroredControl('cloudtrail_enabled')],
            }),
        });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('ERROR');
        expect(res.counts).toMatchObject({ ok: 1, error: 1, total: 2 });
        expect(res.evidenceCreated).toBe(0);
        expect(db.evidence.create).not.toHaveBeenCalled();
        expect(persisted(db).resultJson).toMatchObject({ collectorExitCode: 2 });
    });

    it('alarms alongside the errored control → FAILED, and the passing control IS evidenced', async () => {
        // Refusing exit 2 outright would discard every alarm in the run. The
        // findings are real and the operator needs them.
        const db = makeDb();
        collectorRun({
            err: exitedWith(2),
            stdout: powerpipeBenchmarkJson('aws_compliance.benchmark.soc_2', {
                controls: [
                    powerpipeControl(AWS_MAPPED, 'ok'),
                    powerpipeControl('s3_bucket_public_access_blocked', 'alarm'),
                    powerpipeErroredControl('cloudtrail_enabled'),
                ],
            }),
        });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('FAILED');
        expect(res.evidenceCreated).toBe(1);
    });

    it('an all-passing payload at exit 2 is NEVER PASSED, and evidences nothing', async () => {
        // The collector counted a control error our parse did not. We do not
        // certify an account over a disagreement about what happened — and the
        // ERROR verdict is what stops the evidence loop from running.
        const db = makeDb();
        collectorRun({
            err: exitedWith(2),
            stdout: powerpipeBenchmarkJson('aws_compliance.benchmark.soc_2', {
                controls: [powerpipeControl(AWS_MAPPED, 'ok')],
            }),
        });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('ERROR');
        expect(res.counts).toMatchObject({ ok: 1, alarm: 0, error: 0, total: 1 });
        expect(res.evidenceCreated).toBe(0);
        expect(db.evidence.create).not.toHaveBeenCalled();
    });
});

// ═══ GCP — the same chain through the SHARED core ════════════════════

describe('cloud-posture — the shared core carries the same outcomes', () => {
    const collect = () =>
        runCloudPostureCollection({
            cloud: 'gcp-posture',
            tenantId: TENANT,
            connectionId: CONN,
            provider: new GcpPostureProvider(),
            controlMap: GCP_POSTURE_CONTROL_MAP,
            now: NOW,
        });

    it('exit 1 produces FAILED and creates evidence for the passing control', async () => {
        // Azure and GCP go through `powerpipe-core.ts`, a different file from
        // the AWS provider. Both carried the same `!res.ok` gate, so both had
        // the defect, and asserting it in one place would have left the other.
        const db = makeDb();
        collectorRun({
            err: exitedWith(1),
            stdout: powerpipeBenchmarkJson('gcp_compliance.benchmark.soc_2', {
                controls: [
                    powerpipeControl(`gcp_compliance.control.${GCP_MAPPED}`, 'ok'),
                    powerpipeControl('gcp_compliance.control.storage_bucket_not_publicly_accessible', 'alarm'),
                ],
            }),
        });

        const res = await collect();

        expect(res.status).toBe('FAILED');
        expect(res.evidenceCreated).toBe(1);
        expect(db.evidence.create).toHaveBeenCalledTimes(1);
        expect(persisted(db).resultJson).toMatchObject({ collectorExitCode: 1 });
    });

    it('a SIGTERM → ERROR with no evidence, even on all-passing stdout', async () => {
        const db = makeDb();
        collectorRun({
            err: killedBy('SIGTERM'),
            stdout: powerpipeBenchmarkJson('gcp_compliance.benchmark.soc_2', {
                controls: [powerpipeControl(`gcp_compliance.control.${GCP_MAPPED}`, 'ok')],
            }),
        });

        const res = await collect();

        expect(res.status).toBe('ERROR');
        expect(res.evidenceCreated).toBe(0);
        expect(db.evidence.create).not.toHaveBeenCalled();
    });
});
