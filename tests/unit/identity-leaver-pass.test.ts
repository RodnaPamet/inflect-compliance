/**
 * The leaver pass — every gate in front of the batch, and the clamp.
 *
 * The two assertions that carry the weight:
 *   - every rung the ladder can reach RUNS, including AUTOMATIC. The clamp is a
 *     ceiling at the top rung, not a permission, and what keeps a tenant off
 *     AUTOMATIC is the ladder itself (DISABLED by default, one rung per widen,
 *     DRY_RUN_MIN_DAYS of dwell);
 *   - an empty candidate set with terminated workers present is reported as its
 *     own refusal, not as a quiet success — a leaver pass that disables nobody
 *     and says "done" is the failure this whole subsystem is most prone to.
 *
 * This header used to say "a tenant configured at AUTOMATIC gets NOTHING …
 * no pass has ever run". #2187 falsified the first half on 2026-08-30 and the
 * 05:00 pass on 2026-09-12 falsified the second, by disabling a live directory
 * account. Corrected in #2487 along with the rest of that sweep.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));
import { logger } from '@/lib/observability/logger';
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/context-system', () => ({
    buildSystemContext: jest.fn((a: { tenantId: string }) => ({ tenantId: a.tenantId, userId: 'system' })),
}));
const getPolicy = jest.fn();
jest.mock('@/app-layer/usecases/identity-write-policy', () => ({
    getIdentityWritePolicy: (...a: unknown[]) => getPolicy(...a),
}));
const findCandidates = jest.fn();
const disableBatch = jest.fn();
jest.mock('@/app-layer/usecases/identity-disable-account', () => ({
    findLeaverCandidates: (...a: unknown[]) => findCandidates(...a),
    disableAccountsForLeaver: (...a: unknown[]) => disableBatch(...a),
}));
const resolveWriter = jest.fn();
jest.mock('@/app-layer/integrations/identity-writer-factory', () => ({
    resolveDirectoryWriter: (...a: unknown[]) => resolveWriter(...a),
}));
const passMetric = jest.fn();
// Spread the real module and override only what this file asserts on. A factory
// that LISTS the functions is a snapshot of the module as it looked the day it
// was written: the next counter added upstream is `undefined` here, and calling
// undefined throws out of a caller contracted never to throw — so the red lands
// on an unrelated assertion in another file. The spread tracks the module by
// itself, and the exports nobody overrides stay real (a noop meter, no cost).
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordLeaverPassOutcome: (...a: unknown[]) => passMetric(...a),
}));

import {
    runIdentityLeaverPass,
    clampRefusalDetail,
    LEAVER_MAX_MODE,
    LINK_FRESHNESS_MS,
    MAX_REPORTED_DECISIONS,
} from '@/app-layer/usecases/identity-leaver-pass';
import { LADDER, isAboveClamp } from '@/lib/identity/write-ladder';
import { OBSERVATION_FRESHNESS_MS } from '@/app-layer/usecases/identity-write-target';

const mockDb = {
    employee: { findMany: jest.fn() },
    connectedIdentityAccount: { count: jest.fn() },
    // The pass record. Its write is wrapped in a try/catch so a failed insert
    // cannot turn a completed pass into an ERROR — which means a mock missing
    // this key would leave the whole feature dead with the suite green. The
    // assertions below are positive for exactly that reason.
    integrationExecution: { create: jest.fn() },
    // The unsettled-write backlog, read at the HEAD of every pass — before the
    // ladder, so it is reported even by the two refusals that write no row.
    // Same argument as the comment above: the read is wrapped so it cannot fail
    // a pass, which means a mock missing this key would leave every assertion
    // green while the reader threw on every call.
    identityWriteJournal: { findMany: jest.fn() },
    // Which candidates sit on a connection that is still ENABLED (#2419). This
    // read is NOT wrapped: a failure reaches the pass's own catch and the pass
    // records an ERROR, which is the fail-closed direction — a mock missing
    // this key would turn every test in the file red rather than green, which
    // is the right way round for a read that gates a write.
    identityAccountLink: { findMany: jest.fn() },
};

const NOW = new Date('2026-08-20T09:00:00.000Z');
const close = jest.fn(async () => undefined);

function run(over: Record<string, unknown> = {}) {
    return runIdentityLeaverPass({ tenantId: 't1', provider: 'entra-id', now: NOW, ...over });
}

beforeEach(() => {
    jest.clearAllMocks();
    getPolicy.mockResolvedValue({ leaver: { mode: 'DRY_RUN', dryRunSince: NOW }, joiner: { mode: 'DISABLED' } });
    mockDb.employee.findMany.mockResolvedValue([{ id: 'emp-1' }, { id: 'emp-2' }]);
    findCandidates.mockResolvedValue([{ linkId: 'l1', externalUserId: 'x1', onPremisesSyncEnabled: false }]);
    mockDb.connectedIdentityAccount.count.mockResolvedValue(400);
    resolveWriter.mockResolvedValue({ kind: 'snapshot', writer: { provider: 'entra-id' }, close });
    disableBatch.mockResolvedValue({ results: [{ outcome: 'DRY_RUN', linkId: 'l1' }] });
    mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
    // Default: nothing stranded. Tests that care override it.
    mockDb.identityWriteJournal.findMany.mockResolvedValue([]);
    // Default: every candidate's connection is still enabled. Derived from the
    // ids the pass actually asks for rather than pinned to a fixture list, so a
    // test that invents its own candidates does not silently get an empty
    // answer — which the rail reads as "could not confirm", i.e. stranded.
    mockDb.identityAccountLink.findMany.mockImplementation(
        async (args: { where?: { id?: { in?: string[] } } }) =>
            (args.where?.id?.in ?? []).map((id) => ({
                id,
                connectedAccount: { connection: { isEnabled: true } },
            })),
    );
});

describe('the durable record a dry run leaves behind', () => {
    // The seven-day window exists to be COMPARED against what HR and IT actually
    // did — the ladder's own refusal text says so — and until now a dry run
    // decided, logged a histogram, and threw every decision away. The promotion
    // gate counts ELAPSED days, not observed runs, so the window could be
    // satisfied by time passing while nobody watched anything.
    it('writes one execution row carrying a decision per candidate', async () => {
        findCandidates.mockResolvedValue([
            { linkId: 'l1', externalUserId: 'x1', onPremisesSyncEnabled: false },
            { linkId: 'l2', externalUserId: 'x2', onPremisesSyncEnabled: false },
        ]);
        disableBatch.mockResolvedValue({
            results: [
                { outcome: 'DRY_RUN', linkId: 'l1' },
                { outcome: 'REFUSED_TARGET', linkId: 'l2', reason: 'hybrid-synced' },
            ],
        });

        const r = await run();

        expect(r.status).toBe('PASSED');
        expect(mockDb.integrationExecution.create).toHaveBeenCalledTimes(1);
        const data = mockDb.integrationExecution.create.mock.calls[0][0].data;
        expect(data.automationKey).toBe('entra-id.leaver_pass');
        expect(data.status).toBe('PASSED');
        expect(data.resultJson.decisions).toEqual([
            { linkId: 'l1', outcome: 'DRY_RUN' },
            { linkId: 'l2', outcome: 'REFUSED_TARGET', reason: 'hybrid-synced' },
        ]);
        expect(data.resultJson.decisionsTruncated).toBe(false);
    });

    it('carries the decision BASIS into the row, unscrubbed and verbatim', async () => {
        // Every DRY_RUN decision shares one fixed reason sentence, so the report
        // could show a hundred identical "would disable" rows and say nothing
        // about which of them rested on the cloud-only rule #2144 widened. The
        // basis is the only field that separates them, and it survives the
        // scrubbing pass untouched because it can name no account: an enum, a
        // tri-state boolean and a timestamp.
        const basis = {
            rule: 'CLOUD_ONLY_OBSERVED',
            onPremisesSyncEnabled: null,
            observedAt: '2026-08-19T02:00:00.000Z',
        };
        disableBatch.mockResolvedValue({
            results: [{ outcome: 'DRY_RUN', linkId: 'l1', reason: 'Dry-run mode.', basis }],
        });

        await run();

        const decisions = mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson.decisions;
        expect(decisions).toEqual([
            { linkId: 'l1', outcome: 'DRY_RUN', reason: 'Dry-run mode.', basis },
        ]);
    });

    it('omits the basis rather than inventing one when a decision made none', async () => {
        // The refusals decided before the write-target rail carry no basis, and
        // the row must not manufacture one — a `null` or a guessed rule would be
        // indistinguishable on screen from a determination the pass made.
        disableBatch.mockResolvedValue({
            results: [{ outcome: 'REFUSED_PROTECTED', linkId: 'l1', reason: 'service account' }],
        });

        await run();

        const decisions = mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson.decisions;
        expect(decisions[0]).not.toHaveProperty('basis');
        // Paired positive: the decision itself IS in the row, so the absence
        // above is about the basis and not about a row that never got written.
        expect(decisions[0].outcome).toBe('REFUSED_PROTECTED');
    });

    it('carries the JOURNAL ID onto the decision, so the report can reach the capture', async () => {
        // The DISABLED mail tells IT to quote the journal reference to somebody
        // who "can read the captured state and re-apply it". `disableAccount`
        // returns that reference on the result, and `recordPassExecution` used
        // to drop it — leaving `detailsJson.journalId` on the audit row as the
        // only in-product pointer from a disable to what it replaced, which the
        // leaver report cannot reach. Without this field the report can show
        // that an account was disabled and offer no route to the capture.
        disableBatch.mockResolvedValue({
            results: [{ outcome: 'DISABLED', linkId: 'l1', journalId: 'jrnl_abc123' }],
        });

        await run();

        const decisions = mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson
            .decisions as Array<Record<string, unknown>>;
        expect(decisions[0]).toMatchObject({
            linkId: 'l1',
            outcome: 'DISABLED',
            journalId: 'jrnl_abc123',
        });
    });

    it('leaves the journal id UNSCRUBBED — it is an opaque cuid, not an account', async () => {
        // Every `reason` on a decision goes through `redactDirectoryIdentifiers`
        // because a provider sentence embeds the account it is about. A journal
        // id embeds nothing: it is minted by our own database and resolves only
        // through an authorised read of a table we own. Scrubbing it would
        // corrupt the one field whose whole value is being quotable verbatim —
        // and the scrubber is reason-shaped, so a future edit that widened it
        // over the rest of the decision would land here first.
        //
        // Asserted against a candidate whose directory identifier is a
        // substring-rich value, so a scrubber applied to this field would have
        // something to find and would visibly change it.
        findCandidates.mockResolvedValue([
            { linkId: 'l1', externalUserId: 'abc123', onPremisesSyncEnabled: false },
        ]);
        disableBatch.mockResolvedValue({
            results: [{ outcome: 'DISABLED', linkId: 'l1', journalId: 'jrnl_abc123' }],
        });

        await run();

        const decisions = mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson
            .decisions as Array<Record<string, unknown>>;
        expect(decisions[0].journalId).toBe('jrnl_abc123');
    });

    it('OMITS the journal id on a decision that never reached a write', async () => {
        // `journalId` exists only once `beginWrite` has committed a capture, so
        // the refusals decided before it carry none. A `null` on the row would
        // read on screen as "a capture was attempted and produced nothing",
        // which is a different and far more alarming claim than "no write was
        // attempted". Same rule the basis follows.
        disableBatch.mockResolvedValue({
            results: [{ outcome: 'REFUSED_PROTECTED', linkId: 'l1', reason: 'service account' }],
        });

        await run();

        const decisions = mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson
            .decisions as Array<Record<string, unknown>>;
        expect(decisions[0]).not.toHaveProperty('journalId');
        // Paired positive: the decision IS on the row, so the absence above is
        // about the journal id and not about a row that never got written.
        expect(decisions[0].outcome).toBe('REFUSED_PROTECTED');
    });

    it('keys decisions by link id and never by directory identifier', async () => {
        // IntegrationExecution is not encrypted at rest — the Epic B manifest is
        // String-only, so a Json column cannot join it — and these rows outlive
        // the pass. The identifier that goes in must mean nothing without an
        // authorised read.
        const r = await run();

        expect(r.status).toBe('PASSED');
        const json = JSON.stringify(mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson);
        expect(json).toContain('l1');
        expect(json).not.toContain('x1');
    });

    it('scrubs the account out of a provider reason before persisting it', async () => {
        // `DisableResult.reason` is deliberately un-redacted — it is written for
        // an operator reading a tenant-scoped surface — but provider messages
        // routinely embed the account. Persisting one verbatim would put back
        // exactly what keying by link id takes out.
        // A realistic identifier, not 'x1': the scrubber refuses to remove
        // anything under three characters, because a two-character id matches
        // inside ordinary words and would turn a message into confetti. Real
        // directory ids are GUIDs or DNs, and the fixture has to be one for the
        // assertion to mean anything.
        const guid = '11111111-2222-3333-4444-555555555555';
        findCandidates.mockResolvedValue([
            { linkId: 'l1', externalUserId: guid, onPremisesSyncEnabled: false },
        ]);
        disableBatch.mockResolvedValue({
            results: [
                {
                    outcome: 'FAILED',
                    linkId: 'l1',
                    reason: `No observed directory record for ${guid}. The last complete sync did not see it.`,
                },
            ],
        });

        await run();

        const decisions = mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson.decisions;
        expect(decisions[0].reason).not.toContain('1111');
        expect(decisions[0].reason).toContain('{account}');
    });

    it('marks a truncated report PARTIAL and says so in the row', async () => {
        // Unreachable today — the breaker REFUSES above 50 rather than trimming
        // — but a report that IS cut short must say so rather than quietly end
        // early, which is the failure mode of every cap without a flag.
        const many = Array.from({ length: MAX_REPORTED_DECISIONS + 5 }, (_, i) => ({
            outcome: 'DRY_RUN' as const,
            linkId: `l${i}`,
        }));
        disableBatch.mockResolvedValue({ results: many });

        const r = await run();

        const data = mockDb.integrationExecution.create.mock.calls[0][0].data;
        expect(data.status).toBe('PARTIAL');
        expect(data.resultJson.decisions).toHaveLength(MAX_REPORTED_DECISIONS);
        expect(data.resultJson.decisionsTruncated).toBe(true);

        // The half this test used to be missing. The row said PARTIAL and the
        // value handed back to the job said PASSED, because they were two
        // hand-written ternaries 400 lines apart and only one of them had ever
        // learned the word. `executor-registry` puts this return straight onto
        // the job result, so everything downstream of the queue read a truncated
        // pass as a complete one.
        expect(r.status).toBe('PARTIAL');
    });

    it.each([
        [
            'a plain pass',
            () => {
                /* the beforeEach defaults already describe one */
            },
        ],
        [
            'a refused batch',
            () => {
                disableBatch.mockResolvedValue({ results: [], refused: 'blast radius' });
            },
        ],
        [
            'a truncated report',
            () => {
                disableBatch.mockResolvedValue({
                    results: Array.from({ length: MAX_REPORTED_DECISIONS + 1 }, (_, i) => ({
                        outcome: 'DRY_RUN' as const,
                        linkId: `l${i}`,
                    })),
                });
            },
        ],
    ])('reports the same status it recorded, for %s', async (_label, arrange) => {
        // The INVARIANT, stated once, rather than three statuses asserted
        // separately and hoped to match. A test that pins each side to its own
        // expected literal passes just as happily when both are wrong together,
        // and says nothing at all about the property that actually broke: that
        // the artefact an operator reads and the result the queue reports are
        // the same claim about the same run.
        //
        // Written against the two REAL outputs, not against `leaverPassStatus`.
        // Asserting both equal the helper would be true by construction the
        // moment both call it — which is the state we are IN, so the assertion
        // would survive one of them being rewired back to a literal.
        arrange();

        const r = await run();

        const recorded = mockDb.integrationExecution.create.mock.calls[0][0].data.status;
        expect(r.status).toBe(recorded);
    });

    it('records a pass that ran and REFUSED, so silence cannot look like a run', async () => {
        // The distinction the seven-day observation rests on: "the pass ran and
        // found nobody to offboard" and "no pass ran at all" used to be the same
        // absence in the artefact. NO_FRESH_LINKS is the one that matters most —
        // terminated workers present, nobody offboarded, green pass — which is
        // the silent-nothing failure this subsystem is built around.
        findCandidates.mockResolvedValue([]);

        const r = await run();

        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'NO_FRESH_LINKS' });
        expect(mockDb.integrationExecution.create).toHaveBeenCalledTimes(1);
        const data = mockDb.integrationExecution.create.mock.calls[0][0].data;
        expect(data.status).toBe('NOT_APPLICABLE');
        expect(data.resultJson.refusal).toBe('NO_FRESH_LINKS');
        expect(data.resultJson.terminatedWorkers).toBe(2);
    });

    it('does NOT record a tenant that is not observing at all', async () => {
        // A tenant with leaver writes switched off is not in an observation
        // window, and a daily row would imply it was being watched. The ladder
        // refusals are excluded for that reason, not by omission.
        getPolicy.mockResolvedValue({ leaver: { mode: 'DISABLED' }, joiner: { mode: 'DISABLED' } });

        const r = await run();

        expect(r).toMatchObject({ refusal: 'MODE_DISABLED' });
        expect(mockDb.integrationExecution.create).not.toHaveBeenCalled();
    });

    it('a tenant BELOW the clamp is not refused by it', async () => {
        // THE REGRESSION RAISING THE CLAMP WOULD HAVE CAUSED.
        //
        // Gate 1 used to test `mode !== LEAVER_MAX_MODE`, which was correct only
        // by coincidence: with the clamp at the second rung, the one mode that
        // is neither DISABLED (handled above it) nor equal to it happened to be
        // a HIGHER one. With the clamp at AUTOMATIC the coincidence breaks the
        // other way — DRY_RUN is not equal to AUTOMATIC but is BELOW it, and the
        // inequality would refuse MODE_ABOVE_CLAMP, which records no execution
        // row. The live dry run would have stopped dead and the passes page
        // would have gone blank with nothing saying why.
        getPolicy.mockResolvedValue({
            leaver: { mode: 'DRY_RUN', dryRunSince: NOW },
            joiner: { mode: 'DISABLED' },
        });

        const r = await run();

        expect(r.refusal).toBeUndefined();
        expect(r.status).toBe('PASSED');
        expect(mockDb.integrationExecution.create).toHaveBeenCalledTimes(1);
    });

    it('does NOT record a tenant set ABOVE the clamp either', async () => {
        // THE TRIPWIRE for how the empty-page problem was solved.
        //
        // An empty passes page had at least three causes that looked identical,
        // and the obvious fix was to record a row for these two ladder refusals
        // so the page explains itself. That was rejected: it writes one row per
        // (tenant, provider) every night forever with no retention, evicting the
        // actual observation record from a bounded window — and it still covers
        // only two of the causes. The page reads the tenant's mode instead.
        //
        // This test is what makes the two approaches mutually exclusive in one
        // diff: implement the row-writing version and it goes red.
        // WITH THE CLAMP AT THE TOP RUNG, NOTHING IS ABOVE IT — so this
        // refusal is now unreachable through the ladder, and saying so is more
        // honest than manufacturing a fake rung to keep the branch covered.
        //
        // My first attempt did exactly that, with an out-of-ladder 'SUPERUSER',
        // and it did not refuse: `indexOf` returns -1 for an unknown mode, which
        // is NOT greater than the clamp's index, so it reads as below. That is
        // the documented behaviour of `isAboveClamp` and the safe direction, but
        // it means an invented value cannot exercise this branch.
        //
        // The silence property this test protected is pinned on the reachable
        // refusal instead — MODE_DISABLED, above — and the ordering the branch
        // depends on is pinned directly on the predicate in
        // tests/unit/identity-write-ladder.test.ts.
        expect(isAboveClamp('DRY_RUN', LEAVER_MAX_MODE)).toBe(false);
        expect(isAboveClamp('AUTOMATIC', LEAVER_MAX_MODE)).toBe(false);
    });

    it('a refusal whose record fails is still a refusal, not an ERROR', async () => {
        findCandidates.mockResolvedValue([]);
        mockDb.integrationExecution.create.mockRejectedValue(new Error('db is on fire'));

        const r = await run();

        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'NO_FRESH_LINKS' });
    });

    it('a failed insert does not turn a completed pass into an ERROR', async () => {
        // The directory decisions are already made and already reported. Losing
        // the record of them is worth an alert, not a retry of a pass that ran —
        // and the pass runs with attempts: 1 precisely so nothing re-dispatches.
        mockDb.integrationExecution.create.mockRejectedValue(new Error('db is on fire'));

        const r = await run();

        expect(r.status).toBe('PASSED');
        expect((logger.error as jest.Mock).mock.calls.some(
            (c) => typeof c[0] === 'string' && c[0].includes('record could not be written'),
        )).toBe(true);
    });
});

describe('the ladder gate', () => {
    it('does nothing at all when leaver writes are DISABLED', async () => {
        getPolicy.mockResolvedValue({ leaver: { mode: 'DISABLED' }, joiner: { mode: 'DISABLED' } });

        const r = await run();

        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'MODE_DISABLED' });
        expect(mockDb.employee.findMany).not.toHaveBeenCalled();
        expect(resolveWriter).not.toHaveBeenCalled();
    });

    it.each(LADDER.filter((m) => m !== 'DISABLED'))('does NOT clamp a tenant at %s', async (mode) => {
        // Driven from LADDER rather than a literal list, so retiring or adding a
        // rung cannot leave this asserting about a ladder that no longer exists.
        // These USED to be two clamped rungs and one allowed one. The clamp is
        // now the top rung, so every real ladder position runs — which is the
        // point of raising it, and the thing most worth pinning: the gate must
        // not refuse a tenant that is BELOW the ceiling.
        //
        // The rung a tenant occupies is still governed by the ladder itself —
        // DRY_RUN_MIN_DAYS, no two-step widen, DISABLED by default. The clamp is
        // a ceiling, not a permission.
        getPolicy.mockResolvedValue({ leaver: { mode, dryRunSince: NOW }, joiner: { mode: 'DISABLED' } });

        const r = await run();

        expect(r.refusal).toBeUndefined();
        expect(r.status).toBe('PASSED');
        expect(passMetric).not.toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'mode_above_clamp' }),
        );
    });

    it('the clamp is AUTOMATIC — and moving it is a reviewed diff, not a setting', () => {
        // Pinned as a VALUE because it is the single line that decides whether
        // this subsystem may write to a customer's directory at all. A change
        // here should be deliberate enough to update a test in the same diff.
        expect(LEAVER_MAX_MODE).toBe('AUTOMATIC');
    });

    it('no rung is above the clamp — the tripwire for the day one is', () => {
        // WHAT THIS IS FOR. `MODE_ABOVE_CLAMP` in the pass is unreachable while
        // the clamp sits on the TOP rung, and #2487 kept that branch anyway
        // rather than deleting a safety refusal for being temporarily inert.
        // Keeping dead code is only defensible if something announces the
        // moment it stops being dead. This is that something.
        //
        // DERIVED FROM LADDER, never a literal list, and that is the whole
        // design. The adjacent test in identity-write-ladder.test.ts asserts
        // `permitted` equals the three rungs by name — which a rung added ABOVE
        // AUTOMATIC satisfies unchanged, because the new rung is simply not in
        // the permitted set. It passes while the thing it is watching happens.
        // Filtering for what IS above the clamp has no such blind spot: the
        // moment LADDER grows past LEAVER_MAX_MODE, or LEAVER_MAX_MODE is
        // narrowed beneath LADDER's top, this list is non-empty and goes red.
        //
        // When it does go red, that is not a broken test. It means the clamp
        // branch in `runIdentityLeaverPass` is live again — go read the note on
        // it, and check the refusal text below is still the sentence you want
        // an operator to find mid-incident.
        // POSITIVE CONTROL FIRST. The assertion below passes when the selection
        // is empty, and an empty LADDER would satisfy it vacuously — the exact
        // shape this file applies a counterweight to one screen down
        // (`detail.length` guarding a stack of negatives). Applying it there and
        // not here was an oversight, not a distinction.
        expect(LADDER.length).toBeGreaterThan(0);
        expect(LADDER.filter((m) => isAboveClamp(m, LEAVER_MAX_MODE))).toEqual([]);
    });

    describe('the refusal text nobody can reach today', () => {
        // `clampRefusalDetail` is lifted out of the branch precisely so it can
        // be called here. The branch cannot be entered — an invented
        // out-of-ladder mode does not work either, because `isAboveClamp` sorts
        // an unknown value to -1 and reads it as BELOW the clamp — so the
        // string had no reader at all, and went on telling operators that "no
        // tenant has yet watched a single pass" after one had watched one.
        //
        // Called with the clamp LOWERED to DRY_RUN: the incident rollback that
        // wakes this branch up. That is not a hypothetical shape invented for a
        // test. LEAVER_MAX_MODE is a source constant specifically so it can be
        // narrowed in a reviewed diff when a pass misbehaves, and the operator
        // reading this sentence is doing so in the minutes after that ships.
        const LOWERED = 'DRY_RUN';
        const detail = clampRefusalDetail('AUTOMATIC', LOWERED);

        it('names both the configured mode and the clamp, and no other rung', () => {
            // Neither value alone is actionable. "You are clamped" without both
            // rungs leaves the operator unable to tell whether to change a
            // setting or escalate for a deploy, which is the only decision this
            // message exists to inform.
            expect(detail).toContain('AUTOMATIC');
            expect(detail).toContain(LOWERED);

            // A rung it was not handed must not appear — that is the signature
            // of a hardcoded value surviving inside a function whose whole
            // contract is to report what it was given. Derived from LADDER so a
            // retired or added rung updates the check rather than dating it.
            for (const rung of LADDER.filter((m) => m !== 'AUTOMATIC' && m !== LOWERED)) {
                expect(detail).not.toContain(rung);
            }
        });

        it('says the clamp is a constant, and that this refusal records no row', () => {
            // The two facts that change what the operator does next.
            //
            // "Source constant" is the difference between a fix in the admin UI
            // and a fix that needs review and a deploy; guessing wrong costs
            // them the incident.
            expect(detail).toMatch(/source constant/i);
            expect(detail).toMatch(/not a tenant setting/i);

            // And this is one of only two refusals that write no
            // IntegrationExecution row, so the passes page stays empty. An
            // operator who does not know that goes hunting for a dead worker.
            // The asymmetry is documented in CLAUDE.md and it is the single
            // most misreadable property of this subsystem.
            expect(detail).toMatch(/IntegrationExecution/);
            expect(detail).toContain('/admin/identity-leaver-passes');
        });

        it('asserts nothing about the state of the world', () => {
            // THE ROT THIS SWEEP EXISTS TO PREVENT, checked as a claim SHAPE
            // rather than as a truth — a test cannot know whether a sentence is
            // true, and one that greps for today's wording just dates itself
            // alongside the wording (the lesson in CLAUDE.md's "never gate CI
            // on prose", and the same reasoning as
            // tests/guards/scheduled-job-description-claims.test.ts).
            //
            // What IS decidable: a string baked into a build at compile time
            // cannot know how many tenants have run a pass, or whether one ever
            // has. Any such clause is wrong on a long enough timeline and this
            // one proved it — it claimed "no tenant has yet watched a single
            // pass" while an account sat disabled in a customer's directory.
            // The detail may describe THIS refusal, and nothing beyond it.
            // WHAT THIS IS, STATED HONESTLY: a blocklist of the wording the old
            // sentence used. An earlier version of this comment called it a
            // "claim SHAPE rather than a truth" and compared it to
            // scheduled-job-description-claims.test.ts. That comparison does not
            // hold and the claim was false: THAT guard derives its rung alphabet
            // from LADDER and matches clamp-wording adjacent to a rung, which is
            // structural. This is a literal grep for yesterday's sentence.
            //
            // Adversarial review proved the gap by appending a NEW false clause
            // ("Only three tenants have ever reached this rung, and the subsystem
            // remains unproven against a live directory.") — 58/58 stayed green.
            // A fresh instance of the exact rot this PR exists to remove, waved
            // through by the guard named after removing it.
            //
            // It is kept because a blocklist of the KNOWN-bad phrasing still
            // stops the specific regression — reinstating the deleted sentence —
            // and that is worth something. What it must not do is claim to be
            // more. The general problem (a build-time string asserting facts
            // about the world) is not decidable by a regex, and the durable
            // defence is the structural one below: the detail may describe THIS
            // refusal and must name the two modes it compares, so a sentence
            // that wanders into world-claims has nowhere to attach.
            expect(detail).not.toMatch(/no tenant|nobody|never been|has yet|not yet|first (real |live )?(pass|disable|time)|in the field/i);
            // The structural half already exists and is the durable defence:
            // 'names both the configured mode and the clamp, and no other rung'
            // above asserts the detail contains exactly the two rungs it was
            // handed, with the negative derived from LADDER. That is what keeps
            // the sentence a description of THIS refusal; this blocklist only
            // stops the one deleted sentence coming back.

            // Positive counterweight — an empty string satisfies every negative
            // above, and a message that says nothing is its own failure here.
            expect(detail.length).toBeGreaterThan(120);
        });
    });

    it('DISABLED is still refused, and still records nothing', () => {
        // The clamp moved; the floor did not. A tenant that never switched this
        // on is not in an observation window and a nightly row would imply it
        // was being watched.
        expect(LADDER.indexOf('DISABLED')).toBe(0);
    });
});

describe('who the feed says has left', () => {
    it('reads only workers explicitly marked TERMINATED — never inferred from absence', async () => {
        await run();
        expect(mockDb.employee.findMany.mock.calls[0][0].where).toMatchObject({
            tenantId: 't1',
            status: 'TERMINATED',
        });
    });

    it('stops before touching the directory when nobody has left', async () => {
        mockDb.employee.findMany.mockResolvedValue([]);

        const r = await run();

        expect(r.refusal).toBe('NO_TERMINATED_WORKERS');
        expect(findCandidates).not.toHaveBeenCalled();
        expect(resolveWriter).not.toHaveBeenCalled();
    });
});

describe('link freshness is the completeness gate', () => {
    it('demands links re-observed within the freshness window', async () => {
        await run();
        const staleBefore = findCandidates.mock.calls[0][3] as Date;
        expect(staleBefore.getTime()).toBe(NOW.getTime() - LINK_FRESHNESS_MS);
    });

    it('is the SAME band the write-target rail applies', () => {
        // Two bounds over one question — did the daily sync refresh this row
        // recently enough — and they must not drift. `LINK_FRESHNESS_MS` is
        // written as an alias, so this is cheap; what it defends is somebody
        // later "inlining" it back to a literal. Divergence is silent and
        // asymmetric: a pass would accept a link one bound calls fresh, then
        // refuse it at the rail, having already done the work.
        expect(LINK_FRESHNESS_MS).toBe(OBSERVATION_FRESHNESS_MS);
    });

    it('survives one missed nightly sync — the reason it is two days, not one', () => {
        // THE VALUE, not just the comparison. Nothing else pins it: the
        // assertion above derives its expectation from the same constant, so
        // setting the bound to 1 ms leaves this whole file green while every
        // pass refuses NO_FRESH_LINKS — a product that has silently stopped
        // offboarding, reported as a clean run.
        //
        // Expressed as the domain claim rather than as `toBe(172800000)`,
        // because the literal would only restate the source. `identity-sync`
        // is dispatched daily, so a bound at or below one day turns a single
        // missed run into an empty candidate set, and "we disabled nobody"
        // looks exactly like "nobody left".
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        expect(LINK_FRESHNESS_MS).toBeGreaterThan(ONE_DAY_MS);
    });

    it('reports "no fresh links" as its OWN refusal, not as a quiet success', async () => {
        // Terminated workers present but no actable link means the link table is
        // stale or empty. Reporting PASSED here is precisely how an offboarding
        // that disables nobody comes to look like one that works.
        findCandidates.mockResolvedValue([]);

        const r = await run();

        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'NO_FRESH_LINKS', terminatedWorkers: 2 });
        expect(r.detail).toMatch(/terminated worker/i);
        expect(disableBatch).not.toHaveBeenCalled();
    });
});

describe('the batch', () => {
    it('measures the blast radius against the observed account population', async () => {
        await run();
        expect(disableBatch.mock.calls[0][2]).toMatchObject({ population: 400 });
    });

    it('hands the batch every candidate, WITH the state the breaker counts', async () => {
        // The counterpart to the population assertion above, and the other half
        // of the fraction. This file mocks both `findLeaverCandidates` and
        // `disableAccountsForLeaver`, so it can never compose a numerator — its
        // job is to prove the SEAM carries what the numerator is made from.
        //
        // Two claims at once, and #2290 needs both:
        //   • `lastObservedEnabled` survives the hop. Without it every candidate
        //     reads as unknown, the numerator falls back to counting rows, and
        //     the breaker latches shut at the sixth cumulative leaver.
        //   • the already-disabled candidate is still HANDED OVER. It must stay
        //     in the batch — its `!state.enabled` decision is what settles a
        //     stranded INDETERMINATE journal row — so the fix belongs in the
        //     count, never in the list.
        const live = {
            linkId: 'l1',
            externalUserId: 'x1',
            onPremisesSyncEnabled: false,
            lastObservedEnabled: true,
        };
        const alreadyOff = {
            linkId: 'l2',
            externalUserId: 'x2',
            onPremisesSyncEnabled: false,
            lastObservedEnabled: false,
        };
        findCandidates.mockResolvedValue([live, alreadyOff]);
        disableBatch.mockResolvedValue({
            results: [
                { outcome: 'DRY_RUN', linkId: 'l1' },
                { outcome: 'ALREADY_DISABLED', linkId: 'l2' },
            ],
        });

        const r = await run();

        expect(r.status).toBe('PASSED');
        // toEqual, not toMatchObject: an omitted `lastObservedEnabled` is
        // `undefined`, and toMatchObject would ignore it — which is exactly the
        // silent drop this asserts against.
        expect(disableBatch.mock.calls[0][2].candidates).toEqual([live, alreadyOff]);
    });

    it('tallies the outcomes it got back', async () => {
        disableBatch.mockResolvedValue({
            results: [{ outcome: 'DRY_RUN' }, { outcome: 'DRY_RUN' }, { outcome: 'REFUSED_TARGET' }],
        });

        const r = await run();

        expect(r.status).toBe('PASSED');
        expect(r.counts).toEqual({ DRY_RUN: 2, REFUSED_TARGET: 1 });
    });

    it('carries a breaker refusal through instead of reporting a clean run', async () => {
        disableBatch.mockResolvedValue({ refused: '200 of 400 is a broken feed', results: [] });

        const r = await run();

        expect(r.batchRefused).toMatch(/broken feed/);
        expect(passMetric).toHaveBeenCalledWith({ provider: 'entra-id', outcome: 'batch_refused' });
    });

    it('records the refusal as a refusal — in the RETURN and in the ROW', async () => {
        // The gap this closes. `batchRefused` was carried through and the metric
        // fired, but the recorded status stayed PASSED — which the passes page
        // renders as "Ran — complete" beside an empty Refusal cell and a
        // decision count of 0. The one outcome meaning "the pass deliberately
        // did nothing because the blast radius looked wrong" read as a clean
        // night, and the two assertions above are both green against that.
        disableBatch.mockResolvedValue({
            refused: 'Refusing to disable 6 of 10 account(s) (60.0%)',
            results: [],
        });

        const r = await run();

        expect(r.status).toBe('NOT_APPLICABLE');
        expect(r.refusal).toBe('BATCH_REFUSED');

        const data = mockDb.integrationExecution.create.mock.calls.at(-1)?.[0].data;
        expect(data.status).toBe('NOT_APPLICABLE');
        expect(data.resultJson.refusal).toBe('BATCH_REFUSED');

        // Positive controls: the row was actually written, and the operator can
        // still read WHY — the sentence and the empty decision list are what
        // make "wanted 6 of 10" legible rather than merely refused.
        expect(mockDb.integrationExecution.create).toHaveBeenCalledTimes(1);
        expect(data.resultJson.batchRefused).toMatch(/60\.0%/);
        expect(data.resultJson.decisions).toEqual([]);
    });

    it('a normal pass is still PASSED, and carries no refusal', async () => {
        // The other direction, so the change above cannot be satisfied by
        // marking every pass NOT_APPLICABLE.
        const r = await run();

        expect(r.status).toBe('PASSED');
        expect(r.refusal).toBeUndefined();
        const data = mockDb.integrationExecution.create.mock.calls.at(-1)?.[0].data;
        expect(data.status).toBe('PASSED');
        expect(data.resultJson.refusal).toBeUndefined();
    });
});

describe('disposal', () => {
    it('closes the writer on the happy path', async () => {
        await run();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('closes the writer even when the batch throws', async () => {
        // The AD writer holds an LDAP socket. A leaked bind outlives the process
        // that made it, so the finally is unconditional.
        disableBatch.mockRejectedValue(new Error('directory went away'));

        const r = await run();

        expect(r.status).toBe('ERROR');
        expect(close).toHaveBeenCalledTimes(1);
    });
});

describe('it never throws', () => {
    it('reports an unexpected failure as ERROR rather than ending the fan-out', async () => {
        getPolicy.mockRejectedValue(new Error('settings read failed'));

        const r = await run();

        expect(r).toMatchObject({ status: 'ERROR', errorMessage: 'settings read failed' });
        expect(passMetric).toHaveBeenCalledWith({ provider: 'entra-id', outcome: 'error' });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // A pass that THREW still ran (#2297)
    //
    // The catch logged, emitted its metric and returned. The metric is
    // aggregate and the log line lands outside the tenant boundary, so
    // /admin/identity-leaver-passes showed precisely what a tenant with a dead
    // worker shows: nothing at all. A crashed pass and a pass that never fired
    // were the same artefact — the ambiguity `recordRefusedPass` exists to
    // close, left open one rung further down, and the one thing the first
    // AUTOMATIC proving run is built to rule out.
    // ─────────────────────────────────────────────────────────────────────────
    it('records the crash as an ERROR row, so it cannot read as a pass that never ran', async () => {
        getPolicy.mockRejectedValue(new Error('settings read failed'));

        // Resolves rather than rejecting — the contract the fan-out relies on,
        // asserted directly because the new write sits on that path.
        await expect(run()).resolves.toMatchObject({ status: 'ERROR' });

        expect(mockDb.integrationExecution.create).toHaveBeenCalledTimes(1);
        const data = mockDb.integrationExecution.create.mock.calls[0][0].data;
        expect(data.status).toBe('ERROR');
        // Same automationKey as every other pass row, or the passes page — which
        // reads by suffix — would not find it, and the row would exist while the
        // page still showed the absence.
        expect(data.automationKey).toBe('entra-id.leaver_pass');
        expect(data.resultJson.detail).toBe('settings read failed');
        // No rung was established: the throw came out of the policy read itself.
        expect(data.resultJson.mode).toBe('unknown');
        // A crash is not a refusal, and the Refusal column must not imply the
        // pass decided anything.
        expect(data.resultJson.refusal).toBeNull();
    });

    it('SCRUBS the thrown message — resultJson is not encrypted at rest', async () => {
        // The redaction is the load-bearing half of this fix. A provider error
        // routinely embeds the account it was about, and IntegrationExecution
        // rows outlive the pass in a column the Epic B manifest cannot cover —
        // which is why the decision reasons beside them are scrubbed and keyed
        // by link id. Persisting a raw Graph message here would put back exactly
        // what that keying takes out.
        getPolicy.mockRejectedValue(
            new Error('Graph: user bob.jones@acme.com (id 8f14e45f-ceea-467a-9f8b-9c1f2d3e4a5b) could not be read'),
        );

        await run();

        const detail = mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson
            .detail as string;
        expect(detail).not.toMatch(/bob\.jones@acme\.com/);
        expect(detail).not.toMatch(/8f14e45f/i);
        // Paired positive: it was scrubbed, not emptied — an operator still has
        // a diagnosable sentence.
        expect(detail).toContain('{account}');
        expect(detail).toMatch(/Graph:/);
    });

    it('a row that cannot be written does not turn the catch into a throw', async () => {
        // Same posture as `safeRecordRefusal`: a pass that has already failed
        // must not fail differently because its record could not be stored. The
        // fan-out is over tenants, and this one runs inside a catch.
        getPolicy.mockRejectedValue(new Error('settings read failed'));
        mockDb.integrationExecution.create.mockRejectedValue(new Error('pool exhausted'));

        const r = await run();

        expect(r).toMatchObject({ status: 'ERROR', errorMessage: 'settings read failed' });
        expect(logger.error).toHaveBeenCalledWith(
            'leaver pass threw and its record could not be written either',
            expect.objectContaining({ error: 'pool exhausted' }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The unsettled-write backlog (#2291)
//
// `listUnsettledWrites` shipped with NO caller, so a row stranded by a worker
// killed mid-batch stayed PENDING for ever and `identity.write.unsettled` —
// whose docblock says ALERT ON — could never be emitted, its only call site
// being inside the function nobody called.
// ─────────────────────────────────────────────────────────────────────────────
describe('the backlog of writes nobody confirmed', () => {
    it('is read on every pass, INCLUDING the ladder refusal that writes no row', async () => {
        // The tenant narrowed back to DISABLED after an incident is exactly when
        // rows strand and exactly when nothing else looks: this refusal returns
        // before any IntegrationExecution row is written.
        getPolicy.mockResolvedValue({ leaver: { mode: 'DISABLED' }, joiner: { mode: 'DISABLED' } });

        const r = await runIdentityLeaverPass({ tenantId: 't1', provider: 'entra-id', now: NOW });

        expect(r.refusal).toBe('MODE_DISABLED');
        expect(mockDb.integrationExecution.create).not.toHaveBeenCalled();
        expect(mockDb.identityWriteJournal.findMany).toHaveBeenCalledTimes(1);
    });

    it('scopes the read to this provider, so a two-provider tenant is not counted twice', async () => {
        // The dispatcher fans out one job per (tenant, provider) and the
        // counter's only label is the tenant.
        await runIdentityLeaverPass({ tenantId: 't1', provider: 'entra-id', now: NOW });
        const where = mockDb.identityWriteJournal.findMany.mock.calls[0][0].where;
        expect(where.provider).toBe('entra-id');
        expect(where.outcome).toEqual({ in: ['PENDING', 'INDETERMINATE'] });
    });

    it('never selects a directory identifier or the encrypted detail', async () => {
        // The count is persisted into IntegrationExecution.resultJson, which is
        // NOT encrypted at rest. Leaving the columns unselected makes that
        // structural rather than a matter of the caller remembering.
        await runIdentityLeaverPass({ tenantId: 't1', provider: 'entra-id', now: NOW });
        const select = mockDb.identityWriteJournal.findMany.mock.calls[0][0].select;
        expect(select.externalUserId).toBeUndefined();
        expect(select.detail).toBeUndefined();
        expect(select.linkId).toBe(true);
    });

    it('reports the count on the pass record', async () => {
        mockDb.identityWriteJournal.findMany.mockResolvedValue([
            { id: 'j1', linkId: 'l9', outcome: 'PENDING' },
            { id: 'j2', linkId: 'l8', outcome: 'INDETERMINATE' },
        ]);
        await runIdentityLeaverPass({ tenantId: 't1', provider: 'entra-id', now: NOW });
        const row = mockDb.integrationExecution.create.mock.calls[0][0].data;
        expect(row.resultJson.unsettledOnEntry).toBe(2);
    });

    it('a failed read reports null, not zero, and does not fail the pass', async () => {
        // "The read failed" and "the backlog is clear" are different facts and
        // only one of them needs a human.
        mockDb.identityWriteJournal.findMany.mockRejectedValue(new Error('pool exhausted'));

        const r = await runIdentityLeaverPass({ tenantId: 't1', provider: 'entra-id', now: NOW });

        expect(r.status).not.toBe('ERROR');
        const row = mockDb.integrationExecution.create.mock.calls[0][0].data;
        expect(row.resultJson.unsettledOnEntry).toBeNull();
    });
});

describe('a candidate whose connection was soft-disabled (#2419)', () => {
    // ═══ THE WINDOW ═══
    //
    // `resolveDirectoryWriter` refuses AMBIGUOUS_CONNECTION only while TWO
    // connections for a provider are ENABLED. `removeIntegrationConnection`
    // soft-disables, so taking one out drops the count to one and the refusal
    // stops applying — while the rows that connection observed stay present,
    // stay linked (the link reconcile is provider-scoped, so a surviving
    // connection keeps re-stamping them) and stay inside their observation
    // window. Only their `onPremStateObservedAt` freezes, so the age bound
    // catches them two days later. Until then a pass evaluated them against a
    // writer bound to a DIFFERENT connection.

    /** Say which of the pass's candidates sit on a still-enabled connection. */
    function connectionsEnabled(byLinkId: Record<string, boolean>): void {
        mockDb.identityAccountLink.findMany.mockImplementation(
            async (args: { where?: { id?: { in?: string[] } } }) =>
                (args.where?.id?.in ?? [])
                    .filter((id) => id in byLinkId)
                    .map((id) => ({
                        id,
                        connectedAccount: { connection: { isEnabled: byLinkId[id] } },
                    })),
        );
    }

    const live = { linkId: 'l1', externalUserId: 'x1', onPremisesSyncEnabled: false };
    const stranded = { linkId: 'l2', externalUserId: 'x2', onPremisesSyncEnabled: false };

    it('keeps the stranded candidate OUT of the batch and leaves the live one in', async () => {
        findCandidates.mockResolvedValue([live, stranded]);
        connectionsEnabled({ l1: true, l2: false });
        disableBatch.mockResolvedValue({ results: [{ outcome: 'DRY_RUN', linkId: 'l1' }] });

        await run();

        // toEqual, not a length check: the candidate that survives must be the
        // LIVE one. A filter that kept the wrong row would pass a count.
        expect(disableBatch.mock.calls[0][2].candidates).toEqual([live]);
    });

    it('refuses it by NAME, with the connection basis on the record', async () => {
        // Not a silent skip. A dropped candidate would leave the operator with
        // a pass that offboarded fewer people than it had candidates and
        // nothing on the row saying why — the silent-nothing failure again.
        findCandidates.mockResolvedValue([live, stranded]);
        connectionsEnabled({ l1: true, l2: false });
        disableBatch.mockResolvedValue({ results: [{ outcome: 'DRY_RUN', linkId: 'l1' }] });

        const r = await run();

        expect(r.status).toBe('PASSED');
        expect(r.counts).toEqual({ REFUSED_TARGET: 1, DRY_RUN: 1 });
        // Still counted as a candidate: it WAS one, and the report must not
        // show fewer people than the pass looked at.
        expect(r.candidates).toBe(2);

        const decisions = mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson
            .decisions as Array<Record<string, unknown>>;
        const refusal = decisions.find((d) => d.linkId === 'l2');
        expect(refusal).toMatchObject({
            outcome: 'REFUSED_TARGET',
            basis: { rule: 'CONNECTION_DISABLED', onPremisesSyncEnabled: false },
        });
        expect(String(refusal?.reason)).toMatch(/no longer enabled/i);
        // Paired positive: the live candidate's own decision is still there, so
        // the refusal above is about one row and not about a dead pass.
        expect(decisions.find((d) => d.linkId === 'l1')).toMatchObject({ outcome: 'DRY_RUN' });
    });

    it('a candidate on an ENABLED connection is untouched — the other direction', async () => {
        // Without this the refusal above is satisfied by a pass that refuses
        // everything, which is the failure this rail must not become.
        findCandidates.mockResolvedValue([live, stranded]);
        connectionsEnabled({ l1: true, l2: true });
        disableBatch.mockResolvedValue({
            results: [
                { outcome: 'DRY_RUN', linkId: 'l1' },
                { outcome: 'DRY_RUN', linkId: 'l2' },
            ],
        });

        const r = await run();

        expect(disableBatch.mock.calls[0][2].candidates).toEqual([live, stranded]);
        expect(r.counts).toEqual({ DRY_RUN: 2 });
    });

    it('refuses regardless of how FRESH the observation is', async () => {
        // The age bound is not the question. `OBSERVATION_STALE` would catch
        // this row eventually; the point of the new basis is that "eventually"
        // is up to OBSERVATION_FRESHNESS_MS away, and the connection is off NOW.
        const freshlyObserved = {
            ...stranded,
            onPremStateObservedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        };
        findCandidates.mockResolvedValue([freshlyObserved]);
        connectionsEnabled({ l2: false });
        disableBatch.mockResolvedValue({ results: [] });

        const r = await run();

        expect(r.counts).toEqual({ REFUSED_TARGET: 1 });
        const decisions = mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson
            .decisions as Array<Record<string, unknown>>;
        expect(decisions[0]).toMatchObject({
            basis: {
                rule: 'CONNECTION_DISABLED',
                observedAt: freshlyObserved.onPremStateObservedAt.toISOString(),
            },
        });
        // And the batch was handed nothing at all, rather than the row.
        expect(disableBatch.mock.calls[0][2].candidates).toEqual([]);
    });

    it('a link the lookup does not return at all is stranded, not actionable', async () => {
        // FAILS CLOSED. "We could not confirm the connection" and "the
        // connection is fine" are the two answers this subsystem must never
        // collapse — a row deleted between the two reads, or hidden by
        // row-level security, must not read as permission to write.
        findCandidates.mockResolvedValue([live]);
        connectionsEnabled({});
        // The batch is handed nothing, so it decides nothing. Stated rather
        // than inherited from the default mock, which answers for `l1`
        // regardless of what it was given.
        disableBatch.mockResolvedValue({ results: [] });

        const r = await run();

        expect(r.counts).toEqual({ REFUSED_TARGET: 1 });
        expect(disableBatch.mock.calls[0][2].candidates).toEqual([]);
    });

    it('a lookup that THROWS stops the pass rather than writing, and still closes the writer', async () => {
        // The read gates a write, so its failure must not degrade to "carry on".
        // The pass's own catch records an ERROR row, which is visible, and
        // nothing reaches the directory.
        //
        // The close is the other half, and it is why this read sits INSIDE the
        // try rather than above it: the AD arm holds an LDAP bind, and a leaked
        // bind outlives the process that made it.
        findCandidates.mockResolvedValue([live]);
        mockDb.identityAccountLink.findMany.mockRejectedValue(new Error('pool exhausted'));

        const r = await run();

        expect(r.status).toBe('ERROR');
        expect(disableBatch).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('is not consulted at all when no writer could be resolved', async () => {
        // Placement, pinned. Every refusal this rail builds is counted on the
        // write-outcome metric and reported in the row, so it must not run on a
        // path that returns before recording any decision — WRITER_NO_CONNECTION
        // being the reachable one, and exactly the shape a tenant whose ONLY
        // connection was soft-disabled produces.
        findCandidates.mockResolvedValue([live, stranded]);
        connectionsEnabled({ l1: true, l2: false });
        resolveWriter.mockResolvedValue({
            kind: 'none',
            refusal: 'NO_CONNECTION',
            detail: 'No enabled entra-id connection for this tenant.',
        });

        const r = await run();

        expect(r.refusal).toBe('WRITER_NO_CONNECTION');
        expect(mockDb.identityAccountLink.findMany).not.toHaveBeenCalled();
    });

    it('asks about exactly the candidates it holds, tenant-scoped and bounded', async () => {
        findCandidates.mockResolvedValue([live, stranded]);

        await run();

        const args = mockDb.identityAccountLink.findMany.mock.calls[0][0];
        expect(args.where).toMatchObject({ tenantId: 't1', id: { in: ['l1', 'l2'] } });
        expect(args.take).toBe(2);
    });
});
