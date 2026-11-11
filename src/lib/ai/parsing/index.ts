/**
 * THE DOCUMENT PARSER SEAM — which backend runs, decided once.
 *
 * `resolveDocumentParser()` is the only place a backend is chosen, and the
 * only importer of `docling-provider.ts` (`tests/unit/document-parser-seam.test.ts`
 * holds that). The rule is G9's: the operator names `DOC_PARSER_BASE_URL` or
 * nothing external is constructed and the deterministic stub parses text
 * documents. There is no tenant setting here — the parsing service is
 * deployment infrastructure, reached at an operator-configured host (G6).
 *
 * `parseWithFallback` composes a primary with the stub:
 *
 *   - an OUTAGE (`OUTAGE_REASONS`) falls back with a WARN, and the result
 *     carries `fallbackFrom`, so an index built from the stub's answer is
 *     labelled as such and never mistaken for the primary's;
 *   - `UNSUPPORTED_MEDIA` from the primary is routed to the stub (plain text
 *     is the stub's format, not Docling's) without a warning;
 *   - every other refusal stands. An oversized answer, a partial parse, a
 *     contract mismatch or an egress refusal is the primary's verdict on this
 *     document or this deployment, and the stub answering instead would hide it.
 *
 * Callers are expected to be jobs in the worker (G8); the next phase's
 * `knowledge-index` is the first. Whatever a caller does with the result, the
 * text reaches a model only through `guardParsedDocument`
 * (`src/app-layer/ai/parsing/`).
 */
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

import { createDoclingParser } from './docling-provider';
import { createStubParser } from './stub-provider';
import {
    OUTAGE_REASONS,
    type DocumentParser,
    type ParseInput,
    type ParseOptions,
    type ParseResult,
} from './types';

export * from './types';
export { createStubParser, chunkParagraphs, STUB_TEXT_MIMES } from './stub-provider';

/**
 * The parser this deployment runs. Docling only when the operator names a base
 * URL; otherwise the stub. A fresh value per call, never cached: the decision
 * is cheap, and a cached client would outlive a configuration change in tests.
 */
export function resolveDocumentParser(): DocumentParser {
    const baseUrl = env.DOC_PARSER_BASE_URL;
    if (!baseUrl) return createStubParser();
    return createDoclingParser({ baseUrl, apiKey: env.DOC_PARSER_API_KEY });
}

/** Run `primary`, and the stub where the rules above say so. */
export async function parseWithFallback(
    primary: DocumentParser,
    fallback: DocumentParser,
    input: ParseInput,
    opts?: ParseOptions,
): Promise<ParseResult> {
    const first = await primary.parse(input, opts);
    if (first.ok || primary.backend === fallback.backend) return first;

    const outage = OUTAGE_REASONS.has(first.reason);
    if (!outage && first.reason !== 'UNSUPPORTED_MEDIA') return first;

    if (outage) {
        logger.warn('document-parser: primary backend unavailable, falling back to stub', {
            component: 'document-parser',
            backend: primary.backend,
            reason: first.reason,
            fallback: fallback.backend,
        });
    }
    const second = await fallback.parse(input, opts);
    return { ...second, fallbackFrom: { backend: primary.backend, reason: first.reason } };
}

/** Parse one document with this deployment's parser, falling back as above. */
export async function parseDocument(input: ParseInput, opts?: ParseOptions): Promise<ParseResult> {
    return parseWithFallback(resolveDocumentParser(), createStubParser(), input, opts);
}
