/**
 * AI Compliance-Posture Summary — Provider Factory.
 *
 * Selects the provider from `AI_POSTURE_PROVIDER` (default 'stub'):
 *   - 'stub'       — deterministic, no network, no key (the zero-config default)
 *   - 'anthropic'  — direct Claude API   (needs ANTHROPIC_API_KEY; plus
 *                    ANTHROPIC_WORKSPACE_ID for an organisation-level key)
 *   - 'openrouter' — OpenRouter          (needs OPENROUTER_API_KEY)
 *
 * On any misconfiguration (unknown value, or the selected provider's key is
 * missing) it falls back to the deterministic stub so the daily cron can never
 * be broken by config. Each real provider ALSO self-falls-back per call on a
 * runtime error, so the stub is the backstop at two layers.
 */
import type { CompliancePostureProvider } from './types';
import { StubCompliancePostureProvider } from './stub-provider';
import { AnthropicCompliancePostureProvider } from './anthropic-provider';
import { OpenRouterCompliancePostureProvider } from './openrouter-provider';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
// TYPE-only, so no runtime edge to the risk-assessment factory. The shape
// `residencyTermsFrom` returns satisfies it field for field (#3384).
import type { ProviderSelection } from '@/app-layer/ai/risk-assessment';

export function getCompliancePostureProvider(
    selection?: ProviderSelection,
): CompliancePostureProvider {
    /*
        A LOCAL_ONLY TENANT'S POSTURE NEVER LEAVES (#5192).

        This factory took NO tenant input, so a tenant with
        `aiResidency = LOCAL_ONLY` had its posture snapshot — framework names
        and control/risk/evidence/finding counts — POSTed to the configured
        external model every day by the fan-out cron. The payload is aggregate,
        which bounds the harm, but the tenant's choice was simply not read.

        FIRST, before the env read, for the reason `getProvider` and
        `resolveFlueModel` both give: a residency invariant enforced after a
        provider has been chosen is one refactor from not being enforced.

        There is no local posture gateway, so LOCAL_ONLY gets the deterministic
        stub — the same answer this factory already gives for any
        misconfiguration, which is why the daily cron "can never be broken by
        config". `isFallbackMode` is deliberately FALSE here: this is not a
        degraded answer caused by a missing key, it is the answer the tenant
        asked for, and a caller that reports it as a fallback would read as an
        outage on the dashboard.

        An ABSENT selection reads as EXTERNAL — the default
        `residencyTermsFrom` documents — so the caller must pass it. Forgetting
        is a silent partial update, not a compile error.
    */
    if (selection?.residency === 'LOCAL_ONLY') {
        logger.info('posture summary kept local: tenant residency is LOCAL_ONLY', {
            component: 'ai',
            reason: 'residency_local_only',
        });
        return new StubCompliancePostureProvider(/* isFallbackMode */ false);
    }

    const providerName = env.AI_POSTURE_PROVIDER?.toLowerCase() ?? 'stub';

    switch (providerName) {
        case 'anthropic': {
            const apiKey = env.ANTHROPIC_API_KEY;
            if (!apiKey) {
                logger.warn('ANTHROPIC_API_KEY not set — posture summary falling back to deterministic stub', {
                    component: 'ai',
                });
                return new StubCompliancePostureProvider(/* isFallbackMode */ true);
            }
            return new AnthropicCompliancePostureProvider(
                apiKey,
                env.ANTHROPIC_MODEL ?? undefined,
                env.ANTHROPIC_WORKSPACE_ID,
            );
        }
        case 'openrouter': {
            const apiKey = env.OPENROUTER_API_KEY;
            if (!apiKey) {
                logger.warn('OPENROUTER_API_KEY not set — posture summary falling back to deterministic stub', {
                    component: 'ai',
                });
                return new StubCompliancePostureProvider(/* isFallbackMode */ true);
            }
            return new OpenRouterCompliancePostureProvider(apiKey, env.OPENROUTER_MODEL ?? undefined);
        }
        case 'stub':
            return new StubCompliancePostureProvider();
        default:
            logger.warn('Unknown AI_POSTURE_PROVIDER — falling back to deterministic stub', {
                component: 'ai',
                configured: providerName,
            });
            return new StubCompliancePostureProvider();
    }
}

export type {
    CompliancePostureProvider,
    PostureSummaryInput,
    PostureSummaryResult,
} from './types';
