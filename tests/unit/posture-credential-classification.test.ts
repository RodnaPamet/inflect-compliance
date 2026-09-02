/**
 * `markAuthFailure` was UNREACHABLE from both cloud-posture collectors, so the
 * "credential revoked" banner could never be raised for an AWS, Azure or GCP
 * posture connection. Two independent gaps produced one silence:
 *
 *   1. the call site is the `catch` around `provider.runCheck`, and neither
 *      provider threw — `AwsPostureProvider.runCheck` and
 *      `runPowerpipeBenchmark` both CAUGHT the non-zero Powerpipe exit a
 *      revoked credential produces and RETURNED `{ status: 'ERROR' }`;
 *   2. `markAuthFailure` no-ops on anything that is not an
 *      `IntegrationAuthError`, so a generic `Error` would not have marked
 *      even if the catch had run.
 *
 * This file covers the discriminator that closes both, and it is written
 * around the fact that the two error directions cost very different things:
 *
 *   - a MISSED auth failure is the old behaviour — a silently stale connection;
 *   - a FALSE auth failure tells a customer their WORKING credential is
 *     revoked, on a network blip or a missing CLI.
 *
 * So roughly half of what follows asserts that something is NOT flagged. That
 * half is the point: a careless widening of the allowlist, a case-insensitive
 * match, or a classifier that fires on any non-zero exit passes every
 * positive test in this file and fails the negative ones.
 */
import {
    POSTURE_CREDENTIAL_ERROR_CODES,
    postureCredentialErrorCode,
    throwIfPostureCredentialFailure,
} from '@/app-layer/integrations/posture-credential-classification';
import { IntegrationAuthError, shouldBypassQueueRetry } from '@/app-layer/integrations/http-resilience';
import {
    AwsPostureProvider,
    scrubAwsCredentials,
    type AwsCliResult,
    type AwsCliRunner,
} from '@/app-layer/integrations/aws-posture-provider';
import { runPowerpipeBenchmark, type RunBenchmarkInput } from '@/app-layer/integrations/cloud-posture/powerpipe-core';
import { AzurePostureProvider } from '@/app-layer/integrations/providers/azure-posture-provider';
import { GcpPostureProvider } from '@/app-layer/integrations/providers/gcp-posture-provider';
import type { CheckInput } from '@/app-layer/integrations/types';

/**
 * Fabricated, shape-accurate collector stderr. Each carries a real provider
 * error code in the position the SDK prints it, so what is asserted is the
 * classifier's reading of a message and not a bare code in isolation.
 */
const AUTH_STDERR: Record<string, string> = {
    ExpiredToken:
        'Error: failed to refresh cached credentials, operation error STS: AssumeRole, https response error StatusCode: 403, api error ExpiredToken: The security token included in the request is expired',
    ExpiredTokenException:
        'Error: operation error DynamoDB: ListTables, https response error StatusCode: 400, api error ExpiredTokenException: The security token included in the request is expired',
    InvalidClientTokenId:
        'Error: operation error STS: GetCallerIdentity, https response error StatusCode: 403, api error InvalidClientTokenId: The security token included in the request is invalid',
    UnrecognizedClientException:
        'Error: operation error KMS: ListKeys, https response error StatusCode: 400, api error UnrecognizedClientException: The security token included in the request is invalid',
    InvalidAccessKeyId:
        'Error: operation error S3: ListBuckets, https response error StatusCode: 403, api error InvalidAccessKeyId: The AWS Access Key Id you provided does not exist in our records',
    SignatureDoesNotMatch:
        'Error: operation error S3: ListBuckets, https response error StatusCode: 403, api error SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided',
    AuthFailure:
        'Error: operation error EC2: DescribeInstances, https response error StatusCode: 401, api error AuthFailure: AWS was not able to validate the provided access credentials',
    AADSTS7000215:
        'Error: azure: ClientSecretCredential authentication failed. AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value.',
    AADSTS7000222:
        'Error: azure: ClientSecretCredential authentication failed. AADSTS7000222: The provided client secret keys for app are expired.',
    InvalidAuthenticationToken:
        'Error: azure: GET https://management.azure.com/subscriptions: 401 InvalidAuthenticationToken: The access token is invalid.',
    ExpiredAuthenticationToken:
        'Error: azure: GET https://management.azure.com/subscriptions: 401 ExpiredAuthenticationToken: The access token expiry time has passed.',
    UNAUTHENTICATED:
        'Error: gcp: googleapi: Error 401: Request had invalid authentication credentials., code: UNAUTHENTICATED',
    invalid_grant:
        'Error: gcp: oauth2: cannot fetch token: 400 Bad Request, Response: {"error":"invalid_grant","error_description":"Invalid grant: account not found"}',
    invalid_client:
        'Error: oauth2: cannot fetch token: 401 Unauthorized, Response: {"error":"invalid_client"}',
    unauthorized_client:
        'Error: oauth2: cannot fetch token: 400 Bad Request, Response: {"error":"unauthorized_client"}',
};

/**
 * Everything a careless fix would flag and must not.
 *
 * Each is a real reason a posture collector exits non-zero WITHOUT the
 * credential being implicated — transport, host, configuration, or an
 * authorization gap on a role that authenticated perfectly well.
 */
const BENIGN_STDERR: Array<[string, string]> = [
    ['a network blip',
        'Error: operation error EC2: DescribeInstances, exceeded maximum number of attempts, 3, request send failed, Post "https://ec2.eu-west-1.amazonaws.com/": dial tcp 52.94.236.248:443: connect: connection timed out'],
    ['a reset socket',
        'Error: operation error IAM: ListUsers, request send failed, read tcp 10.0.0.4:52344->52.94.236.248:443: read: connection reset by peer'],
    ['the CLI not being installed',
        'execvp: powerpipe: command not found'],
    ['a mod that will not load',
        "Error: failed to load mod: benchmark 'aws_compliance.benchmark.soc_2' does not exist"],
    ['unparseable collector output',
        'Error: failed to decode benchmark output: unexpected end of JSON input'],
    ['an AUTHORIZATION gap on a valid credential (AWS)',
        'Error: operation error S3: GetBucketPolicy, https response error StatusCode: 403, api error AccessDenied: User is not authorized to perform s3:GetBucketPolicy on this resource'],
    ['an AUTHORIZATION gap, JSON-protocol flavour (AWS)',
        'Error: operation error GuardDuty: ListDetectors, https response error StatusCode: 403, api error AccessDeniedException: not authorized'],
    ['an EC2 authorization gap (AWS)',
        'Error: operation error EC2: DescribeFlowLogs, https response error StatusCode: 403, api error UnauthorizedOperation: You are not authorized to perform this operation'],
    ['an AUTHORIZATION gap on a valid credential (GCP)',
        'Error: gcp: googleapi: Error 403: Permission denied on resource project inflect-prod., code: PERMISSION_DENIED'],
    ['an AUTHORIZATION gap on a valid credential (Azure)',
        "Error: azure: AuthorizationFailed: The client does not have authorization to perform action 'Microsoft.Storage/storageAccounts/read'"],
    ['a throttle',
        'Error: operation error CloudTrail: DescribeTrails, https response error StatusCode: 400, api error ThrottlingException: Rate exceeded'],
    ['a request-rate limit',
        'Error: operation error EC2: DescribeVolumes, https response error StatusCode: 503, api error RequestLimitExceeded: Request limit exceeded'],
    ["the COLLECTOR HOST's clock",
        'Error: operation error EC2: DescribeInstances, https response error StatusCode: 403, api error RequestExpired: Request has expired.'],
    ['a skewed clock, S3 flavour',
        'Error: operation error S3: ListBuckets, https response error StatusCode: 403, api error RequestTimeTooSkewed: The difference between the request time and the current time is too large'],
    ['a lowercase control id that merely reads like a code',
        "Error: control 'gcp_compliance.control.compute_instance_unauthenticated_access' failed to run: context deadline exceeded"],
    ['English prose that merely contains a code as a prefix',
        'Warning: ExpiredTokens are refreshed automatically before each benchmark run'],
    ['nothing at all', ''],
    ['whitespace', '   \n  '],
];

describe('postureCredentialErrorCode — what IS a credential verdict', () => {
    it('has a fixture for every allowlisted code, so nothing ships unexercised', () => {
        // Regression class: a code added to the allowlist without a message to
        // read it out of is an untested widening — and widening is the
        // direction that costs a customer a false revocation.
        expect(Object.keys(AUTH_STDERR).sort()).toEqual([...POSTURE_CREDENTIAL_ERROR_CODES].sort());
    });

    it.each(POSTURE_CREDENTIAL_ERROR_CODES)('reads %s out of a real collector message', (code) => {
        expect(postureCredentialErrorCode(AUTH_STDERR[code])).toBe(code);
    });

    it('survives the credential scrub the collector applies before anything sees stderr', () => {
        // Regression class: stderr is scrubbed by `scrubAwsCredentials` inside
        // `runCli` BEFORE the classifier reads it. A scrub pattern that ate the
        // marker would silently switch classification off in production while
        // every unscrubbed fixture above stayed green.
        const raw = `${AUTH_STDERR.ExpiredToken} (role arn:aws:iam::123456789012:role/InflectPostureReadOnly, key AKIAIOSFODNN7EXAMPLE)`; // pragma: allowlist secret — synthetic AWS docs example key + ARN, the input to the scrub
        const scrubbed = scrubAwsCredentials(raw, ['sk-live-9876543210zyxwvutsr']); // pragma: allowlist secret — fabricated, never issued
        expect(scrubbed).not.toContain('AKIAIOSFODNN7EXAMPLE'); // pragma: allowlist secret
        expect(scrubbed).toContain('[REDACTED]');
        expect(postureCredentialErrorCode(scrubbed)).toBe('ExpiredToken');
    });
});

describe('postureCredentialErrorCode — what is NOT', () => {
    it.each(BENIGN_STDERR)('does not accuse the credential on %s', (_label, stderr) => {
        expect(postureCredentialErrorCode(stderr)).toBeNull();
    });

    it('is case-SENSITIVE, so lowercase benchmark vocabulary is not a verdict', () => {
        // Regression class: Powerpipe control ids and titles are lowercase /
        // snake_case, and several of them read like credential codes
        // ("unauthenticated access", "authentication failures"). A
        // case-insensitive matcher turns a benchmark that merely NAMES the
        // concept into a revoked-credential banner.
        expect(postureCredentialErrorCode('api error expiredtoken: the token is expired')).toBeNull();
        expect(postureCredentialErrorCode('code: unauthenticated')).toBeNull();
        expect(postureCredentialErrorCode('api error AUTHFAILURE')).toBeNull();
    });

    it('matches on WORD boundaries, so a longer identifier is read as itself', () => {
        // Regression class: `ExpiredToken` is a prefix of `ExpiredTokenException`
        // and both are listed. Substring matching would report the shorter code
        // for the longer error — a wrong `authFailureReason` rendered to the
        // operator — and would also fire on ordinary prose containing the word.
        expect(postureCredentialErrorCode(AUTH_STDERR.ExpiredTokenException)).toBe('ExpiredTokenException');
        expect(postureCredentialErrorCode('ExpiredTokens are rotated hourly')).toBeNull();
        expect(postureCredentialErrorCode('the invalid_grant_type parameter was rejected')).toBeNull();
    });

    it('treats an absent stderr as "cannot tell", never as a verdict', () => {
        expect(postureCredentialErrorCode(null)).toBeNull();
        expect(postureCredentialErrorCode(undefined)).toBeNull();
    });

    it('carries no authorization, throttle or clock code in the allowlist at all', () => {
        // Regression class: the same claim as the BENIGN table, made against
        // the list itself so it also holds for a code somebody adds tomorrow
        // with no fixture — the table can only refuse what it enumerates.
        for (const forbidden of [
            'AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'AuthorizationFailed',
            'PERMISSION_DENIED', 'ThrottlingException', 'RequestLimitExceeded', 'Throttling',
            'RequestExpired', 'RequestTimeTooSkewed', 'invalid_request', 'invalid_scope',
            'unsupported_grant_type',
        ]) {
            expect(POSTURE_CREDENTIAL_ERROR_CODES).not.toContain(forbidden);
        }
    });
});

describe('throwIfPostureCredentialFailure', () => {
    it('raises the one class the connection-health writer acts on, and nothing less', () => {
        // Regression class: `markAuthFailure` branches on
        // `err instanceof IntegrationAuthError` and on nothing else. A plain
        // Error here — the shape the collectors used to produce — is a silent
        // no-op, which is the defect this whole file exists for.
        let thrown: unknown;
        try {
            throwIfPostureCredentialFailure(AUTH_STDERR.SignatureDoesNotMatch, 'aws_compliance.benchmark.soc_2');
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(IntegrationAuthError);
        const err = thrown as IntegrationAuthError;
        expect(err.reason).toBe('SignatureDoesNotMatch');
        expect(err.status).toBe(403);
        // And it must also stop the queue re-running a dead credential three
        // times inside 35 seconds — `noRetry` on both collectors is derived
        // from this predicate, not hard-coded.
        expect(shouldBypassQueueRetry(err)).toBe(true);
    });

    it('puts the allowlisted CODE in the message and never the stderr around it', () => {
        // Regression class: this message is persisted verbatim into
        // `IntegrationConnection.authFailureReason`, a column exempt from field
        // encryption and rendered in the admin UI. A collector stderr can carry
        // a role ARN, a service-account email or a subscription GUID, so
        // interpolating it would write customer identifiers into an
        // unencrypted, UI-rendered column.
        const stderr = `${AUTH_STDERR.InvalidClientTokenId} for arn:aws:iam::123456789012:role/InflectPostureReadOnly`;
        expect(() => throwIfPostureCredentialFailure(stderr, 'aws_compliance.benchmark.soc_2')).toThrow(
            /Integration auth failed \(403, InvalidClientTokenId\): powerpipe benchmark run aws_compliance\.benchmark\.soc_2/,
        );
        try {
            throwIfPostureCredentialFailure(stderr, 'aws_compliance.benchmark.soc_2');
        } catch (e) {
            expect((e as Error).message).not.toContain('arn:aws:iam');
            expect((e as Error).message).not.toContain('123456789012');
            expect((e as Error).message).not.toContain('The security token');
        }
        expect.assertions(4);
    });

    it('caps the one caller-supplied fragment it does interpolate', () => {
        // Regression class: same column. Every caller resolves the benchmark id
        // from a fixed per-cloud table today, but the parameter is a string and
        // this text is UI copy, so an unbounded value must not reach the row.
        let msg = '';
        try {
            throwIfPostureCredentialFailure(AUTH_STDERR.AuthFailure, 'x'.repeat(500));
        } catch (e) {
            msg = (e as Error).message;
        }
        expect(msg).toContain('x'.repeat(120));
        expect(msg).not.toContain('x'.repeat(121));
    });

    it.each(BENIGN_STDERR)('stays silent on %s', (_label, stderr) => {
        expect(() => throwIfPostureCredentialFailure(stderr, 'b')).not.toThrow();
    });
});

// ─── The providers ───────────────────────────────────────────────────

const BENCH_JSON = JSON.stringify({
    controls: [{ control_id: 'aws_compliance.control.iam_root_user_mfa_enabled', title: 'Root MFA', summary: { status: { ok: 1 } } }],
});

function awsExec(over: Partial<AwsCliResult>): AwsCliRunner {
    return jest.fn(async () => ({ ok: true, stdout: BENCH_JSON, stderr: '', code: 0, missing: false, ...over }));
}
function coreExec(over: Partial<{ ok: boolean; stdout: string; stderr: string; missing: boolean }>): RunBenchmarkInput['exec'] {
    return jest.fn(async () => ({ ok: true, stdout: BENCH_JSON, stderr: '', missing: false, ...over }));
}
const AWS_INPUT: CheckInput = {
    automationKey: 'aws-posture.soc2',
    parsed: { provider: 'aws-posture', checkType: 'soc2', raw: 'aws-posture.soc2' },
    tenantId: 't1',
    connectionConfig: { benchmark: 'soc2' },
    triggeredBy: 'scheduled',
};
const cloudInput = (provider: string): CheckInput => ({
    automationKey: `${provider}.soc2`,
    parsed: { provider, checkType: 'soc2', raw: `${provider}.soc2` },
    tenantId: 't1',
    connectionConfig: { benchmark: 'soc2' },
    triggeredBy: 'scheduled',
});

describe('AwsPostureProvider.runCheck — the non-zero exit is two outcomes, not one', () => {
    it('THROWS the auth class when the exit carries a credential rejection', async () => {
        // Direction (a). Regression class: the whole reported defect. Returning
        // ERROR here is what made the collector's `catch` — and therefore
        // `markAuthFailure` — unreachable for a revoked AWS key.
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: false, stdout: '', stderr: AUTH_STDERR.ExpiredToken, code: 1 }) });
        await expect(provider.runCheck(AWS_INPUT)).rejects.toBeInstanceOf(IntegrationAuthError);
        await expect(provider.runCheck(AWS_INPUT)).rejects.toMatchObject({ reason: 'ExpiredToken' });
    });

    it('classifies the WHOLE stderr, not the 300-char excerpt the ledger shows', async () => {
        // Regression class: the persisted `errorMessage` truncates stderr to
        // 300 chars. Classifying that copy instead of the full stream would
        // drop verdicts at random, depending only on how chatty the CLI was
        // before it failed — a revoked credential detected or not by luck.
        const noisy = `${'powerpipe: loading mod aws_compliance ... '.repeat(12)}${AUTH_STDERR.AuthFailure}`;
        expect(noisy.slice(0, 300)).not.toContain('AuthFailure');
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: false, stdout: '', stderr: noisy, code: 1 }) });
        await expect(provider.runCheck(AWS_INPUT)).rejects.toMatchObject({ reason: 'AuthFailure' });
    });

    it('RETURNS an ordinary ERROR for a collector failure that is not a credential', async () => {
        // Direction (b), and the one that protects customers: a network blip
        // must not raise "your credential was revoked". It must stay a
        // retryable collector error carrying the diagnostic stderr.
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: false, stdout: '', stderr: BENIGN_STDERR[0][1], code: 1 }) });
        const r = await provider.runCheck(AWS_INPUT);
        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toContain('collector error; stderr:');
        expect(r.errorMessage).toContain('connection timed out');
    });

    it('RETURNS an ordinary ERROR for a permission gap on a credential that authenticated', async () => {
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: false, stdout: '', stderr: AUTH_STDERR.ExpiredToken.replace('ExpiredToken', 'AccessDenied'), code: 1 }) });
        await expect(provider.runCheck(AWS_INPUT)).resolves.toMatchObject({ status: 'ERROR' });
    });

    it('RETURNS an ordinary ERROR when the CLI is not installed at all', async () => {
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: false, stdout: '', stderr: '', code: null, missing: true }) });
        const r = await provider.runCheck(AWS_INPUT);
        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toContain('powerpipe not installed');
    });

    it('never accuses the credential on a run that SUCCEEDED, whatever stderr said', async () => {
        // Regression class: a benchmark that exits 0 has demonstrably used the
        // credential, so a marker in its warning noise is not a verdict.
        // Classifying before the `res.ok` gate would revoke a working key on
        // a stale warning line.
        const provider = new AwsPostureProvider({ exec: awsExec({ ok: true, stdout: BENCH_JSON, stderr: AUTH_STDERR.SignatureDoesNotMatch, code: 0 }) });
        await expect(provider.runCheck(AWS_INPUT)).resolves.toMatchObject({ status: 'PASSED' });
    });
});

describe('runPowerpipeBenchmark — the same seam for Azure and GCP', () => {
    it('THROWS the auth class when the exit carries a credential rejection', async () => {
        await expect(
            runPowerpipeBenchmark({ benchmarkId: 'azure_compliance.benchmark.soc_2', env: {}, secretValues: [], exec: coreExec({ ok: false, stdout: '', stderr: AUTH_STDERR.AADSTS7000222 }) }),
        ).rejects.toMatchObject({ name: 'IntegrationAuthError', reason: 'AADSTS7000222' });
    });

    it('classifies the WHOLE stderr, not the 300-char excerpt the ledger shows', async () => {
        // Regression class: same as the AWS side, and it has to be asserted on
        // both — the two collectors are line-for-line parallel, and an
        // asymmetry is a place the defect can hide on one side only. Only the
        // first 300 chars reach the persisted `errorMessage`; classifying that
        // copy would make detection depend on how chatty the CLI was first.
        const noisy = `${'powerpipe: loading mod azure_compliance ... '.repeat(12)}${AUTH_STDERR.AADSTS7000215}`;
        expect(noisy.slice(0, 300)).not.toContain('AADSTS7000215');
        await expect(
            runPowerpipeBenchmark({ benchmarkId: 'b', env: {}, secretValues: [], exec: coreExec({ ok: false, stdout: '', stderr: noisy }) }),
        ).rejects.toMatchObject({ reason: 'AADSTS7000215' });
    });

    it('RETURNS an ordinary ERROR for every other non-zero exit', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: {}, secretValues: [], exec: coreExec({ ok: false, stdout: '', stderr: BENIGN_STDERR[2][1] }) });
        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toContain('command not found');
    });

    it('never accuses the credential on a run that SUCCEEDED', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: {}, secretValues: [], exec: coreExec({ ok: true, stdout: BENCH_JSON, stderr: AUTH_STDERR.UNAUTHENTICATED }) });
        expect(r.status).toBe('PASSED');
    });

    it('reaches both cloud providers through their own runCheck', async () => {
        // Regression class: each provider builds its own env + scrub patterns
        // and could have wrapped or swallowed the throw on the way out. GCP in
        // particular runs the benchmark inside a `try/finally` that unlinks the
        // service-account key, which a thrown error must pass through.
        const azure = new AzurePostureProvider({ exec: coreExec({ ok: false, stdout: '', stderr: AUTH_STDERR.InvalidAuthenticationToken }) });
        await expect(azure.runCheck(cloudInput('azure-posture'))).rejects.toMatchObject({ reason: 'InvalidAuthenticationToken' });

        const gcp = new GcpPostureProvider({ exec: coreExec({ ok: false, stdout: '', stderr: AUTH_STDERR.invalid_grant }) });
        await expect(gcp.runCheck(cloudInput('gcp-posture'))).rejects.toMatchObject({ reason: 'invalid_grant' });

        const azureOk = new AzurePostureProvider({ exec: coreExec({ ok: false, stdout: '', stderr: BENIGN_STDERR[9][1] }) });
        await expect(azureOk.runCheck(cloudInput('azure-posture'))).resolves.toMatchObject({ status: 'ERROR' });

        const gcpOk = new GcpPostureProvider({ exec: coreExec({ ok: false, stdout: '', stderr: BENIGN_STDERR[8][1] }) });
        await expect(gcpOk.runCheck(cloudInput('gcp-posture'))).resolves.toMatchObject({ status: 'ERROR' });
    });
});
