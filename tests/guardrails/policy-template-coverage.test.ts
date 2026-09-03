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
import { codeOf } from '../helpers/source-blocks';

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

    it('seeds at least 25 policy templates', () => {
        const count = (seed.match(/title:\s*'[^']+',\s*category:/g) ?? []).length;
        expect(count).toBeGreaterThanOrEqual(25);
    });

    it('contains NO JupiterOne CC-BY-SA placeholders (content is original, not copied)', () => {
        const leaked = FORBIDDEN_SOURCE_TOKENS.filter((tok) => seed.includes(tok));
        expect(leaked).toEqual([]);
    });
});
