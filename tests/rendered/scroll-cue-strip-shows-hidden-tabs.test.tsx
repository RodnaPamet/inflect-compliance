/**
 * A tab strip that overflows says so, and keeps the selected tab in view.
 *
 * Owner decision (2026-11-22): on a phone the detail tab bar stays a
 * scrolling strip, with cues — an edge fade and a chevron on each side that
 * hides tabs, the active tab scrolled into view, end padding so the last tab
 * is reachable, and sticky under the top bar. jsdom does no layout, so each
 * test gives the list the geometry a 300px phone strip of nine 100px tabs
 * would have, and asserts what the reader would get.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { ScrollCueStrip } from '@/components/ui/scroll-cue-strip';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';

const TAB_WIDTH = 100;
const VIEW_WIDTH = 300;
const TAB_COUNT = 9;

type Geometry = { scrollWidth: number; clientWidth: number; scrollLeft: number };

/** Gives the strip's list a fixed geometry; returns a setter for it. */
function giveListGeometry(list: HTMLElement, g: Geometry) {
    const state = { ...g };
    Object.defineProperty(list, 'scrollWidth', { configurable: true, get: () => state.scrollWidth });
    Object.defineProperty(list, 'clientWidth', { configurable: true, get: () => state.clientWidth });
    Object.defineProperty(list, 'scrollLeft', {
        configurable: true,
        get: () => state.scrollLeft,
        set: (v: number) => {
            state.scrollLeft = v;
        },
    });
    return (next: Partial<Geometry>) => {
        Object.assign(state, next);
        fireEvent.scroll(list);
    };
}

function Tabs({ active }: { active: number }) {
    return (
        <ScrollCueStrip role="tablist" aria-label="Sections" activeKey={String(active)} data-testid="band">
            {Array.from({ length: TAB_COUNT }, (_, i) => (
                <button key={i} type="button" role="tab" aria-selected={i === active} data-tab-index={i}>
                    Tab {i}
                </button>
            ))}
        </ScrollCueStrip>
    );
}

const listOf = () => screen.getByRole('tablist');
const chevron = (side: 'start' | 'end') =>
    document.querySelector(`[data-scroll-cue-chevron="${side}"]`) as HTMLButtonElement | null;

describe('ScrollCueStrip — cues follow the hidden tabs', () => {
    it('shows no cue while every tab fits', () => {
        render(<Tabs active={0} />);
        const set = giveListGeometry(listOf(), { scrollWidth: 280, clientWidth: VIEW_WIDTH, scrollLeft: 0 });
        set({});
        expect(chevron('start')).toBeNull();
        expect(chevron('end')).toBeNull();
        expect(listOf().style.maskImage).toBe('');
    });

    it('cues the end at the start, both sides mid-way, and the start at the end', () => {
        render(<Tabs active={0} />);
        const set = giveListGeometry(listOf(), {
            scrollWidth: TAB_COUNT * TAB_WIDTH,
            clientWidth: VIEW_WIDTH,
            scrollLeft: 0,
        });

        set({ scrollLeft: 0 });
        expect(chevron('start')).toBeNull();
        expect(chevron('end')).not.toBeNull();
        expect(chevron('end')).toHaveAccessibleName('Show more tabs');
        expect(screen.getByTestId('band')).toHaveAttribute('data-overflow-end');
        expect(listOf().style.maskImage).toMatch(/^linear-gradient\(to right, black 0(px)?,.* transparent 100%\)$/);

        set({ scrollLeft: 300 });
        expect(chevron('start')).toHaveAccessibleName('Show earlier tabs');
        expect(chevron('end')).not.toBeNull();
        expect(listOf().style.maskImage).toMatch(/^linear-gradient\(to right, transparent 0(px)?,.* transparent 100%\)$/);

        set({ scrollLeft: TAB_COUNT * TAB_WIDTH - VIEW_WIDTH });
        expect(chevron('start')).not.toBeNull();
        expect(chevron('end')).toBeNull();
        expect(screen.getByTestId('band')).not.toHaveAttribute('data-overflow-end');
    });

    it('re-measures when the window resizes', () => {
        render(<Tabs active={0} />);
        const set = giveListGeometry(listOf(), { scrollWidth: 280, clientWidth: VIEW_WIDTH, scrollLeft: 0 });
        set({});
        expect(chevron('end')).toBeNull();

        Object.defineProperty(listOf(), 'clientWidth', { configurable: true, get: () => 200 });
        act(() => {
            window.dispatchEvent(new Event('resize'));
        });
        expect(chevron('end')).not.toBeNull();
    });

    it('the end chevron pages the strip forward', () => {
        const scrollTo = jest.fn();
        render(<Tabs active={0} />);
        const list = listOf();
        Object.defineProperty(list, 'scrollTo', { configurable: true, value: scrollTo });
        const set = giveListGeometry(list, { scrollWidth: 900, clientWidth: VIEW_WIDTH, scrollLeft: 0 });
        set({});
        fireEvent.click(chevron('end')!);
        expect(scrollTo).toHaveBeenLastCalledWith(
            expect.objectContaining({ left: expect.any(Number) }),
        );
        expect(scrollTo.mock.lastCall[0].left).toBeGreaterThan(0);
        expect(scrollTo.mock.lastCall[0].left).toBeLessThan(VIEW_WIDTH);
    });

    it('keeps the chevrons out of the tab order and out of the tablist', () => {
        render(<Tabs active={0} />);
        giveListGeometry(listOf(), { scrollWidth: 900, clientWidth: VIEW_WIDTH, scrollLeft: 0 })({});
        expect(chevron('end')).toHaveAttribute('tabindex', '-1');
        expect(listOf()).not.toContainElement(chevron('end'));
    });
});

describe('ScrollCueStrip — the last tab is reachable', () => {
    it('ends an overflowing list with a fixed-width spacer after the last tab', () => {
        render(<Tabs active={0} />);
        giveListGeometry(listOf(), { scrollWidth: 900, clientWidth: VIEW_WIDTH, scrollLeft: 0 })({});
        const last = listOf().lastElementChild as HTMLElement;
        expect(last).toHaveAttribute('aria-hidden', 'true');
        expect(last.className).toMatch(/(^|\s)w-\d+(\s|$)/);
        expect(last.className).toMatch(/(^|\s)flex-shrink-0(\s|$)/);
        expect(last.previousElementSibling).toHaveAttribute('data-tab-index', String(TAB_COUNT - 1));
    });

    it('adds no spacer to a list that fits, so its layout is unchanged', () => {
        render(<Tabs active={0} />);
        giveListGeometry(listOf(), { scrollWidth: 280, clientWidth: VIEW_WIDTH, scrollLeft: 0 })({});
        expect(listOf().lastElementChild).toHaveAttribute('data-tab-index', String(TAB_COUNT - 1));
    });
});

describe('ScrollCueStrip — the active tab is scrolled into view', () => {
    const origRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTo: jest.Mock;

    beforeEach(() => {
        scrollTo = jest.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            writable: true,
            value: scrollTo,
        });
        // A 300px viewport onto nine 100px tabs, not scrolled.
        HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
            const idx = this.getAttribute('data-tab-index') ?? /^tab-k(\d+)$/.exec(this.id)?.[1] ?? null;
            if (idx !== null) {
                const left = Number(idx) * TAB_WIDTH;
                return { left, right: left + TAB_WIDTH, width: TAB_WIDTH, top: 0, bottom: 40, height: 40, x: left, y: 0, toJSON() {} } as DOMRect;
            }
            if (this.hasAttribute('data-scroll-cue-list')) {
                return { left: 0, right: VIEW_WIDTH, width: VIEW_WIDTH, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON() {} } as DOMRect;
            }
            return origRect.call(this);
        };
    });

    afterEach(() => {
        HTMLElement.prototype.getBoundingClientRect = origRect;
        delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    });

    it('opens on the last tab with that tab fully in view, without animating', () => {
        render(<Tabs active={TAB_COUNT - 1} />);
        expect(scrollTo).toHaveBeenCalledTimes(1);
        const { left, behavior } = scrollTo.mock.calls[0][0];
        // Its right edge (900) must clear the 300px viewport's right edge.
        expect(left).toBeGreaterThanOrEqual(TAB_COUNT * TAB_WIDTH - VIEW_WIDTH);
        expect(behavior).toBe('auto');
    });

    it('does not scroll for a tab already in view', () => {
        render(<Tabs active={1} />);
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('does not scroll for the first tab at the start of the strip', () => {
        render(<Tabs active={0} />);
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('scrolls smoothly to a newly selected hidden tab', () => {
        const { rerender } = render(<Tabs active={1} />);
        rerender(<Tabs active={6} />);
        expect(scrollTo).toHaveBeenCalledTimes(1);
        expect(scrollTo.mock.calls[0][0].left).toBeGreaterThanOrEqual(7 * TAB_WIDTH - VIEW_WIDTH);
        expect(scrollTo.mock.calls[0][0].behavior).toBe('smooth');
    });

    it('does not animate when the reader prefers reduced motion', () => {
        const orig = window.matchMedia;
        window.matchMedia = ((query: string) => ({
            matches: query.includes('prefers-reduced-motion'),
            media: query,
            onchange: null,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        })) as typeof window.matchMedia;
        try {
            const { rerender } = render(<Tabs active={1} />);
            rerender(<Tabs active={6} />);
            expect(scrollTo.mock.calls[0][0].behavior).toBe('auto');
        } finally {
            window.matchMedia = orig;
        }
    });

    it('does it on the detail-page tab bar too', () => {
        render(
            <EntityDetailLayout
                title="Agent"
                tabs={Array.from({ length: TAB_COUNT }, (_, i) => ({ key: `k${i}`, label: `Tab ${i}` }))}
                activeTab={`k${TAB_COUNT - 1}`}
                onTabChange={jest.fn()}
            >
                <div />
            </EntityDetailLayout>,
        );
        // The geometry mock places the layout's `tab-k<i>` buttons by their id.
        expect(scrollTo).toHaveBeenCalledTimes(1);
        expect(scrollTo.mock.calls[0][0].left).toBeGreaterThanOrEqual(TAB_COUNT * TAB_WIDTH - VIEW_WIDTH);
    });
});

describe('ScrollCueStrip — sticky under the top bar on a phone', () => {
    it('the detail-page tab bar sticks below md on an opaque band, and is static from md up', () => {
        render(
            <EntityDetailLayout
                title="Agent"
                tabs={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]}
                activeTab="a"
                onTabChange={jest.fn()}
            >
                <div />
            </EntityDetailLayout>,
        );
        const band = screen.getByTestId('entity-detail-tabs');
        const sticky = band.parentElement as HTMLElement;
        const cls = sticky.className.split(/\s+/);
        expect(cls).toContain('max-md:sticky');
        expect(cls.some((c) => c.startsWith('max-md:top-['))).toBe(true);
        expect(cls).toContain('max-md:bg-bg-page');
        expect(cls.some((c) => /^(md:)?sticky$/.test(c))).toBe(false);
        // The band keeps its own shade; the opaque phone background is beneath it.
        expect(band.className).toContain('bg-bg-shaded');
    });

    it('a strip that does not ask to stick does not', () => {
        render(<Tabs active={0} />);
        const band = screen.getByTestId('band');
        expect(band.parentElement?.className ?? '').not.toMatch(/sticky/);
        expect(band.className).not.toMatch(/sticky/);
    });
});
