/**
 * The email-verification link consumes email-verification rows only.
 *
 * `VerificationToken` also holds the SSO hand-offs and the spent SAML flow
 * markers. A raw string that hashes to one of those must not consume or
 * delete it through the verify-email link: deleting a spent-flow marker would
 * let a captured SAML response be replayed.
 */
const rows = new Map<string, { identifier: string; expires: Date }>();
const mockDelete = jest.fn();
jest.mock('@/lib/prisma', () => {
    const prisma = {
        verificationToken: {
            findUnique: jest.fn(async ({ where }: { where: { token: string } }) => {
                const r = rows.get(where.token);
                return r ? { token: where.token, ...r } : null;
            }),
            delete: (...a: unknown[]) => {
                mockDelete(...a);
                return Promise.resolve({});
            },
        },
        user: { findUnique: jest.fn(async () => null) },
        $transaction: jest.fn(),
    };
    return { __esModule: true, default: prisma, prisma };
});
jest.mock('@/lib/mailer', () => ({ sendEmail: jest.fn() }));

import { createHash } from 'node:crypto';
import {
    consumeEmailVerification,
    isEmailVerificationIdentifier,
} from '@/lib/auth/email-verification';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
    rows.clear();
    mockDelete.mockClear();
});

describe('which rows the verify-email link may touch', () => {
    it.each([
        ['person@example.com', true],
        ['sso-flow-spent:saml', false],
        ['sso-handoff:tenant-1:user-1', false],
        ['not-an-email', false],
    ])('%s → %s', (identifier, expected) => {
        expect(isEmailVerificationIdentifier(identifier)).toBe(expected);
    });

    it('a raw string that hashes to a spent SAML flow marker neither consumes nor deletes it', async () => {
        const raw = 'sso-flow-spent:saml:flow-123';
        rows.set(sha(raw), { identifier: 'sso-flow-spent:saml', expires: new Date(Date.now() + 60_000) });
        await expect(consumeEmailVerification(raw)).resolves.toEqual({ ok: false, reason: 'invalid' });
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('an expired marker is not deleted through this link either', async () => {
        const raw = 'sso-flow-spent:saml:flow-old';
        rows.set(sha(raw), { identifier: 'sso-flow-spent:saml', expires: new Date(Date.now() - 60_000) });
        await expect(consumeEmailVerification(raw)).resolves.toEqual({ ok: false, reason: 'invalid' });
        expect(mockDelete).not.toHaveBeenCalled();
    });
});
