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
    JEV_TIMEOUT_MS,
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
    // `LAYA_BASE_URL` / `LAYA_API_KEY` were set here until 2026-10-14. They are
    // no longer declared on `env` at all — the Laya estate was retired — so
    // setting them on the mock would configure a variable nothing reads, which
    // is worse than not setting it: it reads as a live knob.
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

    it('EXTERNAL without the key falls back to the stub rather than throwing', () => {
        // Unchanged in spirit from the inactive era, and still the reason it is
        // written this way: a tenant who asked for adjudication gets the
        // privacy-preserving answer or none, never an error that reads like their
        // configuration is broken. The flag alone moves no data — the KEY does.
        //
        // The fallback WAS the local provider and is now the stub, because the
        // local provider was retired. The property is the same one: no mode
        // throws, and no mode reaches a third party.
        mutableEnv.TYPESAFE_API_KEY = undefined;
        expect(getDecisionProvider('EXTERNAL').providerName).toBe('stub');
    });

    it('NO mode goes external now, and the mode is still what the factory reads', () => {
        // The worst case is set up in `beforeEach`: key present, Laya present.
        for (const mode of ['OFF', 'LOCAL_ONLY', 'EXTERNAL'] as const) {
            expect(getDecisionProvider(mode).isExternal).toBe(false);
            expect(getDecisionProvider(mode).providerName).not.toBe('jev');
        }

        // ── THERE IS NO POSITIVE CONTROL LEFT, AND SAYING SO IS THE POINT ──
        //
        // This comment has now been rewritten twice by the same mechanism, so
        // the mechanism is the thing to read rather than either conclusion.
        //
        // Originally the control was `getDecisionProvider('EXTERNAL').isExternal
        // === true`: it proved the loop above was not vacuous by showing the
        // factory COULD return something external. Withdrawing the sub-processor
        // removed that, so it was replaced by a DISCRIMINATION control — `OFF`
        // gives `stub` and `LOCAL_ONLY` gives `laya`, two different answers,
        // which no constant-returning factory can fake.
        //
        // Retiring the Laya estate on 2026-10-14 removed that one too. Every
        // mode now returns the stub, so the loop above is satisfied by a factory
        // that ignores its argument entirely, and NOTHING IN THIS FILE CAN TELL
        // THE DIFFERENCE. That is not a reason to delete the loop — the property
        // it states is still the property we want — but it is a reason not to
        // read a green run here as evidence about the factory's structure.
        //
        // What carries that evidence instead, and where to look when this file
        // passes and you want to know whether it means anything:
        //
        //   · `tests/guards/ai-residency-enforcement.test.ts` reads the factory's
        //     SOURCE: the LOCAL_ONLY branch must RETURN before any external
        //     provider is constructed, and the constructor set is pinned. That is
        //     a structural claim, so it survives every provider coinciding.
        //   · the flag-link test below asserts `isExternal` tracks
        //     `TYPESAFE_SUBPROCESSOR_ACTIVE`, which is the binding that would
        //     have to change for any of this to move.
        //
        // A model returning here restores a discrimination control, and this
        // comment is the note to whoever does it.
        expect(getDecisionProvider('OFF').providerName).toBe('stub');
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

    it('LOCAL_ONLY yields the stub — there is no local model to yield', () => {
        // This replaces two tests that distinguished "a Laya is deployed" from
        // "none is", a distinction `env` can no longer express. The surviving
        // claim is the one that was always the important half: LOCAL_ONLY never
        // falls through to anything external, whatever else is configured.
        const p = getDecisionProvider('LOCAL_ONLY');
        expect(p.providerName).toBe('stub');
        expect(p.isExternal).toBe(false);
    });

    it('LOCAL_ONLY ignores TYPESAFE_API_KEY entirely', () => {
        mutableEnv.TYPESAFE_API_KEY = 'a-very-real-key'; // pragma: allowlist secret
        // The worst case left: the external credential is present and the mode
        // asks for local. Still the stub, and still not external.
        const p = getDecisionProvider('LOCAL_ONLY');
        expect(p.providerName).toBe('stub');
        expect(p.isExternal).toBe(false);
    });
});

describe('6b factory — the stub answers nothing, ever', () => {
    it('rejects rather than returning a neutral verdict', async () => {
        // A neutral answer would still be a verdict, recorded as the model's
        // opinion, and an evaluation record over stub answers would describe a
        // model nobody ran.
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

    /*
     * REMOVED 2026-10-14: `bounds the local path by what the hardware MEASURES,
     * not by how far the packet travels`.
     *
     * Its subject was `LAYA_TIMEOUT_MS`, which lived in `laya-provider.ts` and
     * went with it when the owner retired the Laya estate. There is no local
     * provider to give a budget to, so the assertion had nothing left to bound —
     * it is not a weakened check, it is a deleted one, which is why it is
     * recorded here.
     *
     * The measurement it stood on is worth preserving, because it is the thing
     * that refuted the plausible version of this rule. The original invariant
     * was "the local path gets a TIGHTER timeout than the external one", which
     * reads well and is wrong: on the deployed VM one adjudication measured p50
     * 7,332 ms / p95 7,727 ms (#3445), because it was CPU inference on two
     * shared cores, where Jev's 3 s buys a round trip to GPU-backed inference.
     * Holding the local path to 2 s made LOCAL_ONLY return TIMEOUT for every
     * call — the opposite of preferring it. If a local model is ever
     * reinstated, that is the shape of the mistake to avoid.
     */
    it('keeps the external budget where the round trip puts it', () => {
        expect(JEV_TIMEOUT_MS).toBe(3_000);
    });

    /*
     * REMOVED 2026-10-14: `keeps the intent chooser on its own tight budget, so
     * the raise cannot leak`.
     *
     * Its subject was `LAYA_CHOOSER_TIMEOUT_MS`, which lived in
     * `ai/intent/laya-chooser.ts`. The whole intent layer was retired on the
     * owner's decision (#3528) — it had never run in production, because
     * `AI_LOCAL_BASE_URL` was never set and every call refused
     * `LOCAL_GATEWAY_NOT_CONFIGURED` — so there is no constant left to bound.
     *
     * WHAT IT PROVED, kept because the shape recurs: one constant served two
     * paths with latencies two orders of magnitude apart — adjudication at p50
     * 7.3 s and the intent chooser at p50 206 ms for three options. Raising the
     * shared value for the slow path would have taken the USER-FACING compose
     * route's ceiling from 6 s to 36 s. The fix was to SPLIT the constant, and
     * this test existed to notice them being merged back. If a future surface
     * ever shares a timeout with a slower sibling, split it first.
     */
});

/*
 * REMOVED 2026-10-14: `6b — the per-call timeout and the configured concurrency
 * must compose (#3450)`.
 *
 * Every assertion in it related `LAYA_TIMEOUT_MS` to `REQUESTS_IN_FLIGHT`, and
 * the first of those is gone with `laya-provider.ts`. `REQUESTS_IN_FLIGHT`
 * REMAINS and is still read by `adjudication-pass.ts`, so the concurrency half
 * of the pair is live; it is the per-call budget that no longer exists.
 *
 * WHAT IT PROVED, because the shape recurs and is not obvious: two constants can
 * each be defensible alone and broken together. #3448 set the timeout to 12 s
 * from the concurrency-1 figure while `REQUESTS_IN_FLIGHT` was still 4, where
 * the measured p50 is 16,488 ms — so every call timed out. The test took its p50
 * from the table AT THE CONFIGURED CONCURRENCY rather than at 1, asserted the
 * table actually covered that value (otherwise the lookup is `undefined`, every
 * comparison becomes NaN, and an unmeasured concurrency sails through), and
 * carried a positive control that would have rejected the pair that shipped.
 *
 * The measurements, kept because they cost a VM afternoon: p50 4,112 ms at
 * concurrency 1, 16,488 ms at 4, 32,708 ms at 8, with throughput flat across all
 * three (0.233 / 0.243 / 0.243 accounts per second) — so concurrency bought
 * latency and nothing else.
 */
