/**
 * Coverage wave E batch 3 — the CLI-invocation path of
 * `src/app-layer/integrations/aws-posture-provider.ts`.
 *
 * `node:child_process.execFile` is mocked so the whole collector path runs
 * without `aws` or `powerpipe` on the host. The mock honours the real
 * callback signature `(file, args, opts, cb)`.
 *
 * The behaviours pinned here are the fail-CLOSED ones (H2). Every one of
 * these must produce ERROR rather than a green check:
 *   • a missing CLI (ENOENT)
 *   • a run that did NOT complete — a signal death, a maxBuffer overflow, or
 *     an exit code outside powerpipe's documented {0,1,2}. Whatever stdout
 *     survived such a run must never be scored.
 *   • unparseable JSON
 *   • zero parsed controls — insufficient data, not a pass
 *
 * Note what is NOT on that list: a non-zero exit as such. Powerpipe returns 1
 * for "one or more alarms" and 2 for "one or more control errors" — completed
 * runs that wrote their JSON — and exit 1 is what every real benchmark with a
 * single failing control returns. Refusing it discarded the verdict and every
 * piece of evidence a real account would have produced (#2284).
 *
 * Plus the invariant that credentials reach the child via ENV, never argv,
 * and that stdout/stderr are scrubbed before they can be surfaced.
 */
const execFileMock = jest.fn();
jest.mock('node:child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { AwsPostureProvider } from '@/app-layer/integrations/aws-posture-provider';
import {
    powerpipeControl,
    powerpipeErroredControl,
    groupShapedControlSummary,
    type PowerpipeRowStatus,
} from '../../helpers/powerpipe-benchmark-fixture';

type Cb = (err: unknown, stdout: string, stderr: string) => void;

/** Resolve the next execFile call with the given stdout/stderr/error. */
function cliResult(opts: { stdout?: string; stderr?: string; err?: unknown }) {
    execFileMock.mockImplementationOnce(
        (_file: string, _args: string[], _o: unknown, cb: Cb) => {
            cb(opts.err ?? null, opts.stdout ?? '', opts.stderr ?? '');
        },
    );
}

const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
const exitCode = (code: number) => Object.assign(new Error('exited'), { code });

const provider = () => new AwsPostureProvider();

const benchmarkJson = (controls: unknown[]) => JSON.stringify({ controls });
/**
 * Controls in the REAL wire shape, from the source-cited builder. The inline
 * `summary: { status: { … } }` this fixture used to carry is the shape a result
 * GROUP wears, not a control — see the fixture module's provenance note.
 */
const control = (id: string, status: PowerpipeRowStatus) => powerpipeControl(id, status);

const CREDS = { accessKeyId: 'AKIA_TEST_KEY', secretAccessKey: 'SECRET_TEST_KEY' };

beforeEach(() => {
    jest.clearAllMocks();
});

describe('AwsPostureProvider.benchmarkId', () => {
    it('maps the shorthands, defaulting to soc2', () => {
        expect(AwsPostureProvider.benchmarkId('cis')).toBe(
            'aws_compliance.benchmark.cis_v300',
        );
        expect(AwsPostureProvider.benchmarkId('soc2')).toBe(
            'aws_compliance.benchmark.soc_2',
        );
        expect(AwsPostureProvider.benchmarkId('CIS')).toBe(
            'aws_compliance.benchmark.cis_v300',
        );
        expect(AwsPostureProvider.benchmarkId(undefined)).toBe(
            'aws_compliance.benchmark.soc_2',
        );
        expect(AwsPostureProvider.benchmarkId('nonsense')).toBe(
            'aws_compliance.benchmark.soc_2',
        );
    });
});

describe('AwsPostureProvider — descriptor', () => {
    it('declares live validation and both benchmarks', () => {
        const p = provider();
        expect(p.id).toBe('aws-posture');
        expect(p.liveValidation).toBe(true);
        expect(p.supportedChecks).toEqual(['soc2', 'cis']);
    });
});

describe('AwsPostureProvider.validateConnection', () => {
    it('requires a role ARN or a complete access-key pair', async () => {
        const err = {
            valid: false,
            error: 'Provide a read-only role ARN or an access-key pair.',
        };
        expect(await provider().validateConnection({}, {})).toEqual(err);
        // A half-pair is not enough.
        expect(
            await provider().validateConnection({}, { accessKeyId: 'AKIA_X' }),
        ).toEqual(err);
        expect(
            await provider().validateConnection({}, { secretAccessKey: 'S' }),
        ).toEqual(err);
        expect(execFileMock).not.toHaveBeenCalled();
    });

    it('accepts a role ARN alone and probes the caller identity', async () => {
        cliResult({ stdout: '{"Account":"123456789012"}' });

        const res = await provider().validateConnection(
            { region: 'eu-west-1' },
            { roleArn: 'arn:aws:iam::1:role/R' },
        );

        expect(res).toEqual({ valid: true });
        const [file, args] = execFileMock.mock.calls[0];
        expect(file).toBe('aws');
        expect(args).toEqual(['sts', 'get-caller-identity', '--output', 'json']);
    });

    it('passes credentials via env and never on argv', async () => {
        cliResult({ stdout: '{}' });

        await provider().validateConnection({ region: 'eu-west-1' }, CREDS);

        const [, args, opts] = execFileMock.mock.calls[0];
        // argv is world-readable via /proc — credentials must not appear there.
        expect(JSON.stringify(args)).not.toContain('AKIA_TEST_KEY');
        expect(JSON.stringify(args)).not.toContain('SECRET_TEST_KEY');
        expect(opts.env.AWS_ACCESS_KEY_ID).toBe('AKIA_TEST_KEY');
        expect(opts.env.AWS_SECRET_ACCESS_KEY).toBe('SECRET_TEST_KEY');
        expect(opts.env.AWS_REGION).toBe('eu-west-1');
    });

    it('reports a missing AWS CLI distinctly', async () => {
        cliResult({ err: enoent() });
        const res = await provider().validateConnection({}, CREDS);
        expect(res.valid).toBe(false);
        expect(res.error).toContain('AWS CLI not available on the collector host');
    });

    it('surfaces the scrubbed stderr on a credential failure', async () => {
        cliResult({ err: exitCode(255), stderr: 'AccessDenied for AKIA_TEST_KEY' });

        const res = await provider().validateConnection({}, CREDS);

        expect(res.valid).toBe(false);
        expect(res.error).toContain('AWS credential check failed');
        // The connection's own secret is redacted before it reaches the message.
        expect(res.error).not.toContain('AKIA_TEST_KEY');
        expect(res.error).toContain('[REDACTED]');
    });

    it('falls back to a generic message when stderr is empty', async () => {
        cliResult({ err: exitCode(1), stderr: '' });
        expect((await provider().validateConnection({}, CREDS)).error).toContain(
            'sts:GetCallerIdentity denied',
        );
    });
});

describe('AwsPostureProvider.runCheck — collector invocation', () => {
    const input = (over: Record<string, unknown> = {}) => ({
        parsed: { checkType: 'soc2' },
        connectionConfig: { benchmark: 'soc2', ...CREDS, ...over },
    });

    it('invokes powerpipe with the resolved benchmark id', async () => {
        cliResult({ stdout: benchmarkJson([control('c1', 'ok')]) });

        await provider().runCheck(input() as never);

        const [file, args] = execFileMock.mock.calls[0];
        expect(file).toBe('powerpipe');
        expect(args).toEqual([
            'benchmark',
            'run',
            'aws_compliance.benchmark.soc_2',
            '--output',
            'json',
        ]);
    });

    it('resolves the cis benchmark from config', async () => {
        cliResult({ stdout: benchmarkJson([control('c1', 'ok')]) });
        await provider().runCheck(input({ benchmark: 'cis' }) as never);
        expect(execFileMock.mock.calls[0][1][2]).toBe(
            'aws_compliance.benchmark.cis_v300',
        );
    });

    it('falls back to the check type when no benchmark is configured', async () => {
        cliResult({ stdout: benchmarkJson([control('c1', 'ok')]) });
        await provider().runCheck({
            parsed: { checkType: 'cis' },
            connectionConfig: { ...CREDS },
        } as never);
        expect(execFileMock.mock.calls[0][1][2]).toBe(
            'aws_compliance.benchmark.cis_v300',
        );
    });

    it('passes credentials to the collector via env, not argv', async () => {
        cliResult({ stdout: benchmarkJson([control('c1', 'ok')]) });

        await provider().runCheck(
            input({ region: 'us-east-1', roleArn: 'arn:aws:iam::1:role/R' }) as never,
        );

        const [, args, opts] = execFileMock.mock.calls[0];
        expect(JSON.stringify(args)).not.toContain('AKIA_TEST_KEY');
        expect(opts.env.AWS_ACCESS_KEY_ID).toBe('AKIA_TEST_KEY');
        expect(opts.env.AWS_ROLE_ARN).toBe('arn:aws:iam::1:role/R');
        expect(opts.env.AWS_REGION).toBe('us-east-1');
    });
});

describe('AwsPostureProvider.runCheck — fail-closed contracts (H2)', () => {
    const input = () => ({
        parsed: { checkType: 'soc2' },
        connectionConfig: { benchmark: 'soc2', ...CREDS },
    });

    it('ERRORs when powerpipe is not installed', async () => {
        cliResult({ err: enoent() });

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe CLI not installed on the collector host.');
        expect(res.errorMessage).toContain('powerpipe not installed');
        expect(res.details).toEqual({ benchmark: 'aws_compliance.benchmark.soc_2' });
    });

    it('ERRORs on an exit outside {0,1,2} rather than scoring the stdout that survived', async () => {
        // Valid all-ok JSON is supplied on purpose: if the refusal ever leaked,
        // this would surface as PASSED rather than as a different error string.
        cliResult({ err: exitCode(137), stdout: benchmarkJson([control('c1', 'ok')]), stderr: 'ExpiredToken' });

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe collector did not complete the run.');
        expect(res.errorMessage).toContain('ExpiredToken');
        expect(res.details).toEqual({ benchmark: 'aws_compliance.benchmark.soc_2', collectorExitCode: 137 });
    });

    it('exit 1 is parsed and scored — the routine "controls alarmed" outcome', async () => {
        // #2284: the `!res.ok` gate refused this, so no AWS account with a
        // single failing control ever produced a verdict, and the FAILED arm of
        // the ladder below was unreachable in production.
        cliResult({ err: exitCode(1), stdout: benchmarkJson([control('c1', 'ok'), control('c2', 'alarm')]) });

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('FAILED');
        expect(res.summary).toBe(
            'aws_compliance.benchmark.soc_2: 1 ok / 1 alarm / 0 error / 0 skip / 0 unknown of 2',
        );
        expect(res.details).toMatchObject({
            counts: { ok: 1, alarm: 1, skip: 0, error: 0, unknown: 0, total: 2 },
            collectorExitCode: 1,
        });
    });

    it('exit 2 is parsed, and is never PASSED even on an all-ok payload', async () => {
        // "Completed with no runtime errors, but one or more control errors
        // occurred" — the JSON is there, so it is read; but the collector
        // counted an error our parse did not, and we do not certify an account
        // over that disagreement.
        cliResult({ err: exitCode(2), stdout: benchmarkJson([control('c1', 'ok')]) });

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('ERROR');
        expect(res.details).toMatchObject({
            counts: { ok: 1, alarm: 0, skip: 0, error: 0, unknown: 0, total: 1 },
            collectorExitCode: 2,
        });
    });

    it('scrubs credentials out of the propagated stderr', async () => {
        // Exit 137 rather than exit 1: only a run that did NOT complete
        // surfaces stderr in `errorMessage`, so exit 1 would prove nothing
        // about redaction. The invariant is unchanged.
        cliResult({ err: exitCode(137), stderr: 'denied for AKIA_TEST_KEY' });
        const res = await provider().runCheck(input() as never);
        expect(res.errorMessage).not.toContain('AKIA_TEST_KEY');
        expect(res.errorMessage).toContain('[REDACTED]');
    });

    it('ERRORs on unparseable collector output', async () => {
        cliResult({ stdout: 'not json', stderr: 'warn: something' });

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Failed to parse Powerpipe JSON output.');
        expect(res.errorMessage).toContain('parse error');
    });

    it('ERRORs when zero controls parse — insufficient data, not a pass', async () => {
        cliResult({ stdout: '{}' });

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('ERROR');
        expect(res.summary).toContain('no controls parsed (insufficient data)');
        expect(res.errorMessage).toBe('collector returned zero controls');
    });

    it('treats empty stdout as an empty object rather than a parse error', async () => {
        cliResult({ stdout: '' });
        // '' || '{}' → parses to {} → zero controls → the insufficient-data path.
        expect((await provider().runCheck(input() as never)).errorMessage).toBe(
            'collector returned zero controls',
        );
    });
});

describe('AwsPostureProvider.runCheck — verdicts', () => {
    const input = () => ({
        parsed: { checkType: 'soc2' },
        connectionConfig: { benchmark: 'soc2', ...CREDS },
    });

    it('PASSES when every control is ok or skipped', async () => {
        cliResult({
            stdout: benchmarkJson([control('a', 'ok'), control('b', 'skip')]),
        });

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('PASSED');
        expect(res.summary).toContain('1 ok / 0 alarm / 0 error / 1 skip / 0 unknown of 2');
        expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('FAILS when any control alarms', async () => {
        cliResult({
            stdout: benchmarkJson([control('a', 'ok'), control('b', 'alarm')]),
        });
        expect((await provider().runCheck(input() as never)).status).toBe('FAILED');
    });

    it('ERRORs — never PASSES — when every control errored on a dead credential', async () => {
        // The collector exits ZERO here and writes well-formed JSON, so no
        // refusal above fires: the verdict rests entirely on reading the
        // controls. Scoring those errors as skips is what produced a PASSED
        // verdict off a fully revoked credential.
        cliResult({
            stdout: benchmarkJson([
                powerpipeErroredControl('a'),
                powerpipeErroredControl('b'),
            ]),
        });

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('ERROR');
        expect(res.summary).toContain('2 error');
    });

    it('ERRORs — never PASSES — when the controls arrive in a shape it cannot read', async () => {
        // The AWS provider carries its OWN verdict ladder, separate from the
        // shared core's. Without this, the `unknown` arm of that copy is
        // untested and could be dropped with every suite still green.
        cliResult({
            stdout: benchmarkJson([
                { ...powerpipeControl('a', 'ok'), summary: groupShapedControlSummary('ok'), results: null },
            ]),
        });

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('ERROR');
        expect(res.summary).toContain('1 unknown');
    });

    it('produces no evidence from a run whose controls all errored', async () => {
        // The consequence that reaches the auditor: a broken run must not leave
        // a passing artefact behind.
        cliResult({ stdout: benchmarkJson([powerpipeErroredControl('a')]) });
        const res = await provider().runCheck(input() as never);
        expect(provider().mapResultToEvidence(input() as never, res)).toBeNull();
    });

    it('ERRORs when controls errored but none alarmed', async () => {
        cliResult({
            stdout: benchmarkJson([control('a', 'ok'), control('b', 'error')]),
        });
        expect((await provider().runCheck(input() as never)).status).toBe('ERROR');
    });

    it('ranks alarm above error in the verdict', async () => {
        cliResult({
            stdout: benchmarkJson([control('a', 'alarm'), control('b', 'error')]),
        });
        expect((await provider().runCheck(input() as never)).status).toBe('FAILED');
    });

    it('carries the bounded summary through as details', async () => {
        cliResult({ stdout: benchmarkJson([control('a', 'ok')]) });
        const res = await provider().runCheck(input() as never);
        expect(res.details).toMatchObject({
            benchmark: 'aws_compliance.benchmark.soc_2',
            counts: { ok: 1, alarm: 0, skip: 0, error: 0, total: 1 },
            truncated: false,
        });
    });
});

describe('AwsPostureProvider.mapResultToEvidence', () => {
    const input = { parsed: { checkType: 'soc2' } } as never;

    it('produces configuration evidence for a real verdict', () => {
        expect(
            provider().mapResultToEvidence(input, {
                status: 'PASSED',
                summary: 'all ok',
                details: {},
            } as never),
        ).toEqual({
            title: 'AWS posture — soc2',
            content: 'all ok',
            type: 'CONFIGURATION',
            category: 'aws-posture:soc2',
        });
    });

    it('produces evidence for a FAILED verdict too — a real observation', () => {
        expect(
            provider().mapResultToEvidence(input, {
                status: 'FAILED',
                summary: 'alarms',
                details: {},
            } as never),
        ).not.toBeNull();
    });

    it('produces nothing for a broken run or an empty population (H2)', () => {
        expect(
            provider().mapResultToEvidence(input, {
                status: 'ERROR',
                summary: 'x',
                details: {},
            } as never),
        ).toBeNull();
        expect(
            provider().mapResultToEvidence(input, {
                status: 'NOT_APPLICABLE',
                summary: 'x',
                details: {},
            } as never),
        ).toBeNull();
    });
});


describe('AwsPostureProvider — child-process edge shapes', () => {
    /** Resolve the next execFile call with the RAW arguments given (no defaults). */
    function rawCliResult(err: unknown, stdout?: string, stderr?: string) {
        execFileMock.mockImplementationOnce(
            (_file: string, _args: string[], _o: unknown, cb: Cb) => {
                cb(err, stdout as string, stderr as string);
            },
        );
    }

    const input = () => ({
        parsed: { checkType: 'soc2' },
        connectionConfig: { benchmark: 'soc2', ...CREDS },
    });

    it('treats a SIGNAL death as a broken run, never as "exit 1"', async () => {
        // A signal kill (`{signal: 'SIGKILL'}`, no `code`) is a broken run.
        //
        // The comment that used to sit here said `runCli`'s `code` field had
        // ZERO readers, so `?? 1` and `?? 0` were behaviourally identical and
        // no test could distinguish them. That was true then and is false now:
        // the collector gate reads the exit code, and `?? 1` would classify
        // THIS shape as powerpipe's exit 1 — "ran fine, some controls alarmed"
        // — and parse the stdout of a killed process. Valid all-ok JSON is fed
        // in so that mistake would surface as PASSED.
        rawCliResult(
            Object.assign(new Error('killed'), { signal: 'SIGKILL' }),
            benchmarkJson([control('c1', 'ok')]),
            '',
        );

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe collector did not complete the run.');
        // The signal is reported as a signal. No exit code is invented for it.
        expect(res.details).toEqual({
            benchmark: 'aws_compliance.benchmark.soc_2',
            collectorSignal: 'SIGKILL',
        });
    });

    it('treats a maxBuffer overflow as a broken run — its `code` is a STRING', async () => {
        // Node reports a 64 MiB overflow as `code:
        // 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` in the same field a numeric exit
        // status uses, which is why the runner's `code: number | null` could
        // hold a string. Truncated stdout must never be scored.
        rawCliResult(
            Object.assign(new Error('stdout maxBuffer length exceeded'), {
                code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                signal: 'SIGTERM',
            }),
            benchmarkJson([control('c1', 'ok')]),
            '',
        );

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('ERROR');
        expect(res.details).toEqual({
            benchmark: 'aws_compliance.benchmark.soc_2',
            collectorSignal: 'SIGTERM',
            collectorFailure: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
    });

    it('treats an error carrying no numeric code as a credential failure at validate time', async () => {
        rawCliResult(new Error('killed'), '', '');
        const res = await provider().validateConnection({}, CREDS);
        expect(res.valid).toBe(false);
        expect(res.error).toContain('AWS credential check failed');
    });

    it('tolerates undefined stdout/stderr from the child', async () => {
        // execFile hands back undefined streams on some failure shapes; the
        // nullish coalesce inside runCli must keep this on the insufficient-
        // data path rather than throwing `String(undefined)` into the parser.
        rawCliResult(null, undefined, undefined);

        const res = await provider().runCheck(input() as never);

        expect(res.status).toBe('ERROR');
        expect(res.errorMessage).toBe('collector returned zero controls');
    });

    it('tolerates undefined stderr on a failing run', async () => {
        rawCliResult(exitCode(1), undefined, undefined);

        const res = await provider().validateConnection({}, CREDS);

        expect(res.error).toBe(
            'AWS credential check failed: sts:GetCallerIdentity denied',
        );
    });
});
