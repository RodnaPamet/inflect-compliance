/**
 * The factory's two gates, and the properties that make the external path
 * unreachable today.
 *
 * The environment is mocked so every test can set the WORST case — every
 * credential present, the external mode requested — and still assert that nothing
 * external comes back. A test that proves `LOCAL_ONLY` is safe when no key is
 * configured proves almost nothing; the interesting question is whether a key
 * being present changes the answer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const mutableEnv: Record<string, string | undefined> = {
    // A literal in a mocked env object — no TypeSafe account stands behind it, and
    // these tests exist precisely to prove a key being PRESENT changes nothing
    // while the sub-processor is inactive.
    TYPESAFE_API_KEY: 'typesafe-test-key', // pragma: allowlist secret
    LAYA_BASE_URL: 'http://laya.internal:8080',
    LAYA_API_KEY: undefined,
};
jest.mock('@/env', () => ({ env: mutableEnv }));

import {
    getDecisionProvider,
    TYPESAFE_SUBPROCESSOR_ACTIVE,
    JEV_ENDPOINT,
    JEV_MODEL,
    LAYA_MODEL,
    JEV_TIMEOUT_MS,
    LAYA_TIMEOUT_MS,
    NoDecisionProviderError,
    type MatchState,
} from '@/app-layer/ai/identity-match';

const emptyState: MatchState = {
    account: {
        username: 'x', usernameTokens: ['x'], displayName: null, givenName: null,
        familyName: null, emailLocalPart: null, department: null, title: null,
        accountType: null, variants: [],
    },
    candidates: [],
};

beforeEach(() => {
    mutableEnv.TYPESAFE_API_KEY = 'typesafe-test-key'; // pragma: allowlist secret
    mutableEnv.LAYA_BASE_URL = 'http://laya.internal:8080';
    mutableEnv.LAYA_API_KEY = undefined;
});

describe('6b factory — the sub-processor is registered but INACTIVE', () => {
    it('TYPESAFE_SUBPROCESSOR_ACTIVE is false', () => {
        // Flipping this is a sub-processor activation, not a config change. The
        // whole "no tenant path can obtain Jev" claim rests on this literal.
        expect(TYPESAFE_SUBPROCESSOR_ACTIVE).toBe(false);
    });

    it('EXTERNAL does not yield a Jev provider, even with the key set', () => {
        const p = getDecisionProvider('EXTERNAL');
        expect(p.providerName).not.toBe('jev');
        expect(p.isExternal).toBe(false);
    });

    it('EXTERNAL falls back to the local provider rather than throwing', () => {
        // A tenant who asked for adjudication gets the privacy-preserving answer
        // or none — never an error that reads like their configuration is broken.
        expect(getDecisionProvider('EXTERNAL').providerName).toBe('laya');
    });

    it('EXTERNAL with no Laya deployed yields the stub, still not Jev', () => {
        mutableEnv.LAYA_BASE_URL = undefined;
        const p = getDecisionProvider('EXTERNAL');
        expect(p.providerName).toBe('stub');
        expect(p.isExternal).toBe(false);
    });

    it('no mode whatsoever returns an external provider while the flag is false', () => {
        for (const mode of ['OFF', 'LOCAL_ONLY', 'EXTERNAL'] as const) {
            expect(getDecisionProvider(mode).isExternal).toBe(false);
        }
    });
});

describe('6b factory — residency', () => {
    it('OFF yields the stub', () => {
        expect(getDecisionProvider('OFF').providerName).toBe('stub');
    });

    it('LOCAL_ONLY yields Laya when one is deployed', () => {
        const p = getDecisionProvider('LOCAL_ONLY');
        expect(p.providerName).toBe('laya');
        expect(p.modelName).toBe(LAYA_MODEL);
        expect(p.isExternal).toBe(false);
    });

    it('LOCAL_ONLY yields the stub when no Laya is deployed — never an external fallback', () => {
        mutableEnv.LAYA_BASE_URL = undefined;
        expect(getDecisionProvider('LOCAL_ONLY').providerName).toBe('stub');
    });

    it('LOCAL_ONLY ignores TYPESAFE_API_KEY entirely', () => {
        mutableEnv.TYPESAFE_API_KEY = 'a-very-real-key'; // pragma: allowlist secret
        mutableEnv.LAYA_BASE_URL = undefined;
        // The worst case: external credential present, no local server. Still stub.
        expect(getDecisionProvider('LOCAL_ONLY').providerName).toBe('stub');
    });
});

describe('6b factory — the stub answers nothing, ever', () => {
    it('rejects rather than returning a neutral verdict', async () => {
        // A neutral answer would still be a verdict, recorded as the model's
        // opinion, and an evaluation record over stub answers would describe a
        // model nobody ran.
        mutableEnv.LAYA_BASE_URL = undefined;
        const p = getDecisionProvider('OFF');
        await expect(p.adjudicate(emptyState, { deadlineAt: Date.now() + 1000 })).rejects.toBeInstanceOf(
            NoDecisionProviderError
        );
    });

    it('no verdict can be derived from it — there is no answer to read', async () => {
        const p = getDecisionProvider('OFF');
        let answered = false;
        try {
            const r = await p.adjudicate(emptyState, { deadlineAt: Date.now() + 1000 });
            answered = r !== undefined;
        } catch {
            answered = false;
        }
        expect(answered).toBe(false);
    });

    it('says in its message that this is the safe default', async () => {
        const p = getDecisionProvider('OFF');
        await expect(
            p.adjudicate(emptyState, { deadlineAt: Date.now() + 1000 })
        ).rejects.toThrow(/review queue/);
    });
});

describe('6b factory — the Jev host is a code constant', () => {
    const JEV_SRC = path.resolve(__dirname, '../../src/app-layer/ai/identity-match/jev-provider.ts');

    it('is the documented endpoint', () => {
        expect(JEV_ENDPOINT).toBe('https://api.typesafe.ai/v1/systemone');
    });

    it('no environment variable appears in the URL the provider posts to', () => {
        const src = fs.readFileSync(JEV_SRC, 'utf8');
        // The constant is a plain literal: no interpolation, no env read.
        expect(src).toMatch(/export const JEV_ENDPOINT = 'https:\/\/api\.typesafe\.ai\/v1\/systemone';/);
        // `env` is read in this file for the KEY only. Assert the URL constant is
        // not built from it, which a template literal would allow.
        const endpointLine = src.split('\n').find((l) => l.includes('JEV_ENDPOINT ='))!;
        expect(endpointLine).not.toContain('`');
        expect(endpointLine).not.toContain('env.');
        expect(endpointLine).not.toContain('process.env');
    });

    it('pins the model to the identifier the vendor reference lists', () => {
        // jev-1.13.0, not jev-1.13 — the design table said the latter and the
        // reference won. A wrong model string would have failed nothing until
        // somebody activated the sub-processor.
        expect(JEV_MODEL).toBe('jev-1.13.0');
    });

    it('does not pin an alias, which would move under a committed record', () => {
        expect(JEV_MODEL).not.toContain('latest');
        expect(JEV_MODEL).not.toContain('preview');
    });

    it('gives the local path a tighter timeout than the external one', () => {
        expect(LAYA_TIMEOUT_MS).toBeLessThan(JEV_TIMEOUT_MS);
        expect(JEV_TIMEOUT_MS).toBe(3_000);
        expect(LAYA_TIMEOUT_MS).toBe(2_000);
    });
});
