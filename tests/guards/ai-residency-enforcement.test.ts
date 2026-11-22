/**
 * AI residency enforcement — ratchet (AI sovereignty / DS-1).
 *
 * The invariant: a tenant with `aiResidency=LOCAL_ONLY` NEVER reaches ANY
 * external provider. The provider factory MUST select the local provider (or
 * the deterministic stub when no local gateway is configured) and MUST NOT
 * construct or call an external one — whichever external provider the
 * environment asks for, and even with its key present. EXTERNAL is unchanged.
 *
 * There are two external providers today: OpenRouter, and the direct Claude
 * API (which shares the compliance-posture summary's ANTHROPIC_API_KEY). The
 * structural section below derives that set from the factory source and pins
 * it, so adding a THIRD provider fails here until someone classifies it —
 * which is exactly when the "may LOCAL_ONLY reach it?" decision is due.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const mutableEnv: Record<string, string | undefined> = {
    AI_RISK_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_MODEL: undefined,
    ANTHROPIC_API_KEY: 'anthropic-test',
    ANTHROPIC_MODEL: undefined,
    // The Flue agent runtime's own pin. Never read by this factory: the risk
    // suggestions keep ANTHROPIC_MODEL (owner decision, 2026-10-18).
    AGENT_FLUE_MODEL: undefined,
    ANTHROPIC_WORKSPACE_ID: undefined,
    AI_LOCAL_BASE_URL: 'http://local-gateway:8080',
    AI_LOCAL_MODEL: 'llama3.1',
    AI_LOCAL_API_KEY: undefined,
};
jest.mock('@/env', () => ({ env: mutableEnv }));

// Spy on EVERY external provider's constructor so we can assert none is
// invoked for a LOCAL_ONLY tenant. There are two external providers today
// (OpenRouter, and the direct Claude API sharing the posture summary's key);
// both are equally forbidden under LOCAL_ONLY.
const openRouterCtor = jest.fn();
jest.mock('@/app-layer/ai/risk-assessment/openrouter-provider', () => ({
    DEFAULT_MODEL: 'anthropic/claude-3.5-sonnet-20241022',
    OpenRouterRiskSuggestionProvider: class {
        readonly providerName = 'openrouter';
        constructor(...args: unknown[]) {
            openRouterCtor(...args);
        }
        generateSuggestions() {
            return Promise.resolve({ suggestions: [], modelName: 'x', provider: 'openrouter' });
        }
    },
}));

const anthropicCtor = jest.fn();
jest.mock('@/app-layer/ai/risk-assessment/anthropic-provider', () => ({
    DEFAULT_ANTHROPIC_MODEL: 'claude-haiku-4-5',
    AnthropicRiskSuggestionProvider: class {
        readonly providerName = 'anthropic';
        constructor(...args: unknown[]) {
            anthropicCtor(...args);
        }
        generateSuggestions() {
            return Promise.resolve({ suggestions: [], modelName: 'x', provider: 'anthropic' });
        }
    },
}));

import { getProvider } from '@/app-layer/ai/risk-assessment';
import { LocalRiskSuggestionProvider } from '@/app-layer/ai/risk-assessment/local-provider';
import type { RiskAssessmentInput } from '@/app-layer/ai/risk-assessment/types';
import { repoRelativeFiles } from '../helpers/repo-files';

beforeEach(() => {
    jest.clearAllMocks();
    mutableEnv.AI_RISK_PROVIDER = 'openrouter';
    mutableEnv.OPENROUTER_API_KEY = 'test-key';
    mutableEnv.ANTHROPIC_API_KEY = 'anthropic-test';
    mutableEnv.ANTHROPIC_MODEL = undefined;
    mutableEnv.AGENT_FLUE_MODEL = undefined;
    mutableEnv.ANTHROPIC_WORKSPACE_ID = undefined;
    mutableEnv.AI_LOCAL_BASE_URL = 'http://local-gateway:8080';
    mutableEnv.AI_LOCAL_MODEL = 'llama3.1';
});

/** Every constructor that reaches a third party. None may run under LOCAL_ONLY. */
const EXTERNAL_CTORS: ReadonlyArray<[string, jest.Mock]> = [
    ['openrouter', openRouterCtor],
    ['anthropic', anthropicCtor],
];

function expectNoExternalConstruction() {
    for (const [name, ctor] of EXTERNAL_CTORS) {
        expect([name, ctor.mock.calls.length]).toEqual([name, 0]);
    }
}

describe('LOCAL_ONLY residency invariant', () => {
    // Run each case under EVERY external AI_RISK_PROVIDER setting: the
    // invariant is "residency beats env", so it has to hold whichever
    // external provider the environment asks for.
    it.each(EXTERNAL_CTORS.map(([name]) => name))(
        'returns the LOCAL provider and constructs NO external one (AI_RISK_PROVIDER=%s)',
        (providerName) => {
            mutableEnv.AI_RISK_PROVIDER = providerName;
            const provider = getProvider({ residency: 'LOCAL_ONLY' });
            expect(provider).toBeInstanceOf(LocalRiskSuggestionProvider);
            expect(provider.providerName).toBe('local');
            expectNoExternalConstruction();
        },
    );

    it('a tenant gateway address that is not the deployment\'s is never dialled: the stub, and nothing external (#4545)', () => {
        const provider = getProvider({ residency: 'LOCAL_ONLY', localBaseUrl: 'http://tenant-gw:9000', localModel: 'mistral' });
        expect(provider).not.toBeInstanceOf(LocalRiskSuggestionProvider);
        expectNoExternalConstruction();
    });

    it('a tenant gateway address that restates the deployment\'s is honoured', () => {
        const provider = getProvider({ residency: 'LOCAL_ONLY', localBaseUrl: 'http://local-gateway:8080', localModel: 'mistral' });
        expect(provider).toBeInstanceOf(LocalRiskSuggestionProvider);
        expectNoExternalConstruction();
    });

    it.each(EXTERNAL_CTORS.map(([name]) => name))(
        'falls back to the stub (NOT external) when no local gateway is configured (AI_RISK_PROVIDER=%s)',
        (providerName) => {
            mutableEnv.AI_RISK_PROVIDER = providerName;
            mutableEnv.AI_LOCAL_BASE_URL = undefined;
            const provider = getProvider({ residency: 'LOCAL_ONLY' });
            // Never external, even without a local gateway.
            expect(EXTERNAL_CTORS.map(([n]) => n)).not.toContain(provider.providerName);
            expect(provider).not.toBeInstanceOf(LocalRiskSuggestionProvider);
            expectNoExternalConstruction();
        },
    );
});

describe('EXTERNAL residency (default) — unchanged', () => {
    it('uses the env-configured external provider', () => {
        const provider = getProvider({ residency: 'EXTERNAL' });
        expect(provider.providerName).toBe('openrouter');
        expect(openRouterCtor).toHaveBeenCalledTimes(1);
    });

    it('no residency passed behaves as EXTERNAL', () => {
        const provider = getProvider();
        expect(provider.providerName).toBe('openrouter');
    });

    it('AI_RISK_PROVIDER=anthropic selects the direct Claude API provider', () => {
        mutableEnv.AI_RISK_PROVIDER = 'anthropic';
        const provider = getProvider({ residency: 'EXTERNAL' });
        expect(provider.providerName).toBe('anthropic');
        expect(anthropicCtor).toHaveBeenCalledTimes(1);
        expect(openRouterCtor).not.toHaveBeenCalled();
    });

    it('passes the SAME key + model + workspace the compliance-posture summary uses', () => {
        // The whole point of the anthropic arm: one credential, one model pin
        // shared with the posture Hero. If this ever reads a risk-specific env
        // var instead, that shared-key property is silently gone. The workspace
        // id belongs to the key, so it is shared the same way.
        mutableEnv.AI_RISK_PROVIDER = 'anthropic';
        mutableEnv.ANTHROPIC_MODEL = 'claude-haiku-4-5';
        // Set to something else: the agent runtime's model is not this
        // feature's, and the shared pin is the one it must receive.
        mutableEnv.AGENT_FLUE_MODEL = 'claude-sonnet-5-5';
        mutableEnv.ANTHROPIC_WORKSPACE_ID = 'wrkspc_01TESTWORKSPACE';
        getProvider();
        expect(anthropicCtor).toHaveBeenCalledWith(
            'anthropic-test',
            'claude-haiku-4-5',
            'wrkspc_01TESTWORKSPACE',
        );
    });

    it('degrades to the stub when ANTHROPIC_API_KEY is absent — never throws', () => {
        mutableEnv.AI_RISK_PROVIDER = 'anthropic';
        mutableEnv.ANTHROPIC_API_KEY = undefined;
        const provider = getProvider();
        expect(provider.providerName).not.toBe('anthropic');
        expect(anthropicCtor).not.toHaveBeenCalled();
    });
});

describe('LocalRiskSuggestionProvider conformance', () => {
    const input: RiskAssessmentInput = {
        tenantIndustry: 'fintech',
        tenantContext: 'test',
        frameworks: ['ISO27001'],
        assets: [{ id: 'a1', name: 'DB', type: 'DATABASE', criticality: 'HIGH', classification: null, confidentiality: 5, integrity: 5, availability: 5 }],
        existingControls: [],
        maxRiskScale: 5,
    };

    it('implements the RiskSuggestionProvider interface', () => {
        const p = new LocalRiskSuggestionProvider('http://local-gateway:8080', 'llama3');
        expect(p.providerName).toBe('local');
        expect(typeof p.generateSuggestions).toBe('function');
    });

    it('falls back to the deterministic stub on a gateway error (never throws)', async () => {
        const realFetch = global.fetch;
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
        try {
            const p = new LocalRiskSuggestionProvider('http://unreachable:1', 'llama3');
            const out = await p.generateSuggestions(input);
            // Fallback returns a valid output shape without throwing.
            expect(Array.isArray(out.suggestions)).toBe(true);
            expect(out.provider).not.toBe('local'); // it degraded to the stub/fallback
        } finally {
            global.fetch = realFetch;
        }
    });
});

describe('structural — LOCAL_ONLY short-circuits before EVERY external provider', () => {
    const FACTORY = path.resolve(__dirname, '../../src/app-layer/ai/risk-assessment/index.ts');
    const src = () => fs.readFileSync(FACTORY, 'utf8');

    /**
     * Constructors the factory is allowed to run BEFORE the LOCAL_ONLY guard.
     * `buildLocalProvider` is declared above `getProvider`, so its Local/Stub
     * constructions legitimately appear earlier in the file. Everything else
     * that constructs a provider is external by definition and must come after.
     */
    const NON_EXTERNAL = ['LocalRiskSuggestionProvider', 'StubRiskSuggestionProvider'];

    /** Every `new <Name>RiskSuggestionProvider` the factory constructs. */
    function constructedProviders(source: string): string[] {
        const names = [...source.matchAll(/new\s+(\w*RiskSuggestionProvider)\b/g)].map(m => m[1]);
        return [...new Set(names)];
    }

    it('every external provider is constructed AFTER the LOCAL_ONLY guard', () => {
        const source = src();
        const localOnlyIdx = source.indexOf("residency === 'LOCAL_ONLY'");
        expect(localOnlyIdx).toBeGreaterThan(-1);

        const externals = constructedProviders(source).filter(n => !NON_EXTERNAL.includes(n));
        // Both known external providers must be present — if one disappears,
        // this guard would otherwise pass vacuously.
        expect(externals.sort()).toEqual([
            'AnthropicRiskSuggestionProvider',
            'OpenRouterRiskSuggestionProvider',
        ]);

        for (const name of externals) {
            const idx = source.indexOf(`new ${name}`);
            expect([name, idx > localOnlyIdx]).toEqual([name, true]);
            // And the guard between them returns (short-circuits).
            expect(source.slice(localOnlyIdx, idx)).toMatch(/return buildLocalProvider/);
        }
    });

    it('a NEW provider constructor forces this guard to be updated', () => {
        // The ratchet: the set of constructors the factory uses is pinned. Add
        // a third external provider and this fails until it is classified —
        // which is the moment to decide whether LOCAL_ONLY may reach it.
        expect(constructedProviders(src()).sort()).toEqual([
            'AnthropicRiskSuggestionProvider',
            'LocalRiskSuggestionProvider',
            'OpenRouterRiskSuggestionProvider',
            'StubRiskSuggestionProvider',
        ]);
    });
});

/**
 * ─── The legacy-access decision factory (Step 6b) ──────────────────────────
 *
 * A SECOND factory now chooses between a local and an external model, for a
 * different surface: identity adjudication for legacy access recertification.
 * The invariant is the same one and it is enforced the same way — by reading the
 * source and checking that nothing external is CONSTRUCTED before the
 * `LOCAL_ONLY` return.
 *
 * It gets its own section rather than a shared helper because the two factories
 * name their providers differently (`…RiskSuggestionProvider` /
 * `…DecisionProvider`), and a helper parameterised on the suffix would pass
 * vacuously the day somebody introduces a third naming convention: the regex
 * would match nothing and the assertion would hold over an empty set.
 */
describe('structural — the 6b decision factory constructs nothing external before the guard', () => {
    const FACTORY = path.resolve(__dirname, '../../src/app-layer/ai/identity-match/index.ts');
    const src = () => fs.readFileSync(FACTORY, 'utf8');

    /**
     * Constructors allowed to run BEFORE the `LOCAL_ONLY` return.
     * `buildLocalProvider` is declared above `getDecisionProvider`, so its two
     * constructions legitimately appear earlier in the file. Anything else
     * constructed there is external by definition.
     */
    // `LayaDecisionProvider` left this list on 2026-10-14 with the Laya estate.
    // `LocalDecisionProvider` has never been constructed by the factory at all —
    // it is kept because the list is an ALLOWLIST of names that may appear
    // before the guard line, and a name that is absent from the source costs
    // nothing while a name wrongly missing from here would read as a finding.
    const NON_EXTERNAL = ['LocalDecisionProvider', 'StubDecisionProvider'];

    /**
     * The pinned set. A fourth provider fails this until somebody classifies it,
     * which is exactly when the "may LOCAL_ONLY reach it?" decision is due.
     */
    // TWO, not three, since 2026-10-14: `LayaDecisionProvider` was deleted when
    // the owner retired the Laya estate. `JevDecisionProvider` STAYS — it is
    // constructed on a branch that `TYPESAFE_SUBPROCESSOR_ACTIVE === false`
    // makes unreachable, which is the withdrawal's design and not an oversight.
    //
    // The pin is doing more work than usual while that is true. With no local
    // model, the factory returns the same stub on four of its five paths, so
    // nothing OBSERVABLE distinguishes a correct factory from one that ignores
    // its argument — see the note in `identity-match-provider-factory.test.ts`.
    // This file reads the SOURCE, so it still can.
    const PINNED_CONSTRUCTORS = ['JevDecisionProvider', 'StubDecisionProvider'];

    function constructedProviders(source: string): string[] {
        const names = [...source.matchAll(/new\s+(\w*DecisionProvider)\b/g)].map((m) => m[1]);
        return [...new Set(names)].sort();
    }

    it('the factory source is readable and does construct providers', () => {
        // The denominator. A regex that matches nothing would make every
        // assertion below hold over an empty set.
        const found = constructedProviders(src());
        expect(found.length).toBeGreaterThan(0);
    });

    it('pins the exact constructor set', () => {
        expect(constructedProviders(src())).toEqual([...PINNED_CONSTRUCTORS].sort());
    });

    it('every external provider is constructed AFTER the LOCAL_ONLY guard', () => {
        const source = src();
        const guardIdx = source.indexOf("effectiveMode === 'LOCAL_ONLY'");
        expect(guardIdx).toBeGreaterThan(-1);

        for (const m of source.matchAll(/new\s+(\w*DecisionProvider)\b/g)) {
            if (NON_EXTERNAL.includes(m[1])) continue;
            expect({ provider: m[1], beforeGuard: m.index! < guardIdx }).toEqual({
                provider: m[1],
                beforeGuard: false,
            });
        }
    });

    it('the LOCAL_ONLY branch returns rather than falling through', () => {
        const source = src();
        const guardIdx = source.indexOf("effectiveMode === 'LOCAL_ONLY'");
        // The next statement after the guard must be a return. A branch that
        // merely SETS a variable and continues would reach the external
        // construction below with the guard still reading as satisfied.
        const after = source.slice(guardIdx, guardIdx + 200);
        expect(after).toMatch(/return\s+buildLocalProvider\(\)/);
    });

    it('the inactive-sub-processor gate also precedes the external construction', () => {
        const source = src();
        const gateIdx = source.indexOf('!TYPESAFE_SUBPROCESSOR_ACTIVE');
        const jevIdx = source.indexOf('new JevDecisionProvider');
        expect(gateIdx).toBeGreaterThan(-1);
        expect(jevIdx).toBeGreaterThan(gateIdx);
    });
});

/**
 * ─── The embedding and rerank factory (Layer 4, nemotron-retriever Phases 1-2) ─
 *
 * A THIRD factory, for text that goes to an embedding or rerank model. Today
 * it can construct only in-deployment providers — there is no external
 * embedding route, because one would be a sub-processor (G2). The pin is what
 * keeps that true: an external provider added to `select.ts` fails here until
 * somebody classifies it, and it must then be constructed after the
 * `LOCAL_ONLY` return.
 *
 * Its own section rather than a shared helper, for the reason the 6b section
 * gives: the providers are named `…EmbeddingProvider` / `…RerankProvider`, and
 * a helper parameterised on a suffix would pass vacuously over an empty match.
 */
describe('structural — the embedding factory constructs nothing external before the guard', () => {
    const FACTORY = path.resolve(__dirname, '../../src/lib/ai/embeddings/select.ts');
    const src = () => fs.readFileSync(FACTORY, 'utf8');

    /** In-deployment providers. Every other constructor is external by definition. */
    const IN_DEPLOYMENT = ['TeiEmbeddingProvider', 'TeiRerankProvider'];

    function constructedProviders(source: string): string[] {
        const names = [...source.matchAll(/new\s+(\w*(?:Embedding|Rerank)Provider)\b/g)].map((m) => m[1]);
        return [...new Set(names)].sort();
    }

    it('pins the exact constructor set — no external provider, and never the stub', () => {
        // Also the denominator: an empty match would make the ordering check
        // below hold over nothing.
        expect(constructedProviders(src())).toEqual([...IN_DEPLOYMENT].sort());
    });

    it('every LOCAL_ONLY branch returns before the non-LOCAL_ONLY route is reached', () => {
        const source = src();
        for (const fn of ['resolveEmbeddingRoute', 'resolveRerankRoute']) {
            const start = source.indexOf(`export function ${fn}(`);
            const guard = source.indexOf("sel?.residency === 'LOCAL_ONLY'", start);
            const firstReturn = source.indexOf('return ', guard);
            const guardEnd = source.indexOf('\n    }\n', guard);
            expect({
                fn,
                guardFound: start > -1 && guard > start,
                returnsInsideGuard: firstReturn > -1 && firstReturn < guardEnd,
            }).toEqual({ fn, guardFound: true, returnsInsideGuard: true });
        }
    });

    it('nothing outside the seam reaches a provider or the transport around the factory', () => {
        // A `new TeiEmbeddingProvider(...)` elsewhere would pick a route without
        // asking the residency question at all. Import specifiers are checked
        // rather than constructor names, so an alias cannot slip past.
        const DIRECT = ["'@/lib/ai/embeddings/tei-provider'", "'@/lib/ai/embeddings/http'"];
        const offenders = repoRelativeFiles()
            .filter((f) => f.startsWith('src/') && /\.tsx?$/.test(f) && !f.startsWith('src/lib/ai/embeddings/'))
            .filter((f) => {
                const source = fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
                return DIRECT.some((spec) => source.includes(spec));
            });
        expect(offenders).toEqual([]);
    });
});
