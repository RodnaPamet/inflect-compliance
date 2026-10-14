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
import { LAYA_CHOOSER_TIMEOUT_MS } from '@/app-layer/ai/intent/laya-chooser';
import { LAYA_MODEL as WIRE_LAYA_MODEL, REQUESTS_IN_FLIGHT } from '@/app-layer/ai/identity-match/systemone-wire';

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

describe('6b factory — the sub-processor is WITHDRAWN (owner decision 2026-10-14)', () => {
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

    it('EXTERNAL does NOT yield Jev, even with the key set — this is what withdrawal means', () => {
        // The key is present in `beforeEach`. That is the whole point: the
        // credential is not what gates the transfer, the constant is. A reader
        // who removes the key and concludes the path is shut has checked the
        // wrong thing.
        const p = getDecisionProvider('EXTERNAL');
        expect(p.providerName).not.toBe('jev');
        expect(p.isExternal).toBe(false);
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

    it('NO mode goes external now, and the mode is still what the factory reads', () => {
        // The worst case is set up in `beforeEach`: key present, Laya present.
        for (const mode of ['OFF', 'LOCAL_ONLY', 'EXTERNAL'] as const) {
            expect(getDecisionProvider(mode).isExternal).toBe(false);
            expect(getDecisionProvider(mode).providerName).not.toBe('jev');
        }

        // THE POSITIVE CONTROL HAD TO CHANGE, and the old one is worth recording
        // because its replacement is weaker in one way and stronger in another.
        //
        // It used to be `getDecisionProvider('EXTERNAL').isExternal === true` —
        // which proved the loop was not vacuous by showing the factory COULD
        // return something external. With the sub-processor withdrawn no mode
        // can, so that control is unavailable: it would now assert the very
        // thing the withdrawal removed.
        //
        // What is left is discrimination. If the factory had been broken into
        // returning one provider for everything, the loop above would pass while
        // proving nothing at all — so the control is that two modes still give
        // DIFFERENT answers, which no constant-returning stub can fake.
        expect(getDecisionProvider('OFF').providerName).toBe('stub');
        expect(getDecisionProvider('LOCAL_ONLY').providerName).toBe('laya');
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

    it('bounds the local path by what the hardware MEASURES, not by how far the packet travels', () => {
        // REPLACES 'gives the local path a tighter timeout than the external
        // one'. That invariant read well and measurement refuted it: on the
        // deployed VM one adjudication is p50 7,332 ms / p95 7,727 ms (#3445),
        // because it is CPU inference on two shared cores — where Jev's 3 s
        // buys a round trip to GPU-backed inference. Holding the local path to
        // 2 s made LOCAL_ONLY return TIMEOUT for every call, which is the
        // opposite of preferring it.
        expect(JEV_TIMEOUT_MS).toBe(3_000);
        expect(LAYA_TIMEOUT_MS).toBe(12_000);

        // The property that actually matters, stated against the measurement
        // rather than against the other provider: it must clear the measured
        // p95 with real headroom or the provider cannot answer at all.
        const MEASURED_P95_MS = 7_727;
        expect(LAYA_TIMEOUT_MS).toBeGreaterThan(MEASURED_P95_MS);
        expect(LAYA_TIMEOUT_MS / MEASURED_P95_MS).toBeGreaterThan(1.25);
    });

    it('keeps the intent chooser on its own tight budget, so the raise cannot leak', () => {
        // The split of 2026-10-12. One constant served adjudication (p50 7.3 s)
        // and the intent chooser (p50 206 ms for three options, #3394). Raising
        // the shared value would have taken the USER-FACING compose route's
        // ceiling from 6 s to 36 s, so the constant was split instead. This
        // test is what notices them being merged back.
        expect(LAYA_CHOOSER_TIMEOUT_MS).toBe(2_000);
        expect(LAYA_CHOOSER_TIMEOUT_MS).toBeLessThan(LAYA_TIMEOUT_MS);
        // And it must stay inside the measured 20-option worst case (719 ms)
        // with margin — the reason 2 s was right for this path all along.
        expect(LAYA_CHOOSER_TIMEOUT_MS).toBeGreaterThan(719 * 2);
    });
});

describe('6b — the per-call timeout and the configured concurrency must compose (#3450)', () => {
    /**
     * MEASURED on the production VM, 2026-10-12: digest-pinned image, the
     * Compose service's own limits, the real `buildMatchRequest` payload with
     * five candidates. Per-call p50 against requests in flight.
     *
     * Throughput was flat across all three (0.233 / 0.243 / 0.243 acct/s), so
     * the only thing concurrency changed here was latency.
     */
    const MEASURED_P50_MS: Readonly<Record<number, number>> = {
        1: 4_112,
        4: 16_488,
        8: 32_708,
    };

    it('the timeout clears the p50 measured AT THE CONFIGURED CONCURRENCY, not at 1', () => {
        const configured = REQUESTS_IN_FLIGHT[WIRE_LAYA_MODEL];
        const p50 = MEASURED_P50_MS[configured];

        // The table must actually COVER the configured value. Without this the
        // lookup yields `undefined`, every comparison below becomes NaN, and a
        // concurrency nobody measured would sail through as a pass.
        expect(p50).toBeDefined();

        expect(LAYA_TIMEOUT_MS).toBeGreaterThan(p50);
        // Headroom rather than a hairline pass — a p50 is the middle of the
        // distribution, so half of real calls are slower than this figure.
        expect(LAYA_TIMEOUT_MS / p50).toBeGreaterThan(1.5);
    });

    it('would have rejected the pair that actually shipped — the positive control', () => {
        // #3448 set the timeout to 12 s from the concurrency-1 figure while
        // `REQUESTS_IN_FLIGHT` was still 4, where the measured p50 is 16,488 ms.
        // Each number was defensible alone; together every call timed out. This
        // asserts the RULE has teeth, without pinning either constant — raising
        // the timeout to clear 16,488 ms would be a legitimate alternative fix.
        expect(12_000).toBeLessThan(MEASURED_P50_MS[4]);
    });
});
