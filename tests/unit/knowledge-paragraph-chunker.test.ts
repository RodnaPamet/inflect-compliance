/**
 * The plain paragraph chunker (`paragraph@1`, vector store Phase 2.1): what it
 * keeps, where it cuts, and that it is a pure function of its input — which is
 * what makes a re-index a no-op and a rebuild provable.
 */
import { createHash } from 'node:crypto';
import {
    chunkContentHash,
    chunkParagraphs,
    MAX_CHUNK_CHARS,
    PARAGRAPH_CHUNKER_REVISION,
} from '@/lib/knowledge/paragraph-chunker';

const para = (word: string, chars: number) => `${word} `.repeat(Math.ceil(chars / (word.length + 1))).slice(0, chars).trim();

describe('paragraph@1', () => {
    it('names its revision', () => {
        expect(PARAGRAPH_CHUNKER_REVISION).toBe('paragraph@1');
    });

    it('packs short paragraphs together, so a heading travels with its body', () => {
        const chunks = chunkParagraphs('# Access control\n\nAccess is reviewed quarterly.\n\nAdmins use MFA.');
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).toBe('# Access control\n\nAccess is reviewed quarterly.\n\nAdmins use MFA.');
        expect(chunks[0].chunkIndex).toBe(0);
    });

    it('starts a new chunk when the next paragraph would pass the bound', () => {
        const a = para('alpha', 700);
        const b = para('bravo', 700);
        const chunks = chunkParagraphs(`${a}\n\n${b}`);
        expect(chunks.map((c) => c.text)).toEqual([a, b]);
        expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1]);
    });

    it('normalises CRLF and splits at blank lines that hold only whitespace', () => {
        const chunks = chunkParagraphs(`${para('one', 700)}\r\n \t\r\n${para('two', 700)}`, MAX_CHUNK_CHARS);
        expect(chunks).toHaveLength(2);
        expect(chunks.every((c) => !c.text.includes('\r'))).toBe(true);
    });

    it('drops paragraphs with no letter or digit, and yields nothing for wordless text', () => {
        expect(chunkParagraphs('')).toEqual([]);
        expect(chunkParagraphs('---\n\n***\n\n   ')).toEqual([]);
        expect(chunkParagraphs('---\n\nPolicy text.\n\n***').map((c) => c.text)).toEqual(['Policy text.']);
    });

    it('never emits a chunk longer than the bound, cutting at sentences, then words, then code points', () => {
        const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is about access reviews.`).join(' ');
        const longWord = 'x'.repeat(3000);
        // A CJK Extension B ideograph: a letter outside the BMP, so two UTF-16
        // units each — 1,800 units with no whitespace.
        const astral = '\u{20000}'.repeat(900);
        for (const text of [sentences, `${sentences}\n\n${longWord}`, astral]) {
            const chunks = chunkParagraphs(text);
            expect(chunks.length).toBeGreaterThan(1);
            for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
        }
        // A cut inside a surrogate pair would leave a lone surrogate behind.
        for (const c of chunkParagraphs(astral)) expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(c.text)).toBe(false);
        // Splitting a run with no whitespace loses nothing.
        expect(chunkParagraphs(longWord).map((c) => c.text).join('')).toBe(longWord);
    });

    it('cuts a long paragraph at sentence ends rather than mid-sentence', () => {
        const s = (i: number) => `This is sentence ${i}, which is long enough to matter for the bound here.`;
        const text = Array.from({ length: 30 }, (_, i) => s(i)).join(' ');
        const chunks = chunkParagraphs(text, 400);
        for (const c of chunks) {
            expect(c.text.endsWith('.')).toBe(true);
            expect(c.text.length).toBeLessThanOrEqual(400);
        }
    });

    it('hashes each chunk as SHA-256 of its UTF-8 text', () => {
        const [c] = chunkParagraphs('Политиката за достъп се преглежда всяко тримесечие.');
        expect(c.contentHash).toBe(createHash('sha256').update(c.text, 'utf8').digest('hex'));
        expect(chunkContentHash(c.text)).toBe(c.contentHash);
    });

    it('is deterministic: the same text always yields the same chunks', () => {
        const text = Array.from({ length: 12 }, (_, i) => para(`w${i}`, 300 + i * 37)).join('\n\n');
        expect(chunkParagraphs(text)).toEqual(chunkParagraphs(text));
    });

    it('refuses a bound too small to hold a word', () => {
        expect(() => chunkParagraphs('text', 8)).toThrow(RangeError);
    });
});
