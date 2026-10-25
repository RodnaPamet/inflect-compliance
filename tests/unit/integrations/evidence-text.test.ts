/**
 * `integrationEvidenceText` — what an integration check result is stored as.
 *
 * Both integration Evidence writers (the manual run and the scheduled runner)
 * store a provider's `EvidencePayload` through this, and the payload carries
 * the third party's own text. Each case feeds what a hostile or broken upstream
 * could send and asserts the stored column.
 */
import {
    integrationEvidenceText,
    sanitizeJsonStringValues,
} from '@/app-layer/integrations/evidence-text';
import type { EvidencePayload } from '@/app-layer/integrations/types';

const payload = (over: Partial<EvidencePayload> = {}): EvidencePayload => ({
    title: 'Okta — no_dormant_admins',
    content: '3 account(s) pass no_dormant_admins',
    type: 'REPORT',
    category: 'okta:no_dormant_admins',
    ...over,
});

describe('integrationEvidenceText — prose columns', () => {
    it('stores safe provider text byte for byte', () => {
        expect(integrationEvidenceText(payload())).toEqual({
            title: 'Okta — no_dormant_admins',
            content: '3 account(s) pass no_dormant_admins',
            category: 'okta:no_dormant_admins',
        });
    });

    it('strips markup from the title, the body and the category', () => {
        const stored = integrationEvidenceText(payload({
            title: 'GitHub Branch Protection: acme/<img src=x onerror=alert(1)>repo',
            content: 'acme/repo: PASS — Status checks: <script>alert(1)</script>build, &lt;b&gt;lint&lt;/b&gt;',
            category: 'github:<b>branch</b>',
        }));
        expect(stored).toEqual({
            title: 'GitHub Branch Protection: acme/repo',
            content: 'acme/repo: PASS — Status checks: build, lint',
            category: 'github:branch',
        });
    });

    it('falls back to the "integration" category when none is named, or none survives', () => {
        expect(integrationEvidenceText(payload({ category: undefined })).category).toBe('integration');
        expect(integrationEvidenceText(payload({ category: '<b></b>' })).category).toBe('integration');
    });

    it('stores the body alone when the payload carries no JSON', () => {
        expect(integrationEvidenceText(payload({ content: 'summary' })).content).toBe('summary');
    });
});

describe('integrationEvidenceText — the JSON appended to the body', () => {
    const DETAILS = {
        totalRead: 4,
        applicable: 2,
        failed: 1,
        examples: [{ number: 'CHG0001', approval: 'PENDING' }],
    };

    it('is the body, a blank line, and the details pretty-printed — as the ServiceNow mapper wrote it', () => {
        const stored = integrationEvidenceText(payload({ content: 'One change was not approved.', contentJson: DETAILS }));
        expect(stored.content).toBe(`One change was not approved.\n\n${JSON.stringify(DETAILS, null, 2)}`);
    });

    it('sanitises the string values and still parses as JSON', () => {
        const stored = integrationEvidenceText(payload({
            content: 'summary',
            contentJson: {
                examples: [
                    { number: 'CHG<img src=x onerror=alert(1)>01', approval: 'PENDING' },
                    // A bare `<` before a letter: as text it opens a "tag" that
                    // runs to the next `>`, so sanitising the serialised JSON
                    // would swallow the rest of the document.
                    { number: 'CHG02 a<b', approval: 'REJECTED' },
                    { number: 'CHG03 &reg', approval: 'APPROVED' },
                ],
                failed: 3,
                flagged: true,
                note: null,
            },
        }));
        expect(stored.content.startsWith('summary\n\n')).toBe(true);
        expect(JSON.parse(stored.content.slice('summary\n\n'.length))).toEqual({
            examples: [
                { number: 'CHG01', approval: 'PENDING' },
                { number: 'CHG02 a', approval: 'REJECTED' },
                { number: 'CHG03 ®', approval: 'APPROVED' },
            ],
            failed: 3,
            flagged: true,
            note: null,
        });
        expect(stored.content).not.toMatch(/<img|onerror|<script/);
    });

    it('keeps a URL value pointing where it pointed: the query string survives, markup is encoded', () => {
        const stored = integrationEvidenceText(payload({
            content: 'summary',
            contentJson: {
                link: 'https://acme.service-now.com/change.do?a=1&region=us',
                hostile: 'https://acme.example/x?a=1&region=us"><script>alert(1)</script>',
            },
        }));
        const json = JSON.parse(stored.content.slice('summary\n\n'.length));
        expect(json.link).toBe('https://acme.service-now.com/change.do?a=1&region=us');
        expect(json.hostile).toBe('https://acme.example/x?a=1&region=us%22%3E%3Cscript%3Ealert(1)%3C/script%3E');
    });
});

describe('sanitizeJsonStringValues', () => {
    it('leaves keys, numbers, booleans, null and non-plain objects as they are', () => {
        const at = new Date('2026-10-25T00:00:00.000Z');
        expect(sanitizeJsonStringValues({ 'a-key': 1, b: false, c: null, d: at, e: [2, 'x'] })).toEqual({
            'a-key': 1, b: false, c: null, d: at, e: [2, 'x'],
        });
    });

    it('reaches strings at any depth', () => {
        expect(sanitizeJsonStringValues({ a: [{ b: { c: '<i>deep</i>' } }] })).toEqual({ a: [{ b: { c: 'deep' } }] });
    });
});
