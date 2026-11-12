/**
 * THE DOCLING BACKEND — an HTTP client for a Docling-class parsing-only
 * service the operator runs inside the deployment (D-L4-4, owner 2026-11-11).
 *
 * It speaks docling-serve's `POST /v1/convert/source` with the document as a
 * base64 `file_sources` entry and asks for the `json` format only, then reads
 * the answer's `DoclingDocument` into the seam's {@link ParsedDocument}. The
 * service is stateless by design — a document goes in, structure comes out,
 * nothing is kept — which is the property RAGFlow's dataset lifecycle had to
 * be made to have with a create → delete dance and a "holds nothing" test.
 *
 * ── EGRESS (G6) ─────────────────────────────────────────────────────────────
 *
 * Every byte leaves through `wirePost` (`src/lib/mcp/wire-transport.ts`), the
 * registered SSRF sink: https only, decided from the URL; `safeFetch` (DNS
 * re-resolved and pinned, no redirects); one deadline that covers the body
 * read; and a byte cap that ABORTS the transfer rather than truncating it. This
 * file contains no fetch call of its own, and
 * `tests/guards/ssrf-egress-coverage.test.ts` holds it to that beside the MCP
 * and A2A clients. The base URL is operator config (`DOC_PARSER_BASE_URL`),
 * never a tenant column.
 *
 * Consequence an operator must know: `safeFetch` refuses `http:` and private
 * addresses. A Docling container on the Compose network is reached at a
 * private address, so it needs TLS in front of it and its range in
 * `EGRESS_PRIVATE_CIDR_ALLOWLIST` (self-hosted only). Until then every parse is
 * `EGRESS_REFUSED`, loudly, and does not fall back — see `OUTAGE_REASONS`.
 *
 * ── UNTRUSTED OUTPUT (G4) ───────────────────────────────────────────────────
 *
 * Nothing the service returns is logged: not a heading, not a cell, not an
 * error string from its `errors` member. Log lines carry the reason code, the
 * HTTP status and byte counts. The tenant's file name is never sent either —
 * the service is told `document.<ext>`, derived from the media type.
 *
 * `fetchImpl` is a test seam forwarded to `wirePost`; nothing under `src/`
 * originates one.
 */
import { z } from 'zod';

import {
    RedirectNotAllowedError,
    SsrfBlockedError,
    SsrfUnresolvableHostError,
} from '@/app-layer/automation/webhook-safety';
import {
    WireCapExceededError,
    WireEgressError,
    WireSchemeRefusedError,
    WireTimeoutError,
    wirePost,
    type WireFetch,
} from '@/lib/mcp/wire-transport';
import { logger } from '@/lib/observability/logger';

import { baseMime } from './stub-provider';
import {
    DEFAULT_PARSER_LIMITS,
    refuse,
    sectionsToText,
    type DocumentParser,
    type ParseInput,
    type ParseOptions,
    type ParseRefusalReason,
    type ParseResult,
    type ParsedSection,
    type ParsedTable,
    type ParserLimits,
} from './types';

/** The path, fixed in code. Only the origin (and an optional prefix) is config. */
export const DOCLING_CONVERT_PATH = '/v1/convert/source';

/**
 * Media type → the extension Docling detects the format from. A type not here
 * is `UNSUPPORTED_MEDIA` before anything is sent. `text/plain` is absent on
 * purpose: Docling has no plain-text reader, and the stub reads it.
 */
export const DOCLING_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/html': 'html',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/tiff': 'tiff',
};

/**
 * The request body. `to_formats: ['json']` only: the Markdown and HTML
 * renderings would multiply the bytes read for nothing this client uses.
 * `image_export_mode: 'placeholder'` keeps page images out of the answer.
 */
export function buildConvertRequest(bytes: Uint8Array, ext: string): string {
    return JSON.stringify({
        options: {
            to_formats: ['json'],
            do_ocr: true,
            image_export_mode: 'placeholder',
        },
        file_sources: [
            { base64_string: Buffer.from(bytes).toString('base64'), filename: `document.${ext}` },
        ],
    });
}

// ── The answer, read strictly where it matters and loosely where it does not ──
//
// Only the members this client reads are declared. Unknown members are
// stripped (zod's default), so a newer service that adds fields still parses;
// a service that CHANGES one of these is a CONTRACT_VIOLATION, never a guess.

const ProvSchema = z.object({ page_no: z.number().int().positive() });

const TextItemSchema = z.object({
    label: z.string(),
    text: z.string(),
    prov: z.array(ProvSchema).optional(),
    level: z.number().int().nonnegative().optional(),
    content_layer: z.string().optional(),
});

const TableItemSchema = z.object({
    prov: z.array(ProvSchema).optional(),
    content_layer: z.string().optional(),
    data: z.object({
        grid: z.array(z.array(z.object({ text: z.string() }))),
    }),
});

const DoclingDocumentSchema = z.object({
    texts: z.array(TextItemSchema),
    tables: z.array(TableItemSchema).optional(),
    pages: z.record(z.string(), z.unknown()).optional(),
});

const ConvertResponseSchema = z.object({
    status: z.enum(['success', 'partial_success', 'skipped', 'failure']),
    document: z.object({
        json_content: DoclingDocumentSchema.nullable().optional(),
    }),
});

type DoclingDocument = z.infer<typeof DoclingDocumentSchema>;

/** Labels that are page furniture or decoration rather than the document's text. */
const FURNITURE_LABELS: ReadonlySet<string> = new Set(['page_header', 'page_footer', 'picture']);
const HEADING_LABELS: ReadonlySet<string> = new Set(['title', 'section_header']);

function firstPage(prov: readonly { page_no: number }[] | undefined): number | null {
    return prov && prov.length > 0 ? prov[0].page_no : null;
}

/**
 * Map a DoclingDocument to the seam's shape. Returns a refusal reason when the
 * document is over the limits or empty — never a trimmed document.
 */
export function mapDoclingDocument(
    doc: DoclingDocument,
    limits: ParserLimits,
): { ok: true; sections: ParsedSection[]; tables: ParsedTable[]; pages: number | null } | { ok: false; reason: ParseRefusalReason } {
    const sections: ParsedSection[] = [];
    let current: { heading: string | null; level: number; page: number | null; paragraphs: string[] } = {
        heading: null,
        level: 0,
        page: null,
        paragraphs: [],
    };
    const close = () => {
        if (current.heading !== null || current.paragraphs.length > 0) sections.push(current);
    };
    let maxPage = 0;

    for (const item of doc.texts) {
        if (item.content_layer === 'furniture' || FURNITURE_LABELS.has(item.label)) continue;
        const page = firstPage(item.prov);
        if (page !== null && page > maxPage) maxPage = page;
        const text = item.text.trim();
        if (!text) continue;
        if (HEADING_LABELS.has(item.label)) {
            close();
            current = {
                heading: text,
                level: item.label === 'title' ? 0 : (item.level ?? 1),
                page,
                paragraphs: [],
            };
            if (sections.length + 1 > limits.maxSections) return { ok: false, reason: 'RESPONSE_OVER_LIMITS' };
            continue;
        }
        if (current.page === null) current.page = page;
        current.paragraphs.push(text);
    }
    close();
    if (sections.length > limits.maxSections) return { ok: false, reason: 'RESPONSE_OVER_LIMITS' };

    const rawTables = (doc.tables ?? []).filter((t) => t.content_layer !== 'furniture');
    if (rawTables.length > limits.maxTables) return { ok: false, reason: 'RESPONSE_OVER_LIMITS' };
    const tables: ParsedTable[] = [];
    for (const t of rawTables) {
        const cells = t.data.grid.reduce((n, row) => n + row.length, 0);
        if (cells > limits.maxCellsPerTable) return { ok: false, reason: 'RESPONSE_OVER_LIMITS' };
        if (cells === 0) continue;
        const page = firstPage(t.prov);
        if (page !== null && page > maxPage) maxPage = page;
        tables.push({ page, rows: t.data.grid.map((row) => row.map((c) => c.text)) });
    }

    // Zero is never complete: a document with no text and no table did not parse.
    const hasText = sections.some((s) => s.paragraphs.length > 0 || s.heading !== null);
    if (!hasText && tables.length === 0) return { ok: false, reason: 'EMPTY_DOCUMENT' };

    const declaredPages = doc.pages ? Object.keys(doc.pages).length : 0;
    const pages = declaredPages > 0 ? declaredPages : maxPage > 0 ? maxPage : null;
    return { ok: true, sections, tables, pages };
}

export interface DoclingParserConfig {
    /** Operator config. `DOCLING_CONVERT_PATH` is appended to it. */
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly limits?: Partial<ParserLimits>;
    /** Test seam, forwarded to `wirePost`. */
    readonly fetchImpl?: WireFetch;
}

function reasonForStatus(status: number): ParseRefusalReason {
    if (status === 401 || status === 403) return 'AUTH_FAILED';
    if (status === 429 || status >= 500) return 'UPSTREAM_UNAVAILABLE';
    return 'UPSTREAM_REFUSED';
}

function reasonForWireError(e: unknown): ParseRefusalReason {
    if (e instanceof WireTimeoutError) return 'TIMEOUT';
    if (e instanceof WireCapExceededError) return 'RESPONSE_TOO_LARGE';
    if (e instanceof WireSchemeRefusedError) return 'EGRESS_REFUSED';
    if (e instanceof WireEgressError) {
        const cause = e.cause;
        // A name that does not resolve is the service not being there — a
        // stopped container is NXDOMAIN on the Compose network, a resolver
        // hiccup is EAI_AGAIN — so it is an outage, not a refused address.
        // Checked BEFORE its parent class, which it is a subclass of.
        if (cause instanceof SsrfUnresolvableHostError) return 'UNREACHABLE';
        if (cause instanceof SsrfBlockedError || cause instanceof RedirectNotAllowedError) {
            return 'EGRESS_REFUSED';
        }
        return 'UNREACHABLE';
    }
    // Anything else is a defect in this client, not a fact about the service.
    throw e;
}

export function createDoclingParser(config: DoclingParserConfig): DocumentParser {
    const limits: ParserLimits = { ...DEFAULT_PARSER_LIMITS, ...config.limits };
    const url = config.baseUrl.replace(/\/+$/, '') + DOCLING_CONVERT_PATH;

    const record = (reason: ParseRefusalReason, fields: Record<string, unknown> = {}): ParseResult => {
        // Reason, status and sizes only. Never anything the service said.
        logger.warn('document-parser: docling refused', {
            component: 'document-parser',
            backend: 'docling',
            reason,
            ...fields,
        });
        return refuse('docling', reason);
    };

    return {
        backend: 'docling',
        async parse(input: ParseInput, opts: ParseOptions = {}): Promise<ParseResult> {
            const ext = DOCLING_MIME_EXTENSIONS[baseMime(input.mime)];
            if (!ext) return refuse('docling', 'UNSUPPORTED_MEDIA');
            if (input.bytes.byteLength > limits.maxInputBytes) {
                return record('INPUT_TOO_LARGE', { inputBytes: input.bytes.byteLength });
            }

            const headers: Record<string, string> = {
                'content-type': 'application/json',
                accept: 'application/json',
            };
            if (config.apiKey) headers['x-api-key'] = config.apiKey;

            let raw: string;
            let status: number;
            try {
                const res = await wirePost({
                    url,
                    headers,
                    body: buildConvertRequest(input.bytes, ext),
                    timeoutMs: limits.timeoutMs,
                    deadlineAt: opts.deadlineAt,
                    fetchImpl: config.fetchImpl,
                });
                status = res.status;
                if (!res.ok) {
                    res.discard();
                    return record(reasonForStatus(res.status), { status: res.status });
                }
                const contentType = res.headers.get('content-type') ?? '';
                if (!contentType.toLowerCase().includes('application/json')) {
                    // A zip answer, an HTML error page from a proxy — not this contract.
                    res.discard();
                    return record('CONTRACT_VIOLATION', { status: res.status });
                }
                raw = await res.readBody(limits.maxResponseBytes);
            } catch (e) {
                return record(reasonForWireError(e));
            }

            let json: unknown;
            try {
                json = JSON.parse(raw);
            } catch {
                return record('CONTRACT_VIOLATION', { status, responseBytes: raw.length });
            }
            const parsed = ConvertResponseSchema.safeParse(json);
            if (!parsed.success) return record('CONTRACT_VIOLATION', { status });

            // Fail closed on anything short of a whole conversion: a partial parse
            // reported as complete is an account of a document with pages missing.
            if (parsed.data.status === 'partial_success') return record('PARTIAL_PARSE');
            if (parsed.data.status !== 'success') return record('PARSE_FAILED');
            const doc = parsed.data.document.json_content;
            if (!doc) return record('CONTRACT_VIOLATION', { status });

            const mapped = mapDoclingDocument(doc, limits);
            if (!mapped.ok) return record(mapped.reason);
            const text = sectionsToText(mapped.sections);
            if (text.length > limits.maxTextChars) return record('RESPONSE_OVER_LIMITS');

            return {
                ok: true,
                document: {
                    trust: 'UNTRUSTED',
                    backend: 'docling',
                    sections: mapped.sections,
                    tables: mapped.tables,
                    text,
                    pages: mapped.pages,
                },
            };
        },
    };
}
