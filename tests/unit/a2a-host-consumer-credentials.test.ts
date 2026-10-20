import jwt from 'jsonwebtoken';

import {
    HOST_CONSUMER_CLIENT_PREFIX,
    HOST_CONSUMER_TOKEN_ISSUER,
    HOST_CONSUMER_TOKEN_TTL_SECONDS,
    mintHostConsumerToken,
    verifyHostConsumerToken,
    generateHostConsumerCredentials,
    hashHostConsumerSecret,
    hostConsumerSecretMatches,
    hostConsumersAdmitted,
} from '@/lib/agentic/a2a/host-consumer';

describe('host-consumer credentials (#3861)', () => {
    it('mints a prefixed client id and a secret it does not keep', () => {
        const c = generateHostConsumerCredentials();
        expect(c.clientId.startsWith(HOST_CONSUMER_CLIENT_PREFIX)).toBe(true);
        // 24 random bytes, hex.
        expect(c.secretPlaintext).toMatch(/^[0-9a-f]{48}$/);
        expect(c.secretHash).toMatch(/^[0-9a-f]{64}$/);
        // The stored form is not the secret, and the displayed form is a
        // fragment of it rather than a second secret.
        expect(c.secretHash).not.toContain(c.secretPlaintext);
        expect(c.secretPlaintext.startsWith(c.secretPrefix)).toBe(true);
        expect(c.secretPrefix.length).toBeLessThan(c.secretPlaintext.length);
    });

    it('does not repeat itself', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 50; i += 1) {
            const c = generateHostConsumerCredentials();
            seen.add(c.clientId);
            seen.add(c.secretPlaintext);
        }
        // 50 ids + 50 secrets, all distinct.
        expect(seen.size).toBe(100);
    });

    it('matches a correct secret and refuses a wrong one', () => {
        const c = generateHostConsumerCredentials();
        expect(hostConsumerSecretMatches(c.secretPlaintext, c.secretHash)).toBe(true);
        expect(hostConsumerSecretMatches(`${c.secretPlaintext}x`, c.secretHash)).toBe(false);
        expect(hostConsumerSecretMatches('', c.secretHash)).toBe(false);
        // A near miss: the right length, one character out.
        const nearly = `${c.secretPlaintext.slice(0, -1)}${c.secretPlaintext.endsWith('0') ? '1' : '0'}`;
        expect(hostConsumerSecretMatches(nearly, c.secretHash)).toBe(false);
    });

    it('compares hashes, so a presented secret of any length is safe', () => {
        // `timingSafeEqual` throws on a length mismatch. Hashing first makes
        // both sides 64 characters whatever arrives, which is why a one-byte
        // and a one-megabyte presentation both return false rather than throw.
        const c = generateHostConsumerCredentials();
        expect(() => hostConsumerSecretMatches('x', c.secretHash)).not.toThrow();
        expect(() => hostConsumerSecretMatches('y'.repeat(100_000), c.secretHash)).not.toThrow();
        expect(hostConsumerSecretMatches('y'.repeat(100_000), c.secretHash)).toBe(false);
    });

    it('hashes stably, so a stored hash keeps matching', () => {
        expect(hashHostConsumerSecret('abc')).toBe(hashHostConsumerSecret('abc'));
        expect(hashHostConsumerSecret('abc')).not.toBe(hashHostConsumerSecret('abd'));
    });
});

describe('both gates are required (#3861)', () => {
    // The table is the assertion: only the bottom-right cell admits anything.
    // Neither gate alone does, which is the property a call site cannot be
    // trusted to remember and the reason this is one function.
    it.each([
        ['1', true, true],
        ['true', true, true],
        ['1', false, false],
        ['1', null, false],
        ['1', undefined, false],
        ['0', true, false],
        ['', true, false],
        [undefined, true, false],
        [null, true, false],
        ['yes', true, false],
        ['on', true, false],
        [undefined, false, false],
    ])('env=%p tenant=%p admits %p', (envValue, tenantEnabled, expected) => {
        expect(hostConsumersAdmitted({ envValue, tenantEnabled })).toBe(expected);
    });

    it('refuses a tenant value that is merely truthy, not true', () => {
        // Guards against a caller passing a row that was selected but not
        // coerced — `{} as boolean` is truthy and must not admit.
        expect(hostConsumersAdmitted({ envValue: '1', tenantEnabled: 1 as unknown as boolean })).toBe(false);
        expect(hostConsumersAdmitted({ envValue: '1', tenantEnabled: 'true' as unknown as boolean })).toBe(false);
    });
});

describe('the access token (#3861)', () => {
    const SECRET = 'a'.repeat(48);
    const base = {
        tenantId: 't1',
        hostConsumerId: 'hc1',
        receivingAgentId: 'agent1',
        workflowKeys: ['sap-transaction-review'],
    };

    it('mints a token that verifies back to the same claims', () => {
        const minted = mintHostConsumerToken(base, { secret: SECRET });
        expect(minted.ok).toBe(true);
        if (!minted.ok) return;
        expect(minted.expiresInSeconds).toBe(HOST_CONSUMER_TOKEN_TTL_SECONDS);
        const v = verifyHostConsumerToken(minted.token, { secret: SECRET });
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        expect(v.claims).toEqual({ ...base, jti: minted.jti });
    });

    it('fails CLOSED with no secret, on both sides', () => {
        // Never sign, never accept, rather than falling back to unsigned.
        expect(mintHostConsumerToken(base, { secret: undefined })).toEqual({
            ok: false,
            reason: 'TOKEN_SECRET_NOT_CONFIGURED',
        });
        expect(mintHostConsumerToken(base, { secret: '' })).toEqual({
            ok: false,
            reason: 'TOKEN_SECRET_NOT_CONFIGURED',
        });
        const minted = mintHostConsumerToken(base, { secret: SECRET });
        if (!minted.ok) throw new Error('unreachable');
        expect(verifyHostConsumerToken(minted.token, { secret: null })).toEqual({
            ok: false,
            reason: 'TOKEN_SECRET_NOT_CONFIGURED',
        });
    });

    it('refuses another deployment secret with a NAMED signature refusal', () => {
        const minted = mintHostConsumerToken(base, { secret: SECRET });
        if (!minted.ok) throw new Error('unreachable');
        expect(verifyHostConsumerToken(minted.token, { secret: 'b'.repeat(48) })).toEqual({
            ok: false,
            reason: 'TOKEN_BAD_SIGNATURE',
        });
    });

    it('refuses an expired token, and accepts it just before', () => {
        const now = 1_700_000_000_000;
        const minted = mintHostConsumerToken(base, { secret: SECRET, nowMs: now });
        if (!minted.ok) throw new Error('unreachable');
        const justInside = now + (HOST_CONSUMER_TOKEN_TTL_SECONDS - 5) * 1000;
        expect(verifyHostConsumerToken(minted.token, { secret: SECRET, nowMs: justInside }).ok).toBe(true);
        const past = now + (HOST_CONSUMER_TOKEN_TTL_SECONDS + 60) * 1000;
        expect(verifyHostConsumerToken(minted.token, { secret: SECRET, nowMs: past })).toEqual({
            ok: false,
            reason: 'TOKEN_EXPIRED',
        });
    });

    it('refuses an UNSIGNED token claiming alg:none', () => {
        // This asserts the BEHAVIOUR and not the pin, and the difference was
        // measured: removing `algorithms: ['HS256']` from the verify leaves
        // this test — and all the others — green, because `jsonwebtoken`
        // refuses an unsigned token whenever a secret is supplied. The pin is
        // hygiene for a future asymmetric key, with no behavioural guard; see
        // the docblock on `verifyHostConsumerToken`. Worth keeping anyway: an
        // unsigned bearer being refused is the property, however it is obtained.
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const body = Buffer.from(
            JSON.stringify({ ...base, jti: 'x', iss: HOST_CONSUMER_TOKEN_ISSUER, exp: 9_999_999_999 }),
        ).toString('base64url');
        const v = verifyHostConsumerToken(`${header}.${body}.`, { secret: SECRET });
        expect(v.ok).toBe(false);
    });

    it('refuses a token from a different issuer', () => {
        const foreign = jwt.sign(
            { ...base, jti: 'x', iss: 'someone-else', exp: Math.floor(Date.now() / 1000) + 600 },
            SECRET,
            { algorithm: 'HS256' },
        );
        expect(verifyHostConsumerToken(foreign, { secret: SECRET })).toEqual({
            ok: false,
            reason: 'TOKEN_WRONG_ISSUER',
        });
    });

    it('refuses a correctly-signed token with claims missing', () => {
        // Signed by us, so the signature and issuer pass — the refusal has to
        // come from the claim check, which is what this asserts.
        const thin = jwt.sign(
            { tenantId: 't1', iss: HOST_CONSUMER_TOKEN_ISSUER, exp: Math.floor(Date.now() / 1000) + 600 },
            SECRET,
            { algorithm: 'HS256' },
        );
        expect(verifyHostConsumerToken(thin, { secret: SECRET })).toEqual({
            ok: false,
            reason: 'TOKEN_CLAIMS_INCOMPLETE',
        });
        const badKeys = jwt.sign(
            { ...base, workflowKeys: [1, 2], jti: 'x', iss: HOST_CONSUMER_TOKEN_ISSUER, exp: Math.floor(Date.now() / 1000) + 600 },
            SECRET,
            { algorithm: 'HS256' },
        );
        expect(verifyHostConsumerToken(badKeys, { secret: SECRET })).toEqual({
            ok: false,
            reason: 'TOKEN_CLAIMS_INCOMPLETE',
        });
    });

    it('refuses rubbish without throwing', () => {
        for (const junk of ['', 'x', 'a.b.c', '....', 'not-a-jwt']) {
            expect(() => verifyHostConsumerToken(junk, { secret: SECRET })).not.toThrow();
            expect(verifyHostConsumerToken(junk, { secret: SECRET }).ok).toBe(false);
        }
    });
});
