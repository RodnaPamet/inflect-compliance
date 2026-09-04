/**
 * Branch coverage for the SHARED cloud-posture core,
 * `src/app-layer/integrations/cloud-posture/powerpipe-core.ts`.
 *
 * The existing suites (`tests/unit/cloud-posture.test.ts`,
 * `tests/unit/h2-fail-closed.test.ts`) always inject the `exec` seam, so the
 * module's DEFAULT runner — the one every real Azure / GCP posture check goes
 * through — was never executed by a test. That is where the security
 * invariants live:
 *
 *   • credentials reach the child via ENV, never argv (argv is world-readable
 *     through /proc);
 *   • BOTH stdout and stderr are scrubbed of the connection's secret values
 *     AND the per-cloud credential patterns before anything is surfaced or
 *     persisted;
 *   • the child is bounded (maxBuffer + timeout) so a runaway collector
 *     cannot exhaust the worker.
 *
 * The rest of the file pins the fail-CLOSED refusal ladder in
 * `runPowerpipeBenchmark` — missing CLI, a run that did not complete,
 * unparseable JSON, zero parsed controls — and the exact discriminators a
 * caller uses to tell those four apart (`summary`, `errorMessage`, `details`,
 * `summaryObj`).
 *
 * "Did not complete" is NOT "exited non-zero", and the difference is the whole
 * of #2284. Powerpipe exits 1 for "one or more alarms" and 2 for "one or more
 * control errors"; both are completed runs that wrote their JSON, and exit 1 is
 * what every real benchmark with a single failing control returns. The refusal
 * is reserved for a signal death, a spawn/stream failure, or a code outside
 * {0,1,2}.
 */
const execFileMock = jest.fn();
jest.mock('node:child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
    runPowerpipeBenchmark,
    scrubSecrets,
    frameworkCodesForControl,
    CLOUD_POSTURE_FRAMEWORK_KEYS,
    type CloudPostureControlMapEntry,
} from '@/app-layer/integrations/cloud-posture/powerpipe-core';
import {
    powerpipeControl,
    type PowerpipeRowStatus,
} from '../../helpers/powerpipe-benchmark-fixture';

/**
 * This repo augments `NodeJS.ProcessEnv` so `NODE_ENV` is REQUIRED, which a bare
 * `{}` does not satisfy. These tests deliberately pass a MINIMAL env — several of
 * them assert exactly which variables reach the child process — so injecting a
 * `NODE_ENV` key to appease the type would corrupt the very assertion the test
 * exists to make. They cast instead.
 *
 * A function rather than a shared constant: each call returns a fresh object, so
 * no test can mutate the env another test is about to pass.
 */
const emptyEnv = (): NodeJS.ProcessEnv => ({}) as NodeJS.ProcessEnv;
const asEnv = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;


type Cb = (err: unknown, stdout?: string, stderr?: string) => void;

/** Resolve the next execFile call with the given stdout/stderr/error. */
function cliResult(opts: { stdout?: string; stderr?: string; err?: unknown }) {
    execFileMock.mockImplementationOnce(
        (_file: string, _args: string[], _o: unknown, cb: Cb) => {
            cb(opts.err ?? null, opts.stdout, opts.stderr);
        },
    );
}

const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
const exitCode = (code: number) => Object.assign(new Error('exited'), { code });

/**
 * Controls in the REAL wire shape, from the source-cited builder. The inline
 * `summary: { status: { … } }` these fixtures used to carry is the shape a
 * result GROUP wears, not a control — see the fixture module's provenance note.
 */
const control = (id: string, status: PowerpipeRowStatus) =>
    powerpipeControl(`x.control.${id}`, status, { title: id });
const benchmarkJson = (controls: unknown[]) => JSON.stringify({ controls });

/**
 * An injected runner — the seam the provider suites use.
 *
 * `code` is optional here on purpose, mirroring the seam: a double that models
 * only success-vs-failure must keep behaving as it did before exit codes were
 * carried, i.e. `{ok:false}` alone still refuses. Tests that care about a
 * specific exit status say so.
 */
const fakeExec =
    (
        stdout: string,
        over: { ok?: boolean; stderr?: string; missing?: boolean; code?: number | null; signal?: string } = {},
    ) =>
    async () => ({
        ok: over.ok ?? true,
        stdout,
        stderr: over.stderr ?? '',
        missing: over.missing ?? false,
        code: over.code,
        signal: over.signal,
    });

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── scrubSecrets ────────────────────────────────────────────────────

describe('scrubSecrets', () => {
    it('returns the text untouched when neither secrets nor patterns are supplied', () => {
        // Both parameters default — the caller-omits-everything shape.
        expect(scrubSecrets('benchmark completed with 3 alarms')).toBe(
            'benchmark completed with 3 alarms',
        );
    });

    it('coerces nullish input to the empty string rather than throwing', () => {
        expect(scrubSecrets(undefined as unknown as string)).toBe('');
        expect(scrubSecrets(null as unknown as string, ['supersecretvalue'])).toBe('');
    });

    it('replaces EVERY occurrence of a secret, not just the first', () => {
        expect(scrubSecrets('a=topsecretvalue b=topsecretvalue', ['topsecretvalue'])).toBe(
            'a=[REDACTED] b=[REDACTED]',
        );
    });

    it('ignores secrets shorter than 8 chars rather than over-redacting', () => {
        // A 7-char secret would shred innocent text; the guard is deliberate.
        expect(scrubSecrets('the cat sat on the mat', ['cat'])).toBe('the cat sat on the mat');
        expect(scrubSecrets('1234567 and 12345678', ['1234567'])).toBe('1234567 and 12345678');
        expect(scrubSecrets('1234567 and 12345678', ['12345678'])).toBe('1234567 and [REDACTED]');
    });

    it('skips empty / falsy secret entries', () => {
        expect(scrubSecrets('plain text', ['', undefined as unknown as string])).toBe('plain text');
    });

    it('applies every supplied pattern in order', () => {
        const out = scrubSecrets(
            'tenant 11111111-2222-3333-4444-555555555555 key abcd',
            [],
            [/[0-9a-f-]{36}/gi, /abcd/g],
        );
        expect(out).toBe('tenant [REDACTED] key [REDACTED]');
    });

    it('applies secret values BEFORE patterns', () => {
        // A secret that a pattern would also match must still be redacted once,
        // not double-wrapped — proving the ordering is stable.
        expect(scrubSecrets('v=supersecretvalue', ['supersecretvalue'], [/supersecret\w+/g])).toBe(
            'v=[REDACTED]',
        );
    });
});

// ─── frameworkCodesForControl ────────────────────────────────────────

describe('frameworkCodesForControl', () => {
    const map: Record<string, CloudPostureControlMapEntry> = {
        both: { label: 'Both', soc2: ['CC6.1'], nistCsf: ['PR.AA-01'] },
        soc2Only: { label: 'SOC2 only', soc2: ['CC7.1'] },
        soc2OnlyEmptyCsf: { label: 'Empty CSF', soc2: ['CC7.1'], nistCsf: [] },
        csfOnly: { label: 'CSF only', soc2: [], nistCsf: ['DE.CM-01'] },
        neither: { label: 'Neither', soc2: [], nistCsf: [] },
    };

    it('returns nothing for a control that is not in the map', () => {
        expect(frameworkCodesForControl(map, 'not_mapped')).toEqual([]);
    });

    it('emits SOC 2 first, then NIST CSF', () => {
        expect(frameworkCodesForControl(map, 'both')).toEqual([
            { frameworkKey: CLOUD_POSTURE_FRAMEWORK_KEYS.soc2, codes: ['CC6.1'] },
            { frameworkKey: CLOUD_POSTURE_FRAMEWORK_KEYS.nistCsf, codes: ['PR.AA-01'] },
        ]);
    });

    it('omits the NIST CSF group when the entry declares none', () => {
        expect(frameworkCodesForControl(map, 'soc2Only')).toEqual([
            { frameworkKey: 'SOC2', codes: ['CC7.1'] },
        ]);
    });

    it('omits the NIST CSF group when the entry declares an EMPTY list', () => {
        // An empty array is truthy — the length check is what keeps a
        // meaningless `{frameworkKey:'NIST-CSF-2.0', codes: []}` out of the
        // crosswalk (it would otherwise create a zero-code mapping row).
        expect(frameworkCodesForControl(map, 'soc2OnlyEmptyCsf')).toEqual([
            { frameworkKey: 'SOC2', codes: ['CC7.1'] },
        ]);
    });

    it('omits the SOC 2 group when the entry has no SOC 2 codes', () => {
        expect(frameworkCodesForControl(map, 'csfOnly')).toEqual([
            { frameworkKey: 'NIST-CSF-2.0', codes: ['DE.CM-01'] },
        ]);
    });

    it('returns nothing for a mapped control that crosswalks to nothing', () => {
        expect(frameworkCodesForControl(map, 'neither')).toEqual([]);
    });

    it('pins the framework keys to the library Framework.key values', () => {
        // These strings are joined against the seeded library; a rename here
        // silently breaks every cloud-posture → requirement mapping.
        expect(CLOUD_POSTURE_FRAMEWORK_KEYS).toEqual({ soc2: 'SOC2', nistCsf: 'NIST-CSF-2.0' });
    });
});

// ─── runPowerpipeBenchmark — the default (real) runner ────────────────

describe('runPowerpipeBenchmark — default runner (no injected exec)', () => {
    const SECRET = 'topsecretvalue123'; // pragma: allowlist secret — synthetic redaction input

    it('invokes powerpipe with the benchmark id on argv and the credentials in ENV', async () => {
        cliResult({ stdout: benchmarkJson([control('c1', 'ok')]) });

        await runPowerpipeBenchmark({
            benchmarkId: 'azure_compliance.benchmark.soc_2',
            env: asEnv({ AZURE_CLIENT_SECRET: SECRET, PATH: '/usr/bin' }),
            secretValues: [SECRET],
        });

        expect(execFileMock).toHaveBeenCalledTimes(1);
        const [file, args, opts] = execFileMock.mock.calls[0];
        expect(file).toBe('powerpipe');
        expect(args).toEqual([
            'benchmark',
            'run',
            'azure_compliance.benchmark.soc_2',
            '--output',
            'json',
        ]);
        // argv is world-readable via /proc — the secret must not be there.
        expect(JSON.stringify(args)).not.toContain(SECRET);
        expect(opts.env.AZURE_CLIENT_SECRET).toBe(SECRET);
    });

    it('bounds the child: 64 MiB maxBuffer and a 15-minute timeout', async () => {
        cliResult({ stdout: benchmarkJson([control('c1', 'ok')]) });
        await runPowerpipeBenchmark({ benchmarkId: 'b', env: emptyEnv(), secretValues: [] });
        const [, , opts] = execFileMock.mock.calls[0];
        expect(opts.maxBuffer).toBe(64 * 1024 * 1024);
        expect(opts.timeout).toBe(15 * 60_000);
    });

    it('scrubs the connection secret out of STDOUT before it is parsed', async () => {
        // The secret arrives inside the collector's own output; by the time it
        // reaches `details` it must already be redacted.
        cliResult({ stdout: benchmarkJson([control(SECRET, 'ok')]) });

        const res = await runPowerpipeBenchmark({
            benchmarkId: 'b',
            env: emptyEnv(),
            secretValues: [SECRET],
        });

        expect(res.status).toBe('PASSED');
        expect(res.summaryObj?.controls).toEqual([{ id: '[REDACTED]', status: 'ok' }]);
        expect(JSON.stringify(res)).not.toContain(SECRET);
    });

    it('scrubs the connection secret out of STDERR before it is surfaced', async () => {
        // Exit 137 rather than exit 1: only a run that did NOT complete
        // surfaces stderr in `errorMessage` at all, so exit 1 would prove
        // nothing about redaction. (Exit 1 is a completed run — see the ladder
        // suite below.) The invariant under test is unchanged: whatever reaches
        // `errorMessage` has been through `scrubSecrets` first.
        cliResult({ err: exitCode(137), stderr: `auth failed for ${SECRET}` });

        const res = await runPowerpipeBenchmark({
            benchmarkId: 'b',
            env: emptyEnv(),
            secretValues: [SECRET],
        });

        expect(res.status).toBe('ERROR');
        expect(res.errorMessage).not.toContain(SECRET);
        expect(res.errorMessage).toContain('[REDACTED]');
    });

    it('applies the per-cloud credential patterns to captured output', async () => {
        cliResult({
            err: exitCode(137),
            stderr: 'tenant 11111111-2222-3333-4444-555555555555 denied',
        });

        const res = await runPowerpipeBenchmark({
            benchmarkId: 'b',
            env: emptyEnv(),
            secretValues: [],
            patterns: [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi],
        });

        expect(res.errorMessage).not.toContain('11111111-2222-3333-4444-555555555555');
        expect(res.errorMessage).toContain('[REDACTED]');
    });

    it('reports a missing CLI (ENOENT) as the install-the-collector error', async () => {
        cliResult({ err: enoent(), stderr: 'spawn powerpipe ENOENT' });

        const res = await runPowerpipeBenchmark({ benchmarkId: 'b', env: emptyEnv(), secretValues: [] });

        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe CLI not installed on the collector host.');
        expect(res.errorMessage).toContain('powerpipe not installed');
        expect(res.summaryObj).toBeNull();
    });

    it('treats an UNDOCUMENTED exit code as a collector error, NOT a missing CLI', async () => {
        // The two refusals carry different operator remedies; conflating them
        // sends someone to install a CLI that is already there. Exit 3 is
        // outside powerpipe's documented {0,1,2}, so it means the run did not
        // complete — unlike 1 and 2, which do.
        cliResult({ err: exitCode(3), stderr: 'ExpiredToken' });

        const res = await runPowerpipeBenchmark({ benchmarkId: 'b', env: emptyEnv(), secretValues: [] });

        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe collector did not complete the run.');
        expect(res.errorMessage).toContain('ExpiredToken');
        // The code an operator needs in order to look it up rides in details,
        // which the usecases persist as IntegrationExecution.resultJson.
        expect(res.details).toEqual({ benchmark: 'b', collectorExitCode: 3 });
    });

    it('a SIGNAL death is a refusal, and is never reported as an exit code', async () => {
        // The 15-minute `timeout` kills the child with SIGTERM: `{code: null,
        // signal: 'SIGTERM'}`. The old derivation was `err.code ?? 1`, so this
        // shape reported exit 1 — which powerpipe defines as "ran fine, some
        // controls alarmed". Under the new gate that would have been PARSED.
        cliResult({ err: Object.assign(new Error('killed'), { signal: 'SIGTERM' }), stderr: 'timed out' });

        const res = await runPowerpipeBenchmark({ benchmarkId: 'b', env: emptyEnv(), secretValues: [] });

        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe collector did not complete the run.');
        expect(res.details).toEqual({ benchmark: 'b', collectorSignal: 'SIGTERM' });
    });

    it('a maxBuffer overflow is a refusal — its STRING `code` is not an exit status', async () => {
        // On a 64 MiB overflow Node sets `err.code` to the string
        // ERR_CHILD_PROCESS_STDIO_MAXBUFFER and kills the child. The field the
        // runner used to declare `number | null` therefore held a string.
        cliResult({
            err: Object.assign(new Error('stdout maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', signal: 'SIGTERM' }),
            stdout: benchmarkJson([control('a', 'ok')]),
        });

        const res = await runPowerpipeBenchmark({ benchmarkId: 'b', env: emptyEnv(), secretValues: [] });

        expect(res.status).toBe('ERROR');
        expect(res.details).toEqual({
            benchmark: 'b',
            collectorSignal: 'SIGTERM',
            collectorFailure: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
    });

    it('treats an error carrying neither code nor signal as a collector error too', async () => {
        cliResult({ err: new Error('killed'), stderr: 'unknown failure' });
        const res = await runPowerpipeBenchmark({ benchmarkId: 'b', env: emptyEnv(), secretValues: [] });
        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe collector did not complete the run.');
        // Nothing is invented: no code, no signal, no failure string.
        expect(res.details).toEqual({ benchmark: 'b' });
    });

    it('tolerates undefined stdout/stderr from the child', async () => {
        // execFile hands back undefined streams on some failure shapes; the
        // nullish coalesce must keep this on the insufficient-data path
        // rather than throwing inside the collector.
        cliResult({});

        const res = await runPowerpipeBenchmark({ benchmarkId: 'b', env: emptyEnv(), secretValues: [] });

        expect(res.status).toBe('ERROR');
        expect(res.errorMessage).toBe('collector returned zero controls');
    });
});

// ─── runPowerpipeBenchmark — the refusal ladder ───────────────────────

describe('runPowerpipeBenchmark — fail-closed ladder (H2)', () => {
    it('never reaches the parser when the CLI is missing', async () => {
        // Valid, all-ok JSON on stdout must NOT rescue a `missing` run.
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(benchmarkJson([control('a', 'ok')]), { ok: false, missing: true }),
        });
        expect(res.status).toBe('ERROR');
        expect(res.details).toEqual({ benchmark: 'bench' });
        expect(res.summaryObj).toBeNull();
    });

    it('never reaches the parser when the run did not complete', async () => {
        // The H2 regression this guards: a broken collector run must not be
        // scored off whatever stdout happened to survive it. Valid, all-ok JSON
        // is supplied precisely so a leak past the gate would show as PASSED.
        //
        // The double reports failure with NO exit status, which is what a
        // signal death and a spawn failure both look like — and what every
        // `{ok:false}` double in the repo means. It is NOT "exit 1": that case
        // now completes, and its counterpart is the next test.
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(benchmarkJson([control('a', 'ok')]), { ok: false, stderr: 'denied' }),
        });
        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe collector did not complete the run.');
        expect(res.summaryObj).toBeNull();
    });

    it('exit 1 DOES reach the parser — it is the routine "controls alarmed" outcome', async () => {
        // #2284: this is the case the `!res.ok` gate discarded. Powerpipe
        // returns 1 for a benchmark with one or more alarms, so refusing it
        // threw away every real compliance run and left the FAILED arm of the
        // verdict ladder unreachable in production.
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(benchmarkJson([control('a', 'ok'), control('b', 'alarm')]), { ok: false, code: 1, stderr: '' }),
        });
        expect(res.status).toBe('FAILED');
        expect(res.summaryObj?.counts).toEqual({ ok: 1, alarm: 1, skip: 0, error: 0, unknown: 0, total: 2 });
        expect(res.details).toEqual({
            benchmark: 'bench',
            counts: { ok: 1, alarm: 1, skip: 0, error: 0, unknown: 0, total: 2 },
            controls: [{ id: 'a', status: 'ok' }, { id: 'b', status: 'alarm' }],
            truncated: false,
            collectorExitCode: 1,
        });
    });

    it('exit 2 reaches the parser, and its per-control errors decide the verdict', async () => {
        // Powerpipe: exit 2 = "completed with no runtime errors, but one or
        // more control errors occurred". Completed — so the JSON is there, and
        // the errored controls are in it. The existing ladder already knows
        // what to do with them; refusing the run would instead have discarded
        // every alarm alongside them.
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(benchmarkJson([control('a', 'ok'), control('b', 'error')]), { ok: false, code: 2 }),
        });
        expect(res.status).toBe('ERROR');
        expect(res.summaryObj?.counts.error).toBe(1);
        expect(res.summary).toBe('bench: 1 ok / 0 alarm / 1 error / 0 skip / 0 unknown of 2');
    });

    it('exit 2 with alarms is FAILED — the real findings are not thrown away', async () => {
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(benchmarkJson([control('a', 'alarm'), control('b', 'error')]), { ok: false, code: 2 }),
        });
        expect(res.status).toBe('FAILED');
    });

    it('exit 2 is NEVER PASSED, even when our parse found no errored control', async () => {
        // The collector counted a control error and our parse did not. That is
        // a disagreement about what happened, and a compliance product does not
        // certify an account over one. FAILED and ERROR are untouched — only
        // the pass is refused.
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(benchmarkJson([control('a', 'ok')]), { ok: false, code: 2 }),
        });
        expect(res.status).toBe('ERROR');
        // Not the zero-controls refusal: a real control parsed, and the counts
        // say so. The ERROR comes from the exit code alone.
        expect(res.summaryObj?.counts).toEqual({ ok: 1, alarm: 0, skip: 0, error: 0, unknown: 0, total: 1 });
    });

    it('a signal BEATS an exit status — a killed child did not complete, whatever number rode with it', async () => {
        // MEASURED GAP: without this, deleting the signal/failure guard from
        // `classifyPowerpipeExit` changed nothing, because every other fixture
        // that carries a signal carries `code: null` and so lands on the
        // `default` arm anyway. The guard only bites when the two disagree —
        // which the `exec` seam can produce, since a caller supplies the whole
        // result object. The rule it encodes: a child that died by signal did
        // not complete its run, and a documented-looking exit code does not
        // rehabilitate it.
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(benchmarkJson([control('a', 'ok')]), { ok: false, code: 1, signal: 'SIGKILL' }),
        });
        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Powerpipe collector did not complete the run.');
        expect(res.summaryObj).toBeNull();
        // Both are reported; neither is dropped in favour of the other.
        expect(res.details).toEqual({ benchmark: 'bench', collectorExitCode: 1, collectorSignal: 'SIGKILL' });
    });

    it('the same all-ok JSON at exit 0 PASSES — the clamp above is the exit code, not the payload', async () => {
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(benchmarkJson([control('a', 'ok')]), { code: 0 }),
        });
        expect(res.status).toBe('PASSED');
    });

    it('an exit-1 run with nothing parseable is still refused as insufficient data', async () => {
        // Parsing exit 1 must not become a way in for an empty payload: the
        // zero-controls refusal sits below the gate and still fires.
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec('', { ok: false, code: 1, stderr: 'denied' }),
        });
        expect(res.status).toBe('ERROR');
        expect(res.errorMessage).toBe('collector returned zero controls');
    });

    it('truncates a huge stderr to 300 chars in the surfaced message', async () => {
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec('', { ok: false, stderr: 'E'.repeat(5000) }),
        });
        expect(res.errorMessage).toBe(`collector error; stderr: ${'E'.repeat(300)}`);
    });

    it('ERRORs on unparseable collector output, carrying the stderr tail', async () => {
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec('not json at all', { stderr: 'warn: mod out of date' }),
        });
        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Failed to parse Powerpipe JSON output.');
        expect(res.errorMessage).toBe('parse error; stderr: warn: mod out of date');
        expect(res.details).toEqual({ benchmark: 'bench' });
        expect(res.summaryObj).toBeNull();
    });

    it('truncates a huge stderr to 300 chars on the parse-error path too', async () => {
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec('{', { stderr: 'W'.repeat(5000) }),
        });
        expect(res.errorMessage).toBe(`parse error; stderr: ${'W'.repeat(300)}`);
    });

    it('treats empty stdout as `{}` — insufficient data, never a pass', async () => {
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(''),
        });
        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('bench: no controls parsed (insufficient data).');
        expect(res.errorMessage).toBe('collector returned zero controls');
        // Unlike the three refusals above, THIS one carries a real (empty)
        // summary object — the caller can tell "collector ran but found
        // nothing" from "collector never ran".
        expect(res.summaryObj).toEqual({
            benchmark: 'bench',
            counts: { ok: 0, alarm: 0, skip: 0, error: 0, unknown: 0, total: 0 },
            controls: [],
            truncated: false,
        });
    });

    it('ERRORs on a well-formed benchmark that contains no controls', async () => {
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(JSON.stringify({ groups: [{ groups: [] }] })),
        });
        expect(res.status).toBe('ERROR');
        expect(res.errorMessage).toBe('collector returned zero controls');
    });
});

// ─── runPowerpipeBenchmark — verdicts ────────────────────────────────

describe('runPowerpipeBenchmark — verdict ladder', () => {
    const run = (controls: unknown[]) =>
        runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(benchmarkJson(controls)),
        });

    it('PASSES when every control is ok or skipped', async () => {
        const res = await run([control('a', 'ok'), control('b', 'skip')]);
        expect(res.status).toBe('PASSED');
        expect(res.summary).toBe('bench: 1 ok / 0 alarm / 0 error / 1 skip / 0 unknown of 2');
    });

    it('FAILS when any control alarms', async () => {
        const res = await run([control('a', 'ok'), control('b', 'alarm')]);
        expect(res.status).toBe('FAILED');
        expect(res.summary).toBe('bench: 1 ok / 1 alarm / 0 error / 0 skip / 0 unknown of 2');
    });

    it('ERRORs when controls errored and none alarmed', async () => {
        // Distinct from the refusal ladder: this ERROR carries the real
        // counts, so the summary is a verdict rather than a refusal reason.
        const res = await run([control('a', 'ok'), control('b', 'error')]);
        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('bench: 1 ok / 0 alarm / 1 error / 0 skip / 0 unknown of 2');
        expect(res.summaryObj?.counts.error).toBe(1);
        expect(res.errorMessage).toBeUndefined();
    });

    it('ranks alarm above error — a FAILED verdict is not masked by an error', async () => {
        const res = await run([control('a', 'alarm'), control('b', 'error')]);
        expect(res.status).toBe('FAILED');
    });

    it('PASSES a skip-only benchmark (a control that ran and did not apply)', async () => {
        const res = await run([control('a', 'skip')]);
        expect(res.status).toBe('PASSED');
    });

    it('carries the bounded summary through as details', async () => {
        const res = await run([control('a', 'ok')]);
        expect(res.details).toEqual({
            benchmark: 'bench',
            counts: { ok: 1, alarm: 0, skip: 0, error: 0, unknown: 0, total: 1 },
            controls: [{ id: 'a', status: 'ok' }],
            truncated: false,
        });
    });
});

// ─── the clock seam ──────────────────────────────────────────────────

describe('runPowerpipeBenchmark — durationMs', () => {
    it('measures the run with the injected clock', async () => {
        const ticks = [1_000, 4_500];
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec(benchmarkJson([control('a', 'ok')])),
            now: () => ticks.shift() ?? 9_999,
        });
        expect(res.durationMs).toBe(3_500);
    });

    it('measures the run on a REFUSAL too, so a fast failure is visible', async () => {
        const ticks = [10, 42];
        const res = await runPowerpipeBenchmark({
            benchmarkId: 'bench',
            env: emptyEnv(),
            secretValues: [],
            exec: fakeExec('', { ok: false, missing: true }),
            now: () => ticks.shift() ?? 9_999,
        });
        expect(res.durationMs).toBe(32);
    });

    it('falls back to Date.now — the REAL wall clock — when no clock is injected', async () => {
        // The previous form of this test asserted `durationMs >= 0 && < 60_000`,
        // which is true of almost any implementation: it stayed green with the
        // fallback replaced by `() => 0`, so it read as protection while
        // covering nothing. Pinning `Date.now` itself makes the branch
        // falsifiable — the fallback must be Date.now specifically, not merely
        // "some number that looks plausible".
        const spy = jest.spyOn(Date, 'now');
        try {
            let call = 0;
            spy.mockImplementation(() => (call++ === 0 ? 5_000 : 5_250));

            const res = await runPowerpipeBenchmark({
                benchmarkId: 'bench',
                env: emptyEnv(),
                secretValues: [],
                exec: fakeExec(benchmarkJson([control('a', 'ok')])),
            });

            expect(res.durationMs).toBe(250);
            expect(spy).toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it('prefers the injected clock over Date.now rather than consulting both', async () => {
        // The other half of `input.now ?? Date.now`: when a clock IS supplied
        // the wall clock must not be read at all, or a caller that injected a
        // deterministic clock would still get non-determinism.
        const spy = jest.spyOn(Date, 'now');
        try {
            spy.mockImplementation(() => 999_999);
            const ticks = [100, 175];

            const res = await runPowerpipeBenchmark({
                benchmarkId: 'bench',
                env: emptyEnv(),
                secretValues: [],
                exec: fakeExec(benchmarkJson([control('a', 'ok')])),
                now: () => ticks.shift() ?? 9_999,
            });

            expect(res.durationMs).toBe(75);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});
