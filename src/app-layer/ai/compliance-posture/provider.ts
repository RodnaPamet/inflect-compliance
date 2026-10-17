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

export function getCompliancePostureProvider(): CompliancePostureProvider {
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
