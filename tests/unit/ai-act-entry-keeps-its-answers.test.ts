/**
 * THE REGISTER KEEPS THE ANSWERS, NOT ONLY THE VERDICT.
 *
 * `AiSystem` recorded the tier, the clause and a generated rationale, and
 * discarded the four answers they were derived from. The consequence is the
 * pair of states this file exists to separate — and the last test is the one
 * that shows why it matters: an entry authored with NO questionnaire and an
 * entry authored with an explicit "no triggers apply" produce a BYTE-IDENTICAL
 * verdict (MINIMAL / Art.95, rationale "no prohibited practice, high-risk
 * use-case, or transparency trigger identified"). Only the stored answers tell
 * an auditor which one happened.
 *
 * Found on 2026-09-24 registering the first real agent in production: the
 * entry was authored with `classification: {}` and the row asserted an
 * assessment whose evidence had never been kept.
 *
 * ── THE DISTINCTION LIVES IN THE KEYS ───────────────────────────────────────
 *
 * `ClassificationAnswersSchema` carries `.default({})`, so an ABSENT
 * questionnaire reaches the usecase as `{}` while an explicit "none apply"
 * reaches it as four PRESENT keys holding nulls. Deciding on "are the values
 * empty?" would collapse the two again, which is why the usecase keys on
 * `Object.keys(...).length` and this file asserts that shape rather than the
 * values.
 */
const create = jest.fn(async (_db: unknown, _ctx: unknown, data: Record<string, unknown>) => {
    captured = data;
    return { id: 'ais_1', riskTier: data.riskTier, classificationClauseId: data.classificationClauseId };
});
let captured: Record<string, unknown> = {};

jest.mock('@/app-layer/repositories/AiSystemRepository', () => ({
    AiSystemRepository: {
        create: (...a: unknown[]) => create(...(a as [unknown, unknown, Record<string, unknown>])),
        linkRequirements: jest.fn(async () => 0),
    },
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({})),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn(async () => undefined) }));

import { Prisma } from '@prisma/client';

import { authorAiSystemEntry } from '@/app-layer/usecases/ai-system';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('OWNER');

/**
 * `resolveTierRequirementIds` reads the GLOBAL framework catalogue — both
 * `framework` and `frameworkRequirement`. Empty results are the realistic
 * shape for MINIMAL anyway (`TIER_OBLIGATIONS.MINIMAL` pulls nothing), and
 * what this file asserts is what gets WRITTEN, not which obligations link.
 */
const dbWithRequirements = {
    framework: { findMany: jest.fn(async () => []) },
    frameworkRequirement: { findMany: jest.fn(async () => []) },
} as never;

beforeEach(() => {
    jest.clearAllMocks();
    captured = {};
});

const author = (classification: Record<string, unknown>) =>
    authorAiSystemEntry(dbWithRequirements, ctx, {
        name: 'Test system',
        deploymentRole: 'DEPLOYER',
        classification,
    } as unknown as Parameters<typeof authorAiSystemEntry>[2]);

describe('what the register stores about how it was classified', () => {
    it('an UNANSWERED questionnaire stores NULL, not an empty object', async () => {
        await author({});

        // `{}` would claim four negatives nobody supplied. An empty column
        // says "this was authored with no answers", which is the truth.
        expect(captured.classificationAnswersJson).toBe(Prisma.DbNull);
        // And DbNull specifically, not JsonNull. Prisma separates the SQL
        // NULL from the JSON value `null` for a nullable Json column, and
        // they are two more states that look alike: DbNull leaves the column
        // empty; JsonNull would store the literal `null` AS the answers — an
        // entry claiming its questionnaire was answered with nothing. Getting
        // this wrong rebuilds the ambiguity the column exists to remove.
        expect(captured.classificationAnswersJson).not.toBe(Prisma.JsonNull);
    });

    it('an explicit "no triggers apply" stores the answers', async () => {
        const answered = {
            prohibitedPractice: null,
            isAnnexIProductSafetyComponent: false,
            annexIIIArea: null,
            transparencyCase: null,
        };

        await author(answered);

        expect(captured.classificationAnswersJson).toEqual(answered);
    });

    it('a real trigger stores the answers too', async () => {
        await author({ annexIIIArea: 'employment' });

        expect(captured.classificationAnswersJson).toMatchObject({ annexIIIArea: 'employment' });
    });

    it('THE POINT: unanswered and explicitly-negative reach the SAME verdict', async () => {
        // If these two differed in the verdict, the row would already
        // distinguish them and the column would be redundant. They do not —
        // which is the whole argument for storing the inputs.
        await author({});
        const unanswered = { ...captured };

        await author({
            prohibitedPractice: null,
            isAnnexIProductSafetyComponent: false,
            annexIIIArea: null,
            transparencyCase: null,
        });
        const assessed = { ...captured };

        expect(assessed.riskTier).toBe(unanswered.riskTier);
        expect(assessed.classificationClauseId).toBe(unanswered.classificationClauseId);
        expect(assessed.classificationRationale).toBe(unanswered.classificationRationale);
        // Identical verdict, different evidence — and only the answers say so.
        expect(unanswered.classificationAnswersJson).toBe(Prisma.DbNull);
        expect(assessed.classificationAnswersJson).not.toBe(Prisma.DbNull);
    });
});
