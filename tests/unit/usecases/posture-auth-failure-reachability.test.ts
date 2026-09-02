/**
 * End to end, through the seam that was broken: a revoked posture credential
 * must reach `IntegrationConnection.authFailedAt`, and nothing else may.
 *
 * The two collector suites beside this one mock `connection-health`, so they
 * can only assert that the collector CALLS `markAuthFailure` — which it always
 * did, from a `catch` no posture provider ever entered. That is exactly how a
 * dead call site stayed green: every layer was tested against a stub of the
 * next one, and the composition was tested nowhere.
 *
 * So this file mocks the DATABASE and nothing else. The provider is the real
 * `AwsPostureProvider` / `AzurePostureProvider` / `GcpPostureProvider` with
 * only its CLI runner injected, `markAuthFailure` and `clearAuthFailure` are
 * the real writers, and what is asserted is the row they actually write. A fix
 * that classifies correctly but never wires the classification through, or
 * wires it through to a writer that no-ops on the class it is handed, fails
 * here and passes everywhere else.
 *
 * Both directions are pinned in equal measure, because they cost differently:
 * a missed auth failure is a stale connection, a FALSE one tells a customer to
 * rotate a credential that was working.
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

import { runInTenantContext } from '@/lib/db-context';
import { decryptField } from '@/lib/security/encryption';
import { runAwsPostureCollection } from '@/app-layer/usecases/aws-posture';
import { runCloudPostureCollection } from '@/app-layer/usecases/cloud-posture';
import { AwsPostureProvider, type AwsCliResult, type AwsCliRunner } from '@/app-layer/integrations/aws-posture-provider';
import { AzurePostureProvider } from '@/app-layer/integrations/providers/azure-posture-provider';
import { GcpPostureProvider } from '@/app-layer/integrations/providers/gcp-posture-provider';
import type { RunBenchmarkInput } from '@/app-layer/integrations/cloud-posture/powerpipe-core';
import { AZURE_POSTURE_CONTROL_MAP } from '@/data/integrations/azure-posture-control-map';
import { GCP_POSTURE_CONTROL_MAP } from '@/data/integrations/gcp-posture-control-map';

const runInTenant = runInTenantContext as unknown as jest.Mock;
const decrypt = decryptField as unknown as jest.Mock;

const TENANT = 'tenant-posture-authfail';
const CONN = 'conn-posture-1';
const NOW = new Date('2026-04-02T03:00:00.000Z');

/** A revoked AWS session token, as the SDK prints it through Powerpipe. */
const REVOKED_STDERR =
    'Error: failed to refresh cached credentials, operation error STS: AssumeRole, https response error StatusCode: 403, api error ExpiredToken: The security token included in the request is expired';
/** A transport failure. Same non-zero exit, entirely different meaning. */
const BLIP_STDERR =
    'Error: operation error EC2: DescribeInstances, exceeded maximum number of attempts, 3, request send failed, dial tcp 52.94.236.248:443: connect: connection timed out';

const ONE_OK = JSON.stringify({ controls: [{ control_id: 'x.control.iam_root_user_mfa_enabled', title: 'Root MFA', summary: { status: { ok: 1 } } }] });
const ONE_ALARM = JSON.stringify({ controls: [{ control_id: 'x.control.iam_root_user_mfa_enabled', title: 'Root MFA', summary: { status: { alarm: 1 } } }] });

function makeDb() {
    return {
        integrationConnection: {
            findFirst: jest.fn(async () => ({ id: CONN, configJson: { benchmark: 'soc2' }, secretEncrypted: null, isEnabled: true })),
            // Both connection-health writers land here; `count` is what
            // `clearAuthFailure` reads to decide whether it cleared anything.
            updateMany: jest.fn(async () => ({ count: 1 })),
        },
        integrationExecution: {
            create: jest.fn(async () => ({ id: 'exec-1' })),
            update: jest.fn(async () => ({ id: 'exec-1' })),
        },
        controlRequirementLink: { findFirst: jest.fn(async () => null) },
        evidence: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({ id: 'ev-1' })), update: jest.fn(async () => ({ id: 'ev-1' })) },
        evidenceControlLink: { create: jest.fn(async () => ({ id: 'ecl-1' })) },
        controlEvidenceLink: { create: jest.fn(async () => ({ id: 'cel-1' })) },
    };
}
type Db = ReturnType<typeof makeDb>;

function bind(db: Db) {
    runInTenant.mockImplementation((_ctx: RequestContext, cb: (d: PrismaTx) => Promise<unknown>) => cb(db as unknown as PrismaTx));
}

function awsExec(over: Partial<AwsCliResult>): AwsCliRunner {
    return jest.fn(async () => ({ ok: true, stdout: ONE_OK, stderr: '', code: 0, missing: false, ...over }));
}
function coreExec(over: Partial<{ ok: boolean; stdout: string; stderr: string; missing: boolean }>): RunBenchmarkInput['exec'] {
    return jest.fn(async () => ({ ok: true, stdout: ONE_OK, stderr: '', missing: false, ...over }));
}

/** Every write the connection-health layer made, in order. */
function connectionWrites(db: Db) {
    return (db.integrationConnection.updateMany.mock.calls as unknown as Array<[{ where: Record<string, unknown>; data: Record<string, unknown> }]>).map((c) => c[0]);
}
/**
 * Just the writes that RAISE the banner. Separated from the clears so a test
 * named "does not mark" fails for that reason and no other — the two writers
 * share one `updateMany`, and asserting the whole call list would make a
 * clearing regression read as a marking one.
 */
function markWrites(db: Db) {
    return connectionWrites(db).filter((c) => c.data.authFailedAt instanceof Date);
}

beforeEach(() => {
    jest.clearAllMocks();
    decrypt.mockReturnValue('{}');
});

describe('aws-posture — a revoked credential reaches the connection', () => {
    it('MARKS the connection when the collector exits non-zero on an expired token', async () => {
        // Direction (a), end to end. Regression class: the reported defect.
        // `markAuthFailure` sat in a `catch` that `AwsPostureProvider.runCheck`
        // could not enter, and no-ops on anything that is not an
        // IntegrationAuthError — so this row was unwritable and the banner
        // could not be raised by this collector at all.
        const db = makeDb();
        bind(db);
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: false, stdout: '', stderr: REVOKED_STDERR, code: 1 }) });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

        const writes = connectionWrites(db);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toStrictEqual({
            where: { id: CONN },
            data: { authFailedAt: NOW, authFailureReason: 'Integration auth failed (403, ExpiredToken): powerpipe benchmark run aws_compliance.benchmark.soc_2' },
        });
        // The reason column is unencrypted and rendered in the admin UI, so the
        // stderr around the code must not have travelled with it.
        expect(String(writes[0].data.authFailureReason)).not.toContain('The security token');
        // A dead credential must also stop being re-run three times inside 35s.
        expect(res).toMatchObject({ status: 'ERROR', noRetry: true, evidenceCreated: 0 });
    });

    it('still records the ERROR execution, so the ledger is not the price of the banner', async () => {
        // Regression class: the collector's only other artefact. Marking the
        // connection but losing the execution row would trade one silence for
        // another — nothing on /admin, and a scheduled job that returns quietly
        // is indistinguishable from a dead worker.
        const db = makeDb();
        bind(db);
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: false, stdout: '', stderr: REVOKED_STDERR, code: 1 }) });

        await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

        expect(db.integrationExecution.update).toHaveBeenCalledWith({
            where: { id: 'exec-1' },
            data: expect.objectContaining({
                status: 'ERROR',
                errorMessage: 'Integration auth failed (403, ExpiredToken): powerpipe benchmark run aws_compliance.benchmark.soc_2',
            }),
        });
    });

    it('does NOT mark the connection on a network blip with the same non-zero exit', async () => {
        // Direction (b), and the one that protects customers. Same exit code,
        // same ERROR row — telling an operator their working credential was
        // revoked because a socket timed out is worse than the stale
        // connection this whole change exists to fix.
        const db = makeDb();
        bind(db);
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: false, stdout: '', stderr: BLIP_STDERR, code: 1 }) });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

        expect(markWrites(db)).toEqual([]);
        expect(res.status).toBe('ERROR');
        expect(res.errorMessage).toContain('collector error; stderr:');
        // No `noRetry` at all: the ERROR travelled the completion path, so the
        // queue is left free to re-run a blip on its own backoff. Setting it
        // here would cost a whole day of collection for a timed-out socket.
        expect(res.noRetry).toBeUndefined();
    });

    it('does NOT mark the connection when the CLI is missing from the collector host', async () => {
        // Direction (b). "Nobody installed powerpipe" is our problem, and
        // reporting it as the customer's revoked credential sends them to
        // rotate a key that was never the issue.
        const db = makeDb();
        bind(db);
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: false, stdout: '', stderr: '', code: null, missing: true }) });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

        expect(markWrites(db)).toEqual([]);
        expect(res.errorMessage).toContain('powerpipe not installed');
    });
});

describe('aws-posture — clearing stays honest', () => {
    it('CLEARS a stale banner when the benchmark actually ran and passed', async () => {
        // Regression class: a banner that survives the admin fixing the
        // credential trains people to ignore the one signal that means somebody
        // must act. Marking without clearing is worse than neither.
        const db = makeDb();
        bind(db);
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: true, stdout: ONE_OK }) });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

        expect(res.status).toBe('PASSED');
        expect(connectionWrites(db)).toStrictEqual([
            { where: { id: CONN, authFailedAt: { not: null } }, data: { authFailedAt: null, authFailureReason: null } },
        ]);
    });

    it('CLEARS on a FAILED verdict too — a real gap is still a working credential', async () => {
        // Regression class: clamping the clear to `status === 'PASSED'` is the
        // obvious over-correction for the ERROR-path defect below, and it would
        // strand a REVOKED banner on a healthy connection for as long as the
        // benchmark keeps reporting gaps — which is forever, for most tenants.
        const db = makeDb();
        bind(db);
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: true, stdout: ONE_ALARM }) });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

        expect(res.status).toBe('FAILED');
        expect(connectionWrites(db)).toStrictEqual([
            { where: { id: CONN, authFailedAt: { not: null } }, data: { authFailedAt: null, authFailureReason: null } },
        ]);
    });

    it('does NOT clear on an ERROR result — the account was never observed', async () => {
        // Regression class: this ran unconditionally on every completion,
        // including ERROR. A previously-marked connection whose collector then
        // failed for ANY reason had its revoked-credential banner retracted on
        // no evidence at all — the credential is still dead, and now nothing
        // says so. Exit code 0 with unusable output reaches this line, so the
        // throw upstream does not cover it.
        const db = makeDb();
        bind(db);
        // Exit 0, empty benchmark: the collector "ran" and observed nothing.
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: true, stdout: '{}' }) });

        const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

        expect(res.status).toBe('ERROR');
        expect(connectionWrites(db)).toEqual([]);
    });
});

describe('cloud-posture — the same seam for Azure and GCP', () => {
    const azure = (exec: RunBenchmarkInput['exec']) => ({
        cloud: 'azure-posture', tenantId: TENANT, connectionId: CONN, now: NOW,
        provider: new AzurePostureProvider({ exec }), controlMap: AZURE_POSTURE_CONTROL_MAP,
    });
    const gcp = (exec: RunBenchmarkInput['exec']) => ({
        cloud: 'gcp-posture', tenantId: TENANT, connectionId: CONN, now: NOW,
        provider: new GcpPostureProvider({ exec }), controlMap: GCP_POSTURE_CONTROL_MAP,
    });

    it('MARKS an Azure connection whose client secret has expired', async () => {
        const db = makeDb();
        bind(db);
        const stderr = 'Error: azure: ClientSecretCredential authentication failed. AADSTS7000222: The provided client secret keys for app are expired.';

        const res = await runCloudPostureCollection(azure(coreExec({ ok: false, stdout: '', stderr })));

        expect(connectionWrites(db)).toStrictEqual([
            { where: { id: CONN }, data: { authFailedAt: NOW, authFailureReason: 'Integration auth failed (403, AADSTS7000222): powerpipe benchmark run azure_compliance.benchmark.soc_2' } },
        ]);
        expect(res).toMatchObject({ status: 'ERROR', noRetry: true });
    });

    it('MARKS a GCP connection whose service-account key was revoked', async () => {
        // The GCP provider runs the benchmark inside a try/finally that unlinks
        // the service-account key file; a thrown credential verdict has to pass
        // through that cleanup rather than be swallowed by it.
        const db = makeDb();
        bind(db);
        const stderr = 'Error: gcp: oauth2: cannot fetch token: 400 Bad Request, Response: {"error":"invalid_grant","error_description":"Invalid grant: account not found"}';

        const res = await runCloudPostureCollection(gcp(coreExec({ ok: false, stdout: '', stderr })));

        expect(connectionWrites(db)).toStrictEqual([
            { where: { id: CONN }, data: { authFailedAt: NOW, authFailureReason: 'Integration auth failed (403, invalid_grant): powerpipe benchmark run gcp_compliance.benchmark.soc_2' } },
        ]);
        expect(res).toMatchObject({ status: 'ERROR', noRetry: true });
    });

    it('does NOT mark either cloud on an authorization gap or a blip', async () => {
        // Direction (b) for both clouds. A Reader role short one permission,
        // and a socket timeout: neither is a revoked credential, and a
        // classifier that fires on any non-zero exit fails exactly here.
        const dbA = makeDb();
        bind(dbA);
        const denied = "Error: azure: AuthorizationFailed: The client does not have authorization to perform action 'Microsoft.Storage/storageAccounts/read'";
        const resA = await runCloudPostureCollection(azure(coreExec({ ok: false, stdout: '', stderr: denied })));
        expect(markWrites(dbA)).toEqual([]);
        expect(resA.status).toBe('ERROR');
        expect(resA.noRetry).toBeUndefined();

        const dbG = makeDb();
        bind(dbG);
        const resG = await runCloudPostureCollection(gcp(coreExec({ ok: false, stdout: '', stderr: BLIP_STDERR })));
        expect(markWrites(dbG)).toEqual([]);
        expect(resG.status).toBe('ERROR');
        expect(resG.noRetry).toBeUndefined();
    });

    it('clears on a completed run and stays put on an ERROR one', async () => {
        const dbOk = makeDb();
        bind(dbOk);
        const resOk = await runCloudPostureCollection(azure(coreExec({ ok: true, stdout: ONE_OK })));
        expect(resOk.status).toBe('PASSED');
        expect(connectionWrites(dbOk)).toStrictEqual([
            { where: { id: CONN, authFailedAt: { not: null } }, data: { authFailedAt: null, authFailureReason: null } },
        ]);

        const dbErr = makeDb();
        bind(dbErr);
        const resErr = await runCloudPostureCollection(azure(coreExec({ ok: true, stdout: '{}' })));
        expect(resErr.status).toBe('ERROR');
        expect(connectionWrites(dbErr)).toEqual([]);
    });
});
