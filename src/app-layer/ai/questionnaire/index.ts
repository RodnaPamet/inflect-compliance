/**
 * Inbound-questionnaire AI — provider factory (PR-9).
 *
 * Default: stub (zero config). Set AI_QUESTIONNAIRE_PROVIDER=openrouter +
 * OPENROUTER_API_KEY for the real LLM; a missing key silently falls back to
 * the stub so the feature is always functional. Mirrors ai/risk-assessment.
 */
import { env } from '@/env';
import type { QuestionnaireProvider } from './types';
import { StubQuestionnaireProvider } from './stub-provider';
import { OpenRouterQuestionnaireProvider } from './openrouter-provider';
import { logger } from '@/lib/observability/logger';
// TYPE-only, so no runtime edge to the risk-assessment factory. The shape
// `residencyTermsFrom` returns satisfies it field for field (#3384).
import type { ProviderSelection } from '@/app-layer/ai/risk-assessment';

export function getQuestionnaireProvider(
    selection?: ProviderSelection,
): QuestionnaireProvider {
    /*
        A LOCAL_ONLY TENANT'S QUESTIONNAIRE CONTENT NEVER LEAVES (#5445).

        The header above says this factory "mirrors ai/risk-assessment", and in
        the one respect that matters it did not: that factory takes a
        `ProviderSelection` and returns a local provider for LOCAL_ONLY before
        constructing anything external. This one took no tenant input, so the
        question text and the tenant's own grounding snippets went to
        openrouter.ai whatever the tenant's residency.

        This surface is the subtle one of the three fixed together, because it
        LOOKS gated: `usecases/questionnaire.ts` does call
        `enforceFeatureGate(ctx, 'questionnaire')` and `checkRateLimit`, so the
        off switch and the quota were honoured. But that gate reads
        `AI_RISK_ENABLED` and the per-tenant AI columns and mentions residency
        nowhere — it is an ENABLEMENT gate, not a residency one. Calling it says
        nothing about whether the data may leave.

        No local drafting gateway exists, so LOCAL_ONLY gets the deterministic
        stub, which every caller already handles.
    */
    if (selection?.residency === 'LOCAL_ONLY') {
        logger.info('questionnaire draft kept local: tenant residency is LOCAL_ONLY', {
            component: 'ai',
            reason: 'residency_local_only',
        });
        return new StubQuestionnaireProvider();
    }
    if (env.AI_QUESTIONNAIRE_PROVIDER === 'openrouter' && env.OPENROUTER_API_KEY) {
        return new OpenRouterQuestionnaireProvider(env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL || undefined);
    }
    return new StubQuestionnaireProvider();
}

export type { QuestionnaireProvider, QuestionnaireDraftInput, QuestionnaireDraftOutput, GroundingSnippet } from './types';
