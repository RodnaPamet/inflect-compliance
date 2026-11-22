/**
 * Web Bot Auth Phase 1 — the conformance vector set (`evals/web-bot-auth/vectors.json`).
 *
 * External vectors reproduce a published value byte for byte (RFC 8032, 8037,
 * 9421). Regression vectors pin the directory this implementation serves, and
 * are judged by an INDEPENDENT verifier (`tests/helpers/web-bot-auth-verifier.ts`),
 * never by the signer that produced them.
 */
import { createPrivateKey, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { signedDirectoryResponse } from '@/lib/web-bot-auth/directory';
import { ed25519JwkThumbprint, webBotAuthKeyFromSeed } from '@/lib/web-bot-auth/key';
import { joinMembers, signMember } from '@/lib/web-bot-auth/message-signature';
import { checkWebBotAuthSeed, PUBLISHED_TEST_SEEDS_HEX } from '@/lib/web-bot-auth/seed';

import { independentThumbprint, verifyDirectoryResponse } from '../../helpers/web-bot-auth-verifier';

interface Vectors {
    thumbprints: { jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string }; thumbprint: string }[];
    keys: { seedHex: string; x: string; keyid: string }[];
    ed25519: { seedHex: string; messageHex: string; signatureHex: string }[];
    messageSignatures: {
        seedHex: string;
        label: string;
        components: { name: string; value: string }[];
        params: { created: number; keyid: string };
        base: string;
        signatureInput: string;
        signature: string;
    }[];
    directories: {
        source: string;
        currentSeedHex: string;
        previousSeedHex?: string;
        authority: string;
        now: number;
        body: string;
        signatureInput: string;
        signature: string;
    }[];
}

const vectors = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../evals/web-bot-auth/vectors.json'), 'utf8'),
) as Vectors;

const keyOf = (seedHex: string) => {
    const k = webBotAuthKeyFromSeed(seedHex);
    if (!k) throw new Error('vector seed did not build a key');
    return k;
};

describe('keyid is the RFC 7638 JWK thumbprint', () => {
    it.each(vectors.thumbprints)('reproduces the published thumbprint $thumbprint', (v) => {
        expect(ed25519JwkThumbprint(v.jwk)).toBe(v.thumbprint);
        expect(independentThumbprint(v.jwk)).toBe(v.thumbprint);
    });

    it('ignores non-required members such as kid', () => {
        const v = vectors.thumbprints[0];
        expect(ed25519JwkThumbprint({ ...v.jwk, kid: 'anything' } as typeof v.jwk)).toBe(v.thumbprint);
    });

    it.each(vectors.keys)('a seed builds the published public key and keyid $keyid', (v) => {
        const k = keyOf(v.seedHex);
        expect(k.publicJwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: v.x });
        expect(k.keyid).toBe(v.keyid);
    });
});

describe('Ed25519 signing reproduces RFC 8032', () => {
    it.each(vectors.ed25519)('signature over the test message', (v) => {
        const k = keyOf(v.seedHex);
        expect(sign(null, Buffer.from(v.messageHex, 'hex'), k.privateKey).toString('hex')).toBe(v.signatureHex);
    });
});

describe('the RFC 9421 signature base and members reproduce byte for byte', () => {
    it.each(vectors.messageSignatures)('$label', (v) => {
        const k = keyOf(v.seedHex);
        const m = signMember(v.label, v.components, v.params, k.privateKey);
        expect(m.base).toBe(v.base);
        expect(m.signatureInput).toBe(v.signatureInput);
        expect(m.signature).toBe(v.signature);
        expect(joinMembers([m])).toEqual({ signatureInput: v.signatureInput, signature: v.signature });
    });
});

describe('the served directory', () => {
    it.each(vectors.directories)('matches its regression vector ($source)', (v) => {
        const keys = v.previousSeedHex
            ? { current: keyOf(v.currentSeedHex), previous: keyOf(v.previousSeedHex) }
            : { current: keyOf(v.currentSeedHex) };
        const s = signedDirectoryResponse(keys, v.authority, v.now);
        expect(s.body).toBe(v.body);
        expect(s.headers['Signature-Input']).toBe(v.signatureInput);
        expect(s.headers.Signature).toBe(v.signature);
    });

    it.each(vectors.directories)('every published key carries a signature an independent verifier accepts', (v) => {
        const verdict = verifyDirectoryResponse({ ...v, now: v.now + 1 });
        expect(verdict.failures).toEqual([]);
        const published = (JSON.parse(v.body) as { keys: Record<string, unknown>[] }).keys.map(independentThumbprint);
        expect([...verdict.verifiedKeyids].sort()).toEqual([...published].sort());
    });

    it.each(vectors.directories)('a directory fetched from another authority does not verify', (v) => {
        const verdict = verifyDirectoryResponse({ ...v, authority: 'impostor.example.net', now: v.now + 1 });
        expect(verdict.verifiedKeyids).toEqual([]);
    });

    it('a signature past its expiry does not verify', () => {
        const v = vectors.directories[0];
        const verdict = verifyDirectoryResponse({ ...v, now: v.now + 3600 });
        expect(verdict.verifiedKeyids).toEqual([]);
    });
});

describe('every key in the vector set is refused as a production identity', () => {
    const seeds = [
        ...vectors.keys.map((v) => v.seedHex),
        ...vectors.ed25519.map((v) => v.seedHex),
        ...vectors.messageSignatures.map((v) => v.seedHex),
        ...vectors.directories.flatMap((v) => [v.currentSeedHex, ...(v.previousSeedHex ? [v.previousSeedHex] : [])]),
    ];

    it.each([...new Set(seeds)])('%s', (seedHex) => {
        expect(PUBLISHED_TEST_SEEDS_HEX).toContain(seedHex);
        expect(
            checkWebBotAuthSeed({ seed: seedHex, dataEncryptionKeys: [], refusePublishedTestSeeds: true }),
        ).toBe('PUBLISHED_TEST_SEED');
    });

    it('the PKCS#8 seed of RFC 9421 test-key-ed25519 is the published one', () => {
        // Ties the hex in the vector file to the RFC's own key encoding.
        const pk = createPrivateKey({
            key: Buffer.from('302e020100300506032b657004220420' + vectors.messageSignatures[0].seedHex, 'hex'),
            format: 'der',
            type: 'pkcs8',
        });
        expect(pk.export({ format: 'jwk' }).d).toBe('n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU');
    });
});
