/**
 * The plain paragraph chunker (vector store Phase 2.1,
 * `docs/ai-architecture/weaviate.md`). The parsing service
 * (`docs/ai-architecture/ragflow.md`) replaces it later with layout-aware
 * chunks; until then this is the only chunker, and every chunk it cuts names
 * it by revision (`KnowledgeChunk.chunkerRevision`), so a future chunker's
 * output is never mistaken for this one's.
 *
 * ── What `paragraph@1` does ─────────────────────────────────────────────
 *
 *   1. Line endings are normalised to `\n`.
 *   2. The text is split at blank lines into paragraphs, each trimmed. A
 *      paragraph with no letter or digit (a rule, a row of dashes) is dropped:
 *      it carries nothing to retrieve, and the stub embedder would give it a
 *      zero vector, which the vector store refuses.
 *   3. Consecutive paragraphs are packed into one chunk, joined by a blank
 *      line, while the chunk stays within `MAX_CHUNK_CHARS`, so a heading
 *      travels with the paragraph under it.
 *   4. A paragraph longer than `MAX_CHUNK_CHARS` is split at sentence ends,
 *      a sentence longer than that at whitespace, and a run of characters with
 *      no whitespace at all at the bound itself (by code point, never inside a
 *      surrogate pair).
 *
 * ── Why `MAX_CHUNK_CHARS` is 1,200 ───────────────────────────────────────
 *
 * The deployed model (`intfloat/multilingual-e5-small`, D-L4-3) reads 512
 * tokens, and `tei-embed` runs with `--auto-truncate`, which cuts the rest
 * WITHOUT an error. A chunk longer than the model reads is therefore a chunk
 * whose tail is in `KnowledgeChunk.text` and in nobody's vector: a search
 * could never find it. Characters are a proxy for tokens; 1,200 stays under
 * 512 tokens for English (about four characters a token) and for Cyrillic
 * text, which the tokenizer cuts finer, with the `passage: ` prefix included.
 * A different model with a shorter window needs a new revision.
 *
 * Pure and deterministic: the same text always yields the same chunks and the
 * same hashes, which is what makes a re-index a no-op and a rebuild provable.
 *
 * @module lib/knowledge/paragraph-chunker
 */
import { createHash } from 'node:crypto';

/** The revision every chunk this module cuts is stored under. */
export const PARAGRAPH_CHUNKER_REVISION = 'paragraph@1';

/** The longest chunk, in UTF-16 code units of its text. See the module header. */
export const MAX_CHUNK_CHARS = 1200;

export interface TextChunk {
    /** Position within the source, from 0. */
    readonly chunkIndex: number;
    readonly text: string;
    /** Hex SHA-256 of `text` as UTF-8. */
    readonly contentHash: string;
}

/** Hex SHA-256 of a chunk's text, as `KnowledgeChunk.contentHash` stores it. */
export function chunkContentHash(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

const HAS_WORD = /[\p{L}\p{N}]/u;

/** Split an over-long run at the bound, by code point. */
function hardSplit(text: string, max: number): string[] {
    const out: string[] = [];
    let current = '';
    for (const ch of Array.from(text)) {
        if (current.length + ch.length > max) {
            out.push(current);
            current = '';
        }
        current += ch;
    }
    if (current) out.push(current);
    return out;
}

/**
 * Pack `pieces` into runs no longer than `max`, joined by `sep`. A piece longer
 * than `max` on its own is first broken by `split`.
 */
function pack(pieces: readonly string[], sep: string, max: number, split: (p: string) => string[]): string[] {
    const out: string[] = [];
    let current = '';
    for (const raw of pieces) {
        const parts = raw.length > max ? split(raw) : [raw];
        for (const part of parts) {
            if (!current) {
                current = part;
            } else if (current.length + sep.length + part.length <= max) {
                current += sep + part;
            } else {
                out.push(current);
                current = part;
            }
        }
    }
    if (current) out.push(current);
    return out;
}

function splitSentence(sentence: string, max: number): string[] {
    const words = sentence.split(/\s+/).filter(Boolean);
    return pack(words, ' ', max, (w) => hardSplit(w, max));
}

function splitParagraph(paragraph: string, max: number): string[] {
    // A sentence ends at . ! ? or their CJK / full-width forms, before whitespace.
    const sentences = paragraph.split(/(?<=[.!?。！？])\s+/).filter((s) => s.trim());
    return pack(sentences, ' ', max, (s) => splitSentence(s, max));
}

/** Cut `text` into `paragraph@1` chunks. Empty text, or text with no words, yields none. */
export function chunkParagraphs(text: string, max: number = MAX_CHUNK_CHARS): TextChunk[] {
    if (!Number.isInteger(max) || max < 16) throw new RangeError('chunk bound must be an integer of at least 16');
    const paragraphs = text
        .replace(/\r\n?/g, '\n')
        .split(/\n[ \t\f\v]*\n/)
        .map((p) => p.trim())
        .filter((p) => HAS_WORD.test(p));
    return pack(paragraphs, '\n\n', max, (p) => splitParagraph(p, max))
        .filter((c) => HAS_WORD.test(c))
        .map((chunkText, chunkIndex) => ({ chunkIndex, text: chunkText, contentHash: chunkContentHash(chunkText) }));
}
