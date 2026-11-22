/**
 * THE DOCUMENT PARSER SEAM — the types every backend answers in
 * (`docs/ai-architecture/ragflow.md` Phase 1, adapted to D-L4-4: a
 * Docling-class parsing-only service is the default backend).
 *
 * One interface, two backends: the deterministic paragraph stub
 * (`stub-provider.ts`), which needs nothing, and the Docling HTTP client
 * (`docling-provider.ts`), which exists only when the operator names a base URL.
 * `index.ts` decides which one runs and is the only place that does.
 *
 * Three properties live in these types rather than in any one backend:
 *
 *   1. **A parse never throws for a reason it can name.** `parse()` resolves to
 *      a {@link ParseResult}: a document, or a refusal carrying one
 *      {@link ParseRefusalReason}. Fail closed, never silently (legacy-access
 *      invariant 4, applied here): a truncated, partial or oversized answer is a
 *      refusal with a reason, never a smaller document that looks complete.
 *   2. **Zero is never complete.** A parse that finds no text and no table is
 *      `EMPTY_DOCUMENT`, never `{ ok: true }` with nothing in it — an indexed
 *      file with no chunks is a hole nobody would see.
 *   3. **The output is UNTRUSTED.** Every string in a {@link ParsedDocument} is
 *      text a model will read that no human wrote (G4). It reaches a model only
 *      through `guardParsedDocument` in `src/app-layer/ai/parsing/`, whose
 *      `GuardedParsedDocument` is the only type a model-facing consumer may
 *      accept, and it is never logged — not on success, not in a refusal.
 */

/** Which backend produced a result. Closed on purpose: a third is a reviewed diff. */
export type ParserBackend = 'docling' | 'stub';

/** What the caller hands a parser. `filename` is never forwarded to a backend. */
export interface ParseInput {
    readonly bytes: Uint8Array;
    /** The media type the upload was stored with. Routing is decided on it. */
    readonly mime: string;
    /**
     * Kept for the caller's own records. No backend sends it: a tenant-chosen
     * file name is tenant text, and the parsing service needs only the format,
     * which the backend derives from `mime`.
     */
    readonly filename?: string;
}

export interface ParseOptions {
    /** Absolute epoch-ms ceiling for the whole parse, owned by the caller (a job). */
    readonly deadlineAt?: number;
}

/** One heading-bounded run of text. Its paragraphs are Phase 2's chunk boundaries. */
export interface ParsedSection {
    /** `null` for text that precedes the document's first heading. */
    readonly heading: string | null;
    /** Heading depth: 0 for a document title, 1+ for section headers. */
    readonly level: number;
    /** The page the section starts on; `null` when the backend has no pages. */
    readonly page: number | null;
    readonly paragraphs: readonly string[];
}

/** A table, cell by cell. Phase 2 renders it as one Markdown chunk. */
export interface ParsedTable {
    readonly page: number | null;
    readonly rows: readonly (readonly string[])[];
}

export interface ParsedDocument {
    /** A label for every consumer: this text came from a parser, not a person. */
    readonly trust: 'UNTRUSTED';
    readonly backend: ParserBackend;
    readonly sections: readonly ParsedSection[];
    readonly tables: readonly ParsedTable[];
    /** The sections' headings and paragraphs, in order, blank-line separated. */
    readonly text: string;
    /** Page count; `null` when the backend has no notion of pages. */
    readonly pages: number | null;
}

/**
 * Why a parse produced no document. Each one is a refusal the caller records;
 * none of them is ever reported as a complete parse.
 */
export type ParseRefusalReason =
    /** The backend does not read this media type. */
    | 'UNSUPPORTED_MEDIA'
    /** The upload is over the input cap; nothing was sent. */
    | 'INPUT_TOO_LARGE'
    /** A text document whose bytes are not valid UTF-8. */
    | 'UNDECODABLE_TEXT'
    /** The parse found no text and no table. Zero is never complete. */
    | 'EMPTY_DOCUMENT'
    /** The backend's answer passed the byte cap. The read was aborted, not truncated. */
    | 'RESPONSE_TOO_LARGE'
    /** The answer parsed, but carried more sections, tables or cells than the limits. */
    | 'RESPONSE_OVER_LIMITS'
    /** The answer was not the shape this client reads (version drift, a zip, not JSON). */
    | 'CONTRACT_VIOLATION'
    /** The backend says some of the document converted and some did not. */
    | 'PARTIAL_PARSE'
    /** The backend says the conversion failed or was skipped. */
    | 'PARSE_FAILED'
    /** 401/403 from the backend: the operator's key is wrong or missing. */
    | 'AUTH_FAILED'
    /** Another 4xx: the backend refused this request. */
    | 'UPSTREAM_REFUSED'
    /**
     * The in-deployment rule refused the configured URL
     * (`src/lib/ai/in-deployment-service.ts`): a scheme other than http(s),
     * credentials in the URL, a metadata host, an address — literal or any one
     * it resolves to — outside the deployment, or a redirect. A configuration
     * fault. A name that does not resolve at all is NOT this: nothing was
     * refused, so it is `UNREACHABLE`.
     */
    | 'EGRESS_REFUSED'
    /** 5xx or 429: the backend is up but cannot serve. */
    | 'UPSTREAM_UNAVAILABLE'
    /** The socket failed, or the host did not resolve (NXDOMAIN, EAI_AGAIN): nothing answered. */
    | 'UNREACHABLE'
    /** The deadline passed before the answer was read in full. */
    | 'TIMEOUT';

/**
 * The refusals that mean "the backend is down", as opposed to "the backend
 * answered and the answer is unusable" or "this deployment is misconfigured".
 * Only these fall back to the stub, with a WARN (Phase 1's outage test).
 *
 * `EGRESS_REFUSED` is deliberately NOT here: a URL outside the deployment the
 * in-deployment rule refuses will be refused on every parse, and falling back would
 * hide a permanent misconfiguration behind a stub that reads only text.
 * `RESPONSE_TOO_LARGE` is not here either: the refusal is the property.
 */
export const OUTAGE_REASONS: ReadonlySet<ParseRefusalReason> = new Set<ParseRefusalReason>([
    'UPSTREAM_UNAVAILABLE',
    'UNREACHABLE',
    'TIMEOUT',
]);

/** Where a fallback came from, so a stub result is never mistaken for the primary's. */
export interface FallbackLabel {
    readonly backend: ParserBackend;
    readonly reason: ParseRefusalReason;
}

export type ParseResult =
    | {
          readonly ok: true;
          readonly document: ParsedDocument;
          /** Present when the primary backend refused and this is the stub's answer. */
          readonly fallbackFrom?: FallbackLabel;
      }
    | {
          readonly ok: false;
          readonly backend: ParserBackend;
          readonly reason: ParseRefusalReason;
          readonly fallbackFrom?: FallbackLabel;
      };

export interface DocumentParser {
    readonly backend: ParserBackend;
    parse(input: ParseInput, opts?: ParseOptions): Promise<ParseResult>;
}

/**
 * Size limits shared by every backend. Exceeding any of them is a refusal,
 * never a truncation.
 */
export interface ParserLimits {
    /** Upload bytes. Refused BEFORE anything is sent. */
    readonly maxInputBytes: number;
    /** Backend answer bytes, counted while streaming; the read aborts past it. */
    readonly maxResponseBytes: number;
    readonly maxSections: number;
    readonly maxTables: number;
    readonly maxCellsPerTable: number;
    /** Characters of `text` across the whole document. */
    readonly maxTextChars: number;
    /** Per-request ceiling; the caller's `deadlineAt` can only shorten it. */
    readonly timeoutMs: number;
}

export const DEFAULT_PARSER_LIMITS: ParserLimits = {
    maxInputBytes: 20 * 1024 * 1024,
    maxResponseBytes: 32 * 1024 * 1024,
    maxSections: 5_000,
    maxTables: 1_000,
    maxCellsPerTable: 20_000,
    maxTextChars: 5_000_000,
    timeoutMs: 120_000,
};

/** Build a refusal. One constructor, so every refusal has the same shape. */
export function refuse(backend: ParserBackend, reason: ParseRefusalReason): ParseResult {
    return { ok: false, backend, reason };
}

/** Join sections into the document's `text`, the one way every backend does it. */
export function sectionsToText(sections: readonly ParsedSection[]): string {
    const parts: string[] = [];
    for (const s of sections) {
        if (s.heading !== null) parts.push(s.heading);
        parts.push(...s.paragraphs);
    }
    return parts.join('\n\n');
}
