/**
 * A finding's severity and type are Prisma enums, so the request schemas
 * refuse anything else (#5316).
 *
 * `severity` was `z.string()`: an SDK client posting `severity: 'Major'`
 * passed validation, Prisma rejected the enum value at the driver, and the
 * route answered 500 — a server fault — for a validation error.
 */
import { FindingSeverity } from '@prisma/client';

import { CreateFindingSchema, UpdateFindingSchema } from '@/lib/schemas';

const base = { severity: 'HIGH', type: 'NONCONFORMITY', title: 'Gap' };

describe('finding request schemas — severity and type', () => {
    it.each(Object.values(FindingSeverity))('create accepts severity %s', (severity) => {
        expect(CreateFindingSchema.safeParse({ ...base, severity }).success).toBe(true);
    });

    it.each(['Major', 'high', ''])('create refuses severity %p', (severity) => {
        expect(CreateFindingSchema.safeParse({ ...base, severity }).success).toBe(false);
    });

    it('create refuses a type outside the enum', () => {
        expect(CreateFindingSchema.safeParse({ ...base, type: 'nonconformity' }).success).toBe(false);
    });

    it('update refuses a severity or type outside the enum, and accepts a valid one', () => {
        expect(UpdateFindingSchema.safeParse({ severity: 'Major' }).success).toBe(false);
        expect(UpdateFindingSchema.safeParse({ type: 'nonconformity' }).success).toBe(false);
        expect(UpdateFindingSchema.safeParse({ severity: 'LOW' }).success).toBe(true);
        expect(UpdateFindingSchema.safeParse({}).success).toBe(true);
    });
});
