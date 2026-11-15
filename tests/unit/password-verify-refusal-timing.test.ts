/**
 * Every way `verifyPassword` refuses pays THE SAME bcrypt cost as a real
 * verification, against the dummy hash when it cannot compare against the
 * stored one. A refusal that returned at once (an over-long password, say)
 * made a registered account answer faster than an unknown one, whose sign-in
 * runs `dummyVerify`.
 *
 * Counted, not timed: bcrypt is mocked, and each case asserts how many
 * compares ran.
 *
 * THE COUNT IS DERIVED, NOT WRITTEN DOWN. It was `1` until #5592 made a
 * verification probe two schemes, and a literal then had to be edited in four
 * places — each edit an opportunity to write the wrong number and call the
 * property satisfied. Every case now measures a real verification and asserts
 * the refusal matches it, so the next change to the scheme carries this test
 * with it.
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

/**
 * The compares a verification against a REAL stored hash costs — the figure
 * every refusal has to match.
 */
async function realVerificationCompares(): Promise<number> {
    compare.mockClear();
    await verifyPassword('guess', STORED);
    const n = compare.mock.calls.length;
    // A mock that never ran would make every comparison below trivially equal.
    expect(n).toBeGreaterThan(0);
    compare.mockClear();
    return n;
}

describe('verifyPassword refusals pay the bcrypt cost', () => {
    it.each([
        ['an over-long password', 'a'.repeat(MAX_PASSWORD_LENGTH + 1), STORED],
        ['an empty password', '', STORED],
        ['no stored hash', 'guess', null],
        ['an empty stored hash', 'guess', ''],
    ])('%s: the same compares as a real verification, and false', async (_label, plaintext, stored) => {
        const expected = await realVerificationCompares();

        await expect(verifyPassword(plaintext, stored)).resolves.toBe(false);

        expect(compare).toHaveBeenCalledTimes(expected);
        // What is compared is never longer than a password may be. Checked on
        // EVERY call, not just the first: the pre-hashed candidate and the raw
        // one are different strings and both reach bcrypt.
        for (const call of compare.mock.calls) {
            expect(String(call[0]).length).toBeLessThanOrEqual(MAX_PASSWORD_LENGTH);
        }
    });

    it('a malformed stored hash: the failed compares are followed by dummy ones', async () => {
        const expected = await realVerificationCompares();
        compare.mockRejectedValueOnce(new Error('Invalid salt'));

        await expect(verifyPassword('guess', 'not-a-bcrypt-hash')).resolves.toBe(false);

        // The attempt against the stored hash AND the dummy burn after it, so
        // a corrupted row costs what a healthy one does.
        expect(compare).toHaveBeenCalledTimes(expected * 2);
    });

    it('a wrong password: every compare is against the stored hash', async () => {
        await expect(verifyPassword('guess', STORED)).resolves.toBe(false);
        expect(compare.mock.calls.length).toBeGreaterThan(0);
        for (const call of compare.mock.calls) {
            expect(call[1]).toBe(STORED);
        }
    });
});
