/**
 * WEB BOT AUTH — the deployment's signing seed, as configured (Phase 1, D-L1-5).
 *
 * Pure, and free of `Buffer` and `node:crypto` on purpose: `src/env.ts` imports
 * this module to refuse a bad seed at startup, and `env.ts` is loaded by the
 * Edge middleware, where neither is guaranteed.
 *
 * ONE KEY PER DEPLOYMENT, NEVER PER TENANT. A monitored vendor must not learn
 * which customer monitors it, so the signing identity is Inflect's crawler and
 * nothing else. This is the opposite of the A2A rule ("no deployment key"),
 * for the opposite reason, and neither rule is to be harmonised into the other
 * (docs/ai-architecture/web-bot-auth.md, D-L1-5).
 *
 * The seed is a credential: env-held like the master KEK, never in the
 * database, never logged. Nothing here returns or formats it.
 */

/** The two variables, named once so the refusal messages and the loader agree. */
export const WEB_BOT_AUTH_SIGNING_KEY_VAR = 'WEB_BOT_AUTH_SIGNING_KEY';
export const WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY_VAR = 'WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY';

/**
 * Seeds published in RFCs and in this repository's own conformance vectors
 * (`evals/web-bot-auth/vectors.json`). Anybody can sign as a key built from one
 * of these, so a production deployment configured with one has no identity at
 * all. Hex, lower case.
 */
export const PUBLISHED_TEST_SEEDS_HEX: readonly string[] = Object.freeze([
    // RFC 8032 §7.1 TEST 1, which is also RFC 8037 Appendix A.1's key.
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    // RFC 9421 Appendix B.1.4 `test-key-ed25519` (the key Cloudflare's
    // web-bot-auth examples sign with).
    '9f8362f87a484a954e6e740c5b4c0e84229139a20aa8ab56ff66586f6a7d29c5',
]);

const HEX_SEED = /^[0-9a-fA-F]{64}$/;
// 32 bytes is 43 base64 characters plus one '=' of padding; base64url drops it.
const BASE64URL_SEED = /^[A-Za-z0-9_-]{43}$/;
const BASE64_SEED = /^[A-Za-z0-9+/]{43}=$/;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function decodeBase64Strict(s: string, alphabet62: string, alphabet63: string): Uint8Array | null {
    const body = s.replace(/=+$/, '');
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of body) {
        let idx = B64_ALPHABET.indexOf(ch);
        if (idx < 0) {
            if (ch === alphabet62) idx = 62;
            else if (ch === alphabet63) idx = 63;
            else return null;
        }
        value = (value << 6) | idx;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((value >> bits) & 0xff);
        }
    }
    // A canonical encoding leaves no set bits behind; a non-canonical one is
    // a second spelling of the same key, which this module does not accept.
    if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
    return Uint8Array.from(out);
}

/**
 * Decode a configured seed: exactly 32 bytes, as 64 hex characters, as unpadded
 * base64url, or as padded standard base64. Anything else is `null` — no
 * trimming of interior junk, no lenient base64 that skips characters it does
 * not know, because a seed read two ways is two keys.
 */
export function decodeWebBotAuthSeed(material: string | undefined | null): Uint8Array | null {
    if (typeof material !== 'string') return null;
    const s = material.trim();
    let bytes: Uint8Array | null = null;
    if (HEX_SEED.test(s)) {
        bytes = Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
    } else if (BASE64URL_SEED.test(s)) {
        bytes = decodeBase64Strict(s, '-', '_');
    } else if (BASE64_SEED.test(s)) {
        bytes = decodeBase64Strict(s, '+', '/');
    }
    if (!bytes || bytes.length !== 32) return null;
    // An all-zero seed is a placeholder, not a key.
    if (bytes.every((b) => b === 0)) return null;
    return bytes;
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Why a configured seed is refused. Names a reason, never the value. */
export type SeedRefusal =
    | 'MALFORMED'
    | 'EQUALS_DATA_ENCRYPTION_KEY'
    | 'EQUALS_CURRENT_SIGNING_KEY'
    | 'PUBLISHED_TEST_SEED';

export interface SeedCheckInput {
    /** The seed under check. */
    readonly seed: string;
    /** The other secrets it must not equal. */
    readonly dataEncryptionKeys: readonly (string | undefined)[];
    /** For the previous key: the current one, which it must differ from. */
    readonly currentSigningKey?: string;
    /** Refuse the RFC / vector seeds (production). */
    readonly refusePublishedTestSeeds: boolean;
}

/**
 * Refuse a seed that is malformed, reused from another purpose, the same as
 * the current key, or a published test seed. A key reused across purposes is a
 * key whose compromise spreads, so "equal" is judged on the raw string AND on
 * the decoded bytes: the same 32 bytes spelled in hex and in base64 are one key.
 */
export function checkWebBotAuthSeed(input: SeedCheckInput): SeedRefusal | null {
    const bytes = decodeWebBotAuthSeed(input.seed);
    if (!bytes) return 'MALFORMED';
    const hex = toHex(bytes);
    const sameSecret = (other: string | undefined): boolean => {
        if (!other) return false;
        if (other.trim() === input.seed.trim()) return true;
        const otherBytes = decodeWebBotAuthSeed(other);
        return !!otherBytes && toHex(otherBytes) === hex;
    };
    if (input.dataEncryptionKeys.some(sameSecret)) return 'EQUALS_DATA_ENCRYPTION_KEY';
    if (input.currentSigningKey !== undefined && sameSecret(input.currentSigningKey)) {
        return 'EQUALS_CURRENT_SIGNING_KEY';
    }
    if (input.refusePublishedTestSeeds && PUBLISHED_TEST_SEEDS_HEX.includes(hex)) {
        return 'PUBLISHED_TEST_SEED';
    }
    return null;
}

const REFUSAL_SENTENCE: Record<SeedRefusal, string> = {
    MALFORMED:
        'is not a 32-byte Ed25519 seed (64 hex characters, or 32 bytes in base64url or base64). ' +
        'Generate one with: openssl rand -hex 32',
    EQUALS_DATA_ENCRYPTION_KEY:
        'equals DATA_ENCRYPTION_KEY or DATA_ENCRYPTION_KEY_PREVIOUS. A key reused across purposes ' +
        'is a key whose compromise spreads; generate a separate one.',
    EQUALS_CURRENT_SIGNING_KEY:
        `equals ${WEB_BOT_AUTH_SIGNING_KEY_VAR}. The previous key is the one being rotated out; ` +
        'unset it rather than repeat the current one.',
    PUBLISHED_TEST_SEED:
        'is a published test seed (an RFC example or this repository\'s conformance vectors). ' +
        'Anybody can sign as it; generate a real one.',
};

/** The startup refusal sentence. Names the variable and the reason, never the value. */
export function seedRefusalMessage(variable: string, refusal: SeedRefusal): string {
    return `${variable} ${REFUSAL_SENTENCE[refusal]}`;
}
