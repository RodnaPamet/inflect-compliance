/**
 * The caller starts the gateway VM before it creates a sandbox — 4.3 (#4562).
 *
 * Owner decision 2026-10-30. There is no start schedule and no Cloud Scheduler:
 * the 5 USD/month cap is a runtime budget of about 45 hours, so a day with no
 * scan must cost nothing and starting the machine is the CALLER's act. #4562
 * found that no caller did — the machine was `TERMINATED` and stayed that way.
 *
 * ═══ THE THREE PROPERTIES WORTH HOLDING ═══
 *
 * 1. a start is attempted only when the deploy names a VM. A deploy pointing at
 *    a gateway somebody else runs — including a local one — must not have
 *    `instances start` fired at it;
 * 2. a start that does NOT reach `readyz` stops the collection, rather than
 *    creating a sandbox that can only fail more slowly having spent the boot;
 * 3. it runs PER CALL, because the idle timer takes the VM down after 20
 *    minutes and a runner built once is used many times.
 *
 * @module unit/agentic/collector-starts-the-gateway
 */

const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

import {
    gatewayStartIsConfigured,
    sandboxedCollectorExec,
} from '@/app-layer/integrations/cloud-posture/sandboxed-collector-exec';
import { SandboxUnreachableError, type SandboxTransport } from '@/lib/agentic/openshell/transport';
import { START_OUTCOMES_READY, type StartOutcome } from '@/lib/sandbox-runtime/gateway-start';

/** Names a VM, so a start is in scope. */
function configureVm(): void {
    mockEnv.SANDBOX_RUNTIME_GATEWAY_PROJECT = 'proj';
    mockEnv.SANDBOX_RUNTIME_GATEWAY_ZONE = 'europe-west1-b';
    mockEnv.SANDBOX_RUNTIME_GATEWAY_INSTANCE = 'openshell-gateway';
}

/**
 * A transport that records whether it was reached AT ALL.
 *
 * The counter is the discriminator and it was missing from the first draft of
 * this suite. Without it, "refused because the start failed" and "refused
 * because the sandbox create failed" are the same assertion: both produce a
 * `SandboxUnreachableError` and both leave `res.ok` false. A mutation that
 * skipped the readiness check entirely passed three of these tests.
 */
function countingTransport(): { transport: SandboxTransport; creates: () => number } {
    let creates = 0;
    const transport: SandboxTransport = {
        createSandbox: async () => {
            creates += 1;
            // Refuses AFTER counting: this suite is about the start, and a real
            // sandbox would need a gateway.
            throw new SandboxUnreachableError('no gateway in this test');
        },
        execSandbox: async () => {
            throw new Error('not reached');
        },
        deleteSandbox: async () => ({ outcome: 'DELETION_OUTCOME_COMPLETED' }),
        awaitDeleted: async () => undefined,
        attachProvider: async () => undefined,
    };
    return { transport, creates: () => creates };
}

const run = (exec: ReturnType<typeof sandboxedCollectorExec>) =>
    exec('powerpipe', ['benchmark', 'run'], {} as NodeJS.ProcessEnv, [], []);

beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
});

describe('whether a start is even in scope', () => {
    it('is NOT configured when the deploy names no VM — every deploy today', () => {
        expect(gatewayStartIsConfigured()).toBe(false);
    });

    it('needs all three, so a half-filled deploy does not fire instances start', () => {
        // A deploy pointing at a gateway somebody else runs is the common case
        // this protects: starting it would be wrong, not merely unnecessary.
        mockEnv.SANDBOX_RUNTIME_GATEWAY_PROJECT = 'proj';
        expect(gatewayStartIsConfigured()).toBe(false);
        mockEnv.SANDBOX_RUNTIME_GATEWAY_ZONE = 'z';
        expect(gatewayStartIsConfigured()).toBe(false);
        mockEnv.SANDBOX_RUNTIME_GATEWAY_INSTANCE = 'i';
        expect(gatewayStartIsConfigured()).toBe(true);
    });

    it('an EMPTY value is not a value — compose delivers empty strings', () => {
        // `"${VAR:-}"` is how every optional value in this stack is defaulted,
        // so a blank line must read as absent rather than as a VM named ''.
        mockEnv.SANDBOX_RUNTIME_GATEWAY_PROJECT = 'proj';
        mockEnv.SANDBOX_RUNTIME_GATEWAY_ZONE = '';
        mockEnv.SANDBOX_RUNTIME_GATEWAY_INSTANCE = 'i';
        expect(gatewayStartIsConfigured()).toBe(false);
    });
});

describe('the start happens before any sandbox is created', () => {
    it('does not start anything when no VM is named', async () => {
        const startGateway = jest.fn();
        const { transport } = countingTransport();
        const exec = sandboxedCollectorExec({
            providerName: 'inflect-collector',
            transport,
            startGateway: startGateway as never,
        });
        const res = await run(exec);
        expect(startGateway).not.toHaveBeenCalled();
        // And the collection still went to the transport, unchanged from before.
        expect(res.ok).toBe(false);
    });

    it.each(START_OUTCOMES_READY)('proceeds to the sandbox when the VM is %s', async (outcome) => {
        configureVm();
        const startGateway = jest.fn(async () => ({ outcome, waitedMs: 1 }));
        const { transport, creates } = countingTransport();
        const exec = sandboxedCollectorExec({
            providerName: 'inflect-collector',
            transport,
            startGateway,
        });
        await run(exec);
        expect(startGateway).toHaveBeenCalledTimes(1);
        // The mirror of the discriminator below: a READY gateway must let the
        // collection through to the sandbox.
        expect(creates()).toBe(1);
    });

    it.each(['not-permitted', 'timed-out', 'unavailable'] as StartOutcome[])(
        'refuses the collection when the start ends %s',
        async (outcome) => {
            /*
                The whole point. Creating a sandbox after a failed start can only
                fail more slowly, having already spent the boot — and
                `not-permitted` in production means the compute scope is absent,
                which no amount of retrying fixes.
            */
            configureVm();
            const startGateway = jest.fn(async () => ({ outcome, waitedMs: 2_000 }));
            const { transport, creates } = countingTransport();
            const exec = sandboxedCollectorExec({
                providerName: 'inflect-collector',
                transport,
                startGateway,
            });
            const res = await run(exec);
            // The ladder reports this as ERROR, never a quiet PASSED.
            expect(res.ok).toBe(false);
            expect(res.failure ?? '').toMatch(/SANDBOX_UNREACHABLE|unreachable/i);
            expect(startGateway).toHaveBeenCalledTimes(1);
            // THE DISCRIMINATOR: no sandbox was attempted. Without this the
            // assertions above pass for a run that skipped the readiness check
            // and failed at `createSandbox` instead — the same error, a
            // different cause, and the boot already spent.
            expect(creates()).toBe(0);
        },
    );

    it('names the outcome and the wait in the refusal, so a log says WHICH failure', async () => {
        // "unreachable" alone cannot tell a missing scope from a slow boot, and
        // those need different people.
        configureVm();
        const exec = sandboxedCollectorExec({
            providerName: 'inflect-collector',
            transport: countingTransport().transport,
            startGateway: async () => ({ outcome: 'timed-out' as StartOutcome, waitedMs: 120_000 }),
        });
        const res = await run(exec);
        expect(res.stderr + (res.failure ?? '')).toMatch(/timed-out/);
        expect(res.stderr + (res.failure ?? '')).toMatch(/120000/);
    });

    it('starts PER CALL, because the idle timer takes the VM down between scans', async () => {
        /*
            A runner is built once and used many times. The idle timer shuts the
            machine after four consecutive idle five-minute checks, so a start
            bound to construction would find it gone on the second collection —
            and that failure would look like an unreachable gateway rather than
            a missing start.
        */
        configureVm();
        const startGateway = jest.fn(async () => ({ outcome: 'started' as StartOutcome, waitedMs: 45_000 }));
        const exec = sandboxedCollectorExec({
            providerName: 'inflect-collector',
            transport: countingTransport().transport,
            startGateway,
        });
        await run(exec);
        await run(exec);
        await run(exec);
        expect(startGateway).toHaveBeenCalledTimes(3);
    });
});
