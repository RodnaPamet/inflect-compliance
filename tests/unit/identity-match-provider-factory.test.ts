/**
 * The factory's two gates, and what each mode can and cannot reach.
 *
 * The external path IS reachable since 2026-10-11 (`TYPESAFE_SUBPROCESSOR_ACTIVE`
 * is `true`). What this file asserted before that date — that nothing external
 * comes back whatever the configuration — is no longer true and has been
 * replaced rather than inverted; see the first describe block.
 *
 * The environment is still mocked so every test can set the WORST case — every
 * credential present, the external mode requested. Before activation that was
 * how "nothing external comes back" got proved. After activation it is how the
 * remaining boundary gets proved: `OFF` and `LOCAL_ONLY` must stay local *with a
 * usable TypeSafe key sitting right there*. A test that proves `LOCAL_ONLY` is
 * safe when no key is configured still proves almost nothing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { declarationOf } from '../helpers/source-blocks';

const mutableEnv: Record<string, string | undefined> = {
    // A literal in a mocked env object — no TypeSafe account stands behind it.
    // Since activation its presence DOES change the answer for `EXTERNAL`, which
    // is the point; what it must still not change is `OFF` and `LOCAL_ONLY`.
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

describe('6b factory — the sub-processor is ACTIVE (owner decision 2026-10-11)', () => {
    // These five replace the five that asserted the INACTIVE invariant. They are
    // deliberately NOT the old assertions with their polarity flipped: two of the
    // old five protected something that still holds after activation, and those
    // are kept intact below. What is gone is only the claim that the external
    // path is unreachable, which stopped being true.
    //
    // The literal-pinning test is NOT re-pinned at `true`. See the register
    // agreement test in
    // `tests/guardrails/sub-processor-record-agrees-with-code.test.ts`: pinning a
    // constant against itself notices a flip but cannot notice the register and
    // the code disagreeing, which is the failure that actually reaches a customer.

    it('EXTERNAL with the key set yields Jev — this is what activation means', () => {
        const p = getDecisionProvider('EXTERNAL');
        expect(p.providerName).toBe('jev');
        expect(p.isExternal).toBe(true);
    });

    it('EXTERNAL without the key falls back to the local provider rather than throwing', () => {
        // Unchanged in spirit from the inactive era, and still the reason it is
        // written this way: a tenant who asked for adjudication gets the
        // privacy-preserving answer or none, never an error that reads like their
        // configuration is broken. The flag alone moves no data — the KEY does.
        mutableEnv.TYPESAFE_API_KEY = undefined;
        expect(getDecisionProvider('EXTERNAL').providerName).toBe('laya');
    });

    it('EXTERNAL with neither the key nor a Laya yields the stub', () => {
        mutableEnv.TYPESAFE_API_KEY = undefined;
        mutableEnv.LAYA_BASE_URL = undefined;
        const p = getDecisionProvider('EXTERNAL');
        expect(p.providerName).toBe('stub');
        expect(p.isExternal).toBe(false);
    });

    it('ONLY EXTERNAL can go external — activation does not widen OFF or LOCAL_ONLY', () => {
        // The surviving half of 'no mode whatsoever returns an external provider'.
        // That test's value was never the flag; it was that the MODE decides, and
        // a present credential does not promote a mode that did not ask for it.
        // The worst case is set up in beforeEach: key present, Laya present.
        for (const mode of ['OFF', 'LOCAL_ONLY'] as const) {
            expect(getDecisionProvider(mode).isExternal).toBe(false);
            expect(getDecisionProvider(mode).providerName).not.toBe('jev');
        }
        // The positive control. Without it a loop over an empty or mistyped mode
        // list passes while proving nothing, and a factory that had been broken
        // into returning the stub for everything would look like a success.
        expect(getDecisionProvider('EXTERNAL').isExternal).toBe(true);
    });

    it('the flag is what the gate reads, so the two cannot be reasoned about separately', () => {
        // Keeps one line of the deleted literal test: that this binding is the
        // one the factory consults. It asserts the LINK, not the value.
        expect(typeof TYPESAFE_SUBPROCESSOR_ACTIVE).toBe('boolean');
        expect(getDecisionProvider('EXTERNAL').isExternal).toBe(TYPESAFE_SUBPROCESSOR_ACTIVE);
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
        // NARROWED to the declaration rather than asserted against the whole file.
        // Two reasons, and the ratchet that caught it was right about both: a
        // whole-file `toMatch` is satisfied by any line, so deleting this constant
        // and adding a configurable one elsewhere keeps it green; and
        // `raw-source-assertion-ratchet` is a DOWNWARD ratchet standing at two
        // files, so adding a third was the wrong way to make it pass.
        const decl = declarationOf(fs.readFileSync(JEV_SRC, 'utf8'), 'JEV_ENDPOINT');
        // The narrowing must have found something: an empty extraction satisfies
        // every negative assertion below.
        expect(decl.length).toBeGreaterThan(20);
        expect(decl).toContain('api.typesafe.ai/v1/systemone');
        // A template literal, an `env.` read or a `process.env` read would each
        // make the destination configurable. None may appear in the declaration.
        expect(decl).not.toContain('`');
        expect(decl).not.toContain('env.');
        expect(decl).not.toContain('process.env');
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
