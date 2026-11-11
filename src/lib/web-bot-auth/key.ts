/**
 * WEB BOT AUTH — the deployment key: seed to Ed25519 key, public JWK, and the
 * RFC 7638 thumbprint that serves as `keyid` (Phase 1).
 *
 * Pure (`node:crypto` only). Built the way `src/lib/agentic/a2a/signing-key.ts`
 * builds a tenant's A2A key — a raw 32-byte seed wrapped in the RFC 8410 PKCS#8
 * prefix — but this key belongs to the DEPLOYMENT (D-L1-5), and nothing here
 * takes a tenant.
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

import { decodeWebBotAuthSeed } from './seed';

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The public half as published in the directory: RFC 8037 OKP, required members only. */
export interface Ed25519PublicJwk {
    readonly kty: 'OKP';
    readonly crv: 'Ed25519';
    /** The raw 32-byte public key, base64url without padding. */
    readonly x: string;
}

export interface WebBotAuthKey {
    readonly privateKey: KeyObject;
    readonly publicJwk: Ed25519PublicJwk;
    /** RFC 7638 JWK SHA-256 thumbprint of `publicJwk`, base64url — the `keyid`. */
    readonly keyid: string;
}

/**
 * RFC 7638 §3 thumbprint of an Ed25519 OKP key: SHA-256 over the JSON object
 * holding ONLY the required members, in lexicographic order, with no
 * whitespace — `{"crv":"Ed25519","kty":"OKP","x":"…"}` (RFC 8037 §2) — and the
 * digest base64url-encoded without padding. Any other member (`kid`, `use`,
 * `alg`) is excluded by construction, so it cannot shift the thumbprint.
 */
export function ed25519JwkThumbprint(jwk: Pick<Ed25519PublicJwk, 'crv' | 'kty' | 'x'>): string {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)) {
        throw new Error('ed25519JwkThumbprint: not an Ed25519 OKP public key');
    }
    const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`;
    return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/** Build the deployment key from a configured seed; `null` for anything that is not one. */
export function webBotAuthKeyFromSeed(material: string | undefined | null): WebBotAuthKey | null {
    const seed = decodeWebBotAuthSeed(material);
    if (!seed) return null;
    try {
        const privateKey = createPrivateKey({
            key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
            format: 'der',
            type: 'pkcs8',
        });
        const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
        const x = Buffer.from(spki.subarray(spki.length - 32)).toString('base64url');
        const publicJwk: Ed25519PublicJwk = Object.freeze({ kty: 'OKP', crv: 'Ed25519', x });
        return Object.freeze({ privateKey, publicJwk, keyid: ed25519JwkThumbprint(publicJwk) });
    } catch {
        return null;
    }
}
