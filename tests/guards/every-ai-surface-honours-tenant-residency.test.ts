/**
 * EVERY AI surface that can reach an external model honours the tenant's
 * residency (#5073, #5192, #5445).
 *
 * ── Why this exists beside `ai-residency-enforcement.test.ts` ──────────
 *
 * That guard is real and effective, and it covers ONE factory: every mock,
 * import and assertion in it is about `getProvider` from `ai/risk-assessment`.
 * CLAUDE.md presents it as the structural enforcement of a tenant-wide
 * invariant — "Residency is structural. The factory RETURNS before
 * constructing anything external" — and that sentence was true of one of six
 * surfaces.
 *
 * Three shipped with no residency decision at all: `ai/vendor-doc` (up to
 * 60,000 characters of a vendor's SOC 2 report), `ai/compliance-posture` (the
 * daily aggregate snapshot) and `ai/questionnaire` (question text plus the
 * tenant's grounding snippets).
 *
 * ── The mechanism, which is already documented in the codebase ─────────
 *
 * `residencyTermsFrom`'s docstring says it: "a site that keeps compiling while
 * passing `undefined` for the term it forgot gets the DEFAULT posture, and
 * `resolveFlueModel` reads an absent `residency` as EXTERNAL." An absent
 * residency means external. So a surface that simply never passes it leaks,
 * and nothing fails to compile — which is why this needs a test rather than a
 * type.
 *
 * ── The axis: DID ANYTHING TRY TO LEAVE ───────────────────────────────
 *
 * Asserted on the attempt, not on a spelling. A previous attempt of mine to
 * guard a sibling invariant by grepping for one form of the fix reported 31
 * offenders of which 29 were false — because an exception can be spelled more
 * than one way, a check can be role-gated, and a column-scoped trigger may not
 * fire at all. So here: drive each factory under an env that SELECTS an
 * external provider, and require that LOCAL_ONLY reaches no network and no
 * external constructor.
 *
 * Each case carries a POSITIVE CONTROL in the same `it`, because "no external
 * call" is also what a misconfigured env produces: if EXTERNAL does not reach
 * the network either, the LOCAL_ONLY assertion proves nothing.
 */
import * as path from 'path';
import * as fs from 'fs';
import { repoRelativeFiles } from '../helpers/repo-files';

/**
 * An env that SELECTS an external provider on every surface. Without this the
 * LOCAL_ONLY assertions below would pass on a deployment that was never going
 * to call out anyway — which is why each case also asserts the EXTERNAL case
 * does reach outside.
 */
const mutableEnv: Record<string, string | undefined> = {
    AI_RISK_PROVIDER: 'openrouter',
    AI_POSTURE_PROVIDER: 'openrouter',
    AI_QUESTIONNAIRE_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_MODEL: undefined,
    ANTHROPIC_API_KEY: 'anthropic-test',
    ANTHROPIC_MODEL: undefined,
    ANTHROPIC_WORKSPACE_ID: undefined,
    AI_LOCAL_BASE_URL: 'http://local-gateway:8080',
    AI_LOCAL_MODEL: 'llama3.1',
    AI_LOCAL_API_KEY: undefined,
};
jest.mock('@/env', () => ({ env: mutableEnv }));
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { getCompliancePostureProvider } from '@/app-layer/ai/compliance-posture/provider';
import { StubCompliancePostureProvider } from '@/app-layer/ai/compliance-posture/stub-provider';
import { getQuestionnaireProvider } from '@/app-layer/ai/questionnaire';
import { StubQuestionnaireProvider } from '@/app-layer/ai/questionnaire/stub-provider';
import { extractDocument } from '@/app-layer/ai/vendor-doc';

/** The hosts a tenant's data must never reach under LOCAL_ONLY. */
const EXTERNAL_ENDPOINT = /openrouter\.ai|api\.anthropic\.com|anthropic\.com\/v1/;

/**
 * DERIVED, not listed. Every `src/app-layer/ai/<surface>` that names an
 * external AI endpoint anywhere in its files.
 *
 * A hand-written list is what let three surfaces ship unguarded: the list
 * would have been written when there was one.
 */
function surfacesWithExternalReach(): string[] {
    const found = new Set<string>();
    for (const f of repoRelativeFiles()) {
        if (!f.startsWith('src/app-layer/ai/') || !f.endsWith('.ts')) continue;
        const surface = f.slice('src/app-layer/ai/'.length).split('/')[0];
        if (!surface || surface.endsWith('.ts')) continue;
        if (EXTERNAL_ENDPOINT.test(fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf-8'))) {
            found.add(surface);
        }
    }
    return [...found].sort();
}

/**
 * The surfaces this file drives. Every surface with external reach must appear
 * here, or the coverage test below fails and names it.
 */
const EXERCISED = ['compliance-posture', 'questionnaire', 'vendor-doc'] as const;

/**
 * Surfaces whose residency decision is driven by their OWN tests, mapped to the
 * file that does it.
 *
 * This is an allowlist, so it is made self-checking: each named file must exist
 * AND still assert on `LOCAL_ONLY`. A bare list of names would rot the moment
 * one of those tests was renamed or gutted, which is the failure mode that let
 * three surfaces ship unguarded in the first place.
 */
const COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
    'risk-assessment': 'tests/guards/ai-residency-enforcement.test.ts',
    assistant: 'tests/unit/ai/assistant-residency-concurrency.test.ts',
};

describe('the residency invariant covers every AI surface that can reach outside', () => {
    it('reads a real population', () => {
        const surfaces = surfacesWithExternalReach();
        // Satisfied by an empty scan otherwise — and an empty scan is exactly
        // what a renamed directory or a broken regex produces.
        expect(surfaces.length).toBeGreaterThanOrEqual(4);
        // `includes` into `toBe`, not `toContain`: `surfaces` derives from
        // `readFileSync`, and the Class D ratchet follows that data flow — a
        // `toContain` here is a WHOLE-FILE needle, and 'risk-assessment' occurs
        // in many of the files read, so it counts as ambiguous and raises a
        // ceiling that only ever comes down. The assertion is identical.
        expect(surfaces.includes('risk-assessment')).toBe(true);
    });

    it('every surface that can reach an external model is covered somewhere', () => {
        const uncovered = surfacesWithExternalReach()
            .filter((s) => !(EXERCISED as readonly string[]).includes(s))
            .filter((s) => !(s in COVERED_ELSEWHERE))
            .map((s) => `src/app-layer/ai/${s} names an external AI endpoint but nothing `
                + `drives its factory under LOCAL_ONLY. Add a case here, or point `
                + `COVERED_ELSEWHERE at the test that does. An absent residency reads as `
                + `EXTERNAL, so a surface that never passes it leaks silently and `
                + `compiles cleanly.`);
        expect(uncovered).toEqual([]);
    });

    it('each COVERED_ELSEWHERE entry names a test that exists and still asserts LOCAL_ONLY', () => {
        const broken = Object.entries(COVERED_ELSEWHERE)
            .map(([surface, file]) => {
                const abs = path.resolve(__dirname, '../..', file);
                if (!fs.existsSync(abs)) return `${surface}: ${file} does not exist`;
                if (!fs.readFileSync(abs, 'utf-8').includes('LOCAL_ONLY')) {
                    return `${surface}: ${file} no longer mentions LOCAL_ONLY`;
                }
                return null;
            })
            .filter((x): x is string => x !== null);
        expect(broken).toEqual([]);
    });
});

describe('LOCAL_ONLY reaches no external model — and EXTERNAL does', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mutableEnv.AI_POSTURE_PROVIDER = 'openrouter';
        mutableEnv.AI_QUESTIONNAIRE_PROVIDER = 'openrouter';
        mutableEnv.AI_RISK_PROVIDER = 'openrouter';
        mutableEnv.OPENROUTER_API_KEY = 'test-key';
    });

    it('compliance-posture: the stub for LOCAL_ONLY, the external provider otherwise', () => {
        expect(getCompliancePostureProvider({ residency: 'LOCAL_ONLY' }))
            .toBeInstanceOf(StubCompliancePostureProvider);
        // POSITIVE CONTROL. Without it, a stub returned because the env never
        // selected an external provider would read as the invariant holding.
        expect(getCompliancePostureProvider({ residency: 'EXTERNAL' }))
            .not.toBeInstanceOf(StubCompliancePostureProvider);
        // And an ABSENT selection is EXTERNAL, which is why the caller must pass it.
        expect(getCompliancePostureProvider()).not.toBeInstanceOf(StubCompliancePostureProvider);
    });

    it('questionnaire: the stub for LOCAL_ONLY, the external provider otherwise', () => {
        expect(getQuestionnaireProvider({ residency: 'LOCAL_ONLY' }))
            .toBeInstanceOf(StubQuestionnaireProvider);
        expect(getQuestionnaireProvider({ residency: 'EXTERNAL' }))
            .not.toBeInstanceOf(StubQuestionnaireProvider);
        expect(getQuestionnaireProvider()).not.toBeInstanceOf(StubQuestionnaireProvider);
    });

    it('vendor-doc: NO fetch for LOCAL_ONLY, and a fetch otherwise', async () => {
        // Asserted on the CALL, not the return value: `extractDocument` catches
        // its own errors and returns the stub extraction either way, so the
        // return value cannot tell "kept local" from "tried and failed".
        const fetchSpy = jest.spyOn(globalThis, 'fetch' as never).mockRejectedValue(
            new Error('network disabled in this test') as never,
        );
        try {
            await extractDocument('some vendor report text', { residency: 'LOCAL_ONLY' });
            expect(fetchSpy).not.toHaveBeenCalled();

            // POSITIVE CONTROL: the same text under EXTERNAL does reach out.
            await extractDocument('some vendor report text', { residency: 'EXTERNAL' });
            expect(fetchSpy).toHaveBeenCalled();
            expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('openrouter.ai');
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
