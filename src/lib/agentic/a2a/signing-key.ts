/**
 * A2A SIGNING KEY MATERIAL (#3679): build an Ed25519 key from a 32-byte seed,
 * and mint a fresh seed.
 *
 * Pure. WHERE a key lives is decided elsewhere: each tenant has its own key,
 * stored in `TenantA2aSigningKey` with the seed encrypted under the tenant's
 * DEK (owner decision 2026-10-19), and `usecases/a2a-signing-key.ts` is the
 * only module that reads or writes it. There is no deployment-wide key and no
 * development fallback: a well-known signing key would let anybody mint a
 * receipt that verifies as a tenant's, so a tenant without a key signs nothing
 * and every A2A path treats that as a refusal (`NO_SIGNING_KEY`).
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface A2aSigningKey {
    readonly privateKey: KeyObject;
    /** The raw 32-byte public key, hex — what a peer registers. */
    readonly publicKeyHex: string;
    /** SPKI SHA-256, hex — the same derivation `PeerAgent.signingKeyFingerprint` uses. */
    readonly fingerprint: string;
}

function decodeSeed(material: string): Buffer | null {
    const trimmed = material.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
    try {
        const b = Buffer.from(trimmed, 'base64');
        return b.length === 32 ? b : null;
    } catch {
        return null;
    }
}

/** Build the key from a seed. Exported for the fake peer in tests, which signs the same way. */
export function a2aSigningKeyFromSeed(material: string): A2aSigningKey | null {
    const seed = decodeSeed(material);
    if (!seed) return null;
    try {
        const privateKey = createPrivateKey({
            key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
            format: 'der',
            type: 'pkcs8',
        });
        const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
        return {
            privateKey,
            publicKeyHex: Buffer.from(spki.subarray(spki.length - 32)).toString('hex'),
            fingerprint: createHash('sha256').update(spki).digest('hex'),
        };
    } catch {
        return null;
    }
}

/** A fresh 32-byte seed, hex. Only the key's own usecase stores one. */
export function mintA2aSigningSeed(): string {
    return randomBytes(32).toString('hex');
}
