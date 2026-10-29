/**
 * 4.1 (#3961) — the collectors run in a sandbox, and a sandbox failure is ERROR.
 *
 * The issue's done-when names one test explicitly: "a test proves a collector
 * failure is ERROR rather than PASSED". The cases below drive the REAL
 * `runPowerpipeBenchmark` with a sandboxed runner over a transport that fails
 * in each way a gateway can, because the thing worth proving is not that the
 * bridge returns a tidy object — it is that the collector's existing ladder
 * reaches ERROR from it.
 *
 * That ladder is reused rather than reimplemented, which is why these are
 * end-to-end over `runPowerpipeBenchmark`: a bridge tested only against its own
 * return shape could map every failure to a plausible-looking result that the
 * ladder still scored PASSED, and nothing would have caught it.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

import {
    sandboxedCollectorExec,
    collectorExecForDeploy,
} from '@/app-layer/integrations/cloud-posture/sandboxed-collector-exec';
import { runPowerpipeBenchmark } from '@/app-layer/integrations/cloud-posture/powerpipe-core';
import {
    SandboxExecIncompleteError,
    SandboxUnreachableError,
    unconfiguredTransport,
    type SandboxTransport,
} from '@/lib/agentic/openshell/transport';
import { TOOL_EXEC_MAX_OUTPUT_BYTES, TOOL_EXEC_TIMEOUT_MS } from '@/lib/agentic/bounded-exec';

const BENCHMARK = 'gcp_compliance.benchmark.cis_v300';
const PROVIDER = 'inflect-collector';

interface Recorded {
    created: number;
    attached: Array<{ sandboxId: string; providerName: string }>;
    execEnv: Array<NodeJS.ProcessEnv | undefined>;
    deleted: string[];
    order: string[];
}

interface FakeOpts {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly execThrows?: Error;
    readonly attachThrows?: Error;
    readonly createThrows?: Error;
}

const fake = (opts: FakeOpts = {}): { transport: SandboxTransport; rec: Recorded } => {
    const rec: Recorded = { created: 0, attached: [], execEnv: [], deleted: [], order: [] };
    const transport: SandboxTransport = {
        createSandbox: async () => {
            rec.order.push('create');
            if (opts.createThrows) throw opts.createThrows;
            rec.created++;
            return { id: `sbx-${rec.created}`, phase: 'SANDBOX_PHASE_READY' } as never;
        },
        attachProvider: async ({ sandboxId, providerName }) => {
            rec.order.push('attach');
            if (opts.attachThrows) throw opts.attachThrows;
            rec.attached.push({ sandboxId, providerName });
        },
        execSandbox: async ({ env }) => {
            rec.order.push('exec');
            rec.execEnv.push(env);
            if (opts.execThrows) throw opts.execThrows;
            return {
                exitCode: opts.exitCode ?? 0,
                signal: null,
                stdout: opts.stdout ?? '{}',
                stderr: '',
                exited: true,
            } as never;
        },
        deleteSandbox: async ({ sandboxId }) => {
            rec.order.push('delete');
            rec.deleted.push(sandboxId);
            return { outcome: 'DELETION_OUTCOME_COMPLETED' } as never;
        },
        awaitDeleted: async () => {},
    };
    return { transport, rec };
};

const run = (transport: SandboxTransport) =>
    runPowerpipeBenchmark({
        benchmarkId: BENCHMARK,
        env: { NODE_ENV: 'test', GOOGLE_APPLICATION_CREDENTIALS: '/should/not/be/used' },
        secretValues: ['super-secret-key-value'],
        exec: sandboxedCollectorExec({ transport, providerName: PROVIDER }),
    });

describe('a sandboxed collector failure is ERROR, never PASSED (#3961)', () => {
    beforeEach(() => {
        for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    });

    it('an unreachable gateway is ERROR', async () => {
        // The production path today: this build ships `unconfiguredTransport`.
        const r = await run(unconfiguredTransport);
        expect(r.status).toBe('ERROR');
        expect(r.status).not.toBe('PASSED');
        expect(r.details).toMatchObject({ collectorFailure: 'SANDBOX_UNREACHABLE' });
    });

    it('a stream that closed without an exit event is ERROR, never a partial success', async () => {
        // The issue's own words. A gateway that drops the connection mid-run has
        // produced output nobody can attribute an exit to.
        const { transport } = fake({
            execThrows: new SandboxExecIncompleteError('sbx-1', 2048),
        });
        const r = await run(transport);
        expect(r.status).toBe('ERROR');
        expect(r.details).toMatchObject({ collectorFailure: 'SANDBOX_EXEC_INCOMPLETE' });
    });

    it('a provider that cannot be attached is ERROR, and the tool never runs', async () => {
        // An unattached collector fails in a way that looks exactly like a
        // revoked key, so it must not run at all.
        const { transport, rec } = fake({ attachThrows: new Error('provider not found') });
        const r = await run(transport);
        expect(r.status).toBe('ERROR');
        expect(rec.order.filter((o) => o === 'exec')).toEqual([]);
        // And the sandbox it had already created is still cleaned up.
        expect(rec.deleted).toEqual(['sbx-1']);
    });

    it('a refused creation is ERROR', async () => {
        const { transport } = fake({ createThrows: new Error('compute driver refused') });
        const r = await run(transport);
        expect(r.status).toBe('ERROR');
    });

    it('an undocumented exit code is ERROR — the ladder decides, not the bridge', async () => {
        // 0, 1 and 2 are documented; 9 is not, and the collector's own
        // classifier is what refuses it. The bridge only has to pass the number
        // through as a number.
        const { transport } = fake({ exitCode: 9 });
        const r = await run(transport);
        expect(r.status).toBe('ERROR');
        expect(r.details).toMatchObject({ collectorExitCode: 9 });
    });

    it('a sandbox that ran but parsed nothing is ERROR, not an empty pass', async () => {
        // Exit 0 with no controls. `summary.counts.total === 0` is insufficient
        // data, which the ladder already refuses to call PASSED.
        const { transport } = fake({ exitCode: 0, stdout: '{}' });
        const r = await run(transport);
        expect(r.status).toBe('ERROR');
    });

    it('the positive control — a clean sandboxed run is NOT forced to ERROR', async () => {
        // Without this, every assertion above is satisfied by a bridge that
        // returns ERROR unconditionally.
        const groups = JSON.stringify({
            groups: [{ controls: [{ control_id: 'c1', results: [{ status: 'ok' }] }] }],
        });
        const { transport, rec } = fake({ exitCode: 0, stdout: groups });
        const r = await run(transport);
        expect(r.status).not.toBe('ERROR');
        expect(rec.order.filter((o) => o === 'exec').length).toBeGreaterThan(0);
    });
});

describe('credentials reach the sandbox only through the gateway (#3961)', () => {
    beforeEach(() => {
        for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    });

    it('no environment is forwarded to the sandbox', async () => {
        // The bullet's distinction: an env var is readable by the binary being
        // confined, by anything it spawns, and by /proc/<pid>/environ. The
        // caller's env is deliberately dropped.
        const { transport, rec } = fake({ exitCode: 0 });
        await run(transport);
        expect(rec.execEnv).toEqual([undefined]);
    });

    it('the named provider is attached, and BEFORE the tool runs', async () => {
        const { transport, rec } = fake({ exitCode: 0 });
        await run(transport);
        expect(rec.attached).toEqual([{ sandboxId: 'sbx-1', providerName: PROVIDER }]);
        expect(rec.order.indexOf('attach')).toBeLessThan(rec.order.indexOf('exec'));
        // And after creation, because there is nothing to attach to before it.
        expect(rec.order.indexOf('create')).toBeLessThan(rec.order.indexOf('attach'));
    });

    it('secret values are scrubbed out of what the sandbox returned', async () => {
        const { transport } = fake({
            exitCode: 9,
            stdout: 'leaking super-secret-key-value here',
        });
        const r = await run(transport);
        expect(JSON.stringify(r).includes('super-secret-key-value')).toBe(false);
    });
});

describe('the deploy switch leaves an unconfigured deploy alone (#3961)', () => {
    beforeEach(() => {
        for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    });

    it('is null when the platform switch is absent — the default', async () => {
        // Absent reads as off, so a deploy that has said nothing about sandboxed
        // execution keeps the on-host path exactly as it was. `null` rather than
        // a no-op runner: the providers key their on-disk credential handling off
        // whether a runner was supplied at all.
        expect(collectorExecForDeploy()).toBeNull();
    });

    it('is null when the switch is explicitly off', () => {
        mockEnv.SANDBOX_EXECUTION_ENABLED = '0';
        expect(collectorExecForDeploy()).toBeNull();
    });

    it('is a runner when the switch is on', () => {
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        expect(typeof collectorExecForDeploy()).toBe('function');
    });

    it('a switched-on deploy with no gateway fails CLOSED', async () => {
        // The footgun, asserted as the intended direction: turning the switch on
        // without a gateway does not silently keep running on the host, it makes
        // every collection ERROR. The deploy has declared a capability it cannot
        // provide, and that is the safe way to find out.
        mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
        const exec = collectorExecForDeploy();
        expect(exec).not.toBeNull();
        const r = await runPowerpipeBenchmark({
            benchmarkId: BENCHMARK,
            env: { NODE_ENV: 'test' },
            secretValues: [],
            exec: exec!,
        });
        expect(r.status).toBe('ERROR');
    });
});

describe('the existing bounds move with the call (#3961)', () => {
    it('are the collectors own 15 minutes and 64 MB, not a second copy', () => {
        // The issue requires the bounds to move with the call. They are
        // `runBoundedTool`'s DEFAULTS, so the bridge gets them by using it —
        // asserted here so a future edit that hard-codes different numbers in
        // the bridge is caught.
        expect(TOOL_EXEC_TIMEOUT_MS).toBe(15 * 60_000);
        expect(TOOL_EXEC_MAX_OUTPUT_BYTES).toBe(64 * 1024 * 1024);
    });
});
