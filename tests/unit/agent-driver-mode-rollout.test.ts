/**
 * A NEW `AgentDriverMode` VALUE SHIPS IN TWO DEPLOYS, AND THIS FILE IS WHERE
 * FORGETTING THAT FAILS (#4241).
 *
 * The enum is stored in two columns: `TenantSecuritySettings.agentDriver`, the
 * tenant's choice, and `WorkflowRun.driver`, the engine a run opened under. A
 * Prisma client that meets a stored enum value it was not generated with fails
 * the WHOLE read. That is measured, not assumed, in
 * `tests/integration/agent-driver-unknown-stored-mode.test.ts`. The settings
 * column survives it, because #4224 reads it as `::text`. The run column cannot:
 * its rows are read whole, by the driver's own run store, the run reaper, the
 * narrative dispatch and the run usecases. So if an image that WRITES a new
 * value is rolled back to one built before the value existed, every read of
 * every run carrying it fails, the run store and the reaper included.
 *
 * The defence is the repo's existing discipline, and the agent-engine design
 * documents already plan it for `TOOL_RUNNER` and `CLAUDE_SDK`:
 *
 *   deploy 1  READ_ONLY  the value is in the enum and every reader understands
 *                        it, and no writer accepts it;
 *   deploy 2  WRITTEN    a writer accepts it, and only once the image carrying
 *                        deploy 1 is the one production would roll back to.
 *
 * Nothing enforced that until now, and a rollback is exactly when nobody is
 * reading the roadmap. So every value the schema declares must be classified
 * in `ROLLOUT` below, and each stage is held to what it promises.
 *
 * Moving a value from READ_ONLY to WRITTEN is a one-word diff, and that is on
 * purpose. The pull request carrying it must say which production image already
 * carries the value as READ_ONLY, as the design's hardening lists ask.
 *
 * The run column has one writer, the run create in
 * `app-layer/usecases/workflow-runs.ts`, which stores `recordedModeOf(driver)`
 * for the driver `selectRunDriver` chose. That table names a mode for every
 * driver, so the run writer is held to the same rule: a driver this build can
 * run must record a WRITTEN value (#4270). A driver whose
 * `DRIVER_IMPLEMENTED` flag is false is never chosen, so it may name a
 * READ_ONLY one.
 */
import * as fs from 'fs';
import * as path from 'path';

type Stage = 'READ_ONLY' | 'WRITTEN';

/**
 * Every value of `AgentDriverMode`, and how far its rollout has gone.
 * A value the schema gains goes in here as READ_ONLY first.
 */
const ROLLOUT: Readonly<Record<string, Stage>> = {
    STATIC: 'WRITTEN',
    FLUE: 'WRITTEN',
    // READ_ONLY in Step 2b (#4149), WRITTEN in Step 2c (#4150), once
    // production ran an image that read it (a8ba6717, confirmed 2026-10-29).
    TOOL_RUNNER: 'WRITTEN',
};

const upsert = jest.fn(async (_args: unknown): Promise<unknown> => ({}));
const mockDb = {
    tenantSecuritySettings: { upsert, findUnique: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => []),
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn(async () => undefined) }));
jest.mock('@/env', () => ({ env: {} }));
// The workspace's organization row (#4557): none, so the env-only answer stands.
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenant: { findUnique: jest.fn(async () => ({ organization: null })) } },
}));
jest.mock('@/lib/observability', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/agentic/workflow-registry', () => ({ listWorkflowDefinitions: () => [] }));

import { setAgentDriverSetting } from '@/app-layer/usecases/agent-driver-setting';
import {
    AGENT_DRIVERS,
    DRIVER_IMPLEMENTED,
    coerceStoredDriverMode,
    recordedModeOf,
} from '@/lib/agentic/agent-driver';
import { makeRequestContext } from '../helpers/make-context';

const ENUMS = path.resolve(__dirname, '../../prisma/schema/enums.prisma');

/** The values `enum AgentDriverMode` declares, in the schema's order. */
function declaredValues(): string[] {
    const schema = fs.readFileSync(ENUMS, 'utf8');
    const body = /^enum AgentDriverMode \{([^}]*)\}/m.exec(schema)?.[1];
    if (body === undefined) return [];
    return body
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').trim())
        .filter((line) => line.length > 0 && !line.startsWith('@@'))
        .map((line) => line.split(/\s+/)[0]);
}

const declared = declaredValues();
const valuesAt = (stage: Stage) => Object.keys(ROLLOUT).filter((v) => ROLLOUT[v] === stage);

describe('AgentDriverMode values ship in two deploys (#4241)', () => {
    beforeEach(() => upsert.mockClear());

    it('reads the enum from the schema (positive control)', () => {
        // A renamed enum or file would leave every check below comparing
        // against nothing.
        expect(declared).toContain('STATIC');
    });

    it('classifies every value the schema declares, and nothing else', () => {
        // FAILING HERE MEANS `AgentDriverMode` gained or lost a value.
        //
        // Gained: add it to ROLLOUT as READ_ONLY, and ship that deploy with NO
        // writer for it (not the settings PUT, not the run create). Make it
        // WRITTEN in a later pull request, once production runs an image that
        // carries it. A rollback past the first deploy otherwise makes every
        // read of every run that stored it fail. See #4241.
        //
        // Lost: Postgres cannot drop an enum value without recreating the type,
        // and stored rows may still carry it. Read #4241 before removing one.
        const unclassified = declared.filter((v) => !(v in ROLLOUT));
        const undeclared = Object.keys(ROLLOUT).filter((v) => !declared.includes(v));
        expect({ unclassified, undeclared }).toEqual({ unclassified: [], undeclared: [] });
    });

    it('every reader understands every declared value (deploy 1 teaches the readers)', () => {
        // The settings read coerces an unknown value to STATIC. That is right
        // for a value from a FUTURE build, and wrong for a value this build
        // declares: a tenant who chose it would silently read as STATIC.
        const misread = declared.filter((v) => coerceStoredDriverMode(v) !== v);
        expect(misread).toEqual([]);
    });

    it('the settings writer refuses every READ_ONLY value and accepts every WRITTEN one', async () => {
        const ctx = makeRequestContext('OWNER');
        const outcome: Record<string, 'accepted' | 'refused'> = {};
        for (const value of Object.keys(ROLLOUT)) {
            upsert.mockClear();
            try {
                await setAgentDriverSetting(ctx, value as never);
                outcome[value] = upsert.mock.calls.length > 0 ? 'accepted' : 'refused';
            } catch {
                outcome[value] = 'refused';
            }
        }
        // WRITTEN values are the positive control: a writer that refused
        // everything would satisfy the READ_ONLY half on its own.
        const expected = Object.fromEntries([
            ...valuesAt('READ_ONLY').map((v) => [v, 'refused'] as const),
            ...valuesAt('WRITTEN').map((v) => [v, 'accepted'] as const),
        ]);
        expect(outcome).toEqual(expected);
    });

    it('the run writer records only a WRITTEN value for a driver this build can run (#4270)', () => {
        // FAILING HERE MEANS a driver `selectRunDriver` can choose records a
        // mode that is not WRITTEN yet: its runs would store a value the image
        // production rolls back to cannot read. Either leave the driver's
        // `DRIVER_IMPLEMENTED` flag false until its mode is WRITTEN, or move
        // the mode to WRITTEN in a later deploy, as the settings writer's.
        const runnable = AGENT_DRIVERS.filter((d) => DRIVER_IMPLEMENTED[d]);
        // Positive control: with no runnable driver the check below holds
        // over nothing.
        expect(runnable).toContain('static');
        const recorded = Object.fromEntries(runnable.map((d) => [d, ROLLOUT[recordedModeOf(d)]]));
        expect(recorded).toEqual(Object.fromEntries(runnable.map((d) => [d, 'WRITTEN'])));
    });

    it('every driver records a distinct mode, so the column names the engine (#4270)', () => {
        // A two-way ternary recorded every driver but one as STATIC. Distinct
        // modes are what let the column answer which engine walked a run.
        const modes = AGENT_DRIVERS.map(recordedModeOf);
        expect(new Set(modes).size).toBe(AGENT_DRIVERS.length);
    });
});
