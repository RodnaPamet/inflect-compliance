/**
 * Vendor-document AI extraction — turns a SOC 2 / ISO cert / pen-test
 * report into a structured, Zod-VALIDATED extraction.
 *
 * Discipline (mirrors the risk-assessment AI subsystem):
 *   - SANITIZE before the call: the raw document text is stripped of
 *     control chars, email/phone PII is redacted, and it is length-capped
 *     BEFORE it ever reaches the model (privacy boundary).
 *   - VALIDATE the output: the model response is parsed and checked against
 *     `DocExtractionSchema` (shape AND value). Malformed output → graceful
 *     fallback (an empty OTHER extraction), never a throw into the caller.
 *   - FALLBACK: no OPENROUTER_API_KEY (or provider != openrouter) → the stub
 *     extraction, so the flow works offline / in tests deterministically.
 *
 * This module does NOT touch the DB or propose answers — it only extracts.
 * The usecase orchestrates parse → sanitize → extract → map → propose.
 */
import { z } from 'zod';
import { env } from '@/env';
import { logger } from '@/lib/observability';
// TYPE-only: erased at compile time, so this adds no runtime edge to the
// risk-assessment factory (the trick `tenant-toggle-columns.ts` documents).
// The shape `residencyTermsFrom` returns satisfies it field for field.
import type { ProviderSelection } from '@/app-layer/ai/risk-assessment';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet-20241022';

// ─── Zod extraction schema (shape + value validation) ───────────────

export const ExtractedControlSchema = z.object({
    ref: z.string().max(60),
    description: z.string().max(600).optional().default(''),
    result: z.enum(['IN_PLACE', 'EXCEPTION', 'NOT_TESTED']).default('IN_PLACE'),
});

export const ExtractedExceptionSchema = z.object({
    control: z.string().max(60),
    description: z.string().max(1200),
});

export const DocExtractionSchema = z.object({
    reportType: z.enum(['SOC2_TYPE2', 'SOC2_TYPE1', 'ISO27001', 'PENTEST', 'OTHER']),
    /** ISO date strings (or null when the report doesn't state a period). */
    auditPeriodStart: z.string().max(40).nullable().optional(),
    auditPeriodEnd: z.string().max(40).nullable().optional(),
    scope: z.string().max(2000).nullable().optional(),
    auditor: z.string().max(300).nullable().optional(),
    trustServiceCriteria: z.array(z.string().max(60)).max(50).default([]),
    controls: z.array(ExtractedControlSchema).max(400).default([]),
    exceptions: z.array(ExtractedExceptionSchema).max(200).default([]),
});

export type DocExtraction = z.infer<typeof DocExtractionSchema>;

export interface ExtractResult {
    ok: boolean;
    provider: string;
    model: string | null;
    data: DocExtraction;
    error?: string;
}

const EMPTY_EXTRACTION: DocExtraction = {
    reportType: 'OTHER',
    auditPeriodStart: null,
    auditPeriodEnd: null,
    scope: null,
    auditor: null,
    trustServiceCriteria: [],
    controls: [],
    exceptions: [],
};

// ─── Sanitize before the AI call (privacy boundary) ─────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

/** Strip control chars, redact email/phone PII, collapse whitespace, cap length. */
export function sanitizeDocText(text: string, maxLen = 60_000): string {
    return text
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(EMAIL_RE, '[email]')
        .replace(PHONE_RE, '[phone]')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, maxLen);
}

// ─── Extraction ─────────────────────────────────────────────────────

function stubExtraction(): ExtractResult {
    // Deterministic empty extraction — the offline / no-key / test path.
    return { ok: true, provider: 'stub', model: null, data: EMPTY_EXTRACTION };
}

function buildPrompt(sanitizedText: string): { system: string; user: string } {
    return {
        system:
            'You are a compliance analyst extracting structured facts from a vendor security ' +
            'attestation (SOC 2 / ISO 27001 / penetration test). Extract ONLY what the document ' +
            'states — never infer or invent. If a field is absent, use null / empty. Respond with ' +
            'ONLY a JSON object.',
        user:
            `Extract: reportType (SOC2_TYPE2|SOC2_TYPE1|ISO27001|PENTEST|OTHER), auditPeriodStart, ` +
            `auditPeriodEnd (ISO dates or null), scope, auditor, trustServiceCriteria (e.g. ["CC6.1"]), ` +
            `controls (ref, description, result IN_PLACE|EXCEPTION|NOT_TESTED), and exceptions ` +
            `(control, description). Document:\n\n${sanitizedText}`,
    };
}

/**
 * Extract structured facts from already-sanitized document text. Returns a
 * validated `DocExtraction`; on ANY failure (no key, network, malformed,
 * schema mismatch) returns the empty OTHER extraction with `ok: false` so
 * the caller records the failure without crashing.
 */
export async function extractDocument(
    sanitizedText: string,
    selection?: ProviderSelection,
): Promise<ExtractResult> {
    /*
        A LOCAL_ONLY TENANT'S DOCUMENT NEVER LEAVES (#5073).

        This decided on the DEPLOYMENT's env alone, so a tenant with
        `aiResidency = LOCAL_ONLY` had up to 60,000 characters of a vendor's
        SOC 2 report — scope, auditor findings, exceptions; only emails and
        phone numbers are redacted — POSTed to openrouter.ai. `env.ts` says of
        this very variable that "'anthropic' and 'openrouter' are EXTERNAL and
        are never reached by a tenant with aiResidency=LOCAL_ONLY", and
        CLAUDE.md calls LOCAL_ONLY a hard invariant.

        FIRST, before the env read, for the reason `getProvider` and
        `resolveFlueModel` both give: a residency invariant enforced after an
        external provider has been chosen is one refactor away from not being
        enforced at all.

        There is no local extraction gateway, so LOCAL_ONLY gets the
        deterministic stub — the same answer this function already gives when
        the deployment configures no external provider, and a shape every
        caller already handles.

        An ABSENT selection reads as EXTERNAL, which is the default
        `residencyTermsFrom` documents. That is why the caller must pass it:
        forgetting to is a silent partial update, not a compile error.
    */
    if (selection?.residency === 'LOCAL_ONLY') {
        logger.info('vendor-doc extraction kept local: tenant residency is LOCAL_ONLY', {
            component: 'ai',
            reason: 'residency_local_only',
        });
        return stubExtraction();
    }
    if (env.AI_RISK_PROVIDER?.toLowerCase() !== 'openrouter' || !env.OPENROUTER_API_KEY) {
        return stubExtraction();
    }
    const model = env.OPENROUTER_MODEL || DEFAULT_MODEL;
    try {
        const prompt = buildPrompt(sanitizedText);
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://inflect-compliance.app',
                'X-Title': 'Inflect Compliance - Vendor Document Extraction',
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: prompt.system },
                    { role: 'user', content: prompt.user },
                ],
                temperature: 0.1,
                max_tokens: 4096,
                response_format: { type: 'json_object' },
            }),
        });
        if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
        const data: { choices?: { message?: { content?: string } }[] } = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('empty content');

        const parsed = DocExtractionSchema.safeParse(JSON.parse(content));
        if (!parsed.success) {
            logger.warn('Vendor-doc extraction failed schema validation, using empty', { component: 'ai' });
            return { ok: false, provider: 'openrouter', model, data: EMPTY_EXTRACTION, error: 'schema_validation_failed' };
        }
        return { ok: true, provider: 'openrouter', model, data: parsed.data };
    } catch (err) {
        logger.error('Vendor-doc extraction call failed, using empty extraction', { component: 'ai' });
        return { ok: false, provider: 'openrouter', model, data: EMPTY_EXTRACTION, error: err instanceof Error ? err.message : 'unknown' };
    }
}
