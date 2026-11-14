/**
 * Password verification: every hash already stored still verifies, and a
 * verify does not hold the main thread.
 *
 * Until 2026-10-26 the app hashed with `bcryptjs`, which is pure JavaScript
 * and ran on Node's one main thread. Concurrent logins took turns on it, so
 * 25 at once all finished together after ~8 s, the nightly k6 login p95, and
 * every other request waited with them. It now uses native `bcrypt`, which
 * hashes on libuv's thread pool.
 *
 * Two things that change must never break:
 *
 *   1. Stored hashes. Every hash in the database was written by bcryptjs:
 *      `$2b$` (bcryptjs 3), `$2a$` (bcryptjs 2 and the old seed), and `$2y$`
 *      for anything imported from PHP. Native bcrypt returns false for
 *      `$2y$`, so passwords.ts compares it as `$2b$`. A miss here locks every
 *      credentials user out, silently: verifyPassword returns false.
 *   2. The import shape. On Node ≥ 22, `await import()` of a CommonJS module
 *      puts its exports under `.default`. bcryptjs once lost its `.compare`
 *      that way and every login failed; passwords.ts normalises it.
 *
 * Both `verifyPassword` exports (src/lib/auth/passwords.ts and its
 * re-export in src/lib/auth.ts) are exercised.
 *
 * A third thing changed on 2026-11-14 (#5592 deploy 2): bcrypt's INPUT is now
 * the sha256-base64 pre-hash rather than the raw plaintext, so every stored
 * hash above remains readable (the probe falls back to the legacy compare) while
 * new ones are written in the pre-hashed form. The hashes enumerated in (1) are
 * exactly the population that fallback exists for.
 */

import bcryptjs from 'bcryptjs';
import {
    BCRYPT_COST,
    hashPassword,
    needsRehash,
    prehashForBcrypt,
    verifyPassword as verifyPasswordCanonical,
    verifyPasswordWithScheme,
} from '@/lib/auth/passwords';
import { verifyPassword as verifyPasswordLegacy } from '@/lib/auth';

const KNOWN_PASSWORD = 'CorrectHorseBatteryStaple-2026'; // pragma: allowlist secret — fixed test password for the bcrypt interop regression guard

describe('verifyPassword reads every hash already stored', () => {
    let bcryptjs2b: string;

    beforeAll(async () => {
        bcryptjs2b = await bcryptjs.hash(KNOWN_PASSWORD, 10);
    }, 30_000);

    it('a bcryptjs $2b$ hash: right password true, wrong password false', async () => {
        expect(bcryptjs2b.startsWith('$2b$')).toBe(true);
        expect(await verifyPasswordCanonical(KNOWN_PASSWORD, bcryptjs2b)).toBe(true);
        expect(await verifyPasswordCanonical('not-the-password', bcryptjs2b)).toBe(false);
    });

    it('the same hash written as $2a$ (bcryptjs 2, the old seed)', async () => {
        const as2a = `$2a$${bcryptjs2b.slice(4)}`;
        expect(await verifyPasswordCanonical(KNOWN_PASSWORD, as2a)).toBe(true);
        expect(await verifyPasswordCanonical('not-the-password', as2a)).toBe(false);
    });

    it('the same hash written as $2y$ (PHP), which native bcrypt alone rejects', async () => {
        const as2y = `$2y$${bcryptjs2b.slice(4)}`;
        expect(await verifyPasswordCanonical(KNOWN_PASSWORD, as2y)).toBe(true);
        expect(await verifyPasswordCanonical('not-the-password', as2y)).toBe(false);
        // …and it is rewritten as $2b$ on the next successful login.
        expect(needsRehash(`$2y$${String(BCRYPT_COST).padStart(2, '0')}$${'a'.repeat(53)}`)).toBe(true);
    });

    it('the seed password against a stored $2a$10$ hash', async () => {
        const seedStyleHash = '$2a$10$5n/FT8vHb3kM6AEANm1Z9etU.9Tn9DCwxG7i5i94HFTJggxV6IxXK';
        expect(await verifyPasswordCanonical('password123', seedStyleHash)).toBe(true);
    });

    /**
     * This case guarded "a rollback strands nobody" for the bcryptjs → native
     * bcrypt migration, and it is what caught #5592 being planned as ONE
     * deploy: it asserted `bcryptjs.compare(KNOWN_PASSWORD, fresh)`, which a
     * pre-hashing `hashPassword` makes false, and an image comparing the raw
     * plaintext cannot open such a hash.
     *
     * #5592 deploy 2 is the flip, so the property is restated rather than
     * relaxed — and the ROLLBACK TARGET is what changed. It is no longer "an
     * image that compares the raw plaintext": deploy 1 is already on main, and
     * its probe tries the pre-hashed compare first and falls back to the legacy
     * one. That is the image a revert of this deploy lands on, and it reads
     * both forms. Reverting PAST deploy 1 would strand anyone who set a
     * password in between, which is the cost the two-deploy split buys down and
     * the reason the order cannot be reversed.
     *
     * The bcryptjs-interop property itself is unchanged and still asserted: the
     * library reads our hash. What moved is the INPUT bcrypt is given.
     */
    it('a hash the new hasher writes is still a well-formed bcrypt hash bcryptjs reads', async () => {
        const fresh = await hashPassword(KNOWN_PASSWORD);
        expect(fresh.startsWith(`$2b$${String(BCRYPT_COST).padStart(2, '0')}$`)).toBe(true);
        // bcryptjs verifies it, given what bcrypt was actually given.
        expect(await bcryptjs.compare(prehashForBcrypt(KNOWN_PASSWORD), fresh)).toBe(true);
        // And NOT against the raw plaintext — the fact that makes deploy 1 a
        // precondition rather than a nicety. Asserted so a future revert of
        // `hashPassword` alone turns this red instead of silently passing.
        expect(await bcryptjs.compare(KNOWN_PASSWORD, fresh)).toBe(false);
    }, 30_000);

    it('deploy 1 reads what deploy 2 writes — the rollback target, named', async () => {
        const fresh = await hashPassword(KNOWN_PASSWORD);
        // `verifyPasswordWithScheme` is the probe deploy 1 shipped. It opens a
        // deploy-2 hash and reports it as the CURRENT scheme, so a revert of
        // this deploy strands nobody and re-hashes nobody on every login.
        expect(await verifyPasswordWithScheme(KNOWN_PASSWORD, fresh)).toEqual({
            ok: true,
            legacyScheme: false,
        });
        expect(await verifyPasswordCanonical('not-the-password', fresh)).toBe(false);
    }, 30_000);

    it('the legacy export in src/lib/auth.ts is the same function', async () => {
        expect(verifyPasswordLegacy).toBe(verifyPasswordCanonical);
        expect(await verifyPasswordLegacy(KNOWN_PASSWORD, bcryptjs2b)).toBe(true);
    });
});

describe('verifyPassword does not hold the main thread', () => {
    it('timers keep firing while four cost-12 verifies run', async () => {
        const hash = await hashPassword(KNOWN_PASSWORD);
        let ticks = 0;
        const timer = setInterval(() => ticks++, 10);
        const start = Date.now();
        try {
            const results = await Promise.all(
                Array.from({ length: 4 }, () => verifyPasswordCanonical(KNOWN_PASSWORD, hash)),
            );
            expect(results).toEqual([true, true, true, true]);
        } finally {
            clearInterval(timer);
        }
        const elapsed = Date.now() - start;
        // A free main thread fires about elapsed/10 ticks. bcryptjs, hashing
        // on the main thread, fired 3 in 1,450 ms for five verifies (2%);
        // native bcrypt fired 275 in 3,421 ms for twenty-five (80%). A 25%
        // floor separates them with room for a loaded CI runner.
        expect(ticks).toBeGreaterThanOrEqual(Math.floor((elapsed / 10) * 0.25));
    }, 60_000);
});
