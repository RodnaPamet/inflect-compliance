/**
 * Imported policy-template coverage + print-friendliness ratchet.
 *
 * Generic security policies imported from a vendored CSV export
 * (prisma/fixtures/imported-policies-src/) and converted from messy HTML
 * to CLEAN MARKDOWN so they render through the same markdown→styled→PDF
 * pipeline as the rest of the library. This guard locks:
 *   - the pinned fixture (≥26 templates, required fields, MARKDOWN),
 *   - that every body is sanitiser-stable (no content silently stripped on
 *     adopt) AND free of HTML/entity/bullet remnants (the "print-friendly,
 *     like the rest" guarantee),
 *   - unique slug externalRefs,
 *   - the seed upserts imported templates by externalRef ONLY (so a title
 *     overlapping a ciso-toolkit template doesn't clobber POL-xx),
 *   - the HTML→Markdown converter behaves.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

import { sanitizePolicyContent } from '@/lib/security/sanitize';
import { htmlPolicyToMarkdown } from '../../scripts/import-policy-templates';

const ROOT = path.resolve(__dirname, '../..');
// codeOf() masks comments at the READ SEAM (#2246), so a COMMENT naming a
// thing cannot satisfy an assertion meant to be about CODE. Masking is the
// DEFAULT (`read`) so a new assertion inherits it; `readRaw` is for the files
// where a `//` is content rather than a comment — the `https://` of a URL in
// YAML / JSON / Markdown — and masking would delete real text.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));

const FIXTURE = 'prisma/fixtures/policy-templates-imported.json';
const fixture = JSON.parse(readRaw(FIXTURE)) as {
    source: string;
    templates: Array<Record<string, string>>;
};

describe('imported policy templates — fixture', () => {
    it('vendors at least 26 templates with the required fields', () => {
        expect(fixture.templates.length).toBeGreaterThanOrEqual(26);
        for (const t of fixture.templates) {
            for (const f of ['title', 'category', 'contentText', 'externalRef', 'source']) {
                expect(t[f]).toBeTruthy();
            }
            expect(t.contentType).toBe('MARKDOWN');
            expect(t.source).toBe('imported');
        }
    });

    it('externalRefs are unique, slug-shaped', () => {
        const refs = fixture.templates.map((t) => t.externalRef);
        expect(new Set(refs).size).toBe(refs.length);
        for (const r of refs) expect(r).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    });

    it('every body is print-friendly: sanitiser-stable + no HTML/entity/bullet remnants', () => {
        for (const t of fixture.templates) {
            // Survives the adopt-time sanitiser unchanged (nothing dropped).
            expect(sanitizePolicyContent('MARKDOWN', t.contentText)).toBe(t.contentText);
            // Clean markdown — no leftover tags, entities, raw bullets, or empty bold.
            expect(t.contentText).not.toMatch(/<\/?[a-z][^>]*>/i);
            expect(t.contentText).not.toMatch(/&[a-z]+;|&#\d+;/i);
            expect(t.contentText).not.toContain('•');
            expect(t.contentText).not.toContain('****');
            // Structured: at least one markdown heading.
            expect(t.contentText).toMatch(/(^|\n)#{1,4}\s+\S/);
        }
    });
});

describe('imported policy templates — seed + converter', () => {
    it('seed upserts imported templates by externalRef OR title (imported is canonical)', () => {
        const seed = read('prisma/seed.ts');
        expect(seed).toContain('policy-templates-imported.json');
        // The imported loop supersedes any earlier same-titled template
        // (ciso-toolkit / expanded-starter) so there is one card per title.
        expect(seed).toMatch(/where:\s*\{\s*OR:\s*\[\s*\{\s*externalRef:\s*t\.externalRef\s*\}\s*,\s*\{\s*title:\s*t\.title\s*\}\s*\]\s*\}/);
    });

    it('htmlPolicyToMarkdown converts headings + bullets and drops messy markup', () => {
        const html = '<p></p><h1>Scope</h1><br>Applies to all.<br><span style="font-size:12px;">•&nbsp;</span>First<br><ul><li>Second</li></ul><b></b>';
        const md = htmlPolicyToMarkdown(html);
        expect(md).toMatch(/# Scope/);
        expect(md).toMatch(/- First/);
        expect(md).toMatch(/- Second/);
        expect(md).not.toMatch(/<[a-z/]/i);
        expect(md).not.toContain('•');
        expect(md).not.toContain('****');
    });
});
