/**
 * Unit tests for installShutdownHandlers.
 *
 * Key assertions:
 *   - Idempotent: calling twice adds only one SIGTERM + one SIGINT listener.
 *   - SIGTERM triggers audit flush → pause in-flight agentic runs → OTel
 *     shutdown → Sentry shutdown, IN THAT ORDER.
 *   - A throwing stage does NOT prevent the stages after it from running.
 *   - All four helpers are called exactly once per signal fire.
 *
 * The run-pause stage is mocked here and asserted by POSITION, not merely by
 * "was called". Its whole purpose is to run before the process dies and after
 * the audit buffers are safe; a stage that executed last would satisfy a
 * call-count assertion and lose the runs anyway.
 */

jest.mock('@/app-layer/events/audit-stream', () => ({
    flushAllAuditStreams: jest.fn(),
}));
jest.mock('@/lib/observability/instrumentation', () => ({
    shutdownTelemetry: jest.fn(),
}));
jest.mock('@/lib/observability/sentry', () => ({
    shutdownSentry: jest.fn(),
}));
jest.mock('@/lib/agentic/in-flight-runs', () => ({
    pauseInFlightRuns: jest.fn(),
}));
// Silence logger output in tests
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
    },
}));

import { flushAllAuditStreams } from '@/app-layer/events/audit-stream';
import { shutdownTelemetry } from '@/lib/observability/instrumentation';
import { shutdownSentry } from '@/lib/observability/sentry';
import { pauseInFlightRuns } from '@/lib/agentic/in-flight-runs';
import {
    installShutdownHandlers,
    _resetShutdownInstalledForTesting,
} from '@/lib/observability/shutdown';
import { SHUTDOWN_PAUSE_RUNS_MS } from '@/lib/observability/shutdown-budget';

const mockFlush = flushAllAuditStreams as jest.MockedFunction<typeof flushAllAuditStreams>;
const mockOtel = shutdownTelemetry as jest.MockedFunction<typeof shutdownTelemetry>;
const mockSentry = shutdownSentry as jest.MockedFunction<typeof shutdownSentry>;
const mockPauseRuns = pauseInFlightRuns as jest.MockedFunction<typeof pauseInFlightRuns>;

/** Let the microtask queue + any pending timers settle. */
async function settle(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
}

afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    _resetShutdownInstalledForTesting();
    jest.clearAllMocks();
});

describe('installShutdownHandlers', () => {
    it('is idempotent — calling twice adds only one SIGTERM and one SIGINT listener', () => {
        const beforeTerm = process.listenerCount('SIGTERM');
        const beforeInt = process.listenerCount('SIGINT');

        installShutdownHandlers();
        installShutdownHandlers(); // second call should be a no-op

        expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);
        expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);
    });

    it('SIGTERM drains audit, then in-flight runs, then OTel, then Sentry', async () => {
        const callOrder: string[] = [];
        mockFlush.mockImplementation(async () => { callOrder.push('audit'); });
        mockPauseRuns.mockImplementation(async () => {
            callOrder.push('pause-runs');
            return { attempted: 0, paused: 0, timedOut: false };
        });
        mockOtel.mockImplementation(async () => { callOrder.push('otel'); });
        mockSentry.mockImplementation(async () => { callOrder.push('sentry'); });

        installShutdownHandlers();
        process.emit('SIGTERM');
        await settle();

        // ORDER, not membership. The run pause must come after audit (whose
        // loss is irreversible) and before OTel (a lost span is cheaper than an
        // abandoned run reaped to FAILED an hour later).
        expect(callOrder).toEqual(['audit', 'pause-runs', 'otel', 'sentry']);
    });

    it('calls each helper exactly once on SIGTERM', async () => {
        mockFlush.mockResolvedValue(undefined);
        mockPauseRuns.mockResolvedValue({ attempted: 0, paused: 0, timedOut: false });
        mockOtel.mockResolvedValue(undefined);
        mockSentry.mockResolvedValue(undefined);

        installShutdownHandlers();
        process.emit('SIGTERM');
        await settle();

        expect(mockFlush).toHaveBeenCalledTimes(1);
        expect(mockPauseRuns).toHaveBeenCalledTimes(1);
        expect(mockOtel).toHaveBeenCalledTimes(1);
        expect(mockSentry).toHaveBeenCalledTimes(1);
    });

    it('passes the run-pause stage its declared budget', async () => {
        // A stage raced against the wrong budget is the failure the constants
        // exist to prevent — and passing `SHUTDOWN_OTEL_MS` here would look
        // identical in review, because both are 2000.
        mockFlush.mockResolvedValue(undefined);
        mockPauseRuns.mockResolvedValue({ attempted: 0, paused: 0, timedOut: false });
        mockOtel.mockResolvedValue(undefined);
        mockSentry.mockResolvedValue(undefined);

        installShutdownHandlers();
        process.emit('SIGTERM');
        await settle();

        expect(mockPauseRuns).toHaveBeenCalledWith(SHUTDOWN_PAUSE_RUNS_MS);
    });

    it('the later stages still run when the run pause throws', async () => {
        // `pauseInFlightRuns` promises never to throw. This is the backstop for
        // the day it breaks that promise: a stage that throws must not take the
        // stages after it down with it, or one bad DB connection during a
        // deploy costs every span and every queued Sentry event as well.
        mockFlush.mockResolvedValue(undefined);
        mockPauseRuns.mockRejectedValue(new Error('pause exploded'));
        mockOtel.mockResolvedValue(undefined);
        mockSentry.mockResolvedValue(undefined);

        installShutdownHandlers();
        process.emit('SIGTERM');
        await settle();

        expect(mockOtel).toHaveBeenCalledTimes(1);
        expect(mockSentry).toHaveBeenCalledTimes(1);
    });

    it('OTel and Sentry still run when audit flush throws', async () => {
        mockFlush.mockRejectedValue(new Error('audit flush exploded'));
        mockPauseRuns.mockResolvedValue({ attempted: 0, paused: 0, timedOut: false });
        mockOtel.mockResolvedValue(undefined);
        mockSentry.mockResolvedValue(undefined);

        installShutdownHandlers();
        process.emit('SIGTERM');
        await settle();

        // OTel and Sentry must still have been called despite the audit failure
        expect(mockOtel).toHaveBeenCalledTimes(1);
        expect(mockSentry).toHaveBeenCalledTimes(1);
    });
});
