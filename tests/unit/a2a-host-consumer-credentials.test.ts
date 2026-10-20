import {
    HOST_CONSUMER_CLIENT_PREFIX,
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
