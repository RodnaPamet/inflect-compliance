/**
 * Policy-template coverage + provenance ratchet.
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * Every case in this file read `prisma/seed.ts` and asked whether a string was
 * in it. `prisma/seed.ts` is applied by `npm run db:seed` and is NOT run on a
 * production deploy — `scripts/entrypoint.sh` runs `prisma migrate deploy` plus
 * a handful of targeted seeders. The production writer for the global
 * `PolicyTemplate` library is `scripts/seed-policy-templates.ts`, which applies
 * three vendored fixtures and never looks at `seed.ts` at all.
 *
 * So the two load-bearing claims here were both bound to the wrong file:
 *
 *   • "seeds every required policy-template title" could not fail while every
 *     one of those templates was undeliverable, and would have failed the
 *     moment somebody moved a title into the fixture that actually ships it.
 *   • the LICENSING guard — the one this file calls load-bearing — scanned
 *     `seed.ts` only. A verbatim paste of JupiterOne's CC-BY-SA-4.0 templated
 *     text would land in a FIXTURE today, which the scan could not see. The
 *     guard was pointed at the one place the content no longer lives.
 *
 * ═══ WHAT THIS FILE ASSERTS NOW ═══
 *
 * Two describes, deliberately not merged, because the two populations are not
 * the same product:
 *
 *   1. `policy-template delivery` — the corpus `scripts/seed-policy-templates.ts`
 *      applies on every container start. Domain coverage, per-row
 *      deliverability, and the licensing scan (now over the WHOLE applied
 *      corpus, so a paste into any shipped fixture trips it) live here.
 *   2. `prisma/seed.ts inline starter set` — the dev-only inline arrays, kept
 *      and labelled as dev-only. 11 of the 13 titles in `INLINE_DEV_TITLES`
 *      have NO production counterpart under any spelling, so those assertions
 *      cannot be repointed honestly: there is nothing in production to point
 *      them at. They stay, saying only what they can say.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appliedCatalogueText, appliedSources } from '../helpers/applied-catalogue';
import { codeOf, declarationOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const seed = codeOf(fs.readFileSync(path.join(ROOT, 'prisma/seed.ts'), 'utf8'));

/** The one seeder `scripts/entrypoint.sh` runs for the global template library. */
const POLICY_SEEDER = 'scripts/seed-policy-templates.ts';

interface AppliedTemplate {
    readonly externalRef?: unknown;
    readonly title?: unknown;
    readonly category?: unknown;
    readonly contentText?: unknown;
    readonly source?: unknown;
}

/**
 * The policy templates production actually applies, and the fixtures they came
 * from — DISCOVERED from the seeder, never listed here. The previous version
 * hard-coded the three fixture filenames, so a fourth fixture would have been
 * invisible to every count below.
 */
function appliedPolicyTemplates(): { fixtures: string[]; templates: AppliedTemplate[] } {
    const fixtures = appliedSources().filter(
        (s) => s.appliedBy === POLICY_SEEDER && s.file.endsWith('.json'),
    );
    const templates = fixtures.flatMap((s) => {
        const raw = JSON.parse(s.text) as unknown;
        const list = Array.isArray(raw) ? raw : ((raw as { templates?: unknown[] }).templates ?? []);
        return list as AppliedTemplate[];
    });
    return { fixtures: fixtures.map((s) => s.file), templates };
}

/**
 * Policy domains the delivered library must cover, named by the title
 * production actually ships. These are the titles present in the fixtures the
 * entrypoint seeder applies — not the inline `seed.ts` spellings, several of
 * which differ (`Cloud Security Policy` inline vs `Cloud Services Policy`
 * delivered) and several of which do not exist in production at all.
 */
const DELIVERED_TITLES = [
    'Information Security Policy',
    'Risk Management Policy',
    'Access Management Policy',
    'Asset Management Policy',
    'Incident Management Policy',
    'Business Continuity Policy',
    'Privacy Policy',
    'Secure Development Policy',
    'Threat & Vulnerability Management Policy',
    'Cryptography & Data Protection Policy',
    'Mobile Device Management & BYOD Policy',
    'Cloud Services Policy',
    'Logging and Monitoring Policy',
    'Physical Security Policy',
    'Compliance Management Policy',
    'Human Resources Security Policy',
    'Backup Policy',
    'Supplier Management Policy',
    'Data Classification & Handling Policy',
    'Corporate Governance of Information Security Policy',
];

// JupiterOne's CC-BY-SA-4.0 templates use these Mustache tokens. If any appear
// in anything we apply, content was copied verbatim — a licensing problem.
const FORBIDDEN_SOURCE_TOKENS = [
    '{{companyShortName}}',
    '{{companyLongName}}',
    '{{defaultRevision}}',
    '{{#needStandard',
    '{{/needStandard}}',
];

describe('policy-template delivery (what production applies)', () => {
    const { fixtures, templates } = appliedPolicyTemplates();

    it('a production seeder applies policy-template fixtures at all', () => {
        // DENOMINATOR. Every case below is vacuous on an empty corpus — which
        // is precisely how the previous fixture reader could have failed
        // silently, since it named its three files by hand.
        expect(fixtures.length).toBeGreaterThanOrEqual(3);
        expect(templates.length).toBeGreaterThanOrEqual(45);
    });

    it('covers every policy domain the delivered library promises', () => {
        const delivered = new Set(templates.map((t) => t.title));
        const missing = DELIVERED_TITLES.filter((t) => !delivered.has(t));
        expect(missing).toEqual([]);
    });

    it('every delivered template carries the fields the seeder writes', () => {
        // The seeder upserts keyed by `externalRef` OR `title` and writes
        // `contentText` straight through. A row missing either key is not
        // idempotent; a row with a stub body renders as an empty document.
        const broken = templates.filter(
            (t) =>
                typeof t.externalRef !== 'string' ||
                t.externalRef.length === 0 ||
                typeof t.title !== 'string' ||
                t.title.length === 0 ||
                typeof t.contentText !== 'string' ||
                t.contentText.length < 500,
        );
        expect(broken.map((t) => String(t.title ?? '<untitled>'))).toEqual([]);
    });

    it('attributes every delivered template to a declared provenance', () => {
        const sources = new Set(templates.map((t) => t.source));
        expect([...sources].sort()).toEqual(['IC Original', 'ciso-toolkit', 'imported']);
    });

    it('contains NO JupiterOne CC-BY-SA placeholders anywhere production applies', () => {
        // Was `seed.includes(tok)`, which could not see the fixtures the
        // content now lives in. Scanned over the whole applied corpus — seed.ts
        // AND every fixture any entrypoint seeder names — so a paste into any
        // shipped file trips it. Widening a forbidden-token scan forbids more.
        const corpus = appliedCatalogueText();
        const leaked = FORBIDDEN_SOURCE_TOKENS.filter((tok) => corpus.includes(tok));
        expect(leaked).toEqual([]);
    });
});

describe('prisma/seed.ts inline starter set (dev only — NOT applied on deploy)', () => {
    // These titles exist ONLY in the inline `policyTemplates` array in
    // prisma/seed.ts. `scripts/seed-policy-templates.ts` does not read them, so
    // no deployed environment has them, and 11 of the 13 have no production
    // counterpart under any spelling. There is nothing to repoint these at, so
    // they are kept as what they are: a claim about a dev-only array.
    const INLINE_DEV_TITLES = [
        'Asset Management Policy',
        'Vulnerability Management Policy',
        'Secure Development (SDLC) Policy',
        'Data Protection & Encryption Policy',
        'Mobile Device & BYOD Policy',
        'Privacy Policy',
        'Threat Intelligence & Management Policy',
        'Security Governance Policy',
        'Data Retention & Disposal Policy',
        'Data Breach Notification Policy',
        'Compliance & Audit Management Policy',
        'Policy Management Policy',
        'Cloud Security Policy',
    ];

    it('the inline dev array still holds every title it claims', () => {
        const missing = INLINE_DEV_TITLES.filter((t) => !seed.includes(`title: '${t}'`));
        expect(missing).toEqual([]);
    });

    it('counts its templates from the declarations, not from the file', () => {
        // WHAT THIS USED TO DO. It ran `/title:\s*'[^']+',\s*category:/` over
        // the WHOLE of seed.ts and asserted >= 25. That needle is not specific
        // to policy templates: it matched CONTROL templates too, and only ever
        // passed because ten legacy control templates padded it. Moving those
        // into a fixture dropped it from 33 to 23 and turned this red — a guard
        // failing because a control template moved, in a file about policies.
        //
        // It was then rewritten to count the inline arrays PLUS the three
        // fixtures and assert the sum was >= 50. That sum was its own mistake:
        // it added a dev-only population to a production one and reported a
        // single number, so 14 undeliverable templates propped up a floor about
        // what customers get. The two populations are counted apart now — the
        // production floor lives in the delivery describe above.
        const inline = ['policyTemplates', 'flagshipTemplates']
            .map((name) => declarationOf(seed, name))
            .reduce((n, block) => n + (block.match(/title:\s*'(?:[^'\\]|\\.)*'/g) ?? []).length, 0);

        expect(inline).toBeGreaterThanOrEqual(14);
    });
});
