/**
 * AI Risk Assessment — Local / self-hosted provider (AI sovereignty).
 *
 * Calls an OpenAI-COMPATIBLE chat-completions endpoint hosted inside the
 * tenant's own perimeter (Ollama, vLLM, LM Studio, or any local gateway). This
 * is the "Sovereign AI" path: inference never leaves the tenant's jurisdiction
 * — no request reaches an external provider (OpenRouter). Directly satisfies the
 * DS-1 sovereignty dimension and pairs with the SSRF egress allowlist (a
 * LOCAL_ONLY tenant's AI calls stay on an allowlisted internal host).
 *
 * Same request/response shape and same fall-back-to-stub-on-error contract as
 * OpenRouterRiskSuggestionProvider — IC does NOT bundle or host a model; ops
 * owns the gateway + the model runtime.
 *
 * PROVENANCE: authored from IC's own provider pattern. No third-party (AGPL)
 * code.
 */
import type { RiskAssessmentInput, RiskSuggestionOutput, RiskSuggestionProvider } from './types';
import { buildRiskAssessmentPrompt } from './prompt-builder';
import { RiskSuggestionOutputSchema } from './schemas';
import { StubRiskSuggestionProvider } from './stub-provider';
import { logger } from '@/lib/observability/logger';

const DEFAULT_LOCAL_MODEL = 'local-model';
/**
 * Bound on one gateway call, headers AND body (#5305). Longer than the hosted
 * providers' 30 s because a local model is slower, but bounded: without it a
 * gateway that accepted the connection and stalled held the request until
 * undici's 300 s default, so the fallback never fired in time.
 */
export const LOCAL_RISK_TIMEOUT_MS = 60_000;

export class LocalRiskSuggestionProvider implements RiskSuggestionProvider {
    readonly providerName = 'local';
    private baseUrl: string;
    private model: string;
    /** Optional bearer for gateways that require one (many local ones don't). */
    private apiKey?: string;
    private fallback: StubRiskSuggestionProvider;

    constructor(baseUrl: string, model?: string, apiKey?: string) {
        // Normalise: accept a bare host or a full /v1 base URL.
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.model = model && model.length > 0 ? model : DEFAULT_LOCAL_MODEL;
        this.apiKey = apiKey;
        this.fallback = new StubRiskSuggestionProvider(/* isFallbackMode */ true);
    }

    async generateSuggestions(input: RiskAssessmentInput): Promise<RiskSuggestionOutput> {
        try {
            return await this.callApi(input);
        } catch {
            logger.error('Local AI gateway call failed, using fallback', { component: 'ai' });
            return this.fallback.generateSuggestions(input);
        }
    }

    private endpoint(): string {
        // The gateway exposes the OpenAI-compatible route. Support both a base
        // host (append /v1/chat/completions) and a pre-suffixed /v1 base URL.
        if (/\/v1(\/|$)/.test(this.baseUrl)) return `${this.baseUrl.replace(/\/v1.*$/, '')}/v1/chat/completions`;
        return `${this.baseUrl}/v1/chat/completions`;
    }

    private async callApi(input: RiskAssessmentInput): Promise<RiskSuggestionOutput> {
        const prompt = buildRiskAssessmentPrompt(input);

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        const response = await fetch(this.endpoint(), {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: prompt.system },
                    {
                        role: 'user',
                        content: `${prompt.user}\n\nRespond with ONLY JSON matching this schema:\n${prompt.responseSchema}`,
                    },
                ],
                temperature: 0.3,
                max_tokens: 4096,
                response_format: { type: 'json_object' },
            }),
            signal: AbortSignal.timeout(LOCAL_RISK_TIMEOUT_MS),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'unknown');
            throw new Error(`Local AI gateway error ${response.status}: ${errorText}`);
        }

        const data: {
            choices?: { message?: { content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            model?: string;
        } = await response.json();
        const content = data?.choices?.[0]?.message?.content;

        if (!content) {
            throw new Error('Local AI gateway returned empty content');
        }

        const actualModel = data.model;
        const modelMismatch =
            typeof actualModel === 'string' && actualModel.length > 0 && actualModel !== this.model;

        const u = data.usage;
        const usage =
            u && (u.prompt_tokens != null || u.completion_tokens != null)
                ? {
                      promptTokens: u.prompt_tokens ?? 0,
                      completionTokens: u.completion_tokens ?? 0,
                      totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
                  }
                : undefined;

        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch {
            throw new Error(`Failed to parse local AI response as JSON: ${content.substring(0, 200)}`);
        }

        const validated = RiskSuggestionOutputSchema.parse(parsed);

        return {
            suggestions: validated.suggestions.map((s) => ({
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
            provider: 'local',
            isFallback: false,
            usage,
            actualModel,
            modelMismatch,
        };
    }
}
