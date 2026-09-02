/**
 * Behavioural coverage for `runCloudPostureCollection` — the cloud-agnostic
 * collector behind the `azure-posture-collect` / `gcp-posture-collect`
 * scheduled jobs.
 *
 * Same argument as `aws-posture-collection.test.ts`: this runs unattended, and
 * its only artefacts are one `IntegrationExecution` row and the auto-collected
 * `Evidence` it attaches. The cloud-specific half is what is worth pinning
 * here — every persisted string (`automationKey`, evidence `category`, the
 * back-reference `note`) is derived from the injected `cloud` prefix, so a
 * regression there cross-labels Azure evidence as GCP with nothing to notice.
 */
import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';

jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantContext: jest.fn(),
}));
jest.mock('@/lib/security/encryption', () => ({
    ...jest.requireActual('@/lib/security/encryption'),
    decryptField: jest.fn(),
}));
jest.mock('@/app-layer/integrations/connection-health', () => ({
    markAuthFailure: jest.fn(),
    clearAuthFailure: jest.fn(),
}));

import { runInTenantContext } from '@/lib/db-context';
import { decryptField } from '@/lib/security/encryption';
import { markAuthFailure, clearAuthFailure } from '@/app-layer/integrations/connection-health';
import { IntegrationRateLimitedError } from '@/app-layer/integrations/http-resilience';
import { runCloudPostureCollection } from '@/app-layer/usecases/cloud-posture';
import { logger } from '@/lib/observability/logger';
import type { CloudPostureControlMapEntry } from '@/app-layer/integrations/cloud-posture/powerpipe-core';
import type { CheckResult } from '@/app-layer/integrations/types';

/** The real `Date.now`, captured before any test spy can replace it. */
const realNow = Date.now.bind(Date);

const runInTenant = runInTenantContext as unknown as jest.Mock;
const decrypt = decryptField as unknown as jest.Mock;
const markAuth = markAuthFailure as unknown as jest.Mock;
const clearAuth = clearAuthFailure as unknown as jest.Mock;

/**
 * The suite runs TWICE, once per ARM, and that is the load-bearing part of
 * this file. An arm is not just a cloud: it is a complete, disjoint set of the
 * fixture values the collector derives from.
 *
 * The rule the table encodes, stated generally: **a fixture value that appears
 * exactly once cannot be told apart from a constant.** Whatever the collector
 * derives — the cloud, the benchmark, the tenant and connection ids, the
 * execution id, the injected `now` and the day string cut from it, the elapsed
 * duration, the evidence-row and covering-control ids, the crosswalk itself —
 * is byte-identical at runtime to the literal the fixture chose, so a source
 * literal written at ANY site that consumes it passes the whole file at 100%
 * branch coverage. Two arms that disagree on every one of those values removes
 * the coincidence by construction rather than by predicting sites: whichever
 * value a literal names, the other arm fails, including at sites added after
 * this file was written.
 *
 * Sites the table cannot reach — a value observed only ONCE in the whole run,
 * such as the completion log line or the returned provider error — are pinned
 * instead by a SECOND assertion at a different value; each one says so where
 * it stands.
 *
 * Every persisted string the collector writes — the connection `where`, both
 * `provider` columns, the `automationKey`, `parsed.provider`, the evidence
 * `category` / `content` / back-reference `note`, both connection-health
 * labels, and the completion log line — is derived from the injected `cloud`.
 * With a single fixture cloud, the parameter and the literal `'azure-posture'`
 * are the SAME STRING at runtime, so no assertion in the file can tell them
 * apart: a hard-coded prefix at any of those sites passes everything at 100%
 * branch coverage. That was measured — 10 of 18 mutations survived, all of it
 * that one shape.
 *
 * Running the identical assertions under two distinct clouds removes the
 * coincidence by construction rather than by predicting sites: any literal
 * fails the arm it does not name, whichever site it is written at, including
 * sites added after this file was written. `azure-posture` stays in the list
 * so the cloud the connector shipped for is still exercised end to end.
 *
 * The BENCHMARK is the same story a second time, and it is why each arm pairs
 * a cloud with its own benchmark rather than sharing one. `automationKey` is
 * interpolated into the persisted evidence `content`; pinning the evidence path
 * to a single benchmark makes that substring byte-identical to a literal at
 * runtime, so the derivation and the constant are again indistinguishable.
 * Moving the fixture from `soc2` to `CIS` only MOVES that coincidence — a
 * hard-coded `${cloud}.cis` then survives in its place. Varying it per arm
 * removes it: whichever benchmark a literal names, the other arm fails.
 *
 * MEASURED — and stated carefully, because the first version of this paragraph
 * was wrong in a way a reader could not have caught.
 *
 * The population is every expression sitting in a VALUE POSITION in
 * `cloud-posture.ts`: anything a hard-coded literal could be written in place
 * of. The AST walk that produces it originally recorded a site and then
 * STOPPED, on the reasoning that a recorded site is one substitutable value.
 * That is wrong whenever the site is COMPOSITE: `decryptField(x)` is one
 * substitutable value AND `x` is another, nested inside it. The walk reported
 * 111 sites against 141 real ones — 22% of the population never scored, and the
 * unscored fifth was not uniform. It contained the argument to `decryptField`,
 * and the catch path's `e.message` and `String(e)`. An enumeration that stops
 * at the first thing it recognises will always miss what is nested inside it.
 *
 * Corrected walk: 141 sites. 139 are derived values; 2 are references to
 * `EVIDENCE_FRESHNESS_DAYS`, a module constant declared `= 30` at
 * cloud-posture.ts:23. Each site was pinned in turn to a constant it is
 * OBSERVED to equal — every distinct observed value, not just the first,
 * because a site can be indistinguishable at one observation and caught at
 * another — and the whole file re-run per mutation.
 *
 * Result: 2 survivors, and both are the module constant. Substituting `30` for
 * a name declared `= 30` is the identity — the same program with the constant
 * inlined — so no assertion can distinguish it and none should be written to
 * try. Undetectable DERIVED values: 0.
 *
 * `completedAt: new Date()` is NOT among them: `completionInstant` demands a
 * value within minutes of the real clock, so a committed date literal goes red
 * within minutes of being written. (A literal cut from a fresh observation does
 * pass for the first five minutes, which is why every survivor here was
 * re-confirmed serially, hours later, rather than trusted from the sweep.)
 */
const ARMS = [
    {
        cloud: 'gcp-posture', benchmark: 'soc2', key: 'soc2',
        tenant: 'tenant-cloud-1', conn: 'conn-gcp-4', exec: 'exec-9', elapsed: 250,
        now: new Date('2026-03-01T12:00:00.000Z'),
        /** EVIDENCE_FRESHNESS_DAYS = 30 after this arm's `now`. */
        thirtyDays: new Date('2026-03-31T12:00:00.000Z'),
        day: '2026-03-01',
        dual: 'storage_account_encryption_enabled',
        soc2Only: 'keyvault_logging_enabled',
        ctl: 'ctl', ev: 'ev',
        // The connection's stored ciphertext, and what it decrypts to. Single
        // fixture values here made `conn.secretEncrypted` — the argument to
        // `decryptField` — byte-identical to the literal `'cipher-blob'`.
        blob: 'cipher-gcp-4f21',
        clientId: 'cid-gcp-11', clientSecret: 'csecret-gcp-11',
        // The provider's own failure text, on the throw path and on the
        // completion path. Both were file-wide constants, so every expression
        // that carries a provider message was pinnable to the one string.
        throwText: 'quota exhausted for project gcp-77',
        nonErrorText: 'weird failure in the gcp collector',
        erroredText: 'collector error for project gcp-77; stderr: ',
    },
    {
        cloud: 'azure-posture', benchmark: 'CIS', key: 'cis',
        tenant: 'tenant-cloud-2', conn: 'conn-az-1', exec: 'exec-3', elapsed: 410,
        now: new Date('2026-05-09T06:45:00.000Z'),
        thirtyDays: new Date('2026-06-08T06:45:00.000Z'),
        day: '2026-05-09',
        dual: 'compute_disk_encryption_enabled',
        soc2Only: 'audit_log_retention_enabled',
        ctl: 'ctr', ev: 'row',
        blob: 'cipher-az-8b07',
        clientId: 'cid-az-22', clientSecret: 'csecret-az-22',
        throwText: 'subscription throttled in tenant az-31',
        nonErrorText: 'weird failure in the azure collector',
        erroredText: 'collector error in tenant az-31; stderr: ',
    },
] as const;

/**
 * Crosswalk injected by the caller — the collector itself is map-agnostic.
 * Both arms' controls carry IDENTICAL requirement codes, so every
 * framework-resolution assertion below holds unchanged under either arm and
 * the ONLY thing that varies is the id itself.
 */
const CONTROL_MAPS: Record<string, Record<string, CloudPostureControlMapEntry>> = {
    'gcp-posture': {
        storage_account_encryption_enabled: { label: 'Storage encrypted', soc2: ['CC6.1'], nistCsf: ['PR.DS-01'] },
        keyvault_logging_enabled: { label: 'Key Vault logging', soc2: ['CC7.1'] },
    },
    'azure-posture': {
        compute_disk_encryption_enabled: { label: 'Disk encrypted', soc2: ['CC6.1'], nistCsf: ['PR.DS-01'] },
        audit_log_retention_enabled: { label: 'Audit log retention', soc2: ['CC7.1'] },
    },
};

interface Conn {
    id: string;
    configJson: Record<string, unknown> | null;
    secretEncrypted: string | null;
}

function makeDbFor(conn: Conn | null, execId: string, evPrefix: string) {
    let evSeq = 0;
    return {
        integrationConnection: { findFirst: jest.fn(async () => conn) },
        integrationExecution: {
            create: jest.fn(async () => ({ id: execId })),
            update: jest.fn(async () => ({ id: execId })),
        },
        controlRequirementLink: {
            findFirst: jest.fn(async () => null as { controlId: string | null } | null),
        },
        evidence: {
            findFirst: jest.fn(async () => null as { id: string } | null),
            create: jest.fn(async () => ({ id: `${evPrefix}-${++evSeq}` })),
            update: jest.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })),
        },
        evidenceControlLink: { create: jest.fn(async () => ({ id: 'ecl-1' })) },
        controlEvidenceLink: { create: jest.fn(async () => ({ id: 'cel-1' })) },
    };
}

type Db = ReturnType<typeof makeDbFor>;

function bind(db: Db) {
    runInTenant.mockImplementation(
        (_ctx: RequestContext, cb: (d: PrismaTx) => Promise<unknown>) =>
            cb(db as unknown as PrismaTx),
    );
}

function providerReturning(result: CheckResult) {
    return { runCheck: jest.fn(async () => result) };
}
function providerThrowing(err: unknown) {
    return {
        runCheck: jest.fn(async () => {
            throw err;
        }),
    };
}
function checkResult(over: Partial<CheckResult> = {}): CheckResult {
    return { status: 'PASSED', summary: 's', details: {}, ...over };
}

/**
 * `durationMs` is `Date.now() - start`, so pinning it needs the wall clock
 * under test control: a literal asserted against the real clock is a fuse that
 * goes green at merge and red on a slow CI box, and `expect.any(Number)` is
 * satisfied by the constant `0`. `fakeClock()` freezes `Date.now`, and the two
 * `*After` provider stubs advance it by exactly `ms` while the check runs — so
 * the persisted duration is that number and nothing else.
 */
function fakeClockFor(base: Date) {
    let t = base.getTime();
    jest.spyOn(Date, 'now').mockImplementation(() => t);
    return {
        advance(ms: number) {
            t += ms;
        },
    };
}
type Clock = ReturnType<typeof fakeClockFor>;

function providerReturningAfter(result: CheckResult, clock: Clock, ms: number) {
    return {
        runCheck: jest.fn(async () => {
            clock.advance(ms);
            return result;
        }),
    };
}
function providerThrowingAfter(err: unknown, clock: Clock, ms: number) {
    return {
        runCheck: jest.fn(async () => {
            clock.advance(ms);
            throw err;
        }),
    };
}

/**
 * `completedAt` is stamped from the wall clock AT COMPLETION — never from the
 * injected `now`, which is the job's START instant.
 *
 * `expect.any(Date)` cannot tell those apart, because `now` is a Date as well,
 * and both update sites used it: a collector that stamped the start time
 * passed, reporting an execution that finished before its own benchmark did
 * and contradicting the `durationMs` written on the same row. `NOW` is a fixed
 * past fixture date, so a genuine completion instant is strictly greater while
 * the `now` swap is exactly equal.
 */
function completionInstant(now: Date) {
    return {
        // Strictly after the injected `now` AND within minutes of the real
        // clock: `> now` alone is satisfied by ANY constant date later than the
        // fixture, which is exactly the substitution this file exists to catch.
        asymmetricMatch: (v: unknown) =>
            v instanceof Date && v.getTime() > now.getTime() && Math.abs(v.getTime() - realNow()) < 300_000,
        toString: () => 'CompletionInstant(the real clock, strictly after the injected `now`)',
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    decrypt.mockReturnValue('{}');
    markAuth.mockResolvedValue(false);
    clearAuth.mockResolvedValue(undefined);
});

// Only ever restores `jest.spyOn` mocks (the `Date.now` clock above); the
// module factories from `jest.mock` are untouched by this.
afterEach(() => {
    jest.restoreAllMocks();
});

describe.each(ARMS)(
    'runCloudPostureCollection [cloud=$cloud benchmark=$benchmark]',
    ({
        cloud: CLOUD, benchmark: BENCHMARK, key: KEY, tenant: TENANT, conn: CONN,
        exec: EXEC, elapsed: ELAPSED_MS, now: NOW, thirtyDays: THIRTY_DAYS,
        day: DAY, dual: DUAL, soc2Only: SOC2_ONLY, ctl: CTL, ev: EV,
        blob: BLOB, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
        throwText: THROW_TEXT, nonErrorText: NON_ERROR_TEXT, erroredText: ERRORED_TEXT,
    }) => {
    const makeDb = (conn: Conn | null) => makeDbFor(conn, EXEC, EV);
    const fakeClock = () => fakeClockFor(NOW);
    const COMPLETION_INSTANT = completionInstant(NOW);

    /** Every call needs the same four injected inputs; only the deltas vary. */
    function run(over: Partial<Parameters<typeof runCloudPostureCollection>[0]> = {}) {
        return runCloudPostureCollection({
            cloud: CLOUD,
            tenantId: TENANT,
            connectionId: CONN,
            provider: providerReturning(checkResult()),
            controlMap: CONTROL_MAPS[CLOUD],
            now: NOW,
            ...over,
        });
    }

    describe('connection resolution', () => {
        it('scopes the lookup to the tenant AND the cloud, and records an ERROR row when it misses', async () => {
            // Regression class: dropping `provider` from the where would let the
            // Azure job pick up (and run its Azure benchmark against) a GCP
            // connection's credentials.
            const db = makeDb(null);
            bind(db);

            const res = await run();

            expect(db.integrationConnection.findFirst).toHaveBeenCalledWith({
                where: { id: CONN, tenantId: TENANT, provider: CLOUD },
                select: { id: true, configJson: true, secretEncrypted: true },
            });
            expect(db.integrationExecution.create).toHaveBeenCalledWith({
                data: {
                    tenantId: TENANT,
                    provider: CLOUD,
                    automationKey: `${CLOUD}.unknown`,
                    status: 'ERROR',
                    errorMessage: 'Connection not found',
                    triggeredBy: 'scheduled',
                    completedAt: NOW,
                },
            });
            expect(res).toStrictEqual({
                executionId: EXEC,
                status: 'ERROR',
                counts: null,
                evidenceCreated: 0,
                errorMessage: 'Connection not found',
            });
            expect(clearAuth).not.toHaveBeenCalled();
        });

        it('derives the JOB context from the caller tenant and the cloud label, and defaults `now`', async () => {
            // Regression class: the RLS binding, and the greppable job identity
            // that is the only way to tell an Azure pass from a GCP pass in the
            // logs. `requestId` carries the cloud, so under the two-arm
            // parametrisation a hard-coded label here fails the arm it does not
            // name — the sibling test above cannot see that on its own, because
            // it asserts a value the fixture happens to equal.
            const db = makeDb(null);
            bind(db);

            // `now` omitted on purpose — exercises the injection default. The
            // sibling test above supplies NOW and pins `completedAt` to it, so
            // the two together tell `input.now` apart from a fresh `new Date()`.
            await run({ now: undefined });

            const ctx = runInTenant.mock.calls[0][0] as RequestContext;
            expect(ctx.tenantId).toBe(TENANT);
            // Derived from BOTH the cloud label and the tenant. Asserted without
            // pinning the exact spelling: `makeSystemCtx` composes `${cloud}-posture`
            // over a cloud that already ends in `-posture`, so the literal value is
            // `gcp-posture-posture-…`. Pinning that would make this test — whose own
            // title claims to protect the job identity — the thing that blocks the
            // one-line fix for it.
            expect(ctx.requestId.startsWith(CLOUD)).toBe(true);
            expect(ctx.requestId).toContain(TENANT);
            expect(ctx.actorType).toBe('JOB');
            expect(ctx.userId).toBe('system');
            expect(db.integrationExecution.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ completedAt: COMPLETION_INSTANT }) }),
            );
        });

        it('defaults an absent configJson to the soc2 benchmark with no secrets', async () => {
            const db = makeDb({ id: CONN, configJson: null, secretEncrypted: null });
            bind(db);
            const provider = providerReturning(checkResult());

            const res = await run({ provider });

            expect(db.integrationExecution.create).toHaveBeenCalledWith({
                data: {
                    tenantId: TENANT,
                    connectionId: CONN,
                    provider: CLOUD,
                    automationKey: `${CLOUD}.soc2`,
                    status: 'RUNNING',
                    triggeredBy: 'scheduled',
                    executedAt: NOW,
                },
            });
            expect(provider.runCheck).toHaveBeenCalledWith({
                automationKey: `${CLOUD}.soc2`,
                parsed: { provider: CLOUD, checkType: 'soc2', raw: `${CLOUD}.soc2` },
                tenantId: TENANT,
                connectionConfig: {},
                triggeredBy: 'scheduled',
            });
            expect(decrypt).not.toHaveBeenCalled();
            expect(res.counts).toBeNull();
        });

        it('coerces a non-string benchmark and lowercases it before building the automation key', async () => {
            // Regression class: `configJson` is untyped JSON. Without the String()
            // coercion a numeric benchmark throws OUTSIDE the try block, so the
            // RUNNING execution row is never completed and the job dies silently.
            const db = makeDb({ id: CONN, configJson: { benchmark: 2 }, secretEncrypted: null });
            bind(db);

            await run();

            expect(db.integrationExecution.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ automationKey: `${CLOUD}.2` }) }),
            );
        });

        it('lowercases the benchmark and merges the decrypted secrets into the provider config', async () => {
            const db = makeDb({ id: CONN, configJson: { benchmark: 'CIS', subscriptionId: 'sub-1' }, secretEncrypted: BLOB });
            bind(db);
            decrypt.mockReturnValue(JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }));
            const provider = providerReturning(checkResult());

            await run({ provider });

            // The ciphertext the connection actually stores, not a constant: with
            // one fixture blob file-wide, `decryptField(conn.secretEncrypted)`
            // could not be told from `decryptField('cipher-blob')`.
            expect(decrypt).toHaveBeenCalledWith(BLOB);
            expect(provider.runCheck).toHaveBeenCalledWith(
                expect.objectContaining({
                    automationKey: `${CLOUD}.cis`,
                    // `parsed` too, and under a benchmark the default case cannot
                    // produce: the sibling test pins `checkType` at 'soc2', which
                    // is byte-identical to the literal there.
                    parsed: { provider: CLOUD, checkType: 'cis', raw: `${CLOUD}.cis` },
                    connectionConfig: { benchmark: 'CIS', subscriptionId: 'sub-1', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
                }),
            );
        });
    });

    describe('provider throw', () => {
        it('truncates the persisted error, marks the credential with the cloud label, and blocks the retry', async () => {
            // Regression class: `noRetry` must follow the error class. A rate-limit
            // past the absorb budget re-queued immediately hammers the provider.
            const db = makeDb({ id: CONN, configJson: {}, secretEncrypted: null });
            bind(db);
            // Arm-varying: `e.message` is read on the catch path and persisted, and
            // a file-wide URL made that read byte-identical to its own literal.
            const err = new IntegrationRateLimitedError(`https://${CLOUD}.example/${THROW_TEXT}/${'x'.repeat(700)}`, 30_000);
            expect(err.message.length).toBeGreaterThan(500);
            const clock = fakeClock();

            const res = await run({ provider: providerThrowingAfter(err, clock, ELAPSED_MS) });

            expect(markAuth).toHaveBeenCalledWith(db, CONN, err, NOW, CLOUD);
            expect(db.integrationExecution.update).toHaveBeenCalledWith({
                where: { id: EXEC },
                // Elapsed, not a constant: the clock moved by exactly ELAPSED_MS
                // while `runCheck` was in flight, so `Date.now() - start` is pinned.
                data: { status: 'ERROR', errorMessage: err.message.slice(0, 500), durationMs: ELAPSED_MS, completedAt: COMPLETION_INSTANT },
            });
            expect(res).toStrictEqual({
                executionId: EXEC,
                status: 'ERROR',
                counts: null,
                evidenceCreated: 0,
                errorMessage: err.message.slice(0, 500),
                noRetry: true,
            });
            expect(res.errorMessage).toHaveLength(500);
            expect(clearAuth).not.toHaveBeenCalled();
        });

        it('stringifies a non-Error throw and leaves the queue free to retry', async () => {
            const db = makeDb({ id: CONN, configJson: {}, secretEncrypted: null });
            bind(db);

            // Arm-varying for the same reason as the sibling above — this is the
            // ONLY observation of `String(e)` in the file.
            const thrown = { toString: () => NON_ERROR_TEXT };

            const res = await run({ provider: providerThrowing(thrown) });

            // The thrown value itself reaches the credential writer. The sibling
            // test is the only other assertion on that argument, so with one
            // observation it is byte-identical to the constant it takes there.
            expect(markAuth).toHaveBeenCalledWith(db, CONN, thrown, NOW, CLOUD);

            // The persisted message, not just the returned one, and under a
            // SECOND value: the sibling above is the only other assertion on
            // this site, so with one observation the derived `msg` is
            // byte-identical to the constant it takes there.
            expect(db.integrationExecution.update).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ errorMessage: NON_ERROR_TEXT }) }),
            );
            expect(res).toStrictEqual({
                executionId: EXEC,
                status: 'ERROR',
                counts: null,
                evidenceCreated: 0,
                errorMessage: NON_ERROR_TEXT,
                noRetry: false,
            });
        });
    });

    describe('evidence collection', () => {
        const passing = checkResult({
            status: 'PASSED',
            details: {
                counts: { ok: 2, alarm: 0, skip: 0, error: 0, total: 2 },
                controls: [{ id: DUAL, status: 'ok' }],
            },
        });

        /**
         * The evidence path runs THIS ARM'S benchmark, not a benchmark fixed for
         * the whole file — see the `ARMS` note above. The `CIS` arm additionally
         * re-exercises the lowercasing all the way through to a persisted row
         * rather than only at the automation-key assertion.
         */
        function connDb() {
            const db = makeDb({ id: CONN, configJson: { benchmark: BENCHMARK }, secretEncrypted: null });
            bind(db);
            return db;
        }

        it('labels every persisted string with the injected cloud prefix', async () => {
            // Regression class: `category`, `content` and the back-reference `note`
            // are the ONLY thing distinguishing Azure evidence from GCP evidence on
            // the same control. A hard-coded prefix cross-labels them silently.
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-shared` });
            const clock = fakeClock();
            // Restored by the file-wide `jest.restoreAllMocks()` afterEach.
            const info = jest.spyOn(logger, 'info');

            const res = await run({ provider: providerReturningAfter(passing, clock, ELAPSED_MS) });

            expect(res.evidenceCreated).toBe(1);
            expect(db.evidence.create).toHaveBeenCalledWith({
                data: {
                    tenantId: TENANT,
                    type: 'TEXT',
                    title: `Automated evidence — ${DUAL}`,
                    content: `${CLOUD} check "${DUAL}" PASSED (${CLOUD}.${KEY}) on ${DAY}. Machine-collected via Powerpipe; execution ${EXEC}.`,
                    category: `${CLOUD}:${DUAL}`,
                    dateCollected: NOW,
                    reviewCycle: 'MONTHLY',
                    nextReviewDate: THIRTY_DAYS,
                    status: 'APPROVED',
                },
            });
            expect(db.evidenceControlLink.create).toHaveBeenCalledWith({
                data: { tenantId: TENANT, evidenceId: `${EV}-1`, controlId: `${CTL}-shared`, createdByUserId: null },
            });
            expect(db.controlEvidenceLink.create).toHaveBeenCalledWith({
                data: { tenantId: TENANT, controlId: `${CTL}-shared`, kind: 'INTEGRATION_RESULT', integrationResultId: EXEC, note: `${CLOUD}: ${DUAL}` },
            });
            expect(db.integrationExecution.update).toHaveBeenCalledWith({
                where: { id: EXEC },
                data: {
                    status: 'PASSED',
                    resultJson: passing.details,
                    evidenceId: `${EV}-1`,
                    errorMessage: null,
                    // Elapsed, not a constant — see `fakeClock`.
                    durationMs: ELAPSED_MS,
                    completedAt: COMPLETION_INSTANT,
                },
            });
            expect(clearAuth).toHaveBeenCalledWith(db, CONN, CLOUD);
            // The completion line is the operator's ONLY per-run signal that a
            // given cloud ran at all — `component` is the fixed subsystem name,
            // `cloud` the per-run label, and confusing the two makes an Azure
            // pass and a GCP pass indistinguishable in the aggregator.
            expect(info).toHaveBeenCalledWith('cloud-posture collection complete', {
                component: 'cloud-posture',
                cloud: CLOUD,
                tenantId: TENANT,
                executionId: EXEC,
                status: 'PASSED',
                evidenceCreated: 1,
            });
        });

        it('fans a dual-framework control out to both installed frameworks and pins the first evidence row', async () => {
            // Regression class: the injected map drives WHICH requirement codes are
            // looked up. `firstEvidenceId ?? ev.id` must keep the first, not the last.
            const db = connDb();
            db.controlRequirementLink.findFirst
                .mockResolvedValueOnce({ controlId: `${CTL}-soc2` })
                .mockResolvedValueOnce({ controlId: `${CTL}-nist` });

            const res = await run({ provider: providerReturning(passing) });

            expect(db.controlRequirementLink.findFirst).toHaveBeenNthCalledWith(1, {
                where: { tenantId: TENANT, requirement: { framework: { key: 'SOC2' }, code: { in: ['CC6.1'] } } },
                select: { controlId: true },
            });
            expect(db.controlRequirementLink.findFirst).toHaveBeenNthCalledWith(2, {
                where: { tenantId: TENANT, requirement: { framework: { key: 'NIST-CSF-2.0' }, code: { in: ['PR.DS-01'] } } },
                select: { controlId: true },
            });
            expect(res.evidenceCreated).toBe(2);
            // Two DISTINCT covering controls, two DISTINCT evidence rows, each
            // link pinned per call. Asserting only the first row leaves both
            // `controlId` and `ev.id` byte-identical to the constants they take
            // there, so a collector that stamped the FIRST control (or the first
            // evidence id) on every link stays green.
            expect(db.evidenceControlLink.create).toHaveBeenNthCalledWith(1, {
                data: { tenantId: TENANT, evidenceId: `${EV}-1`, controlId: `${CTL}-soc2`, createdByUserId: null },
            });
            expect(db.evidenceControlLink.create).toHaveBeenNthCalledWith(2, {
                data: { tenantId: TENANT, evidenceId: `${EV}-2`, controlId: `${CTL}-nist`, createdByUserId: null },
            });
            expect(db.controlEvidenceLink.create).toHaveBeenNthCalledWith(2, {
                data: { tenantId: TENANT, controlId: `${CTL}-nist`, kind: 'INTEGRATION_RESULT', integrationResultId: EXEC, note: `${CLOUD}: ${DUAL}` },
            });
            expect(db.integrationExecution.update).toHaveBeenCalledWith({
                where: { id: EXEC },
                data: expect.objectContaining({ evidenceId: `${EV}-1` }),
            });
        });

        it('keeps evidencing the controls that FOLLOW a failing one, honouring their own map entry', async () => {
            // Regression class: `continue` vs `break` in the pass-only filter — a
            // `break` under-collects everything after the first alarm while still
            // reporting a well-formed result. The trailing control is SOC2-only, so
            // this also pins that a single-framework map entry triggers exactly one
            // requirement lookup rather than a speculative NIST one.
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-after` });
            const trailing = checkResult({
                status: 'FAILED',
                details: {
                    counts: { ok: 1, alarm: 1, skip: 0, error: 0, total: 2 },
                    controls: [
                        { id: DUAL, status: 'alarm' },
                        { id: SOC2_ONLY, status: 'ok' },
                    ],
                },
            });

            const res = await run({ provider: providerReturning(trailing) });

            expect(res.evidenceCreated).toBe(1);
            expect(db.controlRequirementLink.findFirst).toHaveBeenCalledTimes(1);
            expect(db.controlRequirementLink.findFirst).toHaveBeenCalledWith({
                where: { tenantId: TENANT, requirement: { framework: { key: 'SOC2' }, code: { in: ['CC7.1'] } } },
                select: { controlId: true },
            });
            expect(db.evidence.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ category: `${CLOUD}:${SOC2_ONLY}` }) }),
            );
        });

        it('evidences two DIFFERENT passing checks that share one covering control', async () => {
            // Regression class: `seenControlIds` is constructed INSIDE the loop over
            // benchmark controls, so it dedupes the frameworks one check crosswalks
            // to — not the checks themselves. Hoisting it out of that loop keeps
            // every other test here green (they all run a single passing check) and
            // silently drops the second check's evidence: `evidenceCreated`
            // under-reports with a well-formed PASSED result to show for it. This is
            // a SCOPE, not a branch, so 100% branch coverage cannot see it.
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-shared` });
            const twoPassing = checkResult({
                status: 'PASSED',
                details: {
                    counts: { ok: 2, alarm: 0, skip: 0, error: 0, total: 2 },
                    controls: [
                        { id: DUAL, status: 'ok' },
                        { id: SOC2_ONLY, status: 'ok' },
                    ],
                },
            });

            const res = await run({ provider: providerReturning(twoPassing) });

            // One row per CHECK (distinct category), deduped within each check.
            expect(res.evidenceCreated).toBe(2);
            expect(db.evidence.create).toHaveBeenCalledTimes(2);
            expect(db.evidence.create).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({ data: expect.objectContaining({ category: `${CLOUD}:${DUAL}` }) }),
            );
            expect(db.evidence.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ data: expect.objectContaining({ category: `${CLOUD}:${SOC2_ONLY}` }) }),
            );
        });

        it('never evidences an alarming, skipped, or unmapped control', async () => {
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-soc2` });
            const mixed = checkResult({
                status: 'FAILED',
                details: {
                    counts: { ok: 1, alarm: 1, skip: 1, error: 0, total: 3 },
                    controls: [
                        { id: DUAL, status: 'alarm' },
                        { id: SOC2_ONLY, status: 'skip' },
                        { id: 'absent_from_the_injected_map', status: 'ok' },
                    ],
                },
            });

            // Restored by the file-wide `jest.restoreAllMocks()` afterEach.
            const info = jest.spyOn(logger, 'info');

            const res = await run({ provider: providerReturning(mixed) });

            expect(db.controlRequirementLink.findFirst).not.toHaveBeenCalled();
            expect(db.evidence.create).not.toHaveBeenCalled();
            expect(res).toStrictEqual({
                executionId: EXEC,
                status: 'FAILED',
                counts: { ok: 1, alarm: 1, skip: 1, error: 0, total: 3 },
                evidenceCreated: 0,
                errorMessage: undefined,
            });
            // Regression class: a FAILED compliance verdict is a SUCCESSFUL
            // collection — the credential demonstrably worked, so a stale REVOKED
            // banner must clear. Clamping the clear to `status === 'PASSED'` (the
            // obvious over-correction for the ERROR-path defect reported alongside
            // this file) would strand the banner on a healthy connection for as long
            // as the benchmark keeps reporting gaps. Only the PASSED path was pinned
            // before, so that clamp landed green.
            expect(clearAuth).toHaveBeenCalledWith(db, CONN, CLOUD);
            // The SECOND observation of the completion line, and the reason this
            // assertion is here rather than only on the passing test: `status`
            // and `evidenceCreated` are derived, but with one observation each
            // was byte-identical to the constant it took there ('PASSED', 1).
            // Two observations that DISAGREE on both fields leave no constant
            // that satisfies them.
            expect(info).toHaveBeenCalledWith('cloud-posture collection complete', {
                component: 'cloud-posture',
                cloud: CLOUD,
                tenantId: TENANT,
                executionId: EXEC,
                status: 'FAILED',
                evidenceCreated: 0,
            });
        });

        it('skips a framework with no covering control, whether the link or its controlId is null', async () => {
            const db = connDb();
            db.controlRequirementLink.findFirst
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ controlId: null });

            const res = await run({ provider: providerReturning(passing) });

            expect(db.evidence.findFirst).not.toHaveBeenCalled();
            expect(res.evidenceCreated).toBe(0);
        });

        it('evidences a control covered under both frameworks exactly once', async () => {
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-shared` });

            const res = await run({ provider: providerReturning(passing) });

            expect(db.controlRequirementLink.findFirst).toHaveBeenCalledTimes(2);
            expect(res.evidenceCreated).toBe(1);
            expect(db.evidence.create).toHaveBeenCalledTimes(1);
        });

        it('refreshes the existing rolling row instead of creating a duplicate', async () => {
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-shared` });
            db.evidence.findFirst.mockResolvedValue({ id: `${EV}-existing` });

            const res = await run({ provider: providerReturning(passing) });

            expect(db.evidence.findFirst).toHaveBeenCalledWith({
                where: {
                    tenantId: TENANT,
                    evidenceControlLinks: { some: { controlId: `${CTL}-shared` } },
                    category: `${CLOUD}:${DUAL}`,
                    type: 'TEXT',
                    isArchived: false,
                    deletedAt: null,
                },
                select: { id: true },
            });
            expect(db.evidence.update).toHaveBeenCalledWith({
                where: { id: `${EV}-existing` },
                data: {
                    title: `Automated evidence — ${DUAL}`,
                    content: `${CLOUD} check "${DUAL}" PASSED (${CLOUD}.${KEY}) on ${DAY}. Machine-collected via Powerpipe; execution ${EXEC}.`,
                    dateCollected: NOW,
                    nextReviewDate: THIRTY_DAYS,
                    status: 'APPROVED',
                },
            });
            // The refreshed row is what the execution points at. The AWS twin
            // asserted this and the cloud one did not, which left the update arm's
            // `firstEvidenceId ?? ev.id` with a single observation elsewhere in the
            // file — and so indistinguishable from that one constant.
            expect(db.integrationExecution.update).toHaveBeenCalledWith({
                where: { id: EXEC },
                data: expect.objectContaining({ evidenceId: `${EV}-existing` }),
            });
            expect(db.evidence.create).not.toHaveBeenCalled();
            expect(db.evidenceControlLink.create).not.toHaveBeenCalled();
            expect(db.controlEvidenceLink.create).not.toHaveBeenCalled();
            expect(res.evidenceCreated).toBe(1);
        });

        it('keeps the FIRST refreshed row as the execution evidence when several are refreshed', async () => {
            // Regression class: the update arm carries its own `firstEvidenceId ??`.
            const db = connDb();
            db.controlRequirementLink.findFirst
                .mockResolvedValueOnce({ controlId: `${CTL}-soc2` })
                .mockResolvedValueOnce({ controlId: `${CTL}-nist` });
            db.evidence.findFirst
                .mockResolvedValueOnce({ id: `${EV}-old-a` })
                .mockResolvedValueOnce({ id: `${EV}-old-b` });

            const res = await run({ provider: providerReturning(passing) });

            expect(db.evidence.update).toHaveBeenCalledTimes(2);
            // The lookup is scoped to EACH resolved control, not to the first one.
            expect(db.evidence.findFirst).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ where: expect.objectContaining({ evidenceControlLinks: { some: { controlId: `${CTL}-nist` } } }) }),
            );
            expect(db.evidence.create).not.toHaveBeenCalled();
            expect(res.evidenceCreated).toBe(2);
            expect(db.integrationExecution.update).toHaveBeenCalledWith({
                where: { id: EXEC },
                data: expect.objectContaining({ evidenceId: `${EV}-old-a` }),
            });
        });

        it('completes the run when the control↔execution back-reference is a duplicate', async () => {
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-shared` });
            db.controlEvidenceLink.create.mockRejectedValue(new Error('Unique constraint failed'));

            const res = await run({ provider: providerReturning(passing) });

            expect(res.evidenceCreated).toBe(1);
            expect(res.status).toBe('PASSED');
            expect(db.integrationExecution.update).toHaveBeenCalledTimes(1);
        });

        it('collects no evidence from an ERRORed run and records the truncated provider error', async () => {
            // Regression class: an ERROR result means the subscription was never
            // observed. Evidencing its `controls` asserts a pass nobody saw.
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-shared` });
            const errored = checkResult({
                status: 'ERROR',
                errorMessage: `${ERRORED_TEXT}${'z'.repeat(600)}`,
                details: { counts: { ok: 1, alarm: 0, skip: 0, error: 0, total: 1 }, controls: [{ id: DUAL, status: 'ok' }] },
            });

            const res = await run({ provider: providerReturning(errored) });

            expect(db.controlRequirementLink.findFirst).not.toHaveBeenCalled();
            expect(db.evidence.create).not.toHaveBeenCalled();
            expect(res.evidenceCreated).toBe(0);
            expect(res.status).toBe('ERROR');
            // The result carries the provider message UNTRUNCATED — the 500-char
            // cut is a persistence concern. Every other test observes this field
            // as `undefined`, so one non-undefined observation is what stops the
            // literal from being indistinguishable from the derivation.
            expect(res.errorMessage).toBe(errored.errorMessage);
            const persisted = `${ERRORED_TEXT}${'z'.repeat(600)}`.slice(0, 500);
            expect(persisted).toHaveLength(500);
            expect(db.integrationExecution.update).toHaveBeenCalledWith({
                where: { id: EXEC },
                data: expect.objectContaining({ status: 'ERROR', evidenceId: null, errorMessage: persisted }),
            });
        });
    });
    },
);
