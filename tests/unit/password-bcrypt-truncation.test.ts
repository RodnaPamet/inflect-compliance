/**
 * bcrypt's 72-byte truncation, and the pre-hash that removes it (#5592).
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * bcrypt reads at most 72 bytes and silently ignores the rest, so any two
 * passwords sharing their first 72 bytes authenticated against the same hash.
 * `MAX_PASSWORD_LENGTH` was documented as the guard and could not be: 128
 * CHARACTERS is nearly double 72 BYTES, and every check measured
 * `String.length`.
 *
 * The cases below are byte-counted on purpose. UTF-8 spends two bytes on
 * Cyrillic, so the cut fell at the 37th character on a product that ships a
 * Bulgarian UI — which is why the second describe block is the one that
 * matters most here, not the ASCII one.
 *
 * ═══ WHAT THESE TESTS WILL NOT TELL YOU ═══
 *
 * Nothing here measures TIME. `verifyPasswordWithScheme` runs both compares
 * concurrently to keep the file's enumeration property, and a wall-clock
 * assertion on bcrypt would be flake rather than evidence. The constant-work
 * shape is asserted structurally instead, by counting compares.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { repoFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

import {
    BCRYPT_COST,
    MAX_PASSWORD_LENGTH,
    dummyVerify,
    hashPassword,
    prehashForBcrypt,
    verifyPassword,
    verifyPasswordWithScheme,
} from '@/lib/auth/passwords';

// Real bcrypt, deliberately: the subject is what bcrypt does to long input,
// so a mock would be a test of the mock. Cost 12 makes each call ~250ms, which
// is why the case count here is small and each one earns its place.
jest.setTimeout(60_000);

async function bcryptMod() {
    const m = (await import('bcrypt')) as unknown as { default?: typeof import('bcrypt') };
    return m.default ?? (m as unknown as typeof import('bcrypt'));
}

/** A hash in the scheme used before #5592: bcrypt over the raw plaintext. */
async function legacyHash(plaintext: string): Promise<string> {
    return (await bcryptMod()).hash(plaintext, BCRYPT_COST);
}

// The `newSchemeHash` helper that used to stand here built the pre-hashed form
// by hand, because deploy 1 only had to READ it. Deploy 2 writes it, so these
// cases call `hashPassword` directly: the subject is now the production writer,
// and a local re-implementation would have let the two drift while staying
// green — the helper's own docblock said to re-point it at the flip.

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('the pre-hash itself', () => {
    it('reduces any input to 44 bytes, so bcrypt truncates nothing', () => {
        const short = prehashForBcrypt('x');
        const long = prehashForBcrypt('ю'.repeat(500));
        expect(bytes(short)).toBe(44);
        expect(bytes(long)).toBe(44);
        // Comfortably inside bcrypt's 72, with no NUL byte — some
        // implementations treat one as a terminator.
        expect(bytes(long)).toBeLessThan(72);
        expect(long).not.toContain('\0');
    });

    it('is base64(sha256(utf8)) and nothing else', () => {
        // Pinned because this IS the credential scheme: a different algorithm,
        // encoding or input encoding invalidates every hash made under it.
        const pw = 'парола-с-кирилица';
        expect(prehashForBcrypt(pw)).toBe(
            createHash('sha256').update(pw, 'utf8').digest('base64'),
        );
    });

    it('separates inputs that differ only past the 72nd byte', () => {
        const base = 'a'.repeat(72);
        expect(prehashForBcrypt(`${base}X`)).not.toBe(prehashForBcrypt(`${base}Y`));
    });
});

describe('a password longer than 72 bytes is no longer truncated', () => {
    it('refuses one that differs only after the 72nd byte', async () => {
        const base = 'correct-horse-battery-staple-'.repeat(3); // 87 bytes
        expect(bytes(base)).toBeGreaterThan(72);
        const hash = await hashPassword(`${base}TAIL-A`);

        await expect(verifyPassword(`${base}TAIL-A`, hash)).resolves.toBe(true);
        // THE DEFECT. Under the old scheme both inputs reached bcrypt as the
        // same 72 bytes and this was `true`.
        await expect(verifyPassword(`${base}TAIL-B`, hash)).resolves.toBe(false);
    });

    it('and the whole password is still accepted at the policy ceiling', async () => {
        // 128 characters remains the body bound, so a long passphrase is
        // usable rather than refused — which is the half a byte cap would
        // have cost.
        const pw = 'z'.repeat(MAX_PASSWORD_LENGTH);
        const hash = await hashPassword(pw);
        await expect(verifyPassword(pw, hash)).resolves.toBe(true);
    });
});

describe('Cyrillic, where the cut actually fell', () => {
    // Two bytes per character, so 36 characters is the old 72-byte limit and
    // the 37th onwards was ignored. This product ships a Bulgarian UI.
    const prefix = 'парола'.repeat(6); // 36 chars, 72 bytes

    it('counts 72 bytes at the 36th character — the premise, stated', () => {
        expect(prefix).toHaveLength(36);
        expect(bytes(prefix)).toBe(72);
    });

    it('distinguishes two 40-character passphrases differing at the 38th', async () => {
        const a = `${prefix}тест`;
        const b = `${prefix}тесн`;
        expect(a).toHaveLength(40);
        const hash = await hashPassword(a);

        await expect(verifyPassword(a, hash)).resolves.toBe(true);
        await expect(verifyPassword(b, hash)).resolves.toBe(false);
    });
});

describe('hashes made before the pre-hash still authenticate, then migrate', () => {
    it('verifies a legacy hash and reports the scheme so the caller re-hashes', async () => {
        const pw = 'старата-ми-парола-1234';
        const stored = await legacyHash(pw);

        const result = await verifyPasswordWithScheme(pw, stored);

        expect(result).toEqual({ ok: true, legacyScheme: true });
    });

    it('reports a NEW hash as current, so nothing re-hashes on every login', async () => {
        // The other half: were `legacyScheme` always true, every sign-in would
        // rewrite the row for ever.
        const pw = 'новата-ми-парола-1234';
        const stored = await hashPassword(pw);

        expect(await verifyPasswordWithScheme(pw, stored)).toEqual({
            ok: true,
            legacyScheme: false,
        });
    });

    it('still verifies a legacy hash whose password exceeded 72 bytes', async () => {
        // Such a user's stored hash was built from input bcrypt had already
        // truncated. The legacy compare truncates the same way, so they are
        // not locked out — which a byte cap at verify time would have done.
        const pw = `${'q'.repeat(80)}-tail`;
        const stored = await legacyHash(pw);
        expect(await verifyPasswordWithScheme(pw, stored)).toEqual({
            ok: true,
            legacyScheme: true,
        });
    });

    it('and once re-hashed, that password\'s tail starts counting', async () => {
        // The migration completing: the same user, re-hashed on login, now has
        // a hash their 80th-character neighbour cannot open.
        const pw = `${'q'.repeat(80)}-tail`;
        const migrated = await hashPassword(pw);
        await expect(verifyPassword(pw, migrated)).resolves.toBe(true);
        await expect(verifyPassword(`${'q'.repeat(80)}-xxxx`, migrated)).resolves.toBe(false);
    });

    it('refuses a wrong password against a legacy hash, reporting no scheme', async () => {
        const stored = await legacyHash('right-password-here');
        expect(await verifyPasswordWithScheme('wrong-password-here', stored)).toEqual({
            ok: false,
            legacyScheme: false,
        });
    });
});

describe('the refusal shapes are unchanged', () => {
    it.each([
        ['empty input', '', 'hash'],
        ['missing hash', 'pw', null],
        ['over-long input', 'x'.repeat(MAX_PASSWORD_LENGTH + 1), 'hash'],
    ])('%s answers false with no scheme', async (_name, pw, hash) => {
        expect(await verifyPasswordWithScheme(pw, hash as string | null)).toEqual({
            ok: false,
            legacyScheme: false,
        });
    });

    it('a malformed stored hash is a failure, not a crash', async () => {
        expect(await verifyPasswordWithScheme('pw', 'not-a-bcrypt-hash')).toEqual({
            ok: false,
            legacyScheme: false,
        });
    });

    it('dummyVerify still answers false', async () => {
        await expect(dummyVerify('anything')).resolves.toBe(false);
    });
});

// ── the deploy-1 boundary ───────────────────────────────────────────────

describe('deploy 2 writes the scheme deploy 1 taught the probe to read', () => {
    // These two cases replace the pair that pinned deploy 1's deliberate
    // RESTRAINT ("hashPassword still writes a hash a RAW comparison can open").
    // That property was true and load-bearing for one deploy and is now
    // reversed on purpose, so the assertions are inverted rather than deleted:
    // a revert of `hashPassword` alone turns these red instead of passing
    // quietly.
    //
    // The rollback guarantee has not gone away, it has moved. A pre-hashed hash
    // cannot be opened by a build that compares the raw plaintext, so writing
    // one before the probe shipped would have stranded every user who set a
    // password in the window. The probe IS shipped (deploy 1, on main), so the
    // image a revert of this deploy lands on reads both forms.
    // `password-verify-bcrypt-interop` names that target explicitly.

    it('hashPassword writes the PRE-HASHED form', async () => {
        const pw = 'CorrectHorseBatteryStaple-2026'; // pragma: allowlist secret -- test fixture
        const written = await hashPassword(pw);
        const bcrypt = await bcryptMod();

        await expect(bcrypt.compare(prehashForBcrypt(pw), written)).resolves.toBe(true);
        // The inversion: the raw plaintext no longer opens it. This is what
        // made deploy 1 a precondition rather than a nicety.
        await expect(bcrypt.compare(pw, written)).resolves.toBe(false);
    });

    it('and the probe reports it as CURRENT, so no login re-hashes it', async () => {
        // The other half of the migration being finite: were this `true`, the
        // `legacyScheme ||` branch in credentials.ts would rewrite the row on
        // every single sign-in, for ever.
        const pw = 'дълга-парола-с-много-знаци-2026';
        expect(await verifyPasswordWithScheme(pw, await hashPassword(pw))).toEqual({
            ok: true,
            legacyScheme: false,
        });
    });

    it('a password past the old 72-byte cut now round-trips through hashPassword', async () => {
        // The end-to-end point of #5592, asserted against the real writer
        // rather than a local re-implementation of it.
        const base = 'парола'.repeat(6); // 36 chars, exactly 72 bytes
        const a = `${base}-ОПАШКА-А`;
        const b = `${base}-ОПАШКА-Б`;
        expect(bytes(a)).toBeGreaterThan(72);

        const written = await hashPassword(a);
        await expect(verifyPassword(a, written)).resolves.toBe(true);
        await expect(verifyPassword(b, written)).resolves.toBe(false);
    });
});

describe('the pre-hash has ONE seam, which is what makes deploy 2 complete', () => {
    // Every password writer — the seed, /api/auth/register, the staging seed,
    // credentials.ts's rehash-on-verify, and both password-management paths —
    // reaches bcrypt through `hashPassword`. That is why flipping one line
    // migrates all of them, and it is a property worth pinning: a second
    // writer calling bcrypt directly would silently keep minting hashes in the
    // legacy scheme, which still VERIFY (the probe falls back) and so would
    // show up as nothing at all until somebody counted schemes.
    //
    // Population from git, not a directory walk with a skip list — a
    // hand-maintained denominator is how `.claude/worktrees/` once got scanned.
    const ROOT = path.resolve(__dirname, '../..');
    const sources = [
        ...repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }),
        ...repoFiles({ under: 'prisma', extensions: ['.ts'] }),
    ];

    // `repoFiles` returns ABSOLUTE paths; the expectations below are written
    // repo-relative, so strip the root rather than joining it on twice.
    const callersOf = (re: RegExp) => sources
        .filter((abs) => re.test(codeOf(readFileSync(abs, 'utf-8'))))
        .map((abs) => path.relative(ROOT, abs).replace(/\\/g, '/'))
        .sort();

    it('exactly one file calls bcrypt.hash, and it is passwords.ts', () => {
        // Comments are masked by `codeOf`, so a docblock mentioning
        // `bcrypt.hash` cannot satisfy this.
        expect(callersOf(/bcrypt\.hash\(/)).toEqual(['src/lib/auth/passwords.ts']);
    });

    it('nothing else imports bcrypt at all', () => {
        expect(callersOf(/from 'bcrypt'|import\('bcrypt'\)|require\('bcrypt'\)/))
            .toEqual(['src/lib/auth/passwords.ts']);
    });

    it('and that one call pre-hashes its input', () => {
        // The assertion the two above exist to make meaningful: one seam is
        // only worth having if the seam itself is right.
        const code = codeOf(readFileSync(path.join(ROOT, 'src/lib/auth/passwords.ts'), 'utf-8'));
        expect(code).toMatch(/bcrypt\.hash\(prehashForBcrypt\(plaintext\), BCRYPT_COST\)/);
    });
});
