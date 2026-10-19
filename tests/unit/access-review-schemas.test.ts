/**
 * Unit tests for the access-review Zod schemas (Epic G-4).
 */
import {
    CreateAccessReviewSchema,
    SubmitDecisionSchema,
    RevokeDecisionSchema,
} from '@/app-layer/schemas/access-review.schemas';

describe('access-review.schemas', () => {
    describe('CreateAccessReviewSchema', () => {
        it('accepts a minimal valid input and applies the scope default', () => {
            const r = CreateAccessReviewSchema.parse({
                name: 'Q1 review',
                reviewerUserId: 'rev-1',
            });
            expect(r.scope).toBe('ALL_USERS');
            expect(r.name).toBe('Q1 review');
        });

        it('trims the name via transform', () => {
            const r = CreateAccessReviewSchema.parse({
                name: '  padded  ',
                reviewerUserId: 'rev-1',
            });
            expect(r.name).toBe('padded');
        });

        it('coerces ISO-string date fields to Date', () => {
            const r = CreateAccessReviewSchema.parse({
                name: 'r',
                reviewerUserId: 'rev-1',
                periodStartAt: '2026-01-01T00:00:00.000Z',
                periodEndAt: '2026-02-01T00:00:00.000Z',
                dueAt: '2026-03-01T00:00:00.000Z',
            });
            expect(r.periodStartAt).toBeInstanceOf(Date);
            expect(r.periodEndAt).toBeInstanceOf(Date);
            expect(r.dueAt).toBeInstanceOf(Date);
        });

        it('accepts a Date object for a date field', () => {
            const r = CreateAccessReviewSchema.safeParse({
                name: 'r',
                reviewerUserId: 'rev-1',
                periodStartAt: new Date('2026-01-01T00:00:00.000Z'),
            });
            expect(r.success).toBe(true);
        });

        it('accepts null description (OptionalText)', () => {
            expect(
                CreateAccessReviewSchema.safeParse({
                    name: 'r',
                    reviewerUserId: 'rev-1',
                    description: null,
                }).success,
            ).toBe(true);
        });

        it('accepts CUSTOM scope with non-empty customMembershipIds', () => {
            const r = CreateAccessReviewSchema.safeParse({
                name: 'r',
                reviewerUserId: 'rev-1',
                scope: 'CUSTOM',
                customMembershipIds: ['m1', 'm2'],
            });
            expect(r.success).toBe(true);
        });

        it('rejects an empty name', () => {
            expect(
                CreateAccessReviewSchema.safeParse({ name: '', reviewerUserId: 'rev-1' }).success,
            ).toBe(false);
        });

        it('rejects a name over 2000 chars', () => {
            expect(
                CreateAccessReviewSchema.safeParse({
                    name: 'a'.repeat(2001),
                    reviewerUserId: 'rev-1',
                }).success,
            ).toBe(false);
        });

        it('rejects an empty reviewerUserId', () => {
            expect(
                CreateAccessReviewSchema.safeParse({ name: 'r', reviewerUserId: '' }).success,
            ).toBe(false);
        });

        it('rejects an invalid scope', () => {
            expect(
                CreateAccessReviewSchema.safeParse({
                    name: 'r',
                    reviewerUserId: 'rev-1',
                    scope: 'NOPE',
                }).success,
            ).toBe(false);
        });

        it('rejects CUSTOM scope with missing customMembershipIds (superRefine)', () => {
            const r = CreateAccessReviewSchema.safeParse({
                name: 'r',
                reviewerUserId: 'rev-1',
                scope: 'CUSTOM',
            });
            expect(r.success).toBe(false);
        });

        it('rejects CUSTOM scope with empty customMembershipIds (superRefine)', () => {
            const r = CreateAccessReviewSchema.safeParse({
                name: 'r',
                reviewerUserId: 'rev-1',
                scope: 'CUSTOM',
                customMembershipIds: [],
            });
            expect(r.success).toBe(false);
        });

        it('rejects non-CUSTOM scope carrying customMembershipIds (superRefine)', () => {
            const r = CreateAccessReviewSchema.safeParse({
                name: 'r',
                reviewerUserId: 'rev-1',
                scope: 'ALL_USERS',
                customMembershipIds: ['m1'],
            });
            expect(r.success).toBe(false);
        });

        it('rejects periodEndAt before periodStartAt (superRefine)', () => {
            const r = CreateAccessReviewSchema.safeParse({
                name: 'r',
                reviewerUserId: 'rev-1',
                periodStartAt: '2026-02-01T00:00:00.000Z',
                periodEndAt: '2026-01-01T00:00:00.000Z',
            });
            expect(r.success).toBe(false);
        });

        it('accepts equal period bounds', () => {
            const r = CreateAccessReviewSchema.safeParse({
                name: 'r',
                reviewerUserId: 'rev-1',
                periodStartAt: '2026-01-01T00:00:00.000Z',
                periodEndAt: '2026-01-01T00:00:00.000Z',
            });
            expect(r.success).toBe(true);
        });
    });

    describe('SubmitDecisionSchema', () => {
        it('accepts a CONFIRM decision', () => {
            expect(SubmitDecisionSchema.safeParse({ decision: 'CONFIRM' }).success).toBe(true);
        });

        it('accepts a REVOKE decision with notes', () => {
            expect(
                SubmitDecisionSchema.safeParse({ decision: 'REVOKE', notes: 'why' }).success,
            ).toBe(true);
        });

        it('accepts a MODIFY decision with modifiedToRole', () => {
            const r = SubmitDecisionSchema.safeParse({
                decision: 'MODIFY',
                modifiedToRole: 'EDITOR',
            });
            expect(r.success).toBe(true);
        });

        it('refuses MODIFY with a modifiedToCustomRoleId — a campaign sets a built-in role only (#3727)', () => {
            expect(
                SubmitDecisionSchema.safeParse({
                    decision: 'MODIFY',
                    modifiedToRole: 'ADMIN',
                    modifiedToCustomRoleId: 'crole-1',
                }).success,
            ).toBe(false);
        });

        it('accepts null modifiedToCustomRoleId', () => {
            expect(
                SubmitDecisionSchema.safeParse({
                    decision: 'MODIFY',
                    modifiedToRole: 'READER',
                    modifiedToCustomRoleId: null,
                }).success,
            ).toBe(true);
        });

        it('rejects MODIFY without modifiedToRole', () => {
            expect(SubmitDecisionSchema.safeParse({ decision: 'MODIFY' }).success).toBe(false);
        });

        it('rejects MODIFY with an invalid role', () => {
            expect(
                SubmitDecisionSchema.safeParse({
                    decision: 'MODIFY',
                    modifiedToRole: 'SUPERUSER',
                }).success,
            ).toBe(false);
        });

        it('rejects an unknown decision', () => {
            expect(SubmitDecisionSchema.safeParse({ decision: 'DELETE' }).success).toBe(false);
        });

        it('rejects an empty modifiedToCustomRoleId', () => {
            expect(
                SubmitDecisionSchema.safeParse({
                    decision: 'MODIFY',
                    modifiedToRole: 'READER',
                    modifiedToCustomRoleId: '',
                }).success,
            ).toBe(false);
        });
    });

    describe('RevokeDecisionSchema', () => {
        it('accepts a valid reason', () => {
            expect(RevokeDecisionSchema.safeParse({ reason: 'mistake' }).success).toBe(true);
        });

        it('rejects a reason under 3 chars', () => {
            expect(RevokeDecisionSchema.safeParse({ reason: 'ab' }).success).toBe(false);
        });

        it('rejects a reason over 2000 chars', () => {
            expect(
                RevokeDecisionSchema.safeParse({ reason: 'a'.repeat(2001) }).success,
            ).toBe(false);
        });

        it('rejects a missing reason', () => {
            expect(RevokeDecisionSchema.safeParse({}).success).toBe(false);
        });
    });
});
