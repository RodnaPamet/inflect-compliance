/**
 * @jest-environment jsdom
 *
 * Policy content enrichment — heading anchors + auto Table of Contents.
 * Runs in jsdom because the helpers parse via the DOM (`DOMParser`).
 */
import {
    slugifyHeading,
    assignHeadingIds,
    enrichPolicyHtml,
    renderPolicyMarkdown,
} from '@/lib/policy/policy-content';

describe('renderPolicyMarkdown', () => {
    it('converts markdown headings, lists and emphasis to HTML', () => {
        const html = renderPolicyMarkdown('# Title\n\n## Purpose\n- a\n- b\n\nBody **bold**.');
        expect(html).toContain('<h1>Title</h1>');
        expect(html).toContain('<h2>Purpose</h2>');
        expect(html).toContain('<li>a</li>');
        expect(html).toContain('<strong>bold</strong>');
    });
    it('converts a markdown thematic break to <hr> (page break)', () => {
        expect(renderPolicyMarkdown('Intro\n\n---\n\n## Next')).toContain('<hr>');
    });
    it('is null/empty-safe', () => {
        expect(renderPolicyMarkdown('')).toBe('');
        expect(renderPolicyMarkdown(null)).toBe('');
        expect(renderPolicyMarkdown('   ')).toBe('');
    });
    it('feeds enrichPolicyHtml — a markdown doc gains heading anchors + a TOC', () => {
        const html = enrichPolicyHtml(
            renderPolicyMarkdown('# Acceptable Use\n\n## Purpose and Scope\nx\n\n## Introduction\ny'),
        );
        expect(html).toContain('<h2 id="purpose-and-scope">');
        expect(html).toContain('policy-toc');
        expect(html).toContain('<a href="#introduction">Introduction</a>');
    });
});

describe('slugifyHeading', () => {
    it('lowercases, strips punctuation, and hyphenates', () => {
        expect(slugifyHeading('Purpose and Scope')).toBe('purpose-and-scope');
        expect(slugifyHeading('Use of email & other comms!')).toBe('use-of-email-other-comms');
    });
    it('falls back to "section" for empty/symbol-only headings', () => {
        expect(slugifyHeading('   ')).toBe('section');
        expect(slugifyHeading('★★★')).toBe('section');
    });
});

describe('assignHeadingIds', () => {
    it('adds a slug id to each heading and returns them in order', () => {
        const { html, headings } = assignHeadingIds(
            '<h1>Acceptable Use Policy</h1><h2>Purpose and Scope</h2><h2>Introduction</h2>',
        );
        expect(html).toContain('<h1 id="acceptable-use-policy">');
        expect(html).toContain('<h2 id="purpose-and-scope">');
        expect(headings.map((h) => h.id)).toEqual([
            'acceptable-use-policy',
            'purpose-and-scope',
            'introduction',
        ]);
        expect(headings[1]).toMatchObject({ level: 2, text: 'Purpose and Scope' });
    });
    it('dedupes repeated headings with a numeric suffix', () => {
        const { headings } = assignHeadingIds('<h2>Use</h2><h2>Use</h2><h2>Use</h2>');
        expect(headings.map((h) => h.id)).toEqual(['use', 'use-2', 'use-3']);
    });
    it('preserves an author-set id', () => {
        const { html, headings } = assignHeadingIds('<h2 id="custom">Title</h2>');
        expect(html).toContain('id="custom"');
        expect(headings[0].id).toBe('custom');
    });
    it('leaves empty headings untouched (no anchor)', () => {
        const { html, headings } = assignHeadingIds('<h2></h2><h2>Real</h2>');
        expect(html).toBe('<h2></h2><h2 id="real">Real</h2>');
        expect(headings).toHaveLength(1);
    });
});

describe('enrichPolicyHtml', () => {
    const body =
        '<h1>Acceptable Use Policy</h1><hr><h2>Purpose and Scope</h2><p>x</p><h2>Introduction</h2><p>y</p>';

    it('inserts the Contents nav immediately after the first page break', () => {
        const out = enrichPolicyHtml(body);
        const hrAt = out.indexOf('<hr');
        const tocAt = out.indexOf('policy-toc');
        const firstH2At = out.indexOf('<h2');
        expect(tocAt).toBeGreaterThan(hrAt);
        expect(tocAt).toBeLessThan(firstH2At);
    });

    it('excludes the leading <h1> title and links the section headings', () => {
        const out = enrichPolicyHtml(body);
        expect(out).toContain('<a href="#purpose-and-scope">Purpose and Scope</a>');
        expect(out).toContain('<a href="#introduction">Introduction</a>');
        // Title is not a TOC entry.
        expect(out).not.toContain('<a href="#acceptable-use-policy">');
    });

    it('falls back to after the first heading when there is no page break', () => {
        const out = enrichPolicyHtml('<h2>One</h2><p>a</p><h2>Two</h2><p>b</p>');
        // The nav sits after the first heading, before the second.
        expect(out.indexOf('policy-toc')).toBeGreaterThan(out.indexOf('>One<'));
        expect(out.indexOf('policy-toc')).toBeLessThan(out.indexOf('>Two<'));
    });

    it('returns the body unchanged when there are fewer than two sections', () => {
        expect(enrichPolicyHtml('<h1>Title</h1><h2>Only</h2><p>x</p>')).not.toContain('policy-toc');
        expect(enrichPolicyHtml('<p>no headings at all</p>')).not.toContain('policy-toc');
    });

    it('escapes heading text in the generated TOC', () => {
        const out = enrichPolicyHtml('<h2>A &amp; B</h2><h2>C &lt;tag&gt;</h2>');
        expect(out).toContain('A &amp; B</a>');
        expect(out).toContain('C &lt;tag&gt;</a>');
        // No raw unescaped angle brackets leaked into the TOC link text.
        expect(out).not.toContain('C <tag></a>');
    });

    it('names the Contents block in the words the page passes, not in English', () => {
        // The policy page passes its catalogue's strings, so a Bulgarian page's
        // TOC landmark is not announced as "Table of contents" (#5884).
        const out = enrichPolicyHtml(body, { title: 'Съдържание', ariaLabel: 'Съдържание на документа' });
        const nav = new DOMParser().parseFromString(out, 'text/html').querySelector('nav.policy-toc');
        expect(nav?.getAttribute('aria-label')).toBe('Съдържание на документа');
        expect(nav?.querySelector('.policy-toc-title')?.textContent).toBe('Съдържание');
        expect(out).not.toMatch(/Table of contents|>Contents</);
    });

    it('marks the labels with the page’s language and the headings with the document’s (#5924)', () => {
        // An English policy on a Bulgarian page: the Contents block is the
        // page's words, its list is the document's headings.
        const out = enrichPolicyHtml(body, { title: 'Съдържание', ariaLabel: 'Съдържание на документа', lang: 'bg', contentLang: 'en' });
        const nav = new DOMParser().parseFromString(out, 'text/html').querySelector('nav.policy-toc');
        expect(nav?.getAttribute('lang')).toBe('bg');
        expect(nav?.querySelector('ul')?.getAttribute('lang')).toBe('en');
        // Same language, nothing to mark.
        const same = new DOMParser().parseFromString(enrichPolicyHtml(body, { title: 'Contents', ariaLabel: 'Contents' }), 'text/html');
        expect(same.querySelector('nav.policy-toc')?.hasAttribute('lang')).toBe(false);
        expect(same.querySelector('nav.policy-toc ul')?.hasAttribute('lang')).toBe(false);
    });

    it('is null-safe', () => {
        expect(enrichPolicyHtml(null)).toBe('');
        expect(enrichPolicyHtml(undefined)).toBe('');
        expect(enrichPolicyHtml('')).toBe('');
    });
});
