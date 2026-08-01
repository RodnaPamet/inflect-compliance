/**
 * AI Risk Assessment — Anthropic (direct Claude API) provider.
 *
 * Calls the Claude Messages API directly (POST /v1/messages) and asks for
 * STRICT JSON matching RiskSuggestionOutputSchema. Any error — network,
 * timeout, non-2xx, unparseable body, wrong shape — degrades to the
 * deterministic knowledge-base templates, so a suggestion request never
 * fails outward.
 *
 * This is the SAME credential the compliance-posture summary uses:
 * `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` (default claude-haiku-4-5). Wiring
 * risk suggestions to it means one key to rotate, one spend line, and one
 * model-pinning decision across both AI surfaces.
 *
 * EXTERNAL provider — reachable only after the factory's LOCAL_ONLY
 * short-circuit. A LOCAL_ONLY tenant must never construct this class; the
 * ratchet at tests/guards/ai-residency-enforcement.test.ts enforces that.
 */
import type { RiskAssessmentInput, RiskSuggestionOutput, RiskSuggestionProvider } from './types';
import { buildRiskAssessmentPrompt } from './prompt-builder';
import { RiskSuggestionOutputSchema } from './schemas';
import { StubRiskSuggestionProvider } from './stub-provider';
import { logger } from '@/lib/observability/logger';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * AISVS C6 (model supply chain): pin a concrete model rather than a floating
 * alias, so an upstream swap can't silently change risk-assessment behaviour.
 * Kept in step with the compliance-posture provider's default and with
 * `ANTHROPIC_MODEL` in src/env.ts — a small, cheap model is plenty for a
 * bounded, schema-constrained suggestion list. Changing it is a deliberate,
 * reviewed edit to this constant (or the ANTHROPIC_MODEL env override).
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';

/**
 * Matches the OpenRouter provider's budget so the SAME feature behaves the
 * same whichever provider serves it. A response that hits the cap is caught
 * explicitly below rather than surfacing as a confusing JSON parse error.
 */
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 30_000;

/**
 * Pull the first JSON object out of arbitrary model text.
 *
 * Needed here but NOT in the OpenRouter provider: OpenRouter is asked for
 * `response_format: { type: 'json_object' }`, which guarantees a bare object.
 * The Claude Messages API has no equivalent request-level JSON mode, so the
 * model may wrap its answer in a ```json fence or a sentence of prose. Mirrors
 * the tolerant extraction the compliance-posture parser already does.
 */
export function extractJsonObject(text: string): unknown {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : trimmed;
    try {
        return JSON.parse(candidate);
    } catch {
        // Last resort: from the first `{` to the last `}`.
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(candidate.slice(start, end + 1));
        }
        throw new Error(`No parseable JSON object in model response: ${candidate.slice(0, 200)}`);
    }
}

export class AnthropicRiskSuggestionProvider implements RiskSuggestionProvider {
    readonly providerName = 'anthropic';
    private apiKey: string;
    private model: string;
    private fallback: StubRiskSuggestionProvider;

    constructor(apiKey: string, model?: string) {
        this.apiKey = apiKey;
        this.model = model ?? DEFAULT_ANTHROPIC_MODEL;
        this.fallback = new StubRiskSuggestionProvider(/* isFallbackMode */ true);

        // AISVS C12.4.3 / C12.5.3 — a model override is a config change and is
        // logged once at construction, so a runtime model swap is never silent.
        if (this.model !== DEFAULT_ANTHROPIC_MODEL) {
            logger.warn('AI risk-assessment model overridden from the pinned default', {
                component: 'ai',
                configuredModel: this.model,
                defaultModel: DEFAULT_ANTHROPIC_MODEL,
            });
        }
    }

    async generateSuggestions(input: RiskAssessmentInput): Promise<RiskSuggestionOutput> {
        try {
            return await this.callApi(input);
        } catch (error) {
            logger.error('Anthropic API call failed, using fallback', {
                component: 'ai',
                error: error instanceof Error ? error.message : String(error),
            });
            return this.fallback.generateSuggestions(input);
        }
    }

    private async callApi(input: RiskAssessmentInput): Promise<RiskSuggestionOutput> {
        const prompt = buildRiskAssessmentPrompt(input);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        let response: Response;
        try {
            response = await fetch(ANTHROPIC_API_URL, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.model,
                    max_tokens: MAX_TOKENS,
                    system: prompt.system,
                    messages: [
                        {
                            role: 'user',
                            content: `${prompt.user}\n\nRespond with ONLY JSON matching this schema:\n${prompt.responseSchema}`,
                        },
                    ],
                }),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'unknown');
            throw new Error(`Anthropic API error ${response.status}: ${errorText.slice(0, 200)}`);
        }

        const data: {
            content?: { type?: string; text?: string }[];
            model?: string;
            stop_reason?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
        } = await response.json();

        // A truncated response is a budget problem, not a model problem. Name
        // it so the log says why we degraded instead of reporting a JSON error.
        if (data.stop_reason === 'max_tokens') {
            throw new Error(
                `Anthropic response truncated at max_tokens=${MAX_TOKENS} — suggestion list too long to parse`,
            );
        }

        const text = data?.content?.find((c) => c.type === 'text')?.text ?? data?.content?.[0]?.text;
        if (!text) throw new Error('Anthropic returned empty content');

        // AISVS C6.1.3 — third-party artifact integrity. The response echoes
        // the model that actually served the request; a difference from the
        // pinned/configured model is surfaced for the inference log.
        const actualModel = data.model;
        const modelMismatch =
            typeof actualModel === 'string' && actualModel.length > 0 && actualModel !== this.model;
        if (modelMismatch) {
            logger.warn('Anthropic served a different model than requested', {
                component: 'ai',
                requestedModel: this.model,
                actualModel,
            });
        }

        // AISVS C12.1.3 / C12.2.5 — token usage. Anthropic reports
        // input_tokens / output_tokens (not OpenAI's prompt_/completion_).
        const u = data.usage;
        const usage =
            u && (u.input_tokens != null || u.output_tokens != null)
                ? {
                      promptTokens: u.input_tokens ?? 0,
                      completionTokens: u.output_tokens ?? 0,
                      totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
                  }
                : undefined;

        const validated = RiskSuggestionOutputSchema.parse(extractJsonObject(text));

        return {
            suggestions: validated.suggestions.map(s => ({
                ...s,
                suggestedControls: s.suggestedControls ?? [],
                confidence: s.confidence ?? 'medium',
                structuredRationale: s.structuredRationale ?? {
                    whyThisRisk: s.rationale,
                    affectedAssetCharacteristics: [],
                    suggestedControlThemes: s.suggestedControls ?? [],
                },
            })),
            modelName: this.model,
            provider: 'anthropic',
            isFallback: false,
            usage,
            actualModel,
            modelMismatch,
        };
    }
}
