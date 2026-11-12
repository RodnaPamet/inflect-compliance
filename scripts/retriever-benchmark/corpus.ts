/**
 * The retriever benchmark's corpus, derived from SEED data and nothing else.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE CORPUS IS DERIVED RATHER THAN HAND-COPIED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * G11 allows seed and fixture corpora only — never customer data. "Only seed
 * data" is a claim about every chunk, and a hand-copied corpus makes that claim
 * by assertion. Deriving the chunks from the files the seed itself loads
 * (`prisma/seed.ts` and the ciso-toolkit fixture it requires) makes it by
 * construction, and `tests/unit/retriever-benchmark-seed-set.test.ts` re-derives
 * the corpus and fails when the committed one differs. So a seed policy edited
 * after the set was built fails CI until the set is rebuilt — which changes its
 * content hash, which is exactly what should retire every record made against
 * the old text.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CHUNKER IS PART OF THE REVISION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rules below — one chunk per heading section, one per numbered policy
 * statement, the document title prefixed — decide what recall@10 measures. A
 * different chunker is a different benchmark, so the chunker's output is inside
 * the set hash rather than beside it.
 *
 * Pure apart from `loadSeedSources`, which reads two repository files. Nothing
 * here touches the network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SourceDocument {
    /** Repository-relative file the text was read from. */
    readonly source: string;
    readonly title: string;
    readonly format: 'markdown' | 'html';
    readonly text: string;
}

export interface CorpusChunk {
    /** `<title-slug>/<heading-slug>`, unique within the corpus. */
    readonly id: string;
    readonly source: string;
    readonly title: string;
    readonly heading: string;
    /** What is embedded: `<title> — <heading>` then the section body. */
    readonly text: string;
}

export const SEED_FILE = 'prisma/seed.ts';
export const CISO_TOOLKIT_FIXTURE = 'prisma/fixtures/policy-templates-ciso-toolkit.json';

export function slug(value: string): string {
    return value
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function unquoteSingle(literal: string): string {
    // A single-quoted TS string literal without escapes beyond \' and \\.
    return literal.slice(1, -1).replace(/\\(['\\])/g, '$1');
}

/**
 * Read the seed's policy texts. Throws when a source yields no documents: a
 * regex that stopped matching after a seed refactor must not shrink the corpus
 * silently, because a smaller corpus makes recall@10 easier, not wrong-looking.
 */
export function loadSeedSources(repoRoot: string): SourceDocument[] {
    const seed = fs.readFileSync(path.join(repoRoot, SEED_FILE), 'utf-8');

    const starters: SourceDocument[] = [];
    const STARTER = /\{ title: '([^']+)', category: '[^']+', tags: '[^']*', contentText: `([^`]*)` \}/g;
    for (const m of seed.matchAll(STARTER)) {
        starters.push({ source: SEED_FILE, title: m[1], format: 'markdown', text: m[2] });
    }
    if (starters.length === 0) throw new Error(`no starter policy templates found in ${SEED_FILE}`);

    const start = seed.indexOf('const flagshipTemplates');
    const end = seed.indexOf('for (const tmpl of flagshipTemplates)', start);
    if (start < 0 || end < 0) throw new Error(`no flagship policy templates found in ${SEED_FILE}`);
    const block = seed.slice(start, end);
    const flagships: SourceDocument[] = [];
    const FLAGSHIP = /title: '([^']+)',[\s\S]*?contentText:\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)/g;
    for (const m of block.matchAll(FLAGSHIP)) {
        const literals = m[2].match(/'(?:[^'\\]|\\.)*'/g) ?? [];
        flagships.push({
            source: SEED_FILE,
            title: m[1],
            format: 'html',
            text: literals.map(unquoteSingle).join(''),
        });
    }
    if (flagships.length === 0) throw new Error(`no flagship policy templates parsed in ${SEED_FILE}`);

    const fixture = JSON.parse(
        fs.readFileSync(path.join(repoRoot, CISO_TOOLKIT_FIXTURE), 'utf-8'),
    ) as { templates: Array<{ title: string; contentType: string; contentText: string }> };
    const toolkit: SourceDocument[] = fixture.templates.map((t) => {
        if (t.contentType !== 'MARKDOWN') {
            throw new Error(`${CISO_TOOLKIT_FIXTURE}: ${t.title} is ${t.contentType}, the chunker reads MARKDOWN`);
        }
        return { source: CISO_TOOLKIT_FIXTURE, title: t.title, format: 'markdown', text: t.contentText };
    });
    if (toolkit.length === 0) throw new Error(`no templates in ${CISO_TOOLKIT_FIXTURE}`);

    return [...starters, ...flagships, ...toolkit];
}

interface Section {
    readonly heading: string;
    readonly body: string;
}

function markdownSections(text: string): Section[] {
    const sections: Section[] = [];
    let h2 = '';
    let heading = '';
    let lines: string[] = [];
    const flush = () => {
        const body = lines.join('\n').trim();
        if (heading && body) sections.push({ heading, body });
        lines = [];
    };
    for (const line of text.split('\n')) {
        const h2m = /^## (.+)$/.exec(line);
        const h3m = /^### (.+)$/.exec(line);
        if (h2m) {
            flush();
            h2 = h2m[1].trim();
            heading = h2;
        } else if (h3m) {
            flush();
            heading = h2 ? `${h2} / ${h3m[1].trim()}` : h3m[1].trim();
        } else if (/^# /.test(line)) {
            flush();
            heading = '';
        } else {
            lines.push(line);
        }
    }
    flush();

    // A numbered "Policy Statements" list is one chunk per statement: each
    // statement answers a different question, and a section-sized chunk would
    // let one hit satisfy four unrelated cases.
    return sections.flatMap((s) => {
        if (!/^Policy Statements$/i.test(s.heading)) return [s];
        const items = [...s.body.matchAll(/^(\d+)\. (.+)$/gm)];
        if (items.length === 0) return [s];
        return items.map((m) => ({ heading: `${s.heading} / ${m[1]}`, body: m[2].trim() }));
    });
}

function stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function htmlSections(html: string): Section[] {
    const sections: Section[] = [];
    const parts = html.split(/<h2>/).slice(1);
    for (const part of parts) {
        const close = part.indexOf('</h2>');
        if (close < 0) continue;
        const heading = stripTags(part.slice(0, close));
        const body = stripTags(part.slice(close + '</h2>'.length));
        if (heading && body) sections.push({ heading, body });
    }
    return sections;
}

export function chunkDocument(doc: SourceDocument): CorpusChunk[] {
    const sections = doc.format === 'html' ? htmlSections(doc.text) : markdownSections(doc.text);
    return sections.map((s) => ({
        id: `${slug(doc.title)}/${slug(s.heading)}`,
        source: doc.source,
        title: doc.title,
        heading: s.heading,
        text: `${doc.title} — ${s.heading}\n${s.body}`,
    }));
}

/**
 * The whole corpus, in source order. Ids are made unique with a numeric
 * suffix in order of appearance, so the result is deterministic for a given
 * input and the set hash is stable.
 */
export function buildCorpus(docs: readonly SourceDocument[]): CorpusChunk[] {
    const seen = new Map<string, number>();
    const out: CorpusChunk[] = [];
    for (const doc of docs) {
        for (const chunk of chunkDocument(doc)) {
            const n = (seen.get(chunk.id) ?? 0) + 1;
            seen.set(chunk.id, n);
            out.push(n === 1 ? chunk : { ...chunk, id: `${chunk.id}-${n}` });
        }
    }
    return out;
}
