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
 *   - that a PRODUCTION seeder applies the fixture, upserting by externalRef
 *     OR title (so a title overlapping a ciso-toolkit template supersedes
 *     POL-xx rather than duplicating it),
 *   - the HTML→Markdown converter behaves.
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * The delivery claim above used to be asked of `prisma/seed.ts`:
 *
 *     const seed = read('prisma/seed.ts');
 *     expect(seed).toContain('policy-templates-imported.json');
 *     expect(seed).toMatch(/where:\s*\{\s*OR:\s*\[…\]\s*\}/);
 *
 * `prisma/seed.ts` is not run on a production deploy — the entrypoint runs
 * `prisma migrate deploy` plus targeted seeders. So both assertions were
 * proxies: they could not fail while the imported templates were undeliverable
 * to any customer, and they would have gone red on the change that FIXED
 * delivery had the loop moved rather than been copied. The seeder that
 * actually reaches production is `scripts/seed-policy-templates.ts`
 * (`node dist/seed-policy-templates.mjs` in `scripts/entrypoint.sh`), which
 * carries its own copy of the same upsert loop.
 *
 * The two claims are now SPLIT rather than merged, because they are not the
 * same claim: the production block asserts delivery, and the dev block below
 * it asserts only that `npm run db:seed` still agrees with production. If the
 * copies ever diverge, the dev block is the one that should redden.
 *
 * The second defect was reach, not path: `expect(seed).toMatch(/where: { OR:
 * […] }/)` was satisfied at THREE positions in seed.ts (ciso-toolkit,
 * imported, original-gaps all upsert the same way), so the imported loop could
 * be deleted outright and a sibling kept the guard green. Both reads are now
 * bounded to the loop they name with `braceBlockAfter`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { appliedCatalogueStats, productionDeclaringSources } from '../helpers/applied-catalogue';
import { braceBlockAfter, codeOf } from '../helpers/source-blocks';

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
/** The seeder `scripts/entrypoint.sh` runs on every container start. */
const PROD_SEEDER = 'scripts/seed-policy-templates.ts';
/** How that seeder spells the fixture, from its own directory. */
const PROD_REQUIRE = '../prisma/fixtures/policy-templates-imported.json';

const fixture = JSON.parse(readRaw(FIXTURE)) as {
    source: string;
    templates: Array<Record<string, string>>;
};

describe('imported policy templates — production delivery', () => {
    it('a production seeder applies the imported fixture at all', () => {
        // DENOMINATOR. Every case in this file is vacuous if nothing that runs
        // on a deploy names this fixture — including the fixture-shape block
        // below, which would then be policing a file no customer receives.
        const stats = appliedCatalogueStats();
        expect(stats.seeders).toContain(PROD_SEEDER);
        expect(stats.fixtures).toContain(FIXTURE);
        expect(productionDeclaringSources(PROD_REQUIRE)).toContain(PROD_SEEDER);
        expect(fixture.templates.length).toBeGreaterThanOrEqual(26);
    });

    it('upserts by externalRef OR title, so a title clash supersedes rather than duplicates', () => {
        const loop = braceBlockAfter(read(PROD_SEEDER), 'for \\(const t of data\\.templates\\)');
        expect(loop).toMatch(
            /where:\s*\{\s*OR:\s*\[\s*\{\s*externalRef:\s*t\.externalRef\s*\}\s*,\s*\{\s*title:\s*t\.title\s*\}\s*\]\s*\}/,
        );
        // Both arms present: a create-only loop would duplicate on re-run, an
        // update-only loop would never deliver a newly added template.
        expect(loop).toContain('policyTemplate.update');
        expect(loop).toContain('policyTemplate.create');
    });
});

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

describe('imported policy templates — dev seeder parity (prisma/seed.ts)', () => {
    // NOT a delivery claim: `prisma/seed.ts` reaches no production database.
    // It is a PARITY claim — the two copies of the upsert loop must agree, so
    // a local `npm run db:seed` produces the same library production gets.
    // If this reddens alone, the copies have diverged; fix the dev copy.
    it('applies the same fixture with the same upsert key as production', () => {
        const seed = read('prisma/seed.ts');
        expect(seed).toContain('policy-templates-imported.json');
        const loop = braceBlockAfter(seed, 'for \\(const t of importedPolicies\\.templates\\)');
        expect(loop).toMatch(
            /where:\s*\{\s*OR:\s*\[\s*\{\s*externalRef:\s*t\.externalRef\s*\}\s*,\s*\{\s*title:\s*t\.title\s*\}\s*\]\s*\}/,
        );
    });
});

describe('imported policy templates — converter', () => {
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
