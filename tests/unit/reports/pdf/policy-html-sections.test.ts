/**
 * HTML policy → PDF section parser. HTML policies (page-break `<hr>` +
 * heading sections, the flagship templates) must export with the same
 * cover + clickable TOC + per-section page breaks as markdown — so the
 * body is parsed into the same `{ title, body }[]` shape, via a real DOM
 * parser (no tags bleeding into the PDF).
 */
import { htmlToSections, looksLikeHtml } from '@/app-layer/reports/pdf/policyDocument';

describe('htmlToSections', () => {
    it('opens a section per h1/h2/h3 with the heading as the title', () => {
        const out = htmlToSections(
            '<h1>Acceptable Use Policy</h1><hr><h2>Purpose and Scope</h2><p>Defines use.</p><h2>Introduction</h2><p>Intro text.</p>',
        );
        expect(out.map((s) => s.title)).toEqual([
            'Acceptable Use Policy',
            'Purpose and Scope',
            'Introduction',
        ]);
        expect(out[1].body).toBe('Defines use.');
        expect(out[2].body).toBe('Intro text.');
    });

    it('strips tags — no markup leaks into the section body', () => {
        const out = htmlToSections('<h2>S</h2><p>Hello <strong>bold</strong> & <em>em</em>.</p>');
        expect(out[0].body).toBe('Hello bold & em.');
        expect(out[0].body).not.toMatch(/[<>]/);
    });

    it('renders list items as bullet lines', () => {
        const out = htmlToSections('<h2>Levels</h2><ul><li>Public</li><li>Internal</li></ul>');
        expect(out[0].body).toBe('• Public\n• Internal');
    });

    it('unwraps <div> layout wrappers and keeps nested block text', () => {
        const out = htmlToSections('<h2>S</h2><div><p>One</p><p>Two</p></div>');
        expect(out[0].body).toBe('One\n\nTwo');
    });

    it('folds pre-heading prose into an implicit "Policy" section', () => {
        const out = htmlToSections('<p>Lead-in before any heading.</p><h2>S</h2><p>Body.</p>');
        expect(out[0]).toEqual({ title: 'Policy', body: 'Lead-in before any heading.' });
        expect(out[1].title).toBe('S');
    });

    it('keeps h4-h6 sub-clause headings as paragraphs of their section (#5305)', () => {
        // A Word document pulled from SharePoint uses Heading 4 for sub-clauses;
        // the export used to drop every one of them.
        const out = htmlToSections('<h2>Access</h2><h4>4.1 Accounts</h4><p>One per person.</p><h5>4.1.1 Review</h5><p>Quarterly.</p>');
        expect(out).toHaveLength(1);
        expect(out[0].body).toBe('4.1 Accounts\n\nOne per person.\n\n4.1.1 Review\n\nQuarterly.');
    });

    it('keeps loose top-level text and inline elements as one paragraph (#5305)', () => {
        const out = htmlToSections('<h2>S</h2>Loose text with <strong>bold</strong> words.<p>Then a paragraph.</p>');
        expect(out[0].body).toBe('Loose text with bold words.\n\nThen a paragraph.');
    });

    it('unwraps section-like wrappers and leaves no style or script text in the body', () => {
        const out = htmlToSections('<style>p{color:red}</style><section><h2>S</h2><p>Body.</p></section>');
        expect(out).toEqual([{ title: 'S', body: 'Body.' }]);
    });

    it('returns a single empty Policy section for empty input', () => {
        expect(htmlToSections('')).toEqual([{ title: 'Policy', body: '' }]);
    });
});

describe('looksLikeHtml', () => {
    it('detects HTML block tags', () => {
        expect(looksLikeHtml('<h1>Title</h1><hr><p>x</p>')).toBe(true);
        expect(looksLikeHtml('<ul><li>a</li></ul>')).toBe(true);
    });
    it('treats markdown / plain text as non-HTML', () => {
        expect(looksLikeHtml('# Title\n\n## Section\n- bullet')).toBe(false);
        expect(looksLikeHtml('Just some prose.')).toBe(false);
    });
});
