/**
 * A SWEEP THAT DRILLED NOBODY IS NOT A SWEEP THAT PASSED.
 *
 * The drill discovers tenants holding a NON-PLACEHOLDER `RegisteredAgent`. A
 * deployment whose only register rows are legacy placeholders yields an empty
 * list, drills nothing, writes no `AgentKillSwitchDrill` row, raises no
 * Finding — and returns `{ tenants: 0, failed: 0 }`, which every aggregate
 * above it reads as a healthy night.
 *
 * Measured, not imagined: on 2026-09-24 this job had run nightly since it
 * shipped and `AgentKillSwitchDrill` held ZERO rows in production, because the
 * one register row was an "Unregistered legacy agent" placeholder. The stop
 * control the drill exists to prove had never once been pulled.
 *
 * ── WHY A UNIT TEST AND NOT AN INTEGRATION ONE ──────────────────────────────
 *
 * Discovery is GLOBAL — `prisma.registeredAgent.findMany` with no tenant
 * filter — so the zero case cannot be staged in a shared test database that
 * other suites are putting agents into. The read seam is mocked instead, which
 * is the only place the emptiness is controllable.
 *
 * ── AND NO ROW IS ASSERTED, DELIBERATELY ────────────────────────────────────
 *
 * `AgentKillSwitchDrill.tenantId` is required and there is no tenant to attach
 * a row to. Inventing one to hold the evidence would put a fabricated subject
 * in the compliance record, which is worse than the silence this closes. The
 * WARN and the counter are the record.
 */
const findMany = jest.fn(async (_args?: unknown) => [] as Array<{ id: string; tenantId: string }>);

jest.mock('@/lib/prisma', () => ({
    prisma: { registeredAgent: { findMany: (a: unknown) => findMany(a) } },
    default: { registeredAgent: { findMany: (a: unknown) => findMany(a) } },
}));

const warn = jest.fn();
const error = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: (...a: unknown[]) => warn(...a), error: (...a: unknown[]) => error(...a) },
}));

const recordDrillMetric = jest.fn();
jest.mock('@/lib/observability/integration-metrics', () => ({
    recordKillSwitchDrill: (a: unknown) => recordDrillMetric(a),
}));

import { runKillSwitchDrillJob } from '@/app-layer/jobs/agent-kill-switch-drill';

beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([]);
});

describe('a sweep that discovers no tenants', () => {
    it('reports zero tenants rather than a pass', async () => {
        const r = await runKillSwitchDrillJob({}, 'test-job-run');

        // The counts an aggregate reads. `failed: 0` is TRUE and misleading on
        // its own — `tenants: 0` is the number that says why.
        expect(r).toEqual({ tenants: 0, passed: 0, failed: 0, errored: 0 });
    });

    it('WARNS, and names how many tenants hold only placeholders', async () => {
        // The discriminator. "Nobody runs agents here" is fine; "the filter
        // excluded everyone" is the defect, and only this number tells them
        // apart.
        findMany
            .mockResolvedValueOnce([])                                   // discovery: non-placeholder
            .mockResolvedValueOnce([{ id: 'a1', tenantId: 't1' },        // placeholder-only probe
                                    { id: 'a2', tenantId: 't1' },
                                    { id: 'a3', tenantId: 't2' }]);

        await runKillSwitchDrillJob({}, 'test-job-run');

        expect(warn).toHaveBeenCalledTimes(1);
        const [message, meta] = warn.mock.calls[0] as [string, Record<string, unknown>];
        expect(message).toContain('ZERO tenants');
        // DISTINCT tenants, not rows — two placeholders in one tenant is one
        // tenant the filter excluded.
        expect(meta).toMatchObject({ tenants: 0, tenantsWithOnlyPlaceholders: 2 });
    });

    it('asserts the positive on the counter operators already watch', async () => {
        // An absence is ambiguous — `recordKillSwitchDrill`'s own docstring
        // says so. A flat line looks like calm; a SWEPT_NOBODY tick is a thing
        // to alert on.
        await runKillSwitchDrillJob({}, 'test-job-run');

        expect(recordDrillMetric).toHaveBeenCalledWith({ outcome: 'SWEPT_NOBODY' });
    });

    it('stays quiet when the sweep actually had tenants to drill', async () => {
        // The negative arm. A guard that fired on every sweep would be noise,
        // and noise on a control this one exists to make audible is worse than
        // the silence it replaced.
        findMany.mockResolvedValueOnce([{ id: 'a1', tenantId: 't1' }]);

        await runKillSwitchDrillJob({}, 'test-job-run').catch(() => undefined);

        expect(recordDrillMetric).not.toHaveBeenCalledWith({ outcome: 'SWEPT_NOBODY' });
        expect(warn).not.toHaveBeenCalledWith(
            expect.stringContaining('ZERO tenants'),
            expect.anything(),
        );
    });
});
