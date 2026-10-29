/**
 * The OpenShell backend, and both bounds tripping THROUGH it — 4.2 (#3962).
 *
 * The issue's acceptance is "both bounds trip through the backend — deadline and
 * output cap, each proven by a test that produces the condition". The point of
 * asserting them here rather than trusting `bounded-exec`'s own tests is that
 * the backend is a different executor: a bound that holds for
 * `nodeToolExecutor` and not for this one would be invisible to either suite
 * alone.
 *
 * The clock is injected and advances only by `fire()`, so nothing passes
 * because a real millisecond elapsed.
 */
import {
    ToolExecutionTimeoutError,
    ToolExecutionOutputCapError,
    runBoundedTool,
    type TimerApi,
} from '@/lib/agentic/bounded-exec';
import { openShellToolExecutor } from '@/lib/agentic/openshell/executor';
import {
    DELETION_OUTCOMES,
    SandboxUnreachableError,
    unconfiguredTransport,
    type DeletionOutcome,
    type SandboxTransport,
} from '@/lib/agentic/openshell/transport';

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function makeTimers(): TimerApi & { fire: () => void } {
    const scheduled: Array<{ fn: () => void; cancelled: boolean }> = [];
    return {
        setTimeout(fn: () => void) {
            const entry = { fn, cancelled: false };
            scheduled.push(entry);
            return entry;
        },
        clearTimeout(handle: unknown) {
            const entry = handle as { cancelled: boolean } | null;
            if (entry) entry.cancelled = true;
        },
        fire() {
            for (const e of scheduled) if (!e.cancelled) e.fn();
        },
    };
}

interface Calls {
    created: number;
    deleted: string[];
    awaited: string[];
}

function fakeTransport(over: Partial<SandboxTransport> = {}): {
    transport: SandboxTransport;
    calls: Calls;
} {
    const calls: Calls = { created: 0, deleted: [], awaited: [] };
    const transport: SandboxTransport = {
        createSandbox: async () => {
            calls.created += 1;
            return { id: `sb-${calls.created}`, phase: 'SANDBOX_PHASE_READY' as const };
        },
        execSandbox: async () => ({ exited: true as const, exitCode: 0, signal: null, stdout: 'ok', stderr: '' }),
        deleteSandbox: async ({ sandboxId }) => {
            calls.deleted.push(sandboxId);
            return { outcome: 'DELETION_OUTCOME_COMPLETED' as const };
        },
        attachProvider: async () => {},
        awaitDeleted: async ({ sandboxId }) => {
            calls.awaited.push(sandboxId);
        },
        ...over,
    };
    return { transport, calls };
}

const run = (exec: ReturnType<typeof openShellToolExecutor>, timers: TimerApi, over = {}) =>
    runBoundedTool({ tool: 'probe', file: '/bin/true', timeoutMs: 1_000, deps: { exec, timers }, ...over });

describe('1. both bounds trip through the backend', () => {
    it('the DEADLINE trips, even though the transport never answers', async () => {
        const timers = makeTimers();
        const { transport } = fakeTransport({
            // Never resolves. The only thing that can end this is the wrapper's
            // race, which is the property being asserted.
            execSandbox: () => new Promise(() => {}),
        });
        const pending = run(openShellToolExecutor(transport), timers);
        const assertion = expect(pending).rejects.toThrow(ToolExecutionTimeoutError);
        timers.fire();
        await assertion;
    });

    it('the OUTPUT CAP trips on what the transport returned', async () => {
        const timers = makeTimers();
        const { transport } = fakeTransport({
            execSandbox: async () => ({
                exited: true as const,
                exitCode: 0,
                signal: null,
                stdout: 'x'.repeat(5_000),
                stderr: '',
            }),
        });
        await expect(
            run(openShellToolExecutor(transport), timers, { maxOutputBytes: 1_000 }),
        ).rejects.toThrow(ToolExecutionOutputCapError);
    });

    it('the cap is the WRAPPER\'s measurement, not something the backend reports', async () => {
        // The backend passes `maxBuffer` down but counts nothing itself. A
        // transport that ignores the ceiling entirely must still be capped, or
        // the bound would depend on the remote side's cooperation.
        const timers = makeTimers();
        const { transport } = fakeTransport({
            execSandbox: async () => ({ exited: true as const, exitCode: 0, signal: null, stdout: 'y'.repeat(9_999), stderr: '' }),
        });
        await expect(
            run(openShellToolExecutor(transport), timers, { maxOutputBytes: 10 }),
        ).rejects.toThrow(ToolExecutionOutputCapError);
    });
});

describe('2. a sandbox that cannot be created is a REFUSAL (4.2b)', () => {
    it('propagates the unreachable error rather than returning a result', async () => {
        const timers = makeTimers();
        const { transport, calls } = fakeTransport({
            createSandbox: () => {
                throw new SandboxUnreachableError('gateway down');
            },
        });
        await expect(run(openShellToolExecutor(transport), timers)).rejects.toThrow(
            SandboxUnreachableError,
        );
        // Nothing was created, so nothing is deleted — and crucially nothing ran.
        expect(calls.deleted).toEqual([]);
    });

    it('is DISTINGUISHABLE from a tool that merely failed', async () => {
        // The contrast that gives the test above its meaning. A non-zero exit
        // resolves into the normal classification path; an uncreatable sandbox
        // does not. If both threw the same way, a caller could not tell
        // "your tool exited 1" from "we could not confine your tool".
        const timers = makeTimers();
        const { transport } = fakeTransport({
            execSandbox: async () => ({ exited: true as const, exitCode: 1, signal: null, stdout: 'out', stderr: 'err' }),
        });
        const result = await run(openShellToolExecutor(transport), timers).catch((e: unknown) => e);
        expect(result).not.toBeInstanceOf(SandboxUnreachableError);
    });

    it('the default transport refuses everything, so a build without one cannot run locally', async () => {
        const timers = makeTimers();
        await expect(run(openShellToolExecutor(), timers)).rejects.toThrow(SandboxUnreachableError);
        await expect(
            unconfiguredTransport.createSandbox({ labels: {} }),
        ).rejects.toThrow(SandboxUnreachableError);
    });
});

describe('3. one sandbox per execution, deleted afterwards', () => {
    it('creates one and deletes it on success', async () => {
        const timers = makeTimers();
        const { transport, calls } = fakeTransport();
        await run(openShellToolExecutor(transport), timers);
        expect(calls.created).toBe(1);
        expect(calls.deleted).toEqual(['sb-1']);
    });

    it('deletes it when the tool FAILS too', async () => {
        const timers = makeTimers();
        const { transport, calls } = fakeTransport({
            execSandbox: async () => ({ exited: true as const, exitCode: 3, signal: null, stdout: '', stderr: 'bad' }),
        });
        await run(openShellToolExecutor(transport), timers).catch(() => undefined);
        expect(calls.deleted).toEqual(['sb-1']);
    });

    it('a delete failure does not discard a completed tool\'s output', async () => {
        // The wrapper's own docblock: losing output is worse than any other
        // failure here, because the caller cannot see the difference. A leaked
        // sandbox is logged, not thrown.
        const timers = makeTimers();
        const { transport } = fakeTransport({
            execSandbox: async () => ({ exited: true as const, exitCode: 0, signal: null, stdout: 'precious', stderr: '' }),
            deleteSandbox: () => {
                throw new Error('delete exploded');
            },
        });
        const result = await run(openShellToolExecutor(transport), timers);
        expect(result.stdout).toBe('precious');
    });
});

describe('4. all FOUR deletion outcomes are handled, not the three the issue names', () => {
    const waits: Array<[DeletionOutcome, boolean]> = [
        ['DELETION_OUTCOME_COMPLETED', false],
        ['DELETION_OUTCOME_ALREADY_ABSENT', false],
        ['DELETION_OUTCOME_ACCEPTED', true],
        // The zero value. Not named by the issue, and the one that must not be
        // read as success: an unset field and a dropped field are these bytes.
        ['DELETION_OUTCOME_UNSPECIFIED', true],
    ];

    it('the enum has exactly four members, so this table is exhaustive', () => {
        expect([...DELETION_OUTCOMES].sort()).toEqual(waits.map(([o]) => o).sort());
    });

    it.each(waits)('%s waits for deletion: %s', async (outcome, shouldWait) => {
        const timers = makeTimers();
        const { transport, calls } = fakeTransport({
            deleteSandbox: async () => ({ outcome }),
        });
        await run(openShellToolExecutor(transport), timers);
        expect(calls.awaited).toEqual(shouldWait ? ['sb-1'] : []);
    });
});
