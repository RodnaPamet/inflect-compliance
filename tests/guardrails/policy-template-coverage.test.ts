/**
 * Policy-template coverage + provenance ratchet.
 *
 * The global policy-template starter set is seeded from the inline
 * `policyTemplates` array in `prisma/seed.ts` into the `PolicyTemplate`
 * model (idempotent by title). This guard:
 *
 *   - locks the expanded domain coverage (the JupiterOne topic list was
 *     used only as a subject checklist — see the impl note);
 *   - PROVES the content is original, not copied from the CC-BY-SA-4.0
 *     source: none of JupiterOne's Mustache placeholders may appear in
 *     our seed. This is the load-bearing licensing guard — a future paste
 *     of their templated text trips it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf, declarationOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const seed = codeOf(fs.readFileSync(path.join(ROOT, 'prisma/seed.ts'), 'utf8'));

// Titles that must exist in the seeded starter set (original content).
// NOTE: the thin one-paragraph pre-existing stubs (Information Security,
// Access Control, Incident Response, Business Continuity, Risk Management)
// were removed — they rendered as near-empty "5-6 row" documents. Those
// topics are now covered by the richer ciso-toolkit + imported fixture
// libraries (which the seed loops load), not by inline originals here.
const REQUIRED_TITLES = [
    // expanded coverage (JupiterOne domains, original text)
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

// JupiterOne's CC-BY-SA-4.0 templates use these Mustache tokens. If any
// appear in our seed, content was copied verbatim — a licensing problem.
const FORBIDDEN_SOURCE_TOKENS = [
    '{{companyShortName}}',
    '{{companyLongName}}',
    '{{defaultRevision}}',
    '{{#needStandard',
    '{{/needStandard}}',
];

describe('policy-template coverage', () => {
    it('seeds every required policy-template title (original content)', () => {
        const missing = REQUIRED_TITLES.filter((t) => !seed.includes(`title: '${t}'`));
        expect(missing).toEqual([]);
    });

    it('seeds at least 50 policy templates, counted from where they actually come from', () => {
        // WHAT THIS USED TO DO, and why it was replaced. It ran
        // `/title:\s*'[^']+',\s*category:/` over the WHOLE of seed.ts and
        // asserted the count was >= 25. That needle is not specific to policy
        // templates: it matched CONTROL templates too, and the assertion only
        // ever passed because ten legacy control templates padded it. Moving
        // those into a fixture dropped the number from 33 to 23 and turned
        // this red — a guard failing because a control template moved, in a
        // file about policies.
        //
        // The real count was never 25. The inline policy arrays hold 14
        // between them; the other 47 come from three fixtures this scan could
        // not see at all. So it was over-counting one population and blind to
        // another, and both errors happened to cancel into a passing number.
        //
        // Counted from the actual sources now, and bound to the declarations
        // rather than to the file.
        const inline = ['policyTemplates', 'flagshipTemplates']
            .map((name) => declarationOf(seed, name))
            .reduce((n, block) => n + (block.match(/title:\s*'(?:[^'\\]|\\.)*'/g) ?? []).length, 0);

        const fromFixtures = [
            'policy-templates-ciso-toolkit.json',
            'policy-templates-imported.json',
            'policy-templates-original-gaps.json',
        ].reduce((n, f) => {
            const raw = JSON.parse(
                fs.readFileSync(path.join(ROOT, 'prisma/fixtures', f), 'utf8'),
            ) as unknown;
            const list = Array.isArray(raw)
                ? raw
                : ((raw as { templates?: unknown[] }).templates ?? []);
            return n + list.length;
        }, 0);

        // 14 inline + 47 fixture = 61 today. A floor, not an equality.
        expect(inline).toBeGreaterThanOrEqual(14);
        expect(fromFixtures).toBeGreaterThanOrEqual(45);
        expect(inline + fromFixtures).toBeGreaterThanOrEqual(50);
    });

    it('contains NO JupiterOne CC-BY-SA placeholders (content is original, not copied)', () => {
        const leaked = FORBIDDEN_SOURCE_TOKENS.filter((tok) => seed.includes(tok));
        expect(leaked).toEqual([]);
    });
});
