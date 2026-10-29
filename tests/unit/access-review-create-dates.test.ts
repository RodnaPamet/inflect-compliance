/**
 * Every campaign schema's dates: one field (`DateField`) and one period rule
 * (`refinePeriodOrder`), shared by the member, connected, agent and legacy
 * creates and the settings change.
 *
 * The connected, agent and legacy creates used `z.coerce.date()`, which is
 * `new Date(input)`: `null` was stored as 1970-01-01, `true` as the first
 * millisecond of 1970, `0` as the epoch, and none of the three refused a
 * period that ended before it began. Each case below is refused for every
 * schema, so a fifth schema written the old way has a table to join.
 */
import type { z } from 'zod';

import {
    CreateAccessReviewSchema,
    CreateLegacyAccessReviewBodySchema,
    CreateLegacyAccessReviewSchema,
    UpdateAccessReviewSettingsSchema,
} from '@/app-layer/schemas/access-review.schemas';
import { CreateConnectedAccessReviewSchema } from '@/app-layer/usecases/access-review-connected';
import { CreateAgentAccessReviewSchema } from '@/app-layer/usecases/access-review-agent';

const DATE_FIELDS = ['dueAt', 'periodStartAt', 'periodEndAt'] as const;

const SCHEMAS: ReadonlyArray<[string, z.ZodType, Record<string, unknown>]> = [
    ['member create', CreateAccessReviewSchema, { name: 'Q4', reviewerUserId: 'u-rev' }],
    ['connected create', CreateConnectedAccessReviewSchema, { name: 'Q4', reviewerUserId: 'u-rev' }],
    ['agent create', CreateAgentAccessReviewSchema, { name: 'Q4', reviewerUserId: 'u-rev', preparerAgentId: 'a-1' }],
    ['legacy create (usecase)', CreateLegacyAccessReviewSchema, { name: 'Q4', connectionId: 'c-1', reviewerUserId: 'u-rev' }],
    ['legacy create (route body)', CreateLegacyAccessReviewBodySchema, { name: 'Q4', connectionId: 'c-1', reviewerUserId: 'u-rev' }],
];

/** What `z.coerce.date()` turned into a real date, and what a date field must refuse. */
const NOT_A_DATE: ReadonlyArray<[string, unknown]> = [
    ['null', null],
    ['true', true],
    ['false', false],
    ['0', 0],
    ['an invalid string', 'next Tuesday'],
    ['an invalid Date', new Date('not a date')],
];

const ISO = '2026-10-01T00:00:00.000Z';

describe.each(SCHEMAS)('%s', (_name, schema, base) => {
    it('accepts the base body, so every refusal below is the date\'s', () => {
        expect(schema.safeParse(base).success).toBe(true);
    });

    describe.each(DATE_FIELDS)('%s', (field) => {
        it.each(NOT_A_DATE)('refuses %s, on that field', (_label, value) => {
            const r = schema.safeParse({ ...base, [field]: value });
            expect(r.success).toBe(false);
            expect(r.error?.issues.map((i) => i.path[0])).toContain(field);
        });

        it('accepts an ISO 8601 string, as a Date', () => {
            const r = schema.safeParse({ ...base, [field]: ISO });
            expect(r.success).toBe(true);
            expect((r.data as Record<string, unknown>)[field]).toEqual(new Date(ISO));
        });

        it('accepts a Date', () => {
            const r = schema.safeParse({ ...base, [field]: new Date(ISO) });
            expect(r.success).toBe(true);
            expect((r.data as Record<string, unknown>)[field]).toEqual(new Date(ISO));
        });

        it('leaves it undefined when omitted', () => {
            const r = schema.safeParse(base);
            expect(r.success).toBe(true);
            expect((r.data as Record<string, unknown>)[field]).toBeUndefined();
        });
    });

    it('refuses a period that ends before it begins, on periodEndAt', () => {
        const r = schema.safeParse({
            ...base, periodStartAt: '2026-10-02T00:00:00.000Z', periodEndAt: '2026-10-01T00:00:00.000Z',
        });
        expect(r.success).toBe(false);
        expect(r.error?.issues).toEqual([
            expect.objectContaining({ path: ['periodEndAt'], message: 'periodEndAt must not precede periodStartAt.' }),
        ]);
    });

    it('accepts a period whose ends are equal or in order, and either end alone', () => {
        for (const period of [
            { periodStartAt: ISO, periodEndAt: ISO },
            { periodStartAt: '2026-07-01T00:00:00.000Z', periodEndAt: '2026-09-30T00:00:00.000Z' },
            { periodStartAt: ISO },
            { periodEndAt: ISO },
        ]) {
            expect(schema.safeParse({ ...base, ...period }).success).toBe(true);
        }
    });
});

describe('updateAccessReviewSettings — null is meaningful there, and stays so', () => {
    it('dueAt: null clears the due date (parsed as null, not as 1970)', () => {
        const r = UpdateAccessReviewSettingsSchema.safeParse({ dueAt: null });
        expect(r.success).toBe(true);
        expect(r.data?.dueAt).toBeNull();
    });

    it.each(NOT_A_DATE.filter(([label]) => label !== 'null'))('refuses dueAt: %s', (_label, value) => {
        expect(UpdateAccessReviewSettingsSchema.safeParse({ dueAt: value }).success).toBe(false);
    });

    it('accepts an ISO string, as a Date', () => {
        expect(UpdateAccessReviewSettingsSchema.parse({ dueAt: ISO }).dueAt).toEqual(new Date(ISO));
    });
});
