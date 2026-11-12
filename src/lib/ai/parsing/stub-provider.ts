/**
 * THE DETERMINISTIC PARAGRAPH STUB — the parser that needs nothing.
 *
 * It is what runs when the operator names no parsing service (G9: absent
 * config constructs nothing), and what an outage of that service falls back to.
 * It reads TEXT documents only — plain text and Markdown — and splits them on
 * blank lines; a Markdown ATX heading (`# …` to `###### …`) starts a section.
 * Anything else (a PDF, an office file, an image) is `UNSUPPORTED_MEDIA`: the
 * stub does not pretend to read a format it cannot, because a PDF decoded as
 * UTF-8 would index as garbage that looks like text.
 *
 * Pure: no network, no clock, no logging. The same bytes always give the same
 * result, which is what makes it a usable placeholder for the chunker revision
 * (Phase 2 keys the mount gate on the parser backend).
 */
import {
    DEFAULT_PARSER_LIMITS,
    refuse,
    sectionsToText,
    type DocumentParser,
    type ParseInput,
    type ParseResult,
    type ParsedSection,
    type ParserLimits,
} from './types';

/** The media types the stub reads. Parameters (`; charset=…`) are ignored. */
export const STUB_TEXT_MIMES: ReadonlySet<string> = new Set(['text/plain', 'text/markdown']);

const ATX_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export function baseMime(mime: string): string {
    return mime.split(';')[0].trim().toLowerCase();
}

/**
 * Split text into heading-bounded sections of blank-line paragraphs.
 * `markdown` decides whether `# …` lines are headings or ordinary text.
 */
export function chunkParagraphs(text: string, markdown: boolean): ParsedSection[] {
    const sections: ParsedSection[] = [];
    let heading: string | null = null;
    let level = 0;
    let paragraphs: string[] = [];
    let lines: string[] = [];

    const flushParagraph = () => {
        const p = lines.join('\n').trim();
        if (p) paragraphs.push(p);
        lines = [];
    };
    const flushSection = () => {
        flushParagraph();
        if (heading !== null || paragraphs.length > 0) {
            sections.push({ heading, level, page: null, paragraphs });
        }
        paragraphs = [];
    };

    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const m = markdown ? ATX_HEADING.exec(line) : null;
        if (m) {
            flushSection();
            heading = m[2];
            level = m[1].length;
            continue;
        }
        if (line.trim() === '') {
            flushParagraph();
            continue;
        }
        lines.push(line);
    }
    flushSection();
    return sections;
}

export function createStubParser(limits: ParserLimits = DEFAULT_PARSER_LIMITS): DocumentParser {
    return {
        backend: 'stub',
        async parse(input: ParseInput): Promise<ParseResult> {
            const mime = baseMime(input.mime);
            if (!STUB_TEXT_MIMES.has(mime)) return refuse('stub', 'UNSUPPORTED_MEDIA');
            if (input.bytes.byteLength > limits.maxInputBytes) return refuse('stub', 'INPUT_TOO_LARGE');

            let text: string;
            try {
                // `fatal`: invalid UTF-8 is a refusal, never U+FFFD sprinkled
                // through text that then indexes as if it were the document.
                text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
            } catch {
                return refuse('stub', 'UNDECODABLE_TEXT');
            }

            const sections = chunkParagraphs(text, mime === 'text/markdown');
            const hasText = sections.some((s) => s.paragraphs.length > 0);
            if (!hasText) return refuse('stub', 'EMPTY_DOCUMENT');
            if (sections.length > limits.maxSections) return refuse('stub', 'RESPONSE_OVER_LIMITS');

            const joined = sectionsToText(sections);
            if (joined.length > limits.maxTextChars) return refuse('stub', 'RESPONSE_OVER_LIMITS');

            return {
                ok: true,
                document: {
                    trust: 'UNTRUSTED',
                    backend: 'stub',
                    sections,
                    tables: [],
                    text: joined,
                    pages: null,
                },
            };
        },
    };
}
