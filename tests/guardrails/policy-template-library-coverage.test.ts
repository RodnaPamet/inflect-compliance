/**
 * ciso-toolkit policy-template library coverage + LICENSING ratchet.
 *
 * 15 ISMS policy documents (POL-00…POL-14) imported from ciso-toolkit
 * (MIT). This guard locks: the pinned fixture (all 15, required fields),
 * the MIT attribution sidecar, the seed upsert, that every body survives
 * sanitizePolicyContent UNCHANGED (no content silently stripped on adopt),
 * the picker UI source credit (licensing obligation), and the sync
 * script's normalizer.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { sanitizePolicyContent } from '@/lib/security/sanitize';
import { normalizePolicyMarkdown } from '../../scripts/sync-ciso-toolkit-policies';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// SOURCE reads are comment-masked at the seam, so a comment naming the source
// credit cannot satisfy an assertion about the rendered code. The JSON fixture,
// the catalog and the LICENSE markdown stay raw — there `//` is content.
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|prisma)$/;
const read = (rel: string) => {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return CODE_FILE.test(rel) ? codeOf(raw) : raw;
};

const FIXTURE = 'prisma/fixtures/policy-templates-ciso-toolkit.json';
const LICENSE = 'prisma/fixtures/policy-templates-ciso-toolkit.LICENSE.md';

const fixture = JSON.parse(read(FIXTURE)) as {
    source: string;
    sourceVersion: string;
    license: string;
    templates: Array<Record<string, string>>;
};

describe('ciso-toolkit policy library — fixture + licensing', () => {
    it('vendors exactly 15 policies (POL-00…POL-14) with the required fields', () => {
        expect(fixture.templates).toHaveLength(15);
        const refs = fixture.templates.map((t) => t.externalRef).sort();
        expect(refs).toEqual(Array.from({ length: 15 }, (_, i) => `POL-${String(i).padStart(2, '0')}`));
        for (const t of fixture.templates) {
            for (const f of ['title', 'category', 'contentText', 'tags', 'source', 'sourceLicense']) {
                expect(t[f]).toBeTruthy();
            }
            expect(t.contentType).toBe('MARKDOWN');
            expect(t.source).toBe('ciso-toolkit');
            expect(t.tags).toMatch(/iso27001/);
            expect(t.tags).toMatch(/nis2/);
        }
    });

    it('carries the MIT attribution (source URL + pinned version) in fixture + LICENSE', () => {
        expect(fixture.license).toBe('MIT');
        expect(fixture.source).toContain('D4d0/ciso-toolkit');
        expect(fixture.sourceVersion).toMatch(/^[0-9a-f]{40}$/);
        const lic = read(LICENSE);
        expect(lic).toMatch(/MIT/);
        expect(lic).toContain('github.com/D4d0/ciso-toolkit');
        expect(lic).toContain(fixture.sourceVersion);
    });
});

describe('ciso-toolkit policy library — sanitisation (no silent stripping)', () => {
    it('every body passes sanitizePolicyContent(MARKDOWN) UNCHANGED', () => {
        for (const t of fixture.templates) {
            expect(sanitizePolicyContent('MARKDOWN', t.contentText)).toBe(t.contentText);
        }
    });

    it('no unresolved toolkit-internal cross-file links remain', () => {
        for (const t of fixture.templates) {
            expect(t.contentText).not.toMatch(/\]\(\.\.\//);
        }
        // ... and no leftover YAML frontmatter.
        for (const t of fixture.templates) {
            expect(t.contentText.startsWith('---')).toBe(false);
        }
    });
});

describe('ciso-toolkit policy library — seed + sync + UI', () => {
    it('the seed upserts the fixture (idempotent by externalRef or title)', () => {
        const seed = read('prisma/seed.ts');
        expect(seed).toContain('policy-templates-ciso-toolkit.json');
        expect(seed).toMatch(/externalRef: t\.externalRef/);
        // Idempotent upsert: match existing by externalRef OR title.
        expect(seed).toMatch(/OR:\s*\[\{\s*externalRef[\s\S]*\{\s*title/);
    });

    it('the templates picker renders the ciso-toolkit source credit', () => {
        // The picker unified into the NewPolicyModal (the standalone
        // /policies/templates page is now a redirect); the licensing credit
        // lives in the modal's template fields.
        const picker = read('src/app/t/[tenantSlug]/(app)/policies/_form/NewPolicyFields.tsx');
        expect(picker).toMatch(/source === 'ciso-toolkit'/);
        // The credit copy moved into the catalog (next-intl); assert the key + its value.
        expect(picker).toMatch(/templates\.adaptedFrom/);
        const en = JSON.parse(read('messages/en.json')) as {
            policies: { templates: Record<string, string> };
        };
        expect(en.policies.templates.adaptedFrom).toContain('Adapted from');
        expect(picker).toContain('github.com/D4d0/ciso-toolkit');
    });

    it('the sync script normalizer strips frontmatter + de-links internal links', () => {
        const sample =
            '---\ndoc_id: POL-99\ntitle: X\n---\n\n# Heading\n\nSee [the proc](../standards-procedures/X/PROC.md) and [ext](https://e.com).\n';
        const out = normalizePolicyMarkdown(sample);
        expect(out.startsWith('# Heading')).toBe(true);
        expect(out).not.toMatch(/\]\(\.\.\//);
        expect(out).toContain('See the proc and [ext](https://e.com).');
    });
});
