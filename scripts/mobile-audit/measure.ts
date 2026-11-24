/**
 * The ONE definition of every mobile-layout metric.
 *
 * Both the whole-product audit (`scripts/mobile-audit/run.ts`) and the mobile
 * E2E project (`tests/e2e/mobile-layout.spec.ts`) import `measurePage` from
 * here, so a defect means the same thing in a nightly report and in a red CI
 * run. Do not copy a metric into a spec: change it here, and both follow.
 *
 * How it measures. `collectInPage` runs inside the page, after the caller has
 * loaded it and let it settle. It reads layout (bounding boxes, computed
 * styles, `elementFromPoint`), never screenshots, so it needs no image
 * comparison and gives the same answer at any device scale. It returns counts
 * plus a few samples per metric, each sample naming the element well enough
 * to find it in the source.
 *
 * The metrics (`MOBILE_METRICS` below is the table of record):
 *
 *   clipped            something interactive, or a run of text, extends past
 *                      the left or right screen edge and NO ancestor scrolls
 *                      sideways to reveal it. The app shell clips horizontal
 *                      overflow (`overflow-x-clip` on the main column) instead
 *                      of scrolling, so this is the real overflow signal: the
 *                      page never scrolls sideways, the control just vanishes.
 *                      Text cut inside a SMALLER box (a `truncate` ellipsis, a
 *                      card's `overflow-hidden`) is a different decision and is
 *                      not counted; only a cut at the screen edge is.
 *   overlay            with the page scrolled to its end, a floating element
 *                      fixed in the lower half of the screen (the assistant
 *                      button, a pinned bar) is the topmost thing at a point of
 *                      a control or of text it overlaps. Scrolled to the end,
 *                      nothing can move out from under it.
 *   tapUnder24/44      an interactive element in the page body (the top bar is
 *                      excluded) whose hit area is under 24 / 44 CSS px on its
 *                      short side. The hit area includes a positioned
 *                      `::before` / `::after` (`TOUCH_HIT_AREA_CLASS` grows a
 *                      22px icon's hit area to 44px that way). An element that
 *                      ignores pointer events (`pointer-events: none`, the
 *                      list card's selection circle) is not what a tap lands
 *                      on: the nearest ancestor that receives them is, so that
 *                      ancestor's box is measured. When none does (the page
 *                      behind the product tour's overlay), no tap reaches the
 *                      element and it is not counted. A link inside a sentence is
 *                      exempt, as WCAG 2.5.8 exempts it, whether it is laid
 *                      out `inline`, `inline-flex` or `inline-block`.
 *   textUnder12        an element whose own text is rendered under 12px. The
 *                      environment badge in the top bar (`top-chrome-env-badge`,
 *                      shown on localhost and staging only) is skipped; every
 *                      other small text, the bell's count badge included, counts.
 *   inputUnder16       a text field, select, textarea or editable region under
 *                      16px: iOS Safari zooms the page when one takes focus.
 *   tabsNoCue          a `role="tablist"` whose tabs do not fit and which shows
 *                      no cue that there is more: no `ScrollCueStrip` overflow
 *                      marker, no mask fade, no visible scrollbar.
 *   buttonWraps        a wrapping flex row of three or more buttons/links laid
 *                      out on three or more lines, where the row's children are
 *                      the buttons themselves (a button, or a wrapper that is
 *                      nothing but one button, such as a tooltip trigger). A
 *                      row with any other child — a form row of labelled
 *                      fields, a navigation strip with a caption — is not a
 *                      button group, and wraps by design.
 *   wideTables         a `<table>` wider than the screen.
 *   englishLeaks       (Bulgarian only) English UI text on the page — see
 *                      `leaks.ts`, which runs Node-side over the texts this
 *                      module collects. Text the page declares to be in
 *                      another language (`lang="en"`) or code (`<code>`) is
 *                      not collected.
 *   docScrollsSideways the document itself scrolls horizontally.
 *
 * Console errors are counted by the caller (they are page events, not layout).
 */
import type { Page } from '@playwright/test';

/** A short, source-findable description of one offending element. */
export interface MeasureSample {
    /** `tag#id.class[data-testid]` of the element, truncated. */
    el: string;
    /** Its visible text or accessible name, truncated. */
    text: string;
    /** Its box, rounded to whole CSS px: x, y, width, height. */
    box: [number, number, number, number];
}

export interface MeasuredMetric {
    count: number;
    samples: MeasureSample[];
}

/** What `collectInPage` returns. Counts are per element, never per page. */
export interface RawMeasurement {
    viewport: { width: number; height: number };
    documentWidth: number;
    docScrollsSideways: boolean;
    clippedControls: MeasuredMetric;
    clippedText: MeasuredMetric;
    overlayCoversControl: MeasuredMetric;
    overlayCoversText: MeasuredMetric;
    tapUnder24: MeasuredMetric;
    tapUnder44: MeasuredMetric;
    textUnder12: MeasuredMetric;
    inputUnder16: MeasuredMetric;
    tabsNoCue: MeasuredMetric;
    buttonWraps: MeasuredMetric;
    wideTables: MeasuredMetric;
    /** Every distinct visible text and accessible-name string, for leak detection. */
    texts: string[];
    /** The subset of `texts` rendered as UI chrome (buttons, tabs, headers, labels, placeholders). */
    chromeTexts: string[];
}

export interface CollectOptions {
    /** Samples kept per metric (the counts are always complete). */
    maxSamples: number;
    /**
     * Scroll to the end of the page before measuring overlays. The audit and
     * the E2E project both do; a caller measuring an open state (a drawer
     * whose page behind it must not move) passes false.
     */
    scrollToEnd: boolean;
}

/**
 * Runs in the browser. It must be self-contained: no imports, no closures over
 * module scope, because Playwright serialises its source into the page.
 */
export function collectInPage(opts: CollectOptions): RawMeasurement {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const EPS = 1;

    const INTERACTIVE = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
        '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
        '[role="switch"]', '[role="menuitem"]', '[role="combobox"]', '[contenteditable="true"]',
        '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    /**
     * Containers that take focus so a roving-focus group can hand it to an
     * item (Radix sets `tabindex=0` on a RadioGroup, ToggleGroup, Tabs list
     * and Toolbar root). The container is not a control: its items are, and
     * they are measured on their own.
     */
    const GROUP_CONTAINER = '[role="radiogroup"],[role="group"],[role="tablist"],[role="toolbar"],[role="menubar"]';
    const NATIVE_CONTROL = 'a[href],button,input,select,textarea,summary,[contenteditable="true"]';
    const isGroupContainer = (el: Element): boolean => el.matches(GROUP_CONTAINER) && !el.matches(NATIVE_CONTROL);
    const CHROME = [
        'button', '[role="button"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]', 'th',
        '[role="columnheader"]', 'label', 'legend', 'option', 'summary',
    ].join(',');
    const TEXT_FIELD_TYPES = new Set([
        '', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date',
        'datetime-local', 'month', 'time', 'week',
    ]);

    type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };

    const metric = (): MeasuredMetric => ({ count: 0, samples: [] });
    const out: RawMeasurement = {
        viewport: { width: vw, height: vh },
        documentWidth: document.documentElement.scrollWidth,
        docScrollsSideways: document.documentElement.scrollWidth > vw + EPS,
        clippedControls: metric(),
        clippedText: metric(),
        overlayCoversControl: metric(),
        overlayCoversText: metric(),
        tapUnder24: metric(),
        tapUnder44: metric(),
        textUnder12: metric(),
        inputUnder16: metric(),
        tabsNoCue: metric(),
        buttonWraps: metric(),
        wideTables: metric(),
        texts: [],
        chromeTexts: [],
    };

    const squash = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

    const describe = (el: Element): string => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += `#${el.id}`;
        const testid = el.getAttribute('data-testid');
        if (testid) s += `[data-testid=${testid}]`;
        const role = el.getAttribute('role');
        if (role) s += `[role=${role}]`;
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
        if (cls) s += `.${cls}`;
        return s.slice(0, 160);
    };

    const nameOf = (el: Element): string =>
        squash(el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || el.getAttribute('placeholder')).slice(0, 80);

    const record = (m: MeasuredMetric, el: Element, box: Box, text?: string) => {
        m.count += 1;
        if (m.samples.length < opts.maxSamples) {
            m.samples.push({
                el: describe(el),
                text: text ?? nameOf(el),
                box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
            });
        }
    };

    /** Hidden by CSS, by `aria-hidden`/`inert`, or a 1px screen-reader-only box. */
    const isShown = (el: Element): boolean => {
        const h = el as HTMLElement;
        if (typeof h.checkVisibility === 'function') {
            if (!h.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        } else {
            const cs = getComputedStyle(h);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        }
        if (el.closest('[aria-hidden="true"],[inert]')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
    };

    const isScrollerX = (el: Element): boolean => {
        const cs = getComputedStyle(el);
        return (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + EPS;
    };

    /**
     * Is `box` (the box of `from` or of a text run inside it) cut at the
     * screen edge? Walk outward; the first ancestor that clips the box on the
     * offending side decides. A sideways scroller means it can be reached. A
     * clipper whose own edge is inside the screen means a smaller box cut it
     * (truncation), which is not this metric.
     */
    const cutAtScreenEdge = (from: Element, box: Box): boolean => {
        const pastRight = box.right > vw + EPS;
        const pastLeft = box.left < -EPS;
        if (!pastRight && !pastLeft) return false;
        for (let a: Element | null = from; a && a !== document.documentElement; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (cs.position === 'fixed') {
                // An off-canvas panel (a closed drawer still mounted) lies
                // wholly outside the screen on purpose.
                const ar = a.getBoundingClientRect();
                if (ar.right <= EPS || ar.left >= vw - EPS) return false;
            }
            if (cs.overflowX === 'visible') continue;
            if (isScrollerX(a)) return false;
            const ar = a.getBoundingClientRect();
            const clipsRight = pastRight && ar.right < box.right - EPS;
            const clipsLeft = pastLeft && ar.left > box.left + EPS;
            if (!clipsRight && !clipsLeft) continue;
            if (clipsRight && ar.right < vw - EPS) return false;
            if (clipsLeft && ar.left > EPS) return false;
            return true;
        }
        // Nothing clipped it: either the document scrolls sideways (its own
        // metric) or the viewport cuts it.
        return !out.docScrollsSideways;
    };

    // ── Collect the populations once ──────────────────────────────────────
    const shownInteractive = Array.from(document.querySelectorAll(INTERACTIVE)).filter((el) => !isGroupContainer(el) && isShown(el));

    type TextRun = { node: Text; el: Element; box: Box };
    const textRuns: TextRun[] = [];
    {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const shownCache = new Map<Element, boolean>();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n as Text;
            if (!t.data.trim()) continue;
            const el = t.parentElement;
            if (!el || el.closest('script,style,noscript,template,svg')) continue;
            let shown = shownCache.get(el);
            if (shown === undefined) {
                shown = isShown(el);
                shownCache.set(el, shown);
            }
            if (!shown) continue;
            const range = document.createRange();
            range.selectNodeContents(t);
            const r = range.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            textRuns.push({ node: t, el, box: r });
        }
    }

    // ── clipped ───────────────────────────────────────────────────────────
    for (const el of shownInteractive) {
        const r = el.getBoundingClientRect();
        if (el.parentElement && cutAtScreenEdge(el.parentElement, r)) record(out.clippedControls, el, r);
    }
    {
        const seen = new Set<Element>();
        for (const run of textRuns) {
            if (seen.has(run.el)) continue;
            if (cutAtScreenEdge(run.el, run.box)) {
                seen.add(run.el);
                record(out.clippedText, run.el, run.box, squash(run.node.data).slice(0, 80));
            }
        }
    }

    // ── textUnder12 ───────────────────────────────────────────────────────
    {
        const seen = new Set<Element>();
        for (const run of textRuns) {
            if (seen.has(run.el)) continue;
            seen.add(run.el);
            // A development/staging marker in the top bar, never shown in production.
            if (run.el.closest('[data-testid="top-chrome-env-badge"]')) continue;
            if (parseFloat(getComputedStyle(run.el).fontSize) < 12 - 0.01) {
                record(out.textUnder12, run.el, run.box, squash(run.node.data).slice(0, 80));
            }
        }
    }

    // ── inputUnder16 ──────────────────────────────────────────────────────
    for (const el of Array.from(document.querySelectorAll('input,select,textarea,[contenteditable="true"]'))) {
        if (el instanceof HTMLInputElement && !TEXT_FIELD_TYPES.has((el.getAttribute('type') ?? '').toLowerCase())) continue;
        if (!isShown(el)) continue;
        if (parseFloat(getComputedStyle(el).fontSize) < 16 - 0.01) {
            record(out.inputUnder16, el, el.getBoundingClientRect());
        }
    }

    // ── tap targets ───────────────────────────────────────────────────────
    const pseudoSize = (el: Element, which: '::before' | '::after'): [number, number] => {
        const cs = getComputedStyle(el, which);
        if (!cs.content || cs.content === 'none' || cs.content === 'normal') return [0, 0];
        if (cs.position !== 'absolute' && cs.position !== 'fixed') return [0, 0];
        if (cs.pointerEvents === 'none') return [0, 0];
        const w = Math.max(parseFloat(cs.width) || 0, parseFloat(cs.minWidth) || 0);
        const h = Math.max(parseFloat(cs.height) || 0, parseFloat(cs.minHeight) || 0);
        return [w, h];
    };
    /**
     * Inside a sentence: the parent's text is the element's plus more. Any
     * control laid out `inline` qualifies; a LINK also qualifies as
     * `inline-flex` / `inline-block` (an arrow icon beside its words), which
     * still flows in the line of text. A flex or grid child is never inline:
     * its parent blockifies it.
     */
    const isInlineSentenceLink = (el: Element): boolean => {
        const display = getComputedStyle(el).display;
        const inline =
            display === 'inline' ||
            ((display === 'inline-flex' || display === 'inline-block') && el.matches('a[href],[role="link"]'));
        if (!inline) return false;
        const parent = el.parentElement;
        if (!parent) return false;
        const own = squash((el as HTMLElement).innerText);
        const around = squash(parent.innerText);
        return around.length > own.length + 3;
    };
    /**
     * What a tap on `el` lands on: `el`, or — when it ignores pointer events,
     * as the list card's 16px selection circle does inside its 44px button
     * wrapper — the nearest ancestor that receives them. `null` when nothing
     * from `el` up to the body receives them: a tap there lands on nothing of
     * the page. That is the page behind the product tour (#5924): driver.js
     * sets `pointer-events: none` on everything outside the step it shows, so
     * the radar's 8px marks — which take no taps on a touch screen anyway —
     * were measured on their own boxes as if a finger could reach them.
     */
    const hitTarget = (el: Element): Element | null => {
        let a: Element | null = el;
        while (a && a !== document.body && getComputedStyle(a).pointerEvents === 'none') a = a.parentElement;
        return a && a !== document.body ? a : null;
    };
    for (const el of shownInteractive) {
        if (el.closest('[role="banner"]')) continue;
        if (isInlineSentenceLink(el)) continue;
        const target = hitTarget(el);
        if (!target) continue;
        const r = target.getBoundingClientRect();
        const [bw, bh] = pseudoSize(target, '::before');
        const [aw, ah] = pseudoSize(target, '::after');
        const side = Math.min(Math.max(r.width, bw, aw), Math.max(r.height, bh, ah));
        if (side < 24 - 0.01) record(out.tapUnder24, el, r);
        if (side < 44 - 0.01) record(out.tapUnder44, el, r);
    }

    // ── tabsNoCue ─────────────────────────────────────────────────────────
    for (const list of Array.from(document.querySelectorAll('[role="tablist"]'))) {
        if (!isShown(list)) continue;
        const lr = list.getBoundingClientRect();
        const tabs = Array.from(list.querySelectorAll('[role="tab"]')).filter(isShown);
        const overflows =
            list.scrollWidth > list.clientWidth + EPS ||
            tabs.some((t) => {
                const r = t.getBoundingClientRect();
                return r.right > Math.min(lr.right, vw) + EPS || r.left < Math.max(lr.left, 0) - EPS;
            });
        if (!overflows) continue;
        let cued = false;
        const strip = list.closest('[data-scroll-cue-strip]');
        if (strip && (strip.hasAttribute('data-overflow-start') || strip.hasAttribute('data-overflow-end'))) cued = true;
        for (let a: Element | null = list, i = 0; !cued && a && i < 3; a = a.parentElement, i++) {
            const cs = getComputedStyle(a);
            const mask = cs.maskImage || cs.getPropertyValue('-webkit-mask-image');
            if (mask && mask !== 'none') cued = true;
            const he = a as HTMLElement;
            if (isScrollerX(a) && he.offsetHeight - he.clientHeight > 2) cued = true; // a visible scrollbar
        }
        if (!cued) record(out.tabsNoCue, list, lr);
    }

    // ── buttonWraps ───────────────────────────────────────────────────────
    const BUTTONISH = 'button,a[href],[role="button"]';
    /**
     * A child that IS a button: the button itself, or a wrapper holding one
     * button and nothing beside it (a tooltip or permission wrapper), which
     * the box test tells: the wrapper is no bigger than its button. A label
     * holding a caption and a picker, or a field holding an input, is not.
     */
    const isButtonChild = (c: Element): boolean => {
        if (c.matches(BUTTONISH)) return true;
        const inner = c.querySelectorAll(BUTTONISH);
        if (inner.length !== 1) return false;
        const cr = c.getBoundingClientRect();
        const ir = inner[0].getBoundingClientRect();
        return cr.width - ir.width <= 4 && cr.height - ir.height <= 4;
    };
    for (const row of Array.from(document.querySelectorAll('*'))) {
        if (row.children.length < 3) continue;
        const cs = getComputedStyle(row);
        if ((cs.display !== 'flex' && cs.display !== 'inline-flex') || cs.flexWrap === 'nowrap') continue;
        if (cs.flexDirection.startsWith('column')) continue;
        if (!isShown(row)) continue;
        const items = Array.from(row.children).filter(isShown);
        if (items.length < 3 || !items.every(isButtonChild)) continue;
        const centres = items.map((c) => {
            const r = c.getBoundingClientRect();
            return r.top + r.height / 2;
        }).sort((a, b) => a - b);
        let lines = 1;
        for (let i = 1; i < centres.length; i++) if (centres[i] - centres[i - 1] > 8) lines += 1;
        if (lines >= 3) record(out.buttonWraps, row, row.getBoundingClientRect(), `${items.length} actions on ${lines} lines`);
    }

    // ── wideTables ────────────────────────────────────────────────────────
    for (const t of Array.from(document.querySelectorAll('table'))) {
        if (!isShown(t)) continue;
        const r = t.getBoundingClientRect();
        if (r.width > vw + EPS) record(out.wideTables, t, r, `${Math.round(r.width)}px wide`);
    }

    // ── texts for leak detection ──────────────────────────────────────────
    {
        const all = new Set<string>();
        const chrome = new Set<string>();
        /**
         * Text the page does not offer in its own language, on purpose, and
         * says so: an element inside a `lang` other than the page's (the
         * English library's clause titles and template names, marked as WCAG
         * 3.1.2 asks, so a screen reader reads them in English), or code — a
         * CSV column name the importer reads literally, in `<code>`. Neither
         * is interface text that missed the catalog.
         */
        const pageLang = (document.documentElement.getAttribute('lang') ?? '').toLowerCase().split('-')[0];
        const declaredNotPageText = (el: Element): boolean => {
            if (el.closest('code,kbd,samp')) return true;
            const tagged = el.closest('[lang]');
            const lang = (tagged?.getAttribute('lang') ?? '').toLowerCase().split('-')[0];
            return Boolean(pageLang && lang && lang !== pageLang);
        };
        for (const run of textRuns) {
            const s = squash(run.node.data);
            if (!s) continue;
            if (declaredNotPageText(run.el)) continue;
            all.add(s);
            if (run.el.closest(CHROME)) chrome.add(s);
        }
        for (const el of Array.from(document.querySelectorAll('[placeholder],[aria-label],[title]'))) {
            if (!isShown(el)) continue;
            if (declaredNotPageText(el)) continue;
            for (const attr of ['placeholder', 'aria-label', 'title']) {
                const s = squash(el.getAttribute(attr));
                if (!s) continue;
                all.add(s);
                chrome.add(s);
            }
        }
        out.texts = Array.from(all).slice(0, 5000);
        out.chromeTexts = Array.from(chrome).slice(0, 5000);
    }

    // ── overlay (last: it scrolls the page) ───────────────────────────────
    if (opts.scrollToEnd) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        for (const el of Array.from(document.querySelectorAll('main,[data-scroll-root]'))) {
            (el as HTMLElement).scrollTop = el.scrollHeight;
        }
    }
    {
        const overlays: Element[] = [];
        for (const el of Array.from(document.querySelectorAll('body *'))) {
            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed') continue;
            if (!isShown(el)) continue;
            const r = el.getBoundingClientRect();
            const visibleArea = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
            if (visibleArea <= 0) continue;
            if (r.top < vh / 2) continue; // floating in the lower half only; the top bar is not a floating overlay
            if (visibleArea > 0.4 * vw * vh) continue; // a sheet or backdrop, not a floating control
            if (overlays.some((o) => o.contains(el))) continue;
            overlays.push(el);
        }
        if (overlays.length) {
            const inOverlay = (el: Element) => overlays.some((o) => o.contains(el));
            const covered = (box: Box): boolean => {
                for (const o of overlays) {
                    const or = o.getBoundingClientRect();
                    const l = Math.max(box.left, or.left, 0);
                    const r = Math.min(box.right, or.right, vw);
                    const t = Math.max(box.top, or.top, 0);
                    const b = Math.min(box.bottom, or.bottom, vh);
                    if (r - l < 1 || b - t < 1) continue;
                    const hit = document.elementFromPoint((l + r) / 2, (t + b) / 2);
                    if (hit && o.contains(hit)) return true;
                }
                return false;
            };
            for (const el of shownInteractive) {
                if (inOverlay(el)) continue;
                const r = el.getBoundingClientRect();
                if (covered(r)) record(out.overlayCoversControl, el, r);
            }
            const seen = new Set<Element>();
            for (const run of textRuns) {
                if (seen.has(run.el) || inOverlay(run.el)) continue;
                const range = document.createRange();
                range.selectNodeContents(run.node);
                const r = range.getBoundingClientRect();
                if (covered(r)) {
                    seen.add(run.el);
                    record(out.overlayCoversText, run.el, r, squash(run.node.data).slice(0, 80));
                }
            }
        }
    }

    return out;
}

/**
 * Run `collectInPage` in `page`.
 *
 * A `__name` shim is installed in the page first: `tsx` compiles with
 * esbuild's `keepNames`, which wraps every inner function in a
 * `__name(fn, "name")` call that exists only in Node. Without the shim the
 * harness would throw `__name is not defined` in the page, while the E2E
 * runner (which compiles differently) would not — the same function would
 * work in one caller and not the other. The shim is a fixed string and the
 * options travel as a Playwright argument, so no code is built from data.
 */
export async function measurePage(page: Page, opts: Partial<CollectOptions> = {}): Promise<RawMeasurement> {
    const full: CollectOptions = { maxSamples: 8, scrollToEnd: true, ...opts };
    // A fixed string: installs the shim, nothing from the caller is in it.
    await page.evaluate('globalThis.__name = globalThis.__name || ((f) => f)');
    // Playwright serialises the function and passes `full` as an argument, so
    // no source text is built from data here.
    return (await page.evaluate(collectInPage, full)) as RawMeasurement;
}

/**
 * Wait until a page is worth measuring: loaded, its data requests settled
 * (bounded, because some pages poll), web fonts in, and two frames painted.
 */
export async function settlePage(page: Page, { networkIdleMs = 8_000 }: { networkIdleMs?: number } = {}): Promise<void> {
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: networkIdleMs }).catch(() => {});
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }).catch(() => {});
}

// ── The table of record ────────────────────────────────────────────────────

/** A page-level check: the page FAILS it when its count is above zero. */
export type MobileMetricId =
    | 'docScrollsSideways'
    | 'clipped'
    | 'overlayCoversText'
    | 'overlayCoversControl'
    | 'tapUnder24'
    | 'tapUnder44'
    | 'textUnder12'
    | 'tabsNoCue'
    | 'buttonWraps'
    | 'inputUnder16'
    | 'wideTables'
    | 'englishLeaks'
    | 'consoleErrors';

export interface MobileMetricDef {
    id: MobileMetricId;
    /** The row label in the summary table. */
    label: string;
}

/** In the order the roadmap's headline table lists them. */
export const MOBILE_METRICS: readonly MobileMetricDef[] = [
    { id: 'docScrollsSideways', label: 'Page scrolls sideways' },
    { id: 'clipped', label: 'Content clipped at the screen edge' },
    { id: 'overlayCoversText', label: 'Floating overlay covers text' },
    { id: 'overlayCoversControl', label: 'Floating overlay covers a control' },
    { id: 'tapUnder24', label: 'Tap target < 24 px in the page body' },
    { id: 'tapUnder44', label: 'Tap target < 44 px in the page body' },
    { id: 'textUnder12', label: 'Text < 12 px' },
    { id: 'tabsNoCue', label: 'Tab bar overflows with no cue' },
    { id: 'buttonWraps', label: 'Button group on 3+ lines' },
    { id: 'inputUnder16', label: 'Input font < 16 px (iOS zoom)' },
    { id: 'wideTables', label: 'Table wider than the screen' },
    { id: 'englishLeaks', label: 'English strings on a Bulgarian page' },
    { id: 'consoleErrors', label: 'Console errors' },
];

/** Element counts per metric for one page in one configuration. */
export type MetricCounts = Record<MobileMetricId, number>;

/** Fold a raw measurement (plus the Node-side leak and console counts) into per-metric counts. */
export function countsOf(m: RawMeasurement, extra: { englishLeaks: number; consoleErrors: number }): MetricCounts {
    return {
        docScrollsSideways: m.docScrollsSideways ? 1 : 0,
        clipped: m.clippedControls.count + m.clippedText.count,
        overlayCoversText: m.overlayCoversText.count,
        overlayCoversControl: m.overlayCoversControl.count,
        tapUnder24: m.tapUnder24.count,
        tapUnder44: m.tapUnder44.count,
        textUnder12: m.textUnder12.count,
        tabsNoCue: m.tabsNoCue.count,
        buttonWraps: m.buttonWraps.count,
        inputUnder16: m.inputUnder16.count,
        wideTables: m.wideTables.count,
        englishLeaks: extra.englishLeaks,
        consoleErrors: extra.consoleErrors,
    };
}

/**
 * The invariants the mobile E2E project holds at ZERO on every route it
 * loads. The other metrics are ratcheted downward rather than held at zero.
 */
export const ZERO_TOLERANCE_INVARIANTS = ['clippedControls', 'inputUnder16', 'overlayCoversControl', 'tabsNoCue'] as const;
export type ZeroToleranceInvariant = (typeof ZERO_TOLERANCE_INVARIANTS)[number];
