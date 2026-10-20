/**
 * Two concurrent assistant turns never cross providers (#3820).
 *
 * This is the test `model-selection.ts`'s docstring exists for. It records the
 * hazard in its own words: the runtime's `setProvider` mutates a
 * **module-scoped singleton**, so "two concurrent runs in one Node process
 * would race, and the loser executes against the winner's provider."
 *
 * With per-tenant `aiResidency: LOCAL_ONLY` a hard invariant, that race is not
 * a flake — it is a CROSS-TENANT EGRESS: a LOCAL_ONLY tenant's reasoning
 * streamed to an endpoint another tenant registered a millisecond earlier, with
 * nothing in the audit trail to show it. A conversational assistant makes
 * concurrency the normal case rather than the exception, which is why this
 * belongs here rather than in a flue-only suite.
 *
 * ═══ THE INTERLEAVING IS THE TEST, NOT A DETAIL OF IT ═══
 *
 * A sequential version of every case below PASSES against an implementation
 * that keeps the provider in module scope: resolve A, call A, resolve B, call B
 * never has two live at once, so the loser-takes-the-winner's-provider bug has
 * no window to appear. So each case starts both turns before either finishes.
 */
/**
 * `resolveFlueModel` reads `env` for every fallback, so the residency cases are
 * only deterministic with it pinned. Set to a FULLY configured deployment —
 * external credential present, local gateway present — because the interesting
 * refusals here are about residency, not about missing configuration.
 */
jest.mock('@/env', () => ({
    env: {
        ANTHROPIC_API_KEY: 'sk-test-key',
        AGENT_FLUE_MODEL: 'claude-sonnet-5-5',
        AI_LOCAL_BASE_URL: 'http://gateway.internal',
        AI_LOCAL_MODEL: 'local-model',
    },
}));

import {
    AnthropicAssistantProvider,
    assistantProviderFor,
    splitSpecifier,
} from '@/app-layer/ai/assistant/turn-provider';
import { FLUE_PROVIDER_IDS, residencyTermsFrom, resolveFlueModel } from '@/lib/agentic/flue/model-selection';
import { runAssistantLoop, type LoopTool } from '@/app-layer/ai/assistant/tool-loop';
import type { ProviderRequest } from '@/app-layer/ai/assistant/tool-loop';

const originalFetch = global.fetch;
afterEach(() => {
    global.fetch = originalFetch;
});

/**
 * A `fetch` double that records every request AND lets the test control when
 * each one resolves, so two calls can be provably in flight together.
 */
function gatedFetch() {
    const sent: Array<{ model: string; system: string }> = [];
    const gates: Array<() => void> = [];
    const impl = jest.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string; system: string };
        sent.push({ model: body.model, system: body.system });
        // Hold the request open until the test releases it. This is what makes
        // the two turns genuinely concurrent rather than merely interleaved in
        // source order.
        await new Promise<void>((resolve) => gates.push(resolve));
        return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
            text: async () => '{}',
        } as unknown as Response;
    });
    return { impl: impl as unknown as typeof fetch, sent, releaseAll: () => gates.forEach((g) => g()), gates };
}

const tool = (name: string): LoopTool => ({
    name,
    description: name,
    jsonSchema: { type: 'object' },
    run: async () => 'rows',
});

const req = (specifier: string, system: string): ProviderRequest => ({
    specifier,
    system,
    question: 'q',
    history: [],
    tools: [],
});

describe('a LOCAL_ONLY tenant gets no external provider at all', () => {
    it('resolves to a local specifier, and assistantProviderFor returns null', () => {
        const choice = resolveFlueModel(
            residencyTermsFrom({
                aiResidency: 'LOCAL_ONLY',
                // MATCHES the deployment's AI_LOCAL_BASE_URL. A tenant value
                // that differs is refused — asserted separately below.
                aiLocalBaseUrl: 'http://gateway.internal',
                aiLocalModel: 'local-model',
            }),
        );
        expect(choice.ok).toBe(true);
        if (!choice.ok) return;

        expect(splitSpecifier(choice.specifier)?.providerId).toBe(FLUE_PROVIDER_IDS.local);

        // NULL, not an external provider with a local specifier. This is the
        // structural reason a crossover cannot happen for this tenant: there is
        // no object able to open an external socket on its behalf.
        expect(
            assistantProviderFor(choice, { ANTHROPIC_API_KEY: 'sk-present' }),
        ).toBeNull();
    });

    it('and the EXTERNAL tenant does get one — the control', () => {
        const choice = resolveFlueModel(residencyTermsFrom({ aiResidency: 'EXTERNAL' }));
        expect(choice.ok).toBe(true);
        if (!choice.ok) return;
        expect(splitSpecifier(choice.specifier)?.providerId).toBe(FLUE_PROVIDER_IDS.external);
        expect(assistantProviderFor(choice, { ANTHROPIC_API_KEY: 'sk-present' })).not.toBeNull();
    });

    it('refuses a CONTRADICTORY choice — residency local, specifier external', () => {
        // Found by mutation: removing the residency check alone changed nothing,
        // because the specifier check already refuses `inflect-local/...`. So
        // the two guards cover DIFFERENT failures and only one was tested.
        //
        // This is the one only the residency check catches: a choice whose
        // residency says LOCAL_ONLY while its specifier says external. That
        // contradiction should be unreachable — `resolveFlueModel` never emits
        // it — but it is the exact shape a wiring mistake would produce, and it
        // is the shape with the worst consequence: a LOCAL_ONLY tenant served
        // externally because one field disagreed with another.
        const contradictory = {
            ok: true as const,
            residency: 'LOCAL_ONLY' as const,
            specifier: `${FLUE_PROVIDER_IDS.external}/claude-sonnet-5-5`,
        };

        expect(assistantProviderFor(contradictory, { ANTHROPIC_API_KEY: 'sk-present' })).toBeNull();
    });

    it('and the same specifier with EXTERNAL residency IS served — the discriminator', () => {
        // Without this, the assertion above is satisfied by a function that
        // returns null for everything.
        expect(
            assistantProviderFor(
                {
                    ok: true as const,
                    residency: 'EXTERNAL' as const,
                    specifier: `${FLUE_PROVIDER_IDS.external}/claude-sonnet-5-5`,
                },
                { ANTHROPIC_API_KEY: 'sk-present' },
            ),
        ).not.toBeNull();
    });

    it('refuses external even when a key is present, because residency decides first', () => {
        // The ordering `resolveFlueModel` documents: "The LOCAL_ONLY branch
        // short-circuits FIRST, before any external consideration ... a
        // residency invariant enforced after an external branch has already
        // been evaluated is an invariant that depends on the order of a switch."
        const local = resolveFlueModel(
            residencyTermsFrom({ aiResidency: 'LOCAL_ONLY', aiLocalModel: 'local-model' }),
        );
        if (!local.ok) throw new Error(`expected a local choice, got ${JSON.stringify(local)}`);
        expect(assistantProviderFor(local, { ANTHROPIC_API_KEY: 'sk-live-key' })).toBeNull();
    });
});

describe('a tenant gateway the deployment does not serve is REFUSED', () => {
    it('does not silently fall back to the deployment endpoint', () => {
        // Found by writing this test wrongly, and worth pinning deliberately.
        // The `inflect-local` provider is built once at boot from
        // `AI_LOCAL_BASE_URL` alone, so a per-tenant `aiLocalBaseUrl` that
        // differs cannot be dialled. Honouring it while the traffic went to the
        // deployment endpoint "would send that tenant's content somewhere it did
        // not nominate — under a residency setting whose whole point is that it
        // does not".
        const choice = resolveFlueModel(
            residencyTermsFrom({
                aiResidency: 'LOCAL_ONLY',
                aiLocalBaseUrl: 'http://a-gateway-this-deployment-does-not-serve',
                aiLocalModel: 'local-model',
            }),
        );

        expect(choice.ok).toBe(false);
        if (choice.ok) return;
        // The REASON, not just the refusal: an operator handed the wrong one
        // edits the wrong setting.
        expect(choice.reason).toBe('LOCAL_GATEWAY_NOT_SERVED');
    });

    it('and the matching gateway resolves — the control', () => {
        const choice = resolveFlueModel(
            residencyTermsFrom({
                aiResidency: 'LOCAL_ONLY',
                aiLocalBaseUrl: 'http://gateway.internal',
                aiLocalModel: 'local-model',
            }),
        );
        expect(choice.ok).toBe(true);
    });
});

describe('two concurrent turns each keep their OWN model', () => {
    it('both in flight at once, neither takes the other model', async () => {
        const f = gatedFetch();
        global.fetch = f.impl;

        const a = new AnthropicAssistantProvider('key-a');
        const b = new AnthropicAssistantProvider('key-b');

        // BOTH STARTED BEFORE EITHER FINISHES. The gated fetch holds each
        // request open, so there is a window in which two turns are live — the
        // window a module-scoped provider would lose one of them in.
        const pa = a.complete(req(`${FLUE_PROVIDER_IDS.external}/claude-sonnet-5-5`, 'tenant-A'));
        const pb = b.complete(req(`${FLUE_PROVIDER_IDS.external}/claude-haiku-4-5`, 'tenant-B'));

        // Proof the window existed: two requests were recorded before any
        // response was released.
        await new Promise((r) => setImmediate(r));
        expect(f.sent).toHaveLength(2);

        f.releaseAll();
        await Promise.all([pa, pb]);

        // Each request carried its own model AND its own system prompt. If
        // provider state were shared, the second construction would have
        // clobbered the first and both would read the same.
        const byTenant = new Map(f.sent.map((s) => [s.system, s.model]));
        expect(byTenant.get('tenant-A')).toBe('claude-sonnet-5-5');
        expect(byTenant.get('tenant-B')).toBe('claude-haiku-4-5');
    });

    it('a LOCAL_ONLY turn interleaved with an EXTERNAL one sends NOTHING externally', async () => {
        const f = gatedFetch();
        global.fetch = f.impl;

        const externalChoice = resolveFlueModel(residencyTermsFrom({ aiResidency: 'EXTERNAL' }));
        const localChoice = resolveFlueModel(
            residencyTermsFrom({ aiResidency: 'LOCAL_ONLY', aiLocalModel: 'local-model' }),
        );
        if (!externalChoice.ok || !localChoice.ok) throw new Error('expected both to resolve');

        const externalProvider = assistantProviderFor(externalChoice, { ANTHROPIC_API_KEY: 'sk' });
        const localProvider = assistantProviderFor(localChoice, { ANTHROPIC_API_KEY: 'sk' });
        expect(externalProvider).not.toBeNull();
        expect(localProvider).toBeNull();

        // The external turn runs; the local tenant has no provider to run with,
        // so its turn never reaches a socket. Started together regardless, so
        // the assertion is about what the LOCAL tenant could not do rather than
        // about the order the test happened to call them in.
        const running = externalProvider!.complete(
            req(`${FLUE_PROVIDER_IDS.external}/claude-sonnet-5-5`, 'external-tenant'),
        );
        await new Promise((r) => setImmediate(r));
        f.releaseAll();
        await running;

        // EXACTLY ONE external request, and it belongs to the EXTERNAL tenant.
        expect(f.sent).toHaveLength(1);
        expect(f.sent[0].system).toBe('external-tenant');
        expect(f.sent.some((s) => s.system.includes('local'))).toBe(false);
    });

    it('a local specifier handed to the external provider is refused, not served', async () => {
        // The second gate on the same invariant. Even if a wiring mistake
        // routed a LOCAL_ONLY tenant's specifier to the external provider, the
        // socket does not open.
        const f = gatedFetch();
        global.fetch = f.impl;

        await expect(
            new AnthropicAssistantProvider('key').complete(req(`${FLUE_PROVIDER_IDS.local}/m`, 'local-tenant')),
        ).rejects.toThrow(/serves .* specifiers only/);

        expect(f.sent).toHaveLength(0);
    });
});

describe('the loop carries the specifier it was given, unchanged', () => {
    it('two concurrent loops each send their own specifier through to the provider', async () => {
        // One level up from the provider test: the LOOP must not hold the
        // specifier anywhere shared either. Two loops run concurrently against
        // one recording provider.
        const seen: string[] = [];
        const provider = {
            complete: async (r: ProviderRequest) => {
                seen.push(r.specifier);
                // Yield, so both loops are inside `complete` together.
                await new Promise((res) => setImmediate(res));
                return { text: `answered ${r.specifier}`, toolCalls: [], stopReason: 'end' as const };
            },
        };

        const [ra, rb] = await Promise.all([
            runAssistantLoop({
                provider,
                specifier: 'inflect-external/model-a',
                system: 's',
                question: 'q',
                tools: [tool('t')],
                now: () => 0,
            }),
            runAssistantLoop({
                provider,
                specifier: 'inflect-local/model-b',
                system: 's',
                question: 'q',
                tools: [tool('t')],
                now: () => 0,
            }),
        ]);

        expect(seen.sort()).toEqual(['inflect-external/model-a', 'inflect-local/model-b']);
        expect(ra.text).toBe('answered inflect-external/model-a');
        expect(rb.text).toBe('answered inflect-local/model-b');
    });
});
