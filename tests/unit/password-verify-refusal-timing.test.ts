/**
 * Every way `verifyPassword` refuses pays one bcrypt compare, against the
 * dummy hash when it cannot compare against the stored one. A refusal that
 * returned at once (an over-long password, say) made a registered account
 * answer faster than an unknown one, whose sign-in runs `dummyVerify`.
 *
 * Counted, not timed: bcrypt is mocked, and each case asserts how many
 * compares ran.
 */
const compare = jest.fn();
const hash = jest.fn(async () => '$2b$12$dummydummydummydummydummydummydummydummydummydummydu');
jest.mock('bcrypt', () => ({ __esModule: true, default: { compare, hash }, compare, hash }));

import { MAX_PASSWORD_LENGTH, verifyPassword } from '@/lib/auth/passwords';

const STORED = '$2b$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz012345';

beforeEach(() => {
    compare.mockReset();
    compare.mockResolvedValue(false);
});

describe('verifyPassword refusals pay the bcrypt cost', () => {
    it.each([
        ['an over-long password', 'a'.repeat(MAX_PASSWORD_LENGTH + 1), STORED],
        ['an empty password', '', STORED],
        ['no stored hash', 'guess', null],
        ['an empty stored hash', 'guess', ''],
    ])('%s: one compare, and false', async (_label, plaintext, stored) => {
        await expect(verifyPassword(plaintext, stored)).resolves.toBe(false);
        expect(compare).toHaveBeenCalledTimes(1);
        // What is compared is never longer than a password may be.
        expect(String(compare.mock.calls[0][0]).length).toBeLessThanOrEqual(MAX_PASSWORD_LENGTH);
    });

    it('a malformed stored hash: the failed compare is followed by a dummy one', async () => {
        compare.mockRejectedValueOnce(new Error('Invalid salt'));
        await expect(verifyPassword('guess', 'not-a-bcrypt-hash')).resolves.toBe(false);
        expect(compare).toHaveBeenCalledTimes(2);
    });

    it('a wrong password: one compare against the stored hash', async () => {
        await expect(verifyPassword('guess', STORED)).resolves.toBe(false);
        expect(compare).toHaveBeenCalledTimes(1);
        expect(compare.mock.calls[0][1]).toBe(STORED);
    });
});
