/**
 * ciso-toolkit policy-template library coverage + LICENSING ratchet.
 *
 * 15 ISMS policy documents (POL-00…POL-14) imported from ciso-toolkit
 * (MIT). This guard locks: the pinned fixture (all 15, required fields),
 * the MIT attribution sidecar, that a PRODUCTION seeder actually applies the
 * library, that every body survives sanitizePolicyContent UNCHANGED (no
 * content silently stripped on adopt), the picker UI source credit (licensing
 * obligation), and the sync script's normalizer.
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * The delivery half of this guard asked `prisma/seed.ts`:
 *
 *     expect(seed).toContain('policy-templates-ciso-toolkit.json');
 *     expect(seed).toMatch(/OR:\s*\[\{\s*externalRef[\s\S]*\{\s*title/);
 *
 * `prisma/seed.ts` is not run on production deploys — that is the whole
 * reason `scripts/seed-policy-templates.ts` exists and is wired into
 * `scripts/entrypoint.sh`. So the assertion could not fail while the 15
 * policies were undeliverable, and it named the ONE writer no customer ever
 * runs. Worse, it read as the guard's delivery evidence: the fixture-shape
 * cases above it parse a file off disk, and nothing here established that
 * anything applies that file.
 *
 * Delivery is now asked of the applied corpus (`tests/helpers/applied-catalogue`),
 * which discovers the production seeders from `entrypoint.sh` and their
 * fixtures from their own source. The idempotency claim moved with it, onto
 * the seeder that actually re-runs on every container start — which is where
 * "safe to re-run" has to be true.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { sanitizePolicyContent } from '@/lib/security/sanitize';
import { normalizePolicyMarkdown } from '../../scripts/sync-ciso-toolkit-policies';
import { appliedCatalogueStats, productionDeclaringSources } from '../helpers/applied-catalogue';
import { codeOf, declarationOf, functionBodyOf } from '../helpers/source-blocks';

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
/** The writer that reaches production. `prisma/seed.ts` does not. */
const SEEDER = 'scripts/seed-policy-templates.ts';

const fixture = JSON.parse(read(FIXTURE)) as {
    source: string;
    sourceVersion: string;
    license: string;
    templates: Array<Record<string, string>>;
};

const REFS = Array.from({ length: 15 }, (_, i) => `POL-${String(i).padStart(2, '0')}`);

describe('ciso-toolkit policy library — production delivery', () => {
    const stats = appliedCatalogueStats();

    it('a production seeder applies the ciso-toolkit fixture at all', () => {
        // DENOMINATOR. Every fixture-shape and sanitisation case below this
        // point is a claim about a file nothing installs, unless this holds.
        expect(stats.seeders).toContain(SEEDER);
        expect(stats.fixtures).toContain(FIXTURE);
        expect(fixture.templates).toHaveLength(15);
    });

    it('every one of the 15 policies is declared by a source that reaches production', () => {
        for (const ref of REFS) {
            expect(productionDeclaringSources(ref)).toContain(FIXTURE);
        }
    });

    it("ships the 'ciso-toolkit' provenance value the attribution credit is gated on", () => {
        // `PolicyTemplate.source` is what the picker tests `=== 'ciso-toolkit'`
        // against, so the credit only renders if this literal survives into the
        // rows production writes — fixture value AND seeder label.
        const declaring = productionDeclaringSources('ciso-toolkit');
        expect(declaring).toContain(FIXTURE);
        expect(declaring).toContain(SEEDER);
    });

    it('the production seeder reads the fixture and upserts it idempotently (externalRef OR title)', () => {
        const seeder = read(SEEDER);
        // Bounded to the FIXTURES declaration: a require() of this path
        // elsewhere in the file must not satisfy the ciso-toolkit arm.
        expect(declarationOf(seeder, 'FIXTURES')).toContain(
            "require('../prisma/fixtures/policy-templates-ciso-toolkit.json')",
        );
        // entrypoint.sh runs this on EVERY container start, so re-running must
        // not duplicate the library.
        const main = functionBodyOf(seeder, 'main');
        expect(main).toMatch(
            /where:\s*\{\s*OR:\s*\[\{\s*externalRef:\s*t\.externalRef\s*\},\s*\{\s*title:\s*t\.title\s*\}\]\s*\}/,
        );
        expect(main).toMatch(/externalRef:\s*t\.externalRef,/);
    });
});

describe('ciso-toolkit policy library — fixture + licensing', () => {
    it('vendors exactly 15 policies (POL-00…POL-14) with the required fields', () => {
        expect(fixture.templates).toHaveLength(15);
        const refs = fixture.templates.map((t) => t.externalRef).sort();
        expect(refs).toEqual(REFS);
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

describe('ciso-toolkit policy library — sync + UI', () => {
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
