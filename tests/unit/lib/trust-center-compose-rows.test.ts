/**
 * #4824 — which compose rows are published, which are left out because they
 * are blank, and which the form refuses on the row.
 */
import {
    documentRowProblem,
    frameworkRowProblem,
    isPublishableUrl,
    publishedDocuments,
    publishedFrameworks,
} from '@/lib/trust-center/compose-rows';

describe('framework rows', () => {
    it('a complete row is fine, a blank one is not a problem, a half one is', () => {
        expect(frameworkRowProblem({ key: 'SOC 2', statusLabel: 'Type II' })).toBeNull();
        expect(frameworkRowProblem({ key: ' ', statusLabel: '' })).toBeNull();
        expect(frameworkRowProblem({ key: 'SOC 2', statusLabel: ' ' })).toBe('incomplete');
        expect(frameworkRowProblem({ key: '', statusLabel: 'Type II' })).toBe('incomplete');
    });

    it('publishes every row with something in it', () => {
        expect(
            publishedFrameworks([
                { key: 'SOC 2', statusLabel: 'Type II' },
                { key: '', statusLabel: '' },
                { key: 'ISO', statusLabel: '' },
            ]),
        ).toEqual([
            { key: 'SOC 2', statusLabel: 'Type II' },
            { key: 'ISO', statusLabel: '' },
        ]);
    });
});

describe('document rows', () => {
    it('needs a name and an http(s) address', () => {
        expect(documentRowProblem({ label: 'Whitepaper', url: 'https://acme.test/w.pdf' })).toBeNull();
        expect(documentRowProblem({ label: '', url: '' })).toBeNull();
        expect(documentRowProblem({ label: 'Whitepaper', url: '' })).toBe('incomplete');
        expect(documentRowProblem({ label: '', url: 'https://acme.test' })).toBe('incomplete');
        expect(documentRowProblem({ label: 'Whitepaper', url: 'acme.test/w.pdf' })).toBe('badUrl');
        expect(documentRowProblem({ label: 'Whitepaper', url: 'javascript:alert(1)' })).toBe('badUrl');
    });

    it('accepts what the server accepts', () => {
        expect(isPublishableUrl(' http://acme.test ')).toBe(true);
        expect(isPublishableUrl('ftp://acme.test')).toBe(false);
        expect(isPublishableUrl('data:text/html,hi')).toBe(false);
    });

    it('leaves out only blank rows', () => {
        expect(publishedDocuments([{ label: '', url: ' ' }, { label: 'A', url: 'x' }])).toEqual([{ label: 'A', url: 'x' }]);
    });
});
