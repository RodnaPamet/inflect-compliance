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

beforeEach(() => {
    jest.clearAllMocks();
    mutableEnv.AI_RISK_PROVIDER = 'openrouter';
    mutableEnv.OPENROUTER_API_KEY = 'test-key';
    mutableEnv.ANTHROPIC_API_KEY = 'anthropic-test';
    mutableEnv.ANTHROPIC_MODEL = undefined;
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

    it('a per-tenant local base URL overrides the env default', () => {
        const provider = getProvider({ residency: 'LOCAL_ONLY', localBaseUrl: 'http://tenant-gw:9000', localModel: 'mistral' });
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

    it('passes the SAME key + model the compliance-posture summary uses', () => {
        // The whole point of the anthropic arm: one credential, one model pin
        // shared with the posture Hero. If this ever reads a risk-specific env
        // var instead, that shared-key property is silently gone.
        mutableEnv.AI_RISK_PROVIDER = 'anthropic';
        mutableEnv.ANTHROPIC_MODEL = 'claude-haiku-4-5';
        getProvider();
        expect(anthropicCtor).toHaveBeenCalledWith('anthropic-test', 'claude-haiku-4-5');
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
