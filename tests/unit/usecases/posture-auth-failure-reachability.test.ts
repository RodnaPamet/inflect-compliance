/**
 * #2252 — what a posture collector says about a CREDENTIAL, and what it must
 * not do about one.
 *
 * WHY THIS FILE EXISTS. `markAuthFailure` is called from exactly one place in
 * each posture usecase: the `catch` around `provider.runCheck`. Neither posture
 * provider throws — every failure arm RETURNS `{status:'ERROR'}` and the CLI
 * runner resolves its callback rather than rejecting — so that catch is never
 * entered and the revoked-credential banner can never be raised for a posture
 * connection. The neighbouring suites cannot see that: the two collection
 * suites inject a FAKE provider and reach `markAuthFailure` only by making the
 * fake throw, and the provider suites mock `execFile` but stop at the
 * `CheckResult`, before the connection exists. So every test here drives the
 * REAL provider with a mocked `execFile` and asserts on the mocked
 * `connection-health` module.
 *
 * WHAT IS PINNED, and why it is deliberately NOT a trigger. The fix for #2252
 * ships the LEGIBILITY half only. A completed run in which not one control
 * produced an observation is now recorded — `noControlObserved: true` in
 * `resultJson`, beside a COUNTS-ONLY `errorMessage` — and nothing acts on it.
 * The two halves that must stay true together are:
 *
 *   (a) the all-errored run is legible: ERROR, counts-only message, breadth
 *       fact in resultJson, and ZERO `markAuthFailure` calls;
 *   (b) a run that observed anything never claims the breadth fact and still
 *       clears the banner — asserted with the verbatim opt-in-region
 *       `AuthFailure` string on an errored control, which is the text a naive
 *       trigger would have fired on (steampipe-plugin-aws#75).
 *
 * The zero-call assertions are the load-bearing ones. They fail the moment
 * someone wires a trigger, which is the point: `authFailedAt` /
 * `authFailureReason` have no reader anywhere in the product, so a trigger
 * would raise nothing visible while stopping the nightly retry.
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
import { markAuthFailure, clearAuthFailure } from '@/app-layer/integrations/connection-health';
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
const markAuth = markAuthFailure as unknown as jest.Mock;
const clearAuth = clearAuthFailure as unknown as jest.Mock;

const TENANT = 'tenant-auth-1';
const CONN = 'conn-auth-1';
const EXEC = 'exec-auth-1';
const NOW = new Date('2026-09-10T03:00:00.000Z');

/** A control the AWS crosswalk covers, so a PASS on it mints evidence. */
const AWS_MAPPED = 'iam_root_user_mfa_enabled';

/**
 * The verbatim message a HEALTHY account returns for a control aimed at a
 * disabled opt-in region (steampipe-plugin-aws#75). Powerpipe presents it
 * through the same `run_error` field a genuinely rejected credential uses,
 * which is why nothing in the fix reads that field.
 */
const OPT_IN_REGION_AUTHFAILURE =
    'operation error EC2: DescribeInstances, https response error StatusCode: 401, '
    + 'api error AuthFailure: AWS was not able to validate the provided access credentials';

/** The message a genuinely revoked AWS credential returns on every control. */
const REVOKED_CREDENTIAL =
    'operation error STS: GetCallerIdentity, https response error StatusCode: 403, '
    + 'api error InvalidClientTokenId: The security token included in the request is invalid';

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
        controlRequirementLink: { findFirst: jest.fn(async () => ({ controlId: 'ctl-covering' })) },
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
        [{ data: { status: string; resultJson: Record<string, unknown>; errorMessage: string | null } }]
    >;
    return calls[calls.length - 1][0].data;
}

const gcpArgs = () => ({
    cloud: 'gcp-posture',
    tenantId: TENANT,
    connectionId: CONN,
    provider: new GcpPostureProvider(),
    controlMap: GCP_POSTURE_CONTROL_MAP,
    now: NOW,
});

beforeEach(() => {
    jest.clearAllMocks();
    decrypt.mockReturnValue(JSON.stringify({
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'x'.repeat(40),
    }));
});

// ═══ AWS — the provider path ═════════════════════════════════════════

describe('aws-posture — a revoked credential is RECORDED, never accused', () => {
    /** Every control in the `setError` state: the rejected-credential shape. */
    const allErrored = powerpipeBenchmarkJson('aws_compliance.benchmark.soc_2', {
        controls: [
            powerpipeErroredControl(AWS_MAPPED, REVOKED_CREDENTIAL),
            powerpipeErroredControl('s3_bucket_versioning_enabled', REVOKED_CREDENTIAL),
        ],
    });

    it('persists the breadth fact and a counts-only errorMessage', async () => {
        const db = makeDb();
        collectorRun({ err: exitedWith(2), stdout: allErrored });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('ERROR');
        const row = persisted(db);
        expect(row.resultJson).toMatchObject({ noControlObserved: true, collectorExitCode: 2 });
        expect(row.errorMessage).toBe(
            '2 error / 0 unreadable of 2 controls (collector exit 2) — no control produced an observation',
        );
    });

    it('quotes NO provider text in the persisted message', async () => {
        // The column is served to the browser by `GET /admin/integrations`.
        // Counts and the exit code only — never `run_error`, `reason`, stderr.
        const db = makeDb();
        collectorRun({ err: exitedWith(2), stdout: allErrored, stderr: 'InvalidClientTokenId for AKIAIOSFODNN7EXAMPLE' });

        await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        const msg = persisted(db).errorMessage ?? '';
        expect(msg).not.toContain('InvalidClientTokenId');
        expect(msg).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(msg).not.toContain('GetCallerIdentity');
    });

    it('does NOT call markAuthFailure — the fact is recorded, the trigger withheld', async () => {
        const db = makeDb();
        collectorRun({ err: exitedWith(2), stdout: allErrored });

        await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(markAuth).not.toHaveBeenCalled();
        // Nor does it CLEAR one: an ERROR is not proof the credential worked.
        expect(clearAuth).not.toHaveBeenCalled();
        // And no evidence is minted off a run that observed nothing.
        expect(db.evidence.create).not.toHaveBeenCalled();
    });

    it('mints no passing evidence and returns the real counts', async () => {
        const db = makeDb();
        collectorRun({ err: exitedWith(2), stdout: allErrored });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.counts).toMatchObject({ ok: 0, alarm: 0, error: 2, total: 2 });
        expect(res.evidenceCreated).toBe(0);
        expect(db.evidenceControlLink.create).not.toHaveBeenCalled();
    });
});

describe('aws-posture — a HEALTHY account with an opt-in-region AuthFailure', () => {
    /**
     * One control passes, one alarms, one errors with the SAME `AuthFailure`
     * text a revoked credential produces. Breadth — not text — is what tells
     * this apart from the block above, and the `ok` settles it.
     */
    const healthy = powerpipeBenchmarkJson('aws_compliance.benchmark.soc_2', {
        controls: [
            powerpipeControl(AWS_MAPPED, 'ok'),
            powerpipeControl('s3_bucket_public_access_blocked', 'alarm'),
            powerpipeErroredControl('ec2_instance_detailed_monitoring_enabled', OPT_IN_REGION_AUTHFAILURE),
        ],
    });

    it('never claims the breadth fact, and still clears the banner', async () => {
        const db = makeDb();
        collectorRun({ err: exitedWith(1), stdout: healthy });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('FAILED');
        expect(persisted(db).resultJson).not.toHaveProperty('noControlObserved');
        expect(markAuth).not.toHaveBeenCalled();
        expect(clearAuth).toHaveBeenCalledWith(expect.anything(), CONN, 'aws-posture');
    });

    it('still evidences the passing control — the false positive this avoids', async () => {
        // A trigger built on the AuthFailure TEXT would have marked this
        // healthy connection revoked and stopped its nightly retry, while it
        // was producing real evidence.
        const db = makeDb();
        collectorRun({ err: exitedWith(1), stdout: healthy });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.evidenceCreated).toBe(1);
        expect(db.evidence.create).toHaveBeenCalledTimes(1);
    });
});

describe('aws-posture — a run that did NOT complete says nothing about the credential', () => {
    it('records no breadth fact on a SIGTERM at the timeout', async () => {
        // The 15-minute timeout kills the child. Zero controls were observed,
        // but the run never happened — claiming the credential failed here is
        // exactly the (c)-for-(a) confusion the predicate refuses.
        const db = makeDb();
        collectorRun({
            err: Object.assign(new Error('killed'), { signal: 'SIGTERM' }),
            stdout: powerpipeBenchmarkJson('aws_compliance.benchmark.soc_2', {
                controls: [powerpipeErroredControl(AWS_MAPPED, REVOKED_CREDENTIAL)],
            }),
        });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

        expect(res.status).toBe('ERROR');
        expect(persisted(db).resultJson).not.toHaveProperty('noControlObserved');
        expect(markAuth).not.toHaveBeenCalled();
    });
});

// ═══ GCP via the SHARED core — the other collector ═══════════════════

describe('cloud-posture (GCP) — the same two halves through the shared core', () => {
    const GCP_MAPPED = 'iam_service_account_no_user_managed_key';
    const gcpAllErrored = powerpipeBenchmarkJson('gcp_compliance.benchmark.soc_2', {
        controls: [
            powerpipeErroredControl(`gcp_compliance.control.${GCP_MAPPED}`,
                'rpc error: code = Unauthenticated desc = request had invalid authentication credentials'),
        ],
    });

    it('records the breadth fact and calls neither auth writer', async () => {
        // The AWS collector and the shared core are the same behaviour written
        // twice; a change to one and not the other is how they drifted (#2284).
        const db = makeDb();
        collectorRun({ err: exitedWith(2), stdout: gcpAllErrored });

        const res = await runCloudPostureCollection(gcpArgs());

        expect(res.status).toBe('ERROR');
        const row = persisted(db);
        expect(row.resultJson).toMatchObject({ noControlObserved: true, collectorExitCode: 2 });
        expect(row.errorMessage).toBe(
            '1 error / 0 unreadable of 1 controls (collector exit 2) — no control produced an observation',
        );
        expect(row.errorMessage).not.toContain('Unauthenticated');
        expect(markAuth).not.toHaveBeenCalled();
        expect(clearAuth).not.toHaveBeenCalled();
    });

    it('withholds it when a control was observed, and clears the banner', async () => {
        // Same `Unauthenticated` text on the errored control as above; the two
        // controls that answered are what make this a different case.
        const db = makeDb();
        collectorRun({
            err: exitedWith(1),
            stdout: powerpipeBenchmarkJson('gcp_compliance.benchmark.soc_2', {
                controls: [
                    powerpipeControl(`gcp_compliance.control.${GCP_MAPPED}`, 'ok'),
                    powerpipeControl('gcp_compliance.control.storage_bucket_uniform_access', 'alarm'),
                    powerpipeErroredControl('gcp_compliance.control.compute_instance_no_public_ip',
                        'rpc error: code = Unauthenticated desc = request had invalid authentication credentials'),
                ],
            }),
        });

        const res = await runCloudPostureCollection(gcpArgs());

        expect(res.status).toBe('FAILED');
        expect(persisted(db).resultJson).not.toHaveProperty('noControlObserved');
        expect(markAuth).not.toHaveBeenCalled();
        expect(clearAuth).toHaveBeenCalledWith(expect.anything(), CONN, 'gcp-posture');
    });
});
