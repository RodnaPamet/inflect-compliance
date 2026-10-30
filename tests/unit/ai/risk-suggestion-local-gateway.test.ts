/**
 * A WORKSPACE ADMIN DOES NOT GET TO CHOOSE THE HOST THE SERVER DIALS (#4545).
 *
 * `TenantSecuritySettings.aiLocalBaseUrl` is writable by any `admin.manage`
 * holder through `PUT /api/t/:slug/admin/security-settings`, whose schema is
 * `z.string().url()` and nothing more. `buildLocalProvider` passed that string
 * straight to `LocalRiskSuggestionProvider`, which dials it with a bare `fetch`
 * and — where the deployment sets `AI_LOCAL_API_KEY` — attaches that key as
 * `Authorization: Bearer …`. So the hole was two holes: a server-side request
 * to any internal host a tenant admin names, and the deployment's own gateway
 * credential delivered to it.
 *
 * ── WHY THESE TESTS ARE BEHAVIOURAL, NOT CONSTRUCTOR ASSERTIONS ─────────────
 *
 * The obvious test reads the provider the factory returned and checks which
 * URL it holds. That passes while the socket still opens: the `providerName`
 * of the stub and the URL held by a provider are both one refactor away from
 * agreeing with a fix that does not work. So every case here drives
 * `generateSuggestions` to completion against a stubbed `global.fetch` and
 * asserts on the CALL LOG — a request that was never made, and a credential
 * that never left, are the two properties worth having, and only the call log
 * can express them.
 *
 * MUTATION-PROVED: with `resolveLocalGateway`'s `NOT_SERVED` arm removed, the
 * two "never dialled" cases below fail on `fetch` having been called with the
 * foreign host, and the credential case fails on the bearer appearing in the
 * log.
 */
import type { RiskAssessmentInput } from '@/app-layer/ai/risk-assessment/types';

const DEPLOYMENT_GATEWAY = 'http://gateway.internal:11434/v1';
const DEPLOYMENT_KEY = 'deployment-gateway-credential';

/**
 * The host a tenant admin would type. `169.254.169.254` is the cloud-metadata
 * endpoint on GCP and AWS alike — the concrete thing this defence exists to
 * refuse, rather than a stand-in like `evil.example.com`, so a reader can see
 * what the unfixed code would have fetched from the production VM.
 */
const TENANT_CHOSEN_HOST = 'http://169.254.169.254/v1';

jest.mock('@/env', () => ({
    env: {
        AI_RISK_PROVIDER: 'local',
        AI_LOCAL_BASE_URL: 'http://gateway.internal:11434/v1',
        AI_LOCAL_MODEL: 'llama-3.1-70b',
        AI_LOCAL_API_KEY: 'deployment-gateway-credential',  // pragma: allowlist secret -- synthetic test input; the point of the test is that it never leaves
        // Present so a leak into an external arm would be visible rather than
        // silently falling through to the stub for want of a key.
        ANTHROPIC_API_KEY: 'sk-should-never-be-reached',  // pragma: allowlist secret -- synthetic test input; the point of the test is that it never leaves
        OPENROUTER_API_KEY: 'or-should-never-be-reached',  // pragma: allowlist secret -- synthetic test input; the point of the test is that it never leaves
    },
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { getProvider } from '@/app-layer/ai/risk-assessment';
import { logger } from '@/lib/observability/logger';

/**
 * `DATA_STORE` and `ISO 27001` are chosen to MATCH the stub's catalogue, so a
 * refusal returns real template suggestions. An unmatched asset type returns an
 * empty list, which would make "the feature still answers" vacuous — the
 * assertion would pass on a provider that answered nothing at all.
 */
const INPUT: RiskAssessmentInput = {
    frameworks: ['ISO 27001'],
    assets: [{ id: 'a1', name: 'Payroll store', type: 'DATA_STORE', criticality: 'HIGH' }],
};

/** One well-formed gateway answer, so the served cases reach the happy path. */
function gatewayResponse() {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            model: 'llama-3.1-70b',
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            suggestions: [
                                {
                                    title: 'Unencrypted payroll data at rest',
                                    description: 'Payroll records are stored without encryption.',
                                    likelihood: 3,
                                    impact: 4,
                                    rationale: 'A database holding personal data has no at-rest encryption.',
                                },
                            ],
                        }),
                    },
                },
            ],
        }),
        text: async () => '',
    };
}

let fetchMock: jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn().mockResolvedValue(gatewayResponse());
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

/** Every URL the process was asked to dial, in order. */
const dialled = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));

/** Every header value sent on every call, flattened — for credential checks. */
function headerValues(): string[] {
    return fetchMock.mock.calls.flatMap((c) => {
        const init = c[1] as { headers?: Record<string, string> } | undefined;
        return Object.values(init?.headers ?? {});
    });
}

describe('a tenant-nominated local gateway this deployment does not serve', () => {
    for (const residency of ['LOCAL_ONLY', 'EXTERNAL'] as const) {
        it(`is never dialled (${residency} tenant)`, async () => {
            // Both arms matter. LOCAL_ONLY short-circuits at the top of
            // `getProvider`; EXTERNAL reaches the same builder through
            // `AI_RISK_PROVIDER=local`. A fix applied to one entry point and
            // not the other leaves the hole open for half the tenants.
            const out = await getProvider({ residency, localBaseUrl: TENANT_CHOSEN_HOST })
                .generateSuggestions(INPUT);

            expect(fetchMock).not.toHaveBeenCalled();
            expect(dialled()).toEqual([]);
            // The feature still answers — with templates, which is this
            // module's documented contract for every provider failure.
            expect(out.isFallback).toBe(true);
            // `fallback`, not `stub`: the stub reports the two apart, and the
            // refusal path builds it with `isFallbackMode` so the surface can
            // tell "AI was unavailable" from "AI was never configured".
            expect(out.provider).toBe('fallback');
            expect(out.suggestions.length).toBeGreaterThan(0);
        });
    }

    it('does not receive AI_LOCAL_API_KEY, because no request is made at all', async () => {
        // The sharper half of the finding. Refusing the host would be
        // insufficient if the key reached it on some other path, so this
        // asserts over the whole call log rather than over one call's headers.
        await getProvider({ residency: 'LOCAL_ONLY', localBaseUrl: TENANT_CHOSEN_HOST })
            .generateSuggestions(INPUT);

        expect(headerValues().some((v) => v.includes(DEPLOYMENT_KEY))).toBe(false);
        expect(dialled().some((u) => u.includes('169.254.169.254'))).toBe(false);
    });

    it('says why in a WARN, naming the refusal rather than looking unconfigured', async () => {
        // An operator who sees "not configured" sets AI_LOCAL_BASE_URL and
        // nothing changes. The reason has to name the actual cause, which is
        // that the workspace's value is not one this deployment serves.
        await getProvider({ residency: 'LOCAL_ONLY', localBaseUrl: TENANT_CHOSEN_HOST })
            .generateSuggestions(INPUT);

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('does not serve'),
            expect.objectContaining({ reason: 'NOT_SERVED' }),
        );
        // And the log line must not carry the host the tenant typed: a WARN is
        // not the place to echo an attacker-chosen string back into the logs.
        const logged = (logger.warn as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join(' ');
        expect(logged).not.toContain('169.254.169.254');
    });
});

describe('the gateway this deployment does serve', () => {
    it('is dialled when the workspace nominates exactly it', async () => {
        const out = await getProvider({ residency: 'LOCAL_ONLY', localBaseUrl: DEPLOYMENT_GATEWAY })
            .generateSuggestions(INPUT);

        expect(dialled()).toEqual([`${DEPLOYMENT_GATEWAY.replace('/v1', '')}/v1/chat/completions`]);
        expect(headerValues()).toContain(`Bearer ${DEPLOYMENT_KEY}`);
        expect(out.provider).toBe('local');
        expect(out.isFallback).toBe(false);
    });

    it('is dialled when the workspace nominates nothing', async () => {
        const out = await getProvider({ residency: 'LOCAL_ONLY' }).generateSuggestions(INPUT);

        expect(dialled()).toEqual([`${DEPLOYMENT_GATEWAY.replace('/v1', '')}/v1/chat/completions`]);
        expect(out.provider).toBe('local');
    });

    it('is compared raw — a trailing slash is a different string and is refused', async () => {
        // Deliberate, and the direction matters: a looser comparison admits
        // more strings, and every string it newly admits is one a tenant admin
        // typed. An operator whose workspace value differs only by a slash
        // fixes the value; nobody's content leaks while they do.
        await getProvider({ residency: 'LOCAL_ONLY', localBaseUrl: `${DEPLOYMENT_GATEWAY}/` })
            .generateSuggestions(INPUT);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still honours the per-tenant MODEL, which names no host', async () => {
        // The model override is not withdrawn by this fix and must not be: it
        // selects among what the deployment's own gateway serves, so it cannot
        // move traffic anywhere. Narrowing it would be a silent feature loss
        // riding along with a security fix.
        await getProvider({
            residency: 'LOCAL_ONLY',
            localBaseUrl: DEPLOYMENT_GATEWAY,
            localModel: 'mistral-small',
        }).generateSuggestions(INPUT);

        const body = JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body));
        expect(body.model).toBe('mistral-small');
    });
});
