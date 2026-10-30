/**
 * #4563 — the audit bridge is passed a recorder, bound to the scan's tenant.
 *
 * #4522 built the bridge and connected the executor's seam, and a test asserts
 * that forwarding. What nothing asserted was the other end: no caller supplied
 * an `onDecision`, so every sandbox created, refused or deleted went
 * unrecorded, with no failing test to say so.
 *
 * ═══ WHY THE TENANT IS BOUND PER SCAN AND NOT PER INSTANCE ═══
 *
 * `bootstrap.ts` registers all three posture providers as MODULE-LEVEL
 * singletons, and `automation-runner` dispatches those same instances for every
 * tenant. So the obvious fix — thread a tenant into the constructor — would
 * bind the first tenant permanently and file every other tenant's decisions
 * under it. #4563 names that as the thing not to do: the audit log is
 * per-tenant and hash-chained, so "a row filed against the wrong tenant is
 * worse than an absent one".
 *
 * The two-tenants-one-instance case below is therefore the point of this file,
 * not an edge: it is the exact shape production runs in.
 *
 * @module unit/integrations/posture-sandbox-decisions-reach-the-audit-log
 */

const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

/** Captures what `logEvent` was asked to write, and under which context. */
const logged: Array<{ tenantId: string; actorType: string; requestId: string; action: string }> = [];
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(
        async (
            _db: unknown,
            ctx: { tenantId: string; actorType: string; requestId: string },
            payload: { action: string },
        ) => {
            logged.push({
                tenantId: ctx.tenantId,
                actorType: ctx.actorType,
                requestId: ctx.requestId,
                action: payload.action,
            });
        },
    ),
}));

import { AwsPostureProvider } from '@/app-layer/integrations/aws-posture-provider';
import { AzurePostureProvider } from '@/app-layer/integrations/providers/azure-posture-provider';
import { GcpPostureProvider } from '@/app-layer/integrations/providers/gcp-posture-provider';
import { sandboxDecisionRecorderForScan } from '@/app-layer/integrations/openshell-audit-bridge';
import * as sandboxedCollector from '@/app-layer/integrations/cloud-posture/sandboxed-collector-exec';
import type { CheckInput } from '@/app-layer/integrations/types';
import type { SandboxDecision } from '@/lib/agentic/openshell/sandbox-decisions';

/**
 * A real member of the union, and the ACTION is asserted wherever this is used.
 *
 * The first draft said `kind: 'created'`, which is not a member. Jest could not
 * see it — the mocked `logEvent` accepts any payload, and the assertions were on
 * the context rather than the action — so `SANDBOX_DECISION_ACTIONS[kind]`
 * resolved to `undefined` and fifteen tests passed on a fixture that could never
 * occur. `tsc` caught it. Asserting the action below is what keeps it caught
 * even where a future reader loosens the type.
 */
const CREATED: SandboxDecision = { kind: 'sandbox-created', sandboxId: 'sbx-1' };
const CREATED_ACTION = 'OPENSHELL_SANDBOX_CREATED';

function checkInput(provider: string, tenantId: string, jobRunId?: string): CheckInput {
    return {
        automationKey: `${provider}.soc2`,
        parsed: { provider, checkType: 'soc2', raw: `${provider}.soc2` },
        tenantId,
        connectionConfig: { benchmark: 'soc2' },
        triggeredBy: 'scheduled',
        ...(jobRunId ? { jobRunId } : {}),
    };
}

/**
 * Intercept `collectorExecForDeploy` to capture the `onDecision` each scan
 * passes, and return a runner that does nothing.
 *
 * The spy sits at the deploy boundary rather than inside the sandbox because
 * what #4563 is about is the ARGUMENT — whether a recorder is handed over at
 * all, and whose tenant it carries. That the runner then forwards it to the
 * executor is #4522's test, already passing, and re-proving it here would make
 * this file depend on a transport to assert a wiring question.
 */
function spyOnDeployExec() {
    const handed: Array<((d: SandboxDecision) => Promise<void>) | undefined> = [];
    const ran: Array<{ secretValues: string[]; patterns: RegExp[] }> = [];
    const spy = jest
        .spyOn(sandboxedCollector, 'collectorExecForDeploy')
        .mockImplementation((deps = {}) => {
            if (!mockEnv.SANDBOX_EXECUTION_ENABLED || mockEnv.SANDBOX_EXECUTION_ENABLED !== '1') {
                return null;
            }
            handed.push(deps.onDecision);
            return async (
                _file: string,
                _args: string[],
                _env: NodeJS.ProcessEnv,
                secretValues: string[],
                patterns: RegExp[],
            ) => {
                ran.push({ secretValues, patterns });
                return {
                    ok: true,
                    stdout: '{}',
                    stderr: '',
                    missing: false,
                    code: 0,
                    signal: null,
                };
            };
        });
    return { handed, ran, spy };
}

beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    logged.length = 0;
    jest.restoreAllMocks();
});

describe('the recorder a scan hands over', () => {
    it('carries the SCAN\'s tenant, as a JOB, with a greppable request id', async () => {
        const record = sandboxDecisionRecorderForScan({
            tenantId: 'tenant-abc',
            job: 'gcp-posture-collect',
            discriminator: 'run-77',
        });
        await record(CREATED);

        expect(logged).toHaveLength(1);
        expect(logged[0].action).toBe(CREATED_ACTION);
        expect(logged[0].tenantId).toBe('tenant-abc');
        // Not 'USER'. A scheduled collection has no person behind it, and the
        // default would make every row claim one did.
        expect(logged[0].actorType).toBe('JOB');
        // Job, tenant and run id, so one run's rows group and are findable.
        expect(logged[0].requestId).toBe('gcp-posture-collect-tenant-abc-run-77');
    });

    it('writes under the right tenant for each of two different tenants', async () => {
        await sandboxDecisionRecorderForScan({ tenantId: 't-1', job: 'j' })(CREATED);
        await sandboxDecisionRecorderForScan({ tenantId: 't-2', job: 'j' })(CREATED);
        expect(logged.map((l) => l.tenantId)).toEqual(['t-1', 't-2']);
    });
});

/*
    Each row carries BOTH builders — one with no runner and one with an injected
    double — so no case has to map a key back to a class.

    The first draft derived the injected provider from `providerKey` with
    `providerKey === 'gcp' ? ... : ...`, and `providerKey` is `'gcp-posture'`.
    Nothing matched, every row fell through to the AWS branch, and the
    injected-runner case tested AWS three times while reporting three
    providers. Jest cannot see a comparison that is merely always false; `tsc`
    reported it as "no overlap". Passing the builder removes the comparison
    rather than correcting it.
*/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Injected = (exec: any) => { runCheck: (i: CheckInput) => Promise<unknown> };

describe.each([
    [
        'gcp',
        () => new GcpPostureProvider(),
        ((exec) => new GcpPostureProvider({ exec })) as Injected,
        'gcp-posture',
        'gcp-posture-collect',
    ],
    [
        'azure',
        () => new AzurePostureProvider(),
        ((exec) => new AzurePostureProvider({ exec })) as Injected,
        'azure-posture',
        'azure-posture-collect',
    ],
    [
        'aws',
        () => new AwsPostureProvider(),
        ((exec) => new AwsPostureProvider({ exec })) as Injected,
        'aws-posture',
        'aws-posture-collect',
    ],
] as const)('%s posture provider', (_name, build, buildInjected, providerKey, job) => {
    it('hands the bridge a recorder when the deploy supplies the runner', async () => {
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        const { handed } = spyOnDeployExec();

        await build().runCheck(checkInput(providerKey, 'tenant-1'));

        // A recorder reached the runner. Before #4563 this was `undefined` on
        // every scan, which is an empty audit trail with no failing test.
        const recorders = handed.filter((h): h is (d: SandboxDecision) => Promise<void> => !!h);
        expect(recorders).toHaveLength(1);

        await recorders[0](CREATED);
        expect(logged).toHaveLength(1);
        expect(logged[0].action).toBe(CREATED_ACTION);
        expect(logged[0].tenantId).toBe('tenant-1');
        expect(logged[0].requestId).toContain(job);
    });

    it('binds a DIFFERENT tenant on each scan of the SAME instance', async () => {
        /*
            THE REGRESSION. `bootstrap.ts` holds one instance per provider for
            the whole process and `automation-runner` runs every tenant through
            it. A recorder bound once — in the constructor, or memoised here —
            would file tenant-2's sandbox decisions under tenant-1, in a
            hash-chained per-tenant log where that is worse than writing
            nothing.
        */
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        const { handed } = spyOnDeployExec();
        const provider = build();

        await provider.runCheck(checkInput(providerKey, 'tenant-1'));
        await provider.runCheck(checkInput(providerKey, 'tenant-2'));

        const recorders = handed.filter((h): h is (d: SandboxDecision) => Promise<void> => !!h);
        expect(recorders).toHaveLength(2);
        await recorders[0](CREATED);
        await recorders[1](CREATED);
        expect(logged.map((l) => l.tenantId)).toEqual(['tenant-1', 'tenant-2']);
    });

    it('hands over NOTHING when a caller injected the runner', async () => {
        // An injected double runs no sandbox, so it has no lifecycle decision
        // to record. Handing it a recorder would invite rows for sandboxes that
        // were never created.
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        const { spy } = spyOnDeployExec();
        const exec = jest.fn(async () => ({
            ok: true,
            stdout: '{}',
            stderr: '',
            missing: false,
            code: 0,
            signal: null,
        }));

        const provider = buildInjected(exec);

        // BASELINED after construction, not asserted as zero. A provider built
        // with no injected runner consults the deploy once in its constructor —
        // that is the existing behaviour and not what this case is about. What
        // must not happen is a SECOND, per-scan consultation, because that is
        // the one that would hand over a recorder.
        const afterConstruction = spy.mock.calls.length;

        await provider.runCheck(checkInput(providerKey, 'tenant-1'));

        expect(exec).toHaveBeenCalled();
        expect(spy.mock.calls.length).toBe(afterConstruction);
        expect(logged).toHaveLength(0);
    });

    it('hands over nothing when the platform switch is off — its default', async () => {
        // Absent reads as off. An unconfigured deploy keeps the on-host path and
        // records nothing, because nothing ran in a sandbox.
        const { handed } = spyOnDeployExec();
        await build()
            .runCheck(checkInput(providerKey, 'tenant-1'))
            .catch(() => undefined); // the on-host CLI is absent here; irrelevant
        expect(handed).toHaveLength(0);
        expect(logged).toHaveLength(0);
    });
});

describe('the AWS per-scan adapter still redacts', () => {
    /*
        NOT a #4563 behaviour — a hole #4563 walked past, and measured as one.

        AWS reaches the shared runner through an adapter, because this file's
        runner takes `AwsPostureSecrets` where the shared one takes a value list
        and a pattern list. Its own comment says what is at stake: handing over
        only the values "would be the difference between redacting an access key
        and printing it".

        Nothing asserted it. Replacing `AWS_CREDENTIAL_PATTERNS` with `[]` left
        128 tests across five AWS and sandbox suites green, and no test file in
        the repository mentioned the constant. Threading the recorder moved that
        adapter into a second call site (`adapt`, reached per scan), so it is now
        a seam this change introduced — and an untested seam that carries secret
        redaction is the wrong thing to leave behind.
    */
    it('hands the runner BOTH the secret values and the credential patterns', async () => {
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        const { ran } = spyOnDeployExec();

        await new AwsPostureProvider().runCheck({
            automationKey: 'aws-posture.soc2',
            parsed: { provider: 'aws-posture', checkType: 'soc2', raw: 'aws-posture.soc2' },
            tenantId: 'tenant-1',
            connectionConfig: {
                benchmark: 'soc2',
                // It must LOOK like an access key: the point of this case is that a
                // key-shaped value reaches the scrubber, so a value the patterns do
                // not match would make the test pass for the wrong reason.
                accessKeyId: 'AKIAEXAMPLE000000000', // pragma: allowlist secret — synthetic placeholder
                secretAccessKey: 'secret-access-key-value', // pragma: allowlist secret — synthetic
                sessionToken: 'session-token-value', // pragma: allowlist secret — synthetic
            },
            triggeredBy: 'scheduled',
        });

        expect(ran).toHaveLength(1);
        // The values, so the exact secret is scrubbed from both streams.
        expect(ran[0].secretValues).toEqual(
            expect.arrayContaining(['AKIAEXAMPLE000000000', 'secret-access-key-value', 'session-token-value']), // pragma: allowlist secret — the same synthetic placeholders asserted back
        );
        // And the patterns, so a credential this scan never saw — one the CLI
        // printed from its own environment or a config file — is scrubbed too.
        expect(ran[0].patterns.length).toBeGreaterThan(0);
        // Asserted by BEHAVIOUR, not by identity: a pattern list that matches
        // an access key is the property, and comparing against the exported
        // constant would pass for an empty list if the constant became empty.
        // AWS's own published documentation key, which is why it is the right
        // probe: the canonical access-key SHAPE, never a live credential.
        expect(ran[0].patterns.some((re) => re.test('AKIAIOSFODNN7EXAMPLE'))).toBe(true); // pragma: allowlist secret — AWS documentation example
    });
});
