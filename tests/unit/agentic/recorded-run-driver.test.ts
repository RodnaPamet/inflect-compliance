/**
 * A run's recorded engine, coerced and read as text (#4241).
 *
 * Two pieces, both pure enough to pin here:
 *
 *   · `coerceRecordedRunDriver` — the one place an unknown `WorkflowRun.driver`
 *     becomes a value. It must NOT behave like `coerceStoredDriverMode`, which
 *     reads an unknown SETTING as `STATIC`: a setting is a permission and
 *     narrowing it is safe, while a run's driver is a fact, and reading an
 *     unknown one as STATIC would say the static engine walked a run it did not.
 *   · `readRecordedRunDrivers` — one statement per page, `::text`, tenant-bound,
 *     and an absent run reading UNRECOGNISED rather than nothing.
 *
 * The usecases that depend on these are driven against a double of the real
 * client's failure in `tests/unit/workflow-run-unknown-driver.test.ts`.
 */
import {
    coerceRecordedRunDriver,
    coerceStoredDriverMode,
    RUN_DRIVER_UNRECOGNISED,
} from '@/lib/agentic/agent-driver';
import { readRecordedRunDriver, readRecordedRunDrivers } from '@/lib/agentic/agent-driver-stored-mode';

describe('coerceRecordedRunDriver', () => {
    it.each(['STATIC', 'FLUE'] as const)('keeps %s, an engine this build knows', (mode) => {
        expect(coerceRecordedRunDriver(mode)).toBe(mode);
    });

    it.each([
        ['a value a later build added', 'CLAUDE_AGENT_SDK'],
        ['a value from another enum', 'PROPOSE'],
        ['a lowercase driver id, which is the runtime name and not the stored label', 'flue'],
        ['an empty string', ''],
        ['null — the run was not read', null],
        ['undefined — the run was not read', undefined],
    ])('reads %s as UNRECOGNISED', (_label, stored) => {
        expect(coerceRecordedRunDriver(stored)).toBe(RUN_DRIVER_UNRECOGNISED);
    });

    it('is NOT the settings coercion: an unknown value never reads as a real engine', () => {
        // The control for the distinction. The settings coercer maps the same
        // bytes to STATIC on purpose; if these two ever agree, a run walked by
        // an engine this build does not know is being reported as static.
        expect(coerceStoredDriverMode('CLAUDE_AGENT_SDK')).toBe('STATIC');
        expect(coerceRecordedRunDriver('CLAUDE_AGENT_SDK')).not.toBe('STATIC');
        expect(coerceRecordedRunDriver('CLAUDE_AGENT_SDK')).not.toBe('FLUE');
    });
});

describe('readRecordedRunDrivers', () => {
    type Call = { sql: string; values: unknown[] };
    const calls: Call[] = [];
    const db = (rows: Array<{ id: string; driver: string | null }>) => ({
        $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            calls.push({ sql: strings.join('?'), values });
            return rows as never;
        }),
    });

    beforeEach(() => {
        calls.length = 0;
    });

    it('reads the column AS TEXT, scoped to the tenant, in one statement for the page', async () => {
        const client = db([
            { id: 'r1', driver: 'STATIC' },
            { id: 'r2', driver: 'CLAUDE_AGENT_SDK' },
        ]);
        const driverOf = await readRecordedRunDrivers(client, 'tenant-1', ['r1', 'r2', 'r1']);

        expect(client.$queryRaw).toHaveBeenCalledTimes(1);
        expect(calls[0].sql).toMatch(/"driver"::text/);
        expect(calls[0].sql).toMatch(/FROM "WorkflowRun"/);
        expect(calls[0].sql).toMatch(/"tenantId" = \?/);
        expect(calls[0].values[0]).toBe('tenant-1');
        // The ids travel as one joined parameter list, de-duplicated.
        expect((calls[0].values[1] as { values: unknown[] }).values).toEqual(['r1', 'r2']);

        expect(driverOf('r1')).toBe('STATIC');
        expect(driverOf('r2')).toBe(RUN_DRIVER_UNRECOGNISED);
    });

    it('a run the read did not return reads UNRECOGNISED, not undefined', async () => {
        const driverOf = await readRecordedRunDrivers(db([]), 'tenant-1', ['gone']);
        expect(driverOf('gone')).toBe(RUN_DRIVER_UNRECOGNISED);
    });

    it('issues no statement for an empty page', async () => {
        const client = db([]);
        const driverOf = await readRecordedRunDrivers(client, 'tenant-1', []);
        expect(client.$queryRaw).not.toHaveBeenCalled();
        expect(driverOf('anything')).toBe(RUN_DRIVER_UNRECOGNISED);
    });

    it('the one-run form answers for that run', async () => {
        expect(await readRecordedRunDriver(db([{ id: 'r1', driver: 'FLUE' }]), 't', 'r1')).toBe('FLUE');
    });
});
