/**
 * @jest-environment jsdom
 *
 * Two rules of the mobile measurement (`scripts/mobile-audit/measure.ts`)
 * that #5924 added, held on a hand-built page:
 *
 *   - A control no tap can reach — it and every ancestor up to the body take
 *     no pointer events — is not a tap target. The product tour does that to
 *     the whole page behind its overlay, and the dashboard's 8px radar marks
 *     were counted under 24px there as if a finger could reach them.
 *   - Text the page declares to be in another language (`lang="en"` on the
 *     English library's clause titles and template names) or code (`<code>`,
 *     a CSV column name the importer reads literally) is not collected for
 *     the leak detector; the page's own text, Latin words and all, still is.
 *
 * jsdom does no layout, so each element's box comes from `data-w` / `data-h`
 * (100x20 when absent) through a stubbed `getBoundingClientRect`.
 */
import { collectInPage } from '../../scripts/mobile-audit/measure';

function box(el: Element) {
    const w = Number(el.getAttribute?.('data-w') ?? 100);
    const h = Number(el.getAttribute?.('data-h') ?? 20);
    return { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
}

beforeAll(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
        return box(this);
    };
    Range.prototype.getBoundingClientRect = function (this: Range) {
        const el = this.startContainer.parentElement ?? (this.startContainer as Element);
        return box(el);
    };
    // jsdom has no pseudo-element styles; none of these elements draws one.
    const real = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((el: Element, pseudo?: string | null) =>
        pseudo ? ({ content: 'none' } as unknown as CSSStyleDeclaration) : real(el)) as typeof window.getComputedStyle;
});

function measure(html: string) {
    document.documentElement.setAttribute('lang', 'bg');
    document.body.innerHTML = html;
    return collectInPage({ maxSamples: 20, scrollToEnd: false });
}

describe('tap targets', () => {
    it('counts a small control a tap can reach, and not one nothing under a finger can receive', () => {
        const m = measure(`
            <div style="pointer-events: none">
                <button style="pointer-events: none" aria-label="behind the tour" data-w="8" data-h="8"></button>
            </div>
            <button aria-label="reachable" data-w="8" data-h="8"></button>
        `);
        expect(m.tapUnder24.samples.map((s) => s.text)).toEqual(['reachable']);
        expect(m.tapUnder24.count).toBe(1);
    });

    it('still measures a control that ignores pointer events by the ancestor that takes them', () => {
        const m = measure(`
            <label data-w="44" data-h="44"><span role="checkbox" tabindex="0" style="pointer-events: none" data-w="16" data-h="16" aria-label="tick"></span></label>
        `);
        expect(m.tapUnder24.count).toBe(0);
    });
});

describe('texts for the leak detector', () => {
    it('skips text declared in another language and code, and keeps the page’s own text', () => {
        const m = measure(`
            <p lang="en">Planning</p>
            <h2>Клауза 6: <span lang="en-GB">Improvement</span></h2>
            <p>Качете CSV файл с колони <code>Status</code> и <code>Owner</code>.</p>
            <button lang="en" aria-label="Select A-5.22 Monitoring">x</button>
            <p>Обратно към Agents</p>
            <p lang="bg">Технически</p>
        `);
        expect(m.texts).toEqual(expect.arrayContaining(['Обратно към Agents', 'Технически', 'Клауза 6:']));
        for (const absent of ['Planning', 'Improvement', 'Status', 'Owner', 'Select A-5.22 Monitoring']) {
            expect(m.texts).not.toContain(absent);
            expect(m.chromeTexts).not.toContain(absent);
        }
    });

    it('keeps everything when the page itself is English', () => {
        document.documentElement.setAttribute('lang', 'en');
        document.body.innerHTML = '<p lang="en">Planning</p><p>Clear filters</p>';
        const m = collectInPage({ maxSamples: 5, scrollToEnd: false });
        expect(m.texts).toEqual(expect.arrayContaining(['Planning', 'Clear filters']));
    });
});
