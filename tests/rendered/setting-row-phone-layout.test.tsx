/**
 * A title-plus-control row keeps its control on a phone screen.
 *
 * Settings-style rows were hand-rolled as `flex items-start justify-between`
 * with a text block that could not shrink and a control cluster that could
 * not wrap. At 360 px that pushed the control past the right edge, where the
 * shell's `overflow-x-clip` cut it off, or squeezed the title to one word per
 * line beside it. `<SettingRow>` is the one shape for them: a column below
 * `sm`, the row from `sm` up.
 *
 * jsdom does no layout, so this holds the classes that MAKE the phone layout
 * (a column below `sm`, a text column that can shrink, a control cluster that
 * wraps and is never stretched), and that every desktop-only class carries
 * its `sm:` prefix. The real-layout check is the mobile E2E ratchet's
 * `clipped` count over the pages that use it.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

import { SettingRow } from '@/components/layout/SettingRow';

const LONG_TITLE = 'Еднократнапроверканаагентскитедействияпредиодобрение';

function classesOf(el: Element): string[] {
    return el.className.split(/\s+/).filter(Boolean);
}

function slot(root: HTMLElement, name: string): HTMLElement {
    const el = root.querySelector<HTMLElement>(`[data-slot="${name}"]`);
    if (!el) throw new Error(`no ${name} slot`);
    return el;
}

function renderRow(props: Partial<React.ComponentProps<typeof SettingRow>> = {}) {
    render(
        <SettingRow
            data-testid="row"
            title={<h2>{LONG_TITLE}</h2>}
            titleAdornment={<span data-testid="badge">Включено</span>}
            description="Изисква второ одобрение, преди агентът да действа."
            control={<button type="button" data-testid="toggle">Изключване</button>}
            {...props}
        />,
    );
    return screen.getByTestId('row');
}

describe('a setting row on a phone', () => {
    it('is a column below sm and the row from sm up', () => {
        const root = renderRow();
        const cls = classesOf(root);
        expect(cls).toEqual(expect.arrayContaining(['flex', 'flex-col', 'sm:flex-row']));
        // No unprefixed row direction or nowrap: below sm it must stay a column.
        expect(cls).not.toContain('flex-row');
        expect(cls).not.toContain('flex-nowrap');
    });

    it('lets the text column shrink, so a long word cannot hold the row open', () => {
        const root = renderRow();
        expect(classesOf(slot(root, 'setting-row-text'))).toContain('min-w-0');
        expect(classesOf(slot(root, 'setting-row-title'))).toContain('min-w-0');
    });

    it('wraps the title and its badge rather than squeezing the title', () => {
        const root = renderRow();
        const title = slot(root, 'setting-row-title');
        expect(classesOf(title)).toContain('flex-wrap');
        expect(title).toContainElement(screen.getByTestId('badge'));
    });

    it('puts the control on its own line, wrapping, at its natural width', () => {
        const root = renderRow();
        const control = slot(root, 'setting-row-control');
        expect(control).toContainElement(screen.getByTestId('toggle'));
        // A sibling of the text column, after it: on a phone, the next line.
        expect(control.parentElement).toBe(root);
        expect(slot(root, 'setting-row-text').compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        const cls = classesOf(control);
        expect(cls).toEqual(expect.arrayContaining(['flex-wrap', 'self-start']));
        // Not shrinking is a desktop rule only; on a phone the cluster wraps.
        expect(cls).toContain('sm:shrink-0');
        expect(cls).not.toContain('shrink-0');
    });

    it('keeps a leading icon beside the text, inside the shrinking block', () => {
        const root = renderRow({ leading: <span data-testid="icon">*</span> });
        const lead = slot(root, 'setting-row-lead');
        expect(classesOf(lead)).toEqual(expect.arrayContaining(['flex', 'min-w-0']));
        expect(lead).toContainElement(screen.getByTestId('icon'));
        expect(lead).toContainElement(slot(root, 'setting-row-text'));
        expect(slot(root, 'setting-row-control').parentElement).toBe(root);
    });

    it('renders no control cluster when there is no control', () => {
        const root = renderRow({ control: false });
        expect(root.querySelector('[data-slot="setting-row-control"]')).toBeNull();
    });

    it('takes spacing by prop, emitting exactly one class per gap', () => {
        // `cn` cannot merge the semantic scale (`gap-tight` vs `gap-compact`
        // both survive), so a className override would leave two rules racing.
        const root = renderRow({ gap: 'compact', controlGap: 'compact', titleGap: 'compact', textSpacing: 'none' });
        const rootCls = classesOf(root);
        expect(rootCls).toContain('sm:gap-compact');
        expect(rootCls).not.toContain('sm:gap-default');
        expect(classesOf(slot(root, 'setting-row-control'))).toContain('gap-compact');
        expect(classesOf(slot(root, 'setting-row-control'))).not.toContain('gap-tight');
        expect(classesOf(slot(root, 'setting-row-title'))).not.toContain('gap-tight');
        expect(classesOf(slot(root, 'setting-row-text')).some((c) => c.startsWith('space-y-'))).toBe(false);
    });

    it('aligns the control from sm up only', () => {
        const root = renderRow({ align: 'end' });
        expect(classesOf(root)).toContain('sm:items-end');
        expect(classesOf(root)).not.toContain('items-end');
        expect(classesOf(slot(root, 'setting-row-control'))).toContain('sm:self-end');
    });
});
