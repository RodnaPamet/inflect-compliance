/**
 * Inbound-questionnaire AI — OpenRouter Provider (PR-9).
 *
 * Real LLM draft generation, grounded strictly in the provided snippets. The
 * prompt instructs the model to answer ONLY from the grounding and to cite the
 * snippet ids it used; on any failure it throws so the usecase falls back to
 * the deterministic stub. Env-gated (AI_QUESTIONNAIRE_PROVIDER=openrouter +
 * OPENROUTER_API_KEY).
 */
import type { QuestionnaireDraftInput, QuestionnaireDraftOutput, QuestionnaireProvider } from './types';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';
/**
 * Bound on one draft call, headers AND body (#5305). Without it a gateway that
 * accepted the connection and stalled held the autofill — a loop over every
 * item — until undici's 300 s default instead of falling back to the stub.
 */
export const QUESTIONNAIRE_DRAFT_TIMEOUT_MS = 30_000;

export class OpenRouterQuestionnaireProvider implements QuestionnaireProvider {
    readonly providerName = 'openrouter';
    constructor(private readonly apiKey: string, private readonly model: string = DEFAULT_MODEL, private readonly fetchImpl: typeof fetch = fetch) {}

    async draftAnswer(input: QuestionnaireDraftInput): Promise<QuestionnaireDraftOutput> {
        const grounding = input.grounding.map((g, i) => `[${i}] (${g.kind} ${g.id}) ${g.label}: ${g.text.slice(0, 800)}`).join('\n');
        const system = 'You answer inbound security questionnaires for a company. Answer ONLY from the provided grounding snippets — never invent controls the company does not have. If the grounding does not support an answer, say so and set a low confidence. Return JSON: {"answer": string, "confidence": number 0..1, "citationIndexes": number[]}.';
        const user = `Question: ${input.question}\n\nGrounding snippets:\n${grounding || '(none)'}\n\nReturn ONLY the JSON.`;

        const res = await this.fetchImpl(OPENROUTER_API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            // H4 — cap output tokens so a malicious/looping prompt can't drive an
            // unbounded (costly) completion. A questionnaire answer is short.
            body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 800 }),
            signal: AbortSignal.timeout(QUESTIONNAIRE_DRAFT_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`OpenRouter questionnaire draft failed (HTTP ${res.status})`);
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = body.choices?.[0]?.message?.content;
        if (!content) throw new Error('OpenRouter returned no content');
        const parsed = JSON.parse(content) as { answer?: string; confidence?: number; citationIndexes?: number[] };
        if (typeof parsed.answer !== 'string') throw new Error('OpenRouter returned malformed draft');

        const idxs = Array.isArray(parsed.citationIndexes) ? parsed.citationIndexes : [];
        const citations = idxs
            .map((i) => input.grounding[i])
            .filter((g): g is NonNullable<typeof g> => !!g)
            .map((g) => ({ kind: g.kind, id: g.id, label: g.label }));
        const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
        return { answer: parsed.answer, confidence, citations };
    }
}
