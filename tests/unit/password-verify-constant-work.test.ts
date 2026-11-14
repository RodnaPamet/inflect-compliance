/**
 * `verifyPassword` does the SAME AMOUNT OF WORK whatever the answer (#5592).
 *
 * This is the property that keeps the file's enumeration guarantee intact after
 * pre-hashing. `verifyPassword`'s contract is that "a sign-in that names a
 * registered account takes as long as one that names an unknown account", and
 * `credentials.ts` relies on it. Probing two schemes could have broken it
 * three ways:
 *
 *   • short-circuit on the pre-hashed compare, and a migrated account answers
 *     in ONE bcrypt while everything else takes two — the fast answer then
 *     marks a registered, already-migrated account;
 *   • leave `dummyVerify` at one compare, and an unknown account answers
 *     faster than any real one;
 *   • run the two compares in sequence, and every login costs twice the
 *     latency, which is not a leak but is a regression nobody asked for.
 *
 * bcrypt is MOCKED here, and that is the right call for once: the subject is
 * how many times it is called and whether the calls overlap, not what it
 * computes. `password-bcrypt-truncation.test.ts` drives the real thing.
 */
// The PARAMETERS are declared, not inferred away. `jest.fn(async () => false)`
// types the mock as taking none, so `mockImplementation((candidate) => …)` does
// not fit it and `compare.mock.calls[0][0]` indexes an empty tuple — jest runs
// both happily and `tsc` refuses, which is how this file first went red.
const compare = jest.fn(async (_candidate: unknown, _stored: unknown): Promise<boolean> => false);
const hash = jest.fn(async (_candidate: unknown, _cost: unknown): Promise<string> =>
    `$2b$12$${'x'.repeat(53)}`,
);
let resolveGate: (() => void) | null = null;

// Forwarded by NAMED parameters rather than a spread. `(...a as [])` passes
// zero arguments to a two-argument signature, which jest tolerates and `tsc`
// does not — the second half of the same typing trap as above.
const fwdCompare = (candidate: unknown, stored: unknown) => compare(candidate, stored);
const fwdHash = (candidate: unknown, cost: unknown) => hash(candidate, cost);
jest.mock('bcrypt', () => ({
    __esModule: true,
    default: { compare: fwdCompare, hash: fwdHash },
    compare: fwdCompare,
    hash: fwdHash,
}));

import { dummyVerify, verifyPasswordWithScheme } from '@/lib/auth/passwords';

const STORED = `$2b$12$${'y'.repeat(53)}`;

beforeEach(() => {
    compare.mockReset();
    compare.mockResolvedValue(false as never);
    resolveGate = null;
});

describe('every verdict costs the same number of compares', () => {
    it('a WRONG password: two', async () => {
        await verifyPasswordWithScheme('nope', STORED);
        expect(compare).toHaveBeenCalledTimes(2);
    });

    it('a CORRECT current-scheme password: two, not one', async () => {
        // The short-circuit this forbids. Returning as soon as the pre-hashed
        // compare succeeds would make this 1, and a one-compare answer would
        // identify a registered, migrated account.
        compare.mockImplementation(async (candidate) =>
            // the pre-hashed candidate is 44 base64 chars; the raw one is not
            typeof candidate === 'string' && candidate.length === 44,
        );
        const out = await verifyPasswordWithScheme('right', STORED);
        expect(out).toEqual({ ok: true, legacyScheme: false });
        expect(compare).toHaveBeenCalledTimes(2);
    });

    it('a CORRECT legacy password: two', async () => {
        compare.mockImplementation(async (candidate) => candidate === 'right');
        const out = await verifyPasswordWithScheme('right', STORED);
        expect(out).toEqual({ ok: true, legacyScheme: true });
        expect(compare).toHaveBeenCalledTimes(2);
    });

    it('and dummyVerify: two, so an unknown account matches a real one', async () => {
        await dummyVerify('whatever');
        expect(compare).toHaveBeenCalledTimes(2);
    });
});

describe('the two compares overlap rather than queue', () => {
    it('issues the second before the first resolves', async () => {
        // Sequential awaits would make every login cost two bcrypt latencies.
        // Asserted by holding the FIRST call open and checking the second has
        // already been issued — no clock, so nothing here can flake on timing.
        let issued = 0;
        compare.mockImplementation(
            () =>
                new Promise<boolean>((resolve) => {
                    issued += 1;
                    if (issued === 1) {
                        resolveGate = () => resolve(false);
                    } else {
                        resolve(false);
                    }
                }),
        );

        const pending = verifyPasswordWithScheme('pw', STORED);
        await Promise.resolve();
        await Promise.resolve();

        expect(issued).toBe(2);
        resolveGate?.();
        await expect(pending).resolves.toEqual({ ok: false, legacyScheme: false });
    });
});

describe('what the two candidates are', () => {
    it('one pre-hashed and one raw, never two of a kind', async () => {
        await verifyPasswordWithScheme('пароларешетка', STORED);
        const candidates = compare.mock.calls.map((c) => String(c[0]));
        expect(candidates).toHaveLength(2);
        // The raw plaintext is what every pre-#5592 hash was built from, and
        // the 44-byte base64 is what every hash after it is built from.
        expect(candidates).toContain('пароларешетка');
        expect(candidates.some((c) => c.length === 44)).toBe(true);
    });
});
