/**
 * The audit workpaper CONTRACT (#3675), pure: what `recordAuditWorkpaper`
 * accepts before it reads anything. The database CHECKs and triggers hold the
 * same shapes for any other writer — `tests/integration/audit-workpaper.test.ts`
 * proves those.
 */
import {
    isEpochOf,
    periodBounds,
    periodHasEnded,
    populationDigest,
    RecordAuditWorkpaperSchema,
    sampleEpochFor,
    sampleMatchesBinding,
} from '@/lib/agentic/audit-workpaper';

const HEX = 'a'.repeat(64);

function workpaper(overrides: Record<string, unknown> = {}) {
    return {
        procedureId: 'iam.leaver_timeliness',
        catalogueVersion: 1,
        periodLabel: '2026-09',
        populationDefinition: 'Employee rows with status TERMINATED and endDate inside the period',
        populationCount: 3,
        populationDigest: HEX,
        sample: {
            epoch: 'iam.leaver_timeliness@2026-09',
            seedFingerprint: HEX,
            sampledUnitIds: ['emp_1', 'emp_2'],
        },
        attributesTested: ['L1', 'L2', 'L3'],
        itemOutcomes: [
            { unitId: 'emp_1', outcome: 'PASS', code: null },
            { unitId: 'emp_2', outcome: 'PASS', code: null },
        ],
        exceptions: [],
        conclusion: 'PASS',
        conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
        evidenceRefs: [],
        proposalIds: [],
        auditorAgentId: 'agent_auditor',
        controlTestRunId: 'run_1',
        ...overrides,
    };
}

const parse = (o: Record<string, unknown> = {}) => RecordAuditWorkpaperSchema.safeParse(workpaper(o));

describe('RecordAuditWorkpaperSchema — codes, identifiers and counts', () => {
    it('accepts a well-formed PASS', () => {
        expect(parse().success).toBe(true);
    });

    it('refuses an unknown procedure id and a future catalogue version', () => {
        expect(parse({ procedureId: 'iam.made_up' }).success).toBe(false);
        expect(parse({ catalogueVersion: 3 }).success).toBe(false);
        expect(parse({ catalogueVersion: 0 }).success).toBe(false);
    });

    it('takes a workpaper of the version in force, 2, and still one of version 1', () => {
        // Version 1 workpapers are write-once rows a reader keeps meeting; the
        // contract reads them as they are, version and all.
        expect(parse({ catalogueVersion: 2 }).success).toBe(true);
        const v1 = RecordAuditWorkpaperSchema.safeParse(workpaper({ catalogueVersion: 1 }));
        expect(v1.success && v1.data.catalogueVersion).toBe(1);
    });

    it.each(['2026-13', '2026-Q5', '26-09', '2026-9', '2026-09-01'])('refuses period label %s', (periodLabel) => {
        expect(parse({ periodLabel }).success).toBe(false);
    });

    it('refuses a unit id that could carry an e-mail address or a name', () => {
        for (const unitId of ['jane.doe@example.com', 'Jane Doe', 'a.b']) {
            expect(
                parse({
                    sample: { epoch: 'iam.leaver_timeliness@2026-09', seedFingerprint: HEX, sampledUnitIds: [unitId] },
                    itemOutcomes: [{ unitId, outcome: 'PASS', code: null }],
                }).success,
            ).toBe(false);
        }
    });

    it('refuses a basis or exception that is prose rather than a code', () => {
        expect(parse({ conclusionBasis: 'all good' }).success).toBe(false);
        expect(
            parse({
                conclusion: 'FAIL',
                exceptions: [{ unitId: 'emp_1', code: 'account was still active' }],
            }).success,
        ).toBe(false);
    });

    it('refuses an undeclared key — a workpaper cannot quietly drop what it was sent', () => {
        expect(parse({ summary: 'free text' }).success).toBe(false);
        expect(parse({ reviewedAt: new Date().toISOString() }).success).toBe(false);
    });
});

describe('zero is never complete', () => {
    it('an empty population can never PASS', () => {
        expect(parse({ populationCount: 0, sample: null, itemOutcomes: [] }).success).toBe(false);
    });

    it('a PASS needs a drawn sample', () => {
        expect(parse({ sample: null, itemOutcomes: [] }).success).toBe(false);
    });

    it('a PASS needs an outcome for every sampled unit (tested === sampleSize)', () => {
        expect(parse({ itemOutcomes: [{ unitId: 'emp_1', outcome: 'PASS', code: null }] }).success).toBe(false);
    });

    it('a PASS cannot carry an exception or an untestable unit', () => {
        expect(parse({ exceptions: [{ unitId: 'emp_1', code: 'LEAVER_ACCOUNT_ACTIVE' }] }).success).toBe(false);
        expect(
            parse({
                itemOutcomes: [
                    { unitId: 'emp_1', outcome: 'PASS', code: null },
                    { unitId: 'emp_2', outcome: 'UNTESTABLE', code: 'DISABLE_TIME_UNKNOWN' },
                ],
            }).success,
        ).toBe(false);
    });

    it('a FAIL names at least one exception', () => {
        expect(parse({ conclusion: 'FAIL', conclusionBasis: 'EXCEPTIONS_FOUND' }).success).toBe(false);
        expect(
            parse({
                conclusion: 'FAIL',
                conclusionBasis: 'EXCEPTIONS_FOUND',
                exceptions: [{ unitId: null, code: 'LEAVER_ACCOUNT_ACTIVE_UNDATED' }],
            }).success,
        ).toBe(true);
    });

    it('an INCONCLUSIVE with no sample is a legal record of a precondition', () => {
        expect(
            parse({
                populationCount: 0,
                sample: null,
                itemOutcomes: [],
                conclusion: 'INCONCLUSIVE',
                conclusionBasis: 'EMPTY_POPULATION',
            }).success,
        ).toBe(true);
    });
});

describe('the sample', () => {
    it('the epoch is fixed by the period, never by the run', () => {
        expect(
            parse({
                sample: { epoch: 'iam.leaver_timeliness@2026-10', seedFingerprint: HEX, sampledUnitIds: ['emp_1', 'emp_2'] },
            }).success,
        ).toBe(false);
        expect(isEpochOf('iam.leaver_timeliness@2026-09/accounts', 'iam.leaver_timeliness', '2026-09')).toBe(true);
        expect(isEpochOf('iam.leaver_timeliness@2026-09/', 'iam.leaver_timeliness', '2026-09')).toBe(false);
        expect(sampleEpochFor('iam.privileged_access', '2026-Q3')).toBe('iam.privileged_access@2026-Q3');
    });

    it('is never larger than its population, and samples a unit once', () => {
        expect(parse({ populationCount: 1 }).success).toBe(false);
        expect(
            parse({
                sample: { epoch: 'iam.leaver_timeliness@2026-09', seedFingerprint: HEX, sampledUnitIds: ['emp_1', 'emp_1'] },
            }).success,
        ).toBe(false);
    });

    it('outcomes are only for sampled units', () => {
        expect(
            parse({
                itemOutcomes: [
                    { unitId: 'emp_1', outcome: 'PASS', code: null },
                    { unitId: 'emp_9', outcome: 'PASS', code: null },
                ],
            }).success,
        ).toBe(false);
    });

    it('a later sample matches the binding one only when epoch, fingerprint and ids agree, in order', () => {
        const binding = { sampleEpoch: 'p@2026-09', seedFingerprint: HEX, sampledUnitIds: ['a', 'b'] };
        expect(sampleMatchesBinding({ epoch: 'p@2026-09', seedFingerprint: HEX, sampledUnitIds: ['a', 'b'] }, binding)).toBe(true);
        expect(sampleMatchesBinding({ epoch: 'p@2026-09', seedFingerprint: HEX, sampledUnitIds: ['b', 'a'] }, binding)).toBe(false);
        expect(sampleMatchesBinding({ epoch: 'p@2026-09', seedFingerprint: 'b'.repeat(64), sampledUnitIds: ['a', 'b'] }, binding)).toBe(false);
        expect(sampleMatchesBinding({ epoch: 'p@2026-09', seedFingerprint: HEX, sampledUnitIds: ['a'] }, binding)).toBe(false);
    });
});

describe('periods and the population digest', () => {
    it('bounds a month and a quarter in UTC, end exclusive', () => {
        expect(periodBounds('2026-12')).toEqual({
            start: new Date('2026-12-01T00:00:00.000Z'),
            end: new Date('2027-01-01T00:00:00.000Z'),
        });
        expect(periodBounds('2027-Q1')).toEqual({
            start: new Date('2027-01-01T00:00:00.000Z'),
            end: new Date('2027-04-01T00:00:00.000Z'),
        });
    });

    it('a period has ended only at its exclusive end', () => {
        expect(periodHasEnded('2026-09', new Date('2026-09-30T23:59:59.999Z'))).toBe(false);
        expect(periodHasEnded('2026-09', new Date('2026-10-01T00:00:00.000Z'))).toBe(true);
    });

    it('the digest sorts the ids itself, so the order a caller hands them over in cannot move it', () => {
        const a = populationDigest('iam.leaver_timeliness', '2026-09', ['b', 'a', 'c']);
        const b = populationDigest('iam.leaver_timeliness', '2026-09', ['c', 'b', 'a']);
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(populationDigest('iam.leaver_timeliness', '2026-10', ['a', 'b', 'c'])).not.toBe(a);
    });
});
