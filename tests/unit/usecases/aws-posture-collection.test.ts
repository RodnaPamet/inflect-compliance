/**
 * Behavioural coverage for `runAwsPostureCollection` — the tenant-scoped
 * collector behind the `aws-posture-collect` scheduled job.
 *
 * Why this file exists: the collector runs at 03:00 with nobody watching, and
 * its ONLY externally visible artefacts are the `IntegrationExecution` row it
 * writes and the auto-collected `Evidence` it attaches to controls. A silent
 * regression here (evidence attached to the wrong control, a credential leaked
 * into a persisted error message, duplicate evidence rows, or an alarming
 * control evidenced as passing) surfaces to nobody. Everything below asserts a
 * concrete regression class, named per test.
 *
 * Seams mocked: `runInTenantContext` (hands the usecase a fake db), the field
 * decryptor, and the connection-health writers. `scrubAwsCredentials` and the
 * real `aws-posture` control map are deliberately NOT mocked — the scrubbing
 * and crosswalk behaviour is part of what is under test.
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
import { IntegrationAuthError } from '@/app-layer/integrations/http-resilience';
import { runAwsPostureCollection } from '@/app-layer/usecases/aws-posture';
import { logger } from '@/lib/observability/logger';
import type { CheckResult } from '@/app-layer/integrations/types';

/** The real `Date.now`, captured before any test spy can replace it. */
const realNow = Date.now.bind(Date);

const runInTenant = runInTenantContext as unknown as jest.Mock;
const decrypt = decryptField as unknown as jest.Mock;
const markAuth = markAuthFailure as unknown as jest.Mock;
const clearAuth = clearAuthFailure as unknown as jest.Mock;

/**
 * The evidence-path connection's own secret. Fabricated, and deliberately
 * shaped so NO pattern in `scrubAwsCredentials` matches it: not `AKIA`/`ASIA`,
 * not a bare 40-char base64 run (the hyphens break `\b…\b`), not a session
 * token, not an ARN. The only thing that can redact it is the connection's own
 * value list — which is what makes a dropped `secretVals` argument visible.
 */
const CONN_SECRET = 'sk-live-9876543210zyxwvutsr'; // pragma: allowlist secret — fabricated, never issued

/**
 * The WHOLE file runs TWICE, once per ARM, and that is load-bearing. An arm is
 * not just a benchmark: it is a complete, disjoint set of the fixture values
 * the collector derives from.
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
 * `automationKey` is derived from the connection's own `configJson.benchmark`
 * and is interpolated into the persisted evidence `content`. Pin the evidence
 * path to ONE benchmark and that substring is byte-identical at runtime to a
 * literal `aws-posture.<that benchmark>`, so nothing in the file can tell the
 * derivation from the constant — a collector that stopped reading the config
 * when labelling evidence stays green. Note that changing WHICH single value
 * the fixture uses only MOVES the coincidence: `soc2` -> `CIS` merely makes
 * `aws-posture.cis` the literal that survives instead.
 *
 * Two arms remove it by construction: whichever benchmark a literal names, the
 * other arm fails. `soc2` is kept as an arm because it is the production
 * default; `CIS` also re-exercises the lowercasing through to a persisted row.
 *
 * Measured, at the time this table was widened: an AST walk over
 * `aws-posture.ts` finds 105 expressions that produce a value in a persisted
 * field, a log or a returned result. Pinning each in turn to the constant it
 * equals leaves 2 undetectable — both `completedAt: new Date()`, which no
 * source constant can satisfy (the matcher demands the real clock) and which
 * only a value re-read from the same process could. The five remaining
 * `AWS_POSTURE_PROVIDER` hits are the module constant itself, not a derivation.
 */
const ARMS = [
    {
        benchmark: 'soc2', key: 'soc2',
        tenant: 'tenant-aws-1', conn: 'conn-1', exec: 'exec-1', elapsed: 250,
        now: new Date('2026-03-01T12:00:00.000Z'),
        /** EVIDENCE_FRESHNESS_DAYS = 30 after this arm's `now`. */
        thirtyDays: new Date('2026-03-31T12:00:00.000Z'),
        day: '2026-03-01',
        mapped: 'iam_root_user_mfa_enabled',
        second: 'guardduty_enabled',
        trailingId: 'inspector_enabled',
        trailingCodes: ['CC3.1', 'CC7.1'],
        ctl: 'ctl', ev: 'ev',
    },
    {
        benchmark: 'CIS', key: 'cis',
        tenant: 'tenant-aws-2', conn: 'conn-6', exec: 'exec-4', elapsed: 410,
        now: new Date('2026-05-09T06:45:00.000Z'),
        thirtyDays: new Date('2026-06-08T06:45:00.000Z'),
        day: '2026-05-09',
        mapped: 'iam_user_mfa_enabled',
        second: 'securityhub_enabled',
        trailingId: 'config_enabled_all_regions',
        trailingCodes: ['CC8.1', 'CC7.1'],
        ctl: 'ctr', ev: 'row',
    },
] as const;

interface Conn {
    id: string;
    configJson: Record<string, unknown> | null;
    secretEncrypted: string | null;
    isEnabled: boolean;
}

function makeDbFor(conn: Conn | null, execId: string, evPrefix: string) {
    let evSeq = 0;
    return {
        integrationConnection: {
            findFirst: jest.fn(async () => conn),
        },
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

/** A provider stub whose `runCheck` returns (or throws) whatever the test wants. */
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

function checkResult(over: Partial<CheckResult> = {}): CheckResult {
    return { status: 'PASSED', summary: 's', details: {}, ...over };
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
    'runAwsPostureCollection [benchmark=$benchmark control=$mapped]',
    ({
        benchmark: BENCHMARK, key: KEY, tenant: TENANT, conn: CONN, exec: EXEC,
        elapsed: ELAPSED_MS, now: NOW, thirtyDays: THIRTY_DAYS, day: DAY,
        mapped: MAPPED, second: SECOND_MAPPED, trailingId: TRAILING,
        trailingCodes: TRAILING_CODES, ctl: CTL, ev: EV,
    }) => {
    const makeDb = (conn: Conn | null) => makeDbFor(conn, EXEC, EV);
    const fakeClock = () => fakeClockFor(NOW);
    const COMPLETION_INSTANT = completionInstant(NOW);

    describe('connection resolution', () => {
        it('records an ERROR execution and never constructs a run when the connection is missing', async () => {
            // Regression class: a deleted / wrong-provider connection must leave a
            // durable ERROR row on the execution ledger — a scheduled job that
            // returns quietly is indistinguishable from a dead worker.
            const db = makeDb(null);
            bind(db);

            // No `provider` and no `now` — exercises both injection defaults.
            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN });

            // The `where` is pinned exactly — tenant + provider scoping is the
            // invariant. The `select` is pinned by CONTAINMENT: these three fields
            // are the ones the collector actually reads. `isEnabled` is selected too
            // (aws-posture.ts:69) and never read, so an exact object here would go
            // red on a behaviour-preserving cleanup that deletes the dead field.
            expect(db.integrationConnection.findFirst).toHaveBeenCalledWith({
                where: { id: CONN, tenantId: TENANT, provider: 'aws-posture' },
                select: expect.objectContaining({ id: true, configJson: true, secretEncrypted: true }),
            });
            expect(db.integrationExecution.create).toHaveBeenCalledWith({
                data: {
                    tenantId: TENANT,
                    provider: 'aws-posture',
                    automationKey: 'aws-posture.unknown',
                    status: 'ERROR',
                    errorMessage: 'Connection not found',
                    triggeredBy: 'scheduled',
                    completedAt: COMPLETION_INSTANT,
                },
            });
            expect(res).toStrictEqual({
                executionId: EXEC,
                status: 'ERROR',
                counts: null,
                evidenceCreated: 0,
                errorMessage: 'Connection not found',
            });
            // Nothing ran, so the credential banner must not be touched.
            expect(clearAuth).not.toHaveBeenCalled();
            expect(markAuth).not.toHaveBeenCalled();
        });

        it('runs the whole collection inside a JOB context bound to the caller tenant', async () => {
            // Regression class: the RLS binding. A ctx built for the wrong tenant
            // would write another tenant's evidence with no error anywhere.
            const db = makeDb(null);
            bind(db);

            await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW });

            const ctx = runInTenant.mock.calls[0][0] as RequestContext;
            expect(ctx.tenantId).toBe(TENANT);
            expect(ctx.requestId).toBe(`aws-posture-${TENANT}`);
            expect(ctx.actorType).toBe('JOB');
            expect(ctx.userId).toBe('system');
            // This call injects `now`; the sibling above omits it and pins a real
            // wall-clock instant. Only the pair distinguishes `now` from a fresh
            // `new Date()` on the not-found branch — either test alone accepts both,
            // because on that branch the two are the same kind of value.
            expect(db.integrationExecution.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ completedAt: NOW }) }),
            );
        });
    });

    describe('benchmark selection and credentials', () => {
        it('defaults the benchmark to soc2 and passes no secrets when the connection carries neither', async () => {
            // Regression class: a connection saved without configJson must still run
            // the default benchmark rather than produce `aws-posture.undefined`.
            const db = makeDb({ id: CONN, configJson: null, secretEncrypted: null, isEnabled: true });
            bind(db);
            const provider = providerReturning(checkResult());

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

            expect(db.integrationExecution.create).toHaveBeenCalledWith({
                data: {
                    tenantId: TENANT,
                    connectionId: CONN,
                    provider: 'aws-posture',
                    automationKey: 'aws-posture.soc2',
                    status: 'RUNNING',
                    triggeredBy: 'scheduled',
                    executedAt: NOW,
                },
            });
            expect(provider.runCheck).toHaveBeenCalledWith({
                automationKey: 'aws-posture.soc2',
                parsed: { provider: 'aws-posture', checkType: 'soc2', raw: 'aws-posture.soc2' },
                tenantId: TENANT,
                connectionConfig: {},
                triggeredBy: 'scheduled',
            });
            expect(decrypt).not.toHaveBeenCalled();
            // `details` had neither counts nor controls.
            expect(res.counts).toBeNull();
            expect(res.evidenceCreated).toBe(0);
        });

        it('lowercases the configured benchmark and merges the decrypted secrets into the provider config', async () => {
            // Regression class: a `CIS`-cased benchmark must not produce the key
            // `aws-posture.CIS`, and the decrypted secrets must actually reach the
            // provider — without them every check silently runs unauthenticated.
            const db = makeDb({ id: CONN, configJson: { benchmark: 'CIS', region: 'eu-west-1' }, secretEncrypted: 'cipher-blob', isEnabled: true });
            bind(db);
            // Fabricated credential shapes — they must MATCH the AWS patterns in
            // `scrubAwsCredentials` for the scrub assertions below to mean anything.
            decrypt.mockReturnValue(JSON.stringify({ accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 'sk-live-0123456789abcdefghij' })); // pragma: allowlist secret
            const provider = providerReturning(checkResult());

            await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

            expect(decrypt).toHaveBeenCalledWith('cipher-blob');
            expect(provider.runCheck).toHaveBeenCalledWith(
                expect.objectContaining({
                    automationKey: 'aws-posture.cis',
                    parsed: { provider: 'aws-posture', checkType: 'cis', raw: 'aws-posture.cis' },
                    connectionConfig: {
                        benchmark: 'CIS',
                        region: 'eu-west-1',
                        accessKeyId: 'AKIAABCDEFGHIJKLMNOP', // pragma: allowlist secret
                        secretAccessKey: 'sk-live-0123456789abcdefghij',
                    },
                }),
            );
        });
    });

    describe('provider throw', () => {
        it('scrubs the connection secrets out of the persisted error and truncates it to 500 chars', async () => {
            // Regression class: the raw CLI error is written to a DB column and read
            // back in the admin UI. A dropped scrub leaks the secret access key.
            const secret = 'sk-live-0123456789abcdefghij'; // pragma: allowlist secret — fabricated, never issued
            const db = makeDb({ id: CONN, configJson: {}, secretEncrypted: 'cipher', isEnabled: true });
            bind(db);
            decrypt.mockReturnValue(JSON.stringify({ secretAccessKey: secret, externalId: 'ext-12345678' }));
            const err = new Error(`boom ${secret} ${'pad '.repeat(200)}`);
            const clock = fakeClock();
            const provider = providerThrowingAfter(err, clock, ELAPSED_MS);

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

            const expected = `boom [REDACTED] ${'pad '.repeat(200)}`.slice(0, 500);
            expect(expected).toHaveLength(500);
            expect(db.integrationExecution.update).toHaveBeenCalledWith({
                where: { id: EXEC },
                // Elapsed, not a constant: the clock moved by exactly ELAPSED_MS
                // while `runCheck` was in flight, so `Date.now() - start` is pinned.
                data: { status: 'ERROR', errorMessage: expected, durationMs: ELAPSED_MS, completedAt: COMPLETION_INSTANT },
            });
            expect(res.errorMessage).toBe(expected);
            expect(res.errorMessage).not.toContain(secret);
            // A throw is not a completed collection — the banner stays as it was.
            expect(clearAuth).not.toHaveBeenCalled();
        });

        it('marks the credential and blocks the queue retry for an auth failure', async () => {
            // Regression class: a revoked credential must not be re-run on the
            // queue's immediate retry, and must reach the connection-health writer
            // with THIS connection's id and provider label.
            const db = makeDb({ id: CONN, configJson: {}, secretEncrypted: null, isEnabled: true });
            bind(db);
            const err = new IntegrationAuthError(403, 'https://sts.amazonaws.com/');
            const provider = providerThrowing(err);

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

            expect(markAuth).toHaveBeenCalledWith(db, CONN, err, NOW, 'aws-posture');
            expect(res).toStrictEqual({
                executionId: EXEC,
                status: 'ERROR',
                counts: null,
                evidenceCreated: 0,
                errorMessage: err.message,
                noRetry: true,
            });
        });

        it('lets the queue retry an ordinary transport failure, and stringifies a non-Error throw', async () => {
            // Regression class: `noRetry` must be derived from the error CLASS, not
            // hard-coded — hard-coding either way loses a whole day of collection or
            // hammers a revoked credential.
            const db = makeDb({ id: CONN, configJson: {}, secretEncrypted: null, isEnabled: true });
            bind(db);
            const thrown = 'socket hang up';
            const provider = providerThrowing(thrown);

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider });

            // The thrown value itself reaches the credential writer. The auth test
            // is the only other assertion on that argument, so with one observation
            // it is byte-identical to the constant it takes there.
            expect(markAuth).toHaveBeenCalledWith(db, CONN, thrown, NOW, 'aws-posture');

            // The PERSISTED message under a second value. The scrub test above is
            // the only other assertion on this site, and with one observation the
            // derived `msg` is byte-identical to the constant it takes there.
            expect(db.integrationExecution.update).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ errorMessage: 'socket hang up' }) }),
            );
            expect(res).toStrictEqual({
                executionId: EXEC,
                status: 'ERROR',
                counts: null,
                evidenceCreated: 0,
                errorMessage: 'socket hang up',
                noRetry: false,
            });
        });
    });

    describe('evidence collection', () => {
        const passing = checkResult({
            status: 'PASSED',
            details: {
                counts: { ok: 1, alarm: 0, skip: 0, error: 0, total: 1 },
                controls: [{ id: MAPPED, status: 'ok' }],
            },
        });

        /**
         * The evidence-path connection deliberately runs a NON-DEFAULT benchmark AND
         * really carries a secret. Both are fixture-level, and both close the same
         * defect shape: a value the collector DERIVES is byte-identical to a
         * constant already in scope at the same site, so no assertion in the file
         * can tell the derivation from the constant.
         *
         *  - THIS ARM'S benchmark rather than one fixed for the whole block — see
         *    the `BENCHMARKS` note above for why a single value cannot work here.
         *  - A real `secretEncrypted`, decrypting to a VALUE-ONLY secret — chosen so
         *    that NONE of the AKIA / ASIA / 40-char / session-token / ARN patterns in
         *    `scrubAwsCredentials` match it, and only the connection's own value list
         *    can redact it. Every evidence-path connection used to have no secret, so
         *    `secretVals` was `[]` — identical to that parameter's own default — and
         *    dropping it from the completion-path scrub survived.
         */
        function connDb() {
            const db = makeDb({ id: CONN, configJson: { benchmark: BENCHMARK }, secretEncrypted: 'cipher-blob', isEnabled: true });
            decrypt.mockReturnValue(JSON.stringify({ secretAccessKey: CONN_SECRET }));
            bind(db);
            return db;
        }

        it('creates one evidence row per distinct covering control and pins the FIRST to the execution', async () => {
            // Regression class: `iam_root_user_mfa_enabled` crosswalks to SOC 2 AND
            // NIST CSF. Both installed frameworks must be evidenced, and the
            // execution's evidenceId must stay the first row (a `= ev.id` mutation
            // silently repoints it at the last).
            const db = connDb();
            db.controlRequirementLink.findFirst
                .mockResolvedValueOnce({ controlId: `${CTL}-soc2` })
                .mockResolvedValueOnce({ controlId: `${CTL}-nist` });
            const clock = fakeClock();
            // Restored by the file-wide `jest.restoreAllMocks()` afterEach.
            const info = jest.spyOn(logger, 'info');

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider: providerReturningAfter(passing, clock, ELAPSED_MS) });

            expect(db.controlRequirementLink.findFirst).toHaveBeenNthCalledWith(1, {
                where: { tenantId: TENANT, requirement: { framework: { key: 'SOC2' }, code: { in: ['CC6.1'] } } },
                select: { controlId: true },
            });
            expect(db.controlRequirementLink.findFirst).toHaveBeenNthCalledWith(2, {
                where: { tenantId: TENANT, requirement: { framework: { key: 'NIST-CSF-2.0' }, code: { in: ['PR.AA-01'] } } },
                select: { controlId: true },
            });
            expect(res.evidenceCreated).toBe(2);
            // The execution row's own `automationKey`, under THIS ARM's benchmark.
            // The default-benchmark test is the only other assertion on that site
            // and always observes `aws-posture.soc2`, so with one observation the
            // derived key is byte-identical to that literal.
            expect(db.integrationExecution.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ automationKey: `aws-posture.${KEY}` }) }),
            );
            expect(db.evidence.create).toHaveBeenCalledTimes(2);
            expect(db.evidence.create).toHaveBeenNthCalledWith(1, {
                data: {
                    tenantId: TENANT,
                    type: 'TEXT',
                    title: `Automated evidence — AWS ${MAPPED}`,
                    content: `AWS posture check "${MAPPED}" PASSED (aws-posture.${KEY}) on ${DAY}. Machine-collected via Powerpipe; execution ${EXEC}.`,
                    category: `aws-posture:${MAPPED}`,
                    dateCollected: NOW,
                    reviewCycle: 'MONTHLY',
                    nextReviewDate: THIRTY_DAYS,
                    status: 'APPROVED',
                },
            });
            expect(db.evidenceControlLink.create).toHaveBeenNthCalledWith(1, {
                data: { tenantId: TENANT, evidenceId: `${EV}-1`, controlId: `${CTL}-soc2`, createdByUserId: null },
            });
            expect(db.evidenceControlLink.create).toHaveBeenNthCalledWith(2, {
                data: { tenantId: TENANT, evidenceId: `${EV}-2`, controlId: `${CTL}-nist`, createdByUserId: null },
            });
            expect(db.controlEvidenceLink.create).toHaveBeenNthCalledWith(1, {
                data: { tenantId: TENANT, controlId: `${CTL}-soc2`, kind: 'INTEGRATION_RESULT', integrationResultId: EXEC, note: `AWS posture: ${MAPPED}` },
            });
            // The SECOND link too: one observation leaves `controlId` byte-identical
            // to the first control's id, so a collector that stamped that id on
            // every back-reference passes.
            expect(db.controlEvidenceLink.create).toHaveBeenNthCalledWith(2, {
                data: { tenantId: TENANT, controlId: `${CTL}-nist`, kind: 'INTEGRATION_RESULT', integrationResultId: EXEC, note: `AWS posture: ${MAPPED}` },
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
            expect(clearAuth).toHaveBeenCalledWith(db, CONN, 'aws-posture');
            // The completion line is the operator's ONLY per-run signal that this
            // collector ran at all, and every field on it but `component` is derived
            // from the run. Nothing asserted it before, so the whole line — message,
            // subsystem label, status and evidence count alike — could be replaced by
            // constants with the suite green.
            expect(info).toHaveBeenCalledWith('aws-posture collection complete', {
                component: 'aws-posture',
                tenantId: TENANT,
                executionId: EXEC,
                status: 'PASSED',
                evidenceCreated: 2,
            });
        });

        it('evidences a control covered under both frameworks exactly once', async () => {
            // Regression class: dropping the seen-set duplicates the evidence row for
            // every framework the check crosswalks to, inflating coverage.
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-shared` });

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider: providerReturning(passing) });

            expect(db.controlRequirementLink.findFirst).toHaveBeenCalledTimes(2);
            expect(res.evidenceCreated).toBe(1);
            expect(db.evidence.create).toHaveBeenCalledTimes(1);
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
                        { id: MAPPED, status: 'ok' },
                        { id: SECOND_MAPPED, status: 'ok' },
                    ],
                },
            });

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider: providerReturning(twoPassing) });

            // One row per CHECK (distinct category), deduped within each check.
            expect(res.evidenceCreated).toBe(2);
            expect(db.evidence.create).toHaveBeenCalledTimes(2);
            expect(db.evidence.create).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({ data: expect.objectContaining({ category: `aws-posture:${MAPPED}` }) }),
            );
            expect(db.evidence.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ data: expect.objectContaining({ category: `aws-posture:${SECOND_MAPPED}` }) }),
            );
        });

        it('never evidences an alarming, skipped, or unmapped control', async () => {
            // Regression class: the whole point of the collector. An ALARM control
            // evidenced as passing is a false compliance claim.
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-soc2` });
            const mixed = checkResult({
                status: 'FAILED',
                details: {
                    counts: { ok: 1, alarm: 1, skip: 1, error: 0, total: 3 },
                    controls: [
                        { id: MAPPED, status: 'alarm' },
                        { id: SECOND_MAPPED, status: 'skip' },
                        { id: 'not_in_the_control_map', status: 'ok' },
                    ],
                },
            });

            // Restored by the file-wide `jest.restoreAllMocks()` afterEach.
            const info = jest.spyOn(logger, 'info');

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider: providerReturning(mixed) });

            expect(db.controlRequirementLink.findFirst).not.toHaveBeenCalled();
            expect(db.evidence.create).not.toHaveBeenCalled();
            expect(res).toStrictEqual({
                executionId: EXEC,
                status: 'FAILED',
                counts: { ok: 1, alarm: 1, skip: 1, error: 0, total: 3 },
                evidenceCreated: 0,
                errorMessage: undefined,
            });
            expect(db.integrationExecution.update).toHaveBeenCalledWith({
                where: { id: EXEC },
                data: expect.objectContaining({ status: 'FAILED', evidenceId: null }),
            });
            // Regression class: a FAILED compliance verdict is a SUCCESSFUL
            // collection — the credential demonstrably worked, so a stale REVOKED
            // banner must clear. Clamping the clear to `status === 'PASSED'` (the
            // obvious over-correction for the ERROR-path defect reported alongside
            // this file) would strand the banner on a healthy connection for as long
            // as the benchmark keeps reporting gaps. Only the PASSED path was pinned
            // before, so that clamp landed green.
            expect(clearAuth).toHaveBeenCalledWith(db, CONN, 'aws-posture');
            // The SECOND observation of the completion line, and the reason it is
            // here rather than only on the passing test: `status` and
            // `evidenceCreated` are derived, but with one observation each was
            // byte-identical to the constant it took there ('PASSED', 2). Two
            // observations that DISAGREE on both leave no constant that satisfies
            // them.
            expect(info).toHaveBeenCalledWith('aws-posture collection complete', {
                component: 'aws-posture',
                tenantId: TENANT,
                executionId: EXEC,
                status: 'FAILED',
                evidenceCreated: 0,
            });
        });

        it('keeps evidencing the controls that FOLLOW a failing one', async () => {
            // Regression class: `continue` vs `break` in the pass-only filter. A
            // `break` stops the whole sweep at the first alarm, so a benchmark that
            // reports controls alphabetically silently under-collects everything
            // after the first failure — with a PASSED-shaped result to show for it.
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-after` });
            const trailing = checkResult({
                status: 'FAILED',
                details: {
                    counts: { ok: 1, alarm: 1, skip: 0, error: 0, total: 2 },
                    controls: [
                        { id: MAPPED, status: 'alarm' },
                        { id: TRAILING, status: 'ok' },
                    ],
                },
            });

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider: providerReturning(trailing) });

            expect(res.evidenceCreated).toBe(1);
            expect(db.controlRequirementLink.findFirst).toHaveBeenNthCalledWith(1, {
                where: { tenantId: TENANT, requirement: { framework: { key: 'SOC2' }, code: { in: [...TRAILING_CODES] } } },
                select: { controlId: true },
            });
            expect(db.evidence.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ category: `aws-posture:${TRAILING}` }) }),
            );
        });

        it('skips a framework the tenant has not installed and a link with no covering control', async () => {
            // Regression class: `link.controlId` is nullable. Treating a null as a
            // control id would attach evidence to nothing and throw on the FK.
            const db = connDb();
            db.controlRequirementLink.findFirst
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ controlId: null });

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider: providerReturning(passing) });

            expect(db.evidence.findFirst).not.toHaveBeenCalled();
            expect(db.evidence.create).not.toHaveBeenCalled();
            expect(res.evidenceCreated).toBe(0);
        });

        it('refreshes the existing auto-collected row rather than creating a second one', async () => {
            // Regression class: the rolling-evidence contract. Losing the lookup
            // grows one Evidence row per night per control, forever.
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-shared` });
            db.evidence.findFirst.mockResolvedValue({ id: `${EV}-existing` });

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider: providerReturning(passing) });

            expect(db.evidence.findFirst).toHaveBeenCalledWith({
                where: {
                    tenantId: TENANT,
                    evidenceControlLinks: { some: { controlId: `${CTL}-shared` } },
                    category: `aws-posture:${MAPPED}`,
                    type: 'TEXT',
                    isArchived: false,
                    deletedAt: null,
                },
                select: { id: true },
            });
            expect(db.evidence.update).toHaveBeenCalledWith({
                where: { id: `${EV}-existing` },
                data: {
                    title: `Automated evidence — AWS ${MAPPED}`,
                    content: `AWS posture check "${MAPPED}" PASSED (aws-posture.${KEY}) on ${DAY}. Machine-collected via Powerpipe; execution ${EXEC}.`,
                    dateCollected: NOW,
                    nextReviewDate: THIRTY_DAYS,
                    status: 'APPROVED',
                },
            });
            expect(db.evidence.create).not.toHaveBeenCalled();
            expect(db.evidenceControlLink.create).not.toHaveBeenCalled();
            expect(db.controlEvidenceLink.create).not.toHaveBeenCalled();
            expect(res.evidenceCreated).toBe(1);
            expect(db.integrationExecution.update).toHaveBeenCalledWith({
                where: { id: EXEC },
                data: expect.objectContaining({ evidenceId: `${EV}-existing` }),
            });
        });

        it('keeps the FIRST refreshed row as the execution evidence when several are refreshed', async () => {
            // Regression class: the update arm has its own `firstEvidenceId ?? ev.id`.
            // A `= ev.id` mutation there repoints the execution at the LAST row, so
            // the ledger entry stops naming the evidence an auditor would open.
            const db = connDb();
            db.controlRequirementLink.findFirst
                .mockResolvedValueOnce({ controlId: `${CTL}-soc2` })
                .mockResolvedValueOnce({ controlId: `${CTL}-nist` });
            db.evidence.findFirst
                .mockResolvedValueOnce({ id: 'ev-old-a' })
                .mockResolvedValueOnce({ id: 'ev-old-b' });

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider: providerReturning(passing) });

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
                data: expect.objectContaining({ evidenceId: 'ev-old-a' }),
            });
        });

        it('completes the run when the control↔execution link is a duplicate', async () => {
            // Regression class: the link is a convenience back-reference; a unique
            // violation on it must not abort the collection or lose the evidence.
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-shared` });
            db.controlEvidenceLink.create.mockRejectedValue(new Error('Unique constraint failed'));

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider: providerReturning(passing) });

            expect(res.evidenceCreated).toBe(1);
            expect(res.status).toBe('PASSED');
            expect(db.integrationExecution.update).toHaveBeenCalledTimes(1);
        });

        it('collects no evidence from an ERRORed run and persists the scrubbed provider error', async () => {
            // Regression class: an ERROR result means the collector did not observe
            // the account. Evidencing its `controls` would assert a pass nobody saw.
            const db = connDb();
            db.controlRequirementLink.findFirst.mockResolvedValue({ controlId: `${CTL}-shared` });
            // Long AND credential-bearing: the provider-reported message goes through
            // its OWN scrub + truncate, separate from the catch path's. It carries
            // BOTH kinds of credential on purpose — an `AKIA…` key that the pattern
            // list alone would catch, and this connection's own value-only secret,
            // which nothing but `secretVals` can redact. Without the second one the
            // completion-path scrub is indistinguishable from `scrubAwsCredentials(msg)`
            // with the argument dropped, because every evidence-path connection used
            // to carry no secret at all.
            const errored = checkResult({
                status: 'ERROR',
                errorMessage: `collector error; key AKIAABCDEFGHIJKLMNOP secret ${CONN_SECRET} expired ${'pad '.repeat(200)}`, // pragma: allowlist secret
                details: { counts: { ok: 1, alarm: 0, skip: 0, error: 0, total: 1 }, controls: [{ id: MAPPED, status: 'ok' }] },
            });

            const res = await runAwsPostureCollection({ tenantId: TENANT, connectionId: CONN, now: NOW, provider: providerReturning(errored) });

            expect(db.controlRequirementLink.findFirst).not.toHaveBeenCalled();
            expect(db.evidence.create).not.toHaveBeenCalled();
            expect(res.evidenceCreated).toBe(0);
            expect(res.status).toBe('ERROR');
            // The result carries the provider message UNSCRUBBED and UNTRUNCATED —
            // both are persistence concerns. Every other test observes this field
            // as `undefined`, so one non-undefined observation is what stops the
            // literal from being indistinguishable from the derivation.
            expect(res.errorMessage).toBe(errored.errorMessage);
            const persisted = `collector error; key [REDACTED] secret [REDACTED] expired ${'pad '.repeat(200)}`.slice(0, 500);
            expect(persisted).toHaveLength(500);
            expect(db.integrationExecution.update).toHaveBeenCalledWith({
                where: { id: EXEC },
                data: expect.objectContaining({
                    status: 'ERROR',
                    evidenceId: null,
                    errorMessage: persisted,
                }),
            });
            // Read back what the collector actually wrote, not the string this test
            // built: asserting `persisted` does not contain the secret would only be
            // asserting the test's own arithmetic.
            const updateArgs = db.integrationExecution.update.mock
                .calls as unknown as Array<[{ data: { errorMessage: string } }]>;
            expect(updateArgs[0][0].data.errorMessage).not.toContain(CONN_SECRET);
        });
    });
    },
);
