/**
 * Web Bot Auth Phase 1 — the deployment key is read strictly, refused when it
 * is another purpose's secret, built from configuration alone, and never
 * logged. Absent configuration builds nothing (G9).
 */
const logged: unknown[][] = [];
jest.mock('@/lib/observability', () => ({
    logger: {
        info: (...a: unknown[]) => logged.push(a),
        warn: (...a: unknown[]) => logged.push(a),
        error: (...a: unknown[]) => logged.push(a),
        debug: (...a: unknown[]) => logged.push(a),
    },
}));

import { webBotAuthDirectoryConfigFrom } from '@/lib/web-bot-auth/config';
import { directoryAuthorityFrom } from '@/lib/web-bot-auth/directory';
import { webBotAuthKeyFromSeed } from '@/lib/web-bot-auth/key';
import { signatureBase } from '@/lib/web-bot-auth/message-signature';
import { checkWebBotAuthSeed, decodeWebBotAuthSeed } from '@/lib/web-bot-auth/seed';

// Fixture seeds, not credentials.
const SEED_HEX = '4f3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e'; // pragma: allowlist secret
const OTHER_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // pragma: allowlist secret
const asB64url = (hex: string) => Buffer.from(hex, 'hex').toString('base64url');
const asB64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

beforeEach(() => {
    logged.length = 0;
});

describe('a seed is read one way only', () => {
    it('accepts hex, base64url and padded base64 spellings of the same 32 bytes as one key', () => {
        const a = webBotAuthKeyFromSeed(SEED_HEX)!;
        expect(webBotAuthKeyFromSeed(asB64url(SEED_HEX))!.keyid).toBe(a.keyid);
        expect(webBotAuthKeyFromSeed(asB64(SEED_HEX))!.keyid).toBe(a.keyid);
    });

    it.each([
        ['too short', SEED_HEX.slice(2)],
        ['too long', SEED_HEX + '00'],
        ['hex with junk', SEED_HEX.slice(0, 63) + 'z'],
        ['base64 with an unknown character', asB64url(SEED_HEX).slice(0, 42) + '!'],
        ['base64 that a lenient decoder would accept', `${asB64(SEED_HEX).slice(0, 20)} ${asB64(SEED_HEX).slice(20)}`],
        ['a non-canonical base64url spelling', asB64url(SEED_HEX).slice(0, 42) + 'B'],
        ['all zeroes', '0'.repeat(64)],
        ['empty', ''],
    ])('refuses %s', (_label, material) => {
        // `B` replacing the canonical last char flips a padding bit, unless it already was `B`.
        if (material === asB64url(SEED_HEX)) return;
        expect(decodeWebBotAuthSeed(material)).toBeNull();
        expect(webBotAuthKeyFromSeed(material)).toBeNull();
    });
});

describe('a key reused across purposes is refused', () => {
    it('refuses the DATA_ENCRYPTION_KEY however it is spelled', () => {
        for (const spelling of [SEED_HEX, asB64url(SEED_HEX), asB64(SEED_HEX)]) {
            expect(
                checkWebBotAuthSeed({ seed: SEED_HEX, dataEncryptionKeys: [spelling], refusePublishedTestSeeds: false }),
            ).toBe('EQUALS_DATA_ENCRYPTION_KEY');
        }
        expect(
            checkWebBotAuthSeed({ seed: SEED_HEX, dataEncryptionKeys: [undefined, SEED_HEX], refusePublishedTestSeeds: false }),
        ).toBe('EQUALS_DATA_ENCRYPTION_KEY');
    });

    it('refuses a previous key equal to the current one', () => {
        expect(
            checkWebBotAuthSeed({
                seed: asB64url(SEED_HEX),
                dataEncryptionKeys: [],
                currentSigningKey: SEED_HEX,
                refusePublishedTestSeeds: false,
            }),
        ).toBe('EQUALS_CURRENT_SIGNING_KEY');
    });

    it('admits a distinct, well-formed seed', () => {
        expect(
            checkWebBotAuthSeed({ seed: SEED_HEX, dataEncryptionKeys: [OTHER_HEX], refusePublishedTestSeeds: true }),
        ).toBeNull();
    });
});

describe('absent configuration builds nothing (G9)', () => {
    const base = { NODE_ENV: 'production', APP_URL: 'https://app.example.com', DATA_ENCRYPTION_KEY: OTHER_HEX };

    it('no seed: no configuration', () => {
        expect(webBotAuthDirectoryConfigFrom({ ...base })).toBeNull();
    });

    it.each([
        ['unset', undefined],
        ['plain http', 'http://app.example.com'],
        ['with a path', 'https://app.example.com/inflect'],
        ['with credentials', 'https://user:pw@app.example.com'],
        ['not a URL', 'app.example.com'],
    ])('no bare https origin (%s): no configuration', (_l, appUrl) => {
        expect(webBotAuthDirectoryConfigFrom({ ...base, APP_URL: appUrl, WEB_BOT_AUTH_SIGNING_KEY: SEED_HEX })).toBeNull();
    });

    it('a refused seed publishes nothing, fails closed', () => {
        expect(
            webBotAuthDirectoryConfigFrom({ ...base, WEB_BOT_AUTH_SIGNING_KEY: OTHER_HEX }),
        ).toBeNull();
    });

    it('a refused previous key leaves the current key published alone', () => {
        const cfg = webBotAuthDirectoryConfigFrom({
            ...base,
            WEB_BOT_AUTH_SIGNING_KEY: SEED_HEX,
            WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY: SEED_HEX,
        });
        expect(cfg?.keys.previous).toBeUndefined();
        expect(cfg?.keys.current.keyid).toBe(webBotAuthKeyFromSeed(SEED_HEX)!.keyid);
    });

    it('configured: the authority is the configured origin, default port dropped', () => {
        const cfg = webBotAuthDirectoryConfigFrom({
            ...base,
            APP_URL: 'https://App.Example.com:443/',
            WEB_BOT_AUTH_SIGNING_KEY: SEED_HEX,
            WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY: OTHER_HEX.replace(/^0/, '1'),
        });
        expect(cfg?.authority).toBe('app.example.com');
        expect(cfg?.keys.previous).toBeDefined();
        expect(directoryAuthorityFrom('https://app.example.com:8443')).toBe('app.example.com:8443');
    });

    it('never logs a seed, current or previous', () => {
        webBotAuthDirectoryConfigFrom({ ...base, WEB_BOT_AUTH_SIGNING_KEY: OTHER_HEX });
        webBotAuthDirectoryConfigFrom({ ...base, WEB_BOT_AUTH_SIGNING_KEY: SEED_HEX, WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY: SEED_HEX });
        webBotAuthDirectoryConfigFrom({ ...base, WEB_BOT_AUTH_SIGNING_KEY: 'zz' + SEED_HEX });
        expect(logged.length).toBeGreaterThanOrEqual(3);
        const text = JSON.stringify(logged);
        for (const s of [SEED_HEX, OTHER_HEX, asB64url(SEED_HEX)]) expect(text).not.toContain(s);
    });
});

describe('the signature base cannot be forged by a component value', () => {
    it.each(['a\nb', 'a\r\nb', 'café', 'a\u0000b'])('refuses %j', (value) => {
        expect(() =>
            signatureBase([{ name: '@authority', value }], { created: 1, keyid: 'k' }),
        ).toThrow(/outside visible ASCII/);
    });

    it('refuses an expiry that is not after creation', () => {
        expect(() =>
            signatureBase([{ name: '@authority', value: 'a' }], { created: 10, expires: 10, keyid: 'k' }),
        ).toThrow(/expires must be after created/);
    });
});
