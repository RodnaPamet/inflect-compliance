/**
 * Epic 66 — `<CardList>` compound component.
 *
 * Verifies the structural contract jsdom can observe: responsive
 * grid classes, slot wiring, selection state, click + keyboard
 * activation, and propagation guards (checkbox / action-menu
 * clicks must NOT trigger the card-level onClick).
 *
 * Layout / responsive behaviour beyond the class names is the CSS
 * engine's job — we assert the right classes are present, not the
 * computed width.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { render, fireEvent } from '@testing-library/react';

import { CardList } from '@/components/ui/card-list';

// ─── Container ─────────────────────────────────────────────────────

describe('CardList — container', () => {
    it('renders a `<ul role="list">` with the responsive grid classes', () => {
        const { container } = render(
            <CardList aria-label="Tenants">
                <CardList.Card>
                    <CardList.CardHeader title="A" />
                </CardList.Card>
            </CardList>,
        );
        const list = container.querySelector('[data-card-list]') as HTMLUListElement;
        expect(list.tagName).toBe('UL');
        expect(list.getAttribute('role')).toBe('list');
        expect(list.getAttribute('aria-label')).toBe('Tenants');
        expect(list.className).toContain('grid');
        expect(list.className).toContain('grid-cols-1');
        expect(list.className).toContain('sm:grid-cols-2');
        expect(list.className).toContain('lg:grid-cols-3');
    });

    it('flags aria-busy + dims when loading', () => {
        const { container } = render(
            <CardList loading>
                <CardList.Card>
                    <CardList.CardHeader title="A" />
                </CardList.Card>
            </CardList>,
        );
        const list = container.querySelector('[data-card-list]') as HTMLElement;
        expect(list.getAttribute('aria-busy')).toBe('true');
        expect(list.className).toContain('opacity-60');
    });

    it('forwards className', () => {
        const { container } = render(
            <CardList className="extra">
                <CardList.Card>
                    <CardList.CardHeader title="A" />
                </CardList.Card>
            </CardList>,
        );
        expect(
            (container.querySelector('[data-card-list]') as HTMLElement).className,
        ).toContain('extra');
    });
});

// ─── Card ──────────────────────────────────────────────────────────

describe('CardList.Card — interaction', () => {
    it('non-interactive card has no role="button" + no tab stop', () => {
        const { container } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardHeader title="Static" />
                </CardList.Card>
            </CardList>,
        );
        const card = container.querySelector(
            '[data-card-list-card] > div',
        ) as HTMLElement;
        expect(card.getAttribute('role')).toBeNull();
        expect(card.getAttribute('tabindex')).toBeNull();
    });

    it('interactive card mounts as role="button" with tabIndex=0', () => {
        const { container } = render(
            <CardList>
                <CardList.Card onClick={() => undefined}>
                    <CardList.CardHeader title="Click me" />
                </CardList.Card>
            </CardList>,
        );
        const card = container.querySelector(
            '[data-card-list-card] > div',
        ) as HTMLElement;
        expect(card.getAttribute('role')).toBe('button');
        expect(card.getAttribute('tabindex')).toBe('0');
    });

    it('fires onClick when the card surface is clicked', () => {
        const handler = jest.fn();
        const { container } = render(
            <CardList>
                <CardList.Card onClick={handler}>
                    <CardList.CardHeader title="X" />
                </CardList.Card>
            </CardList>,
        );
        const card = container.querySelector(
            '[data-card-list-card] > div',
        ) as HTMLElement;
        fireEvent.click(card);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('fires onClick when Space or Enter is pressed', () => {
        const handler = jest.fn();
        const { container } = render(
            <CardList>
                <CardList.Card onClick={handler}>
                    <CardList.CardHeader title="X" />
                </CardList.Card>
            </CardList>,
        );
        const card = container.querySelector(
            '[data-card-list-card] > div',
        ) as HTMLElement;
        fireEvent.keyDown(card, { key: ' ' });
        fireEvent.keyDown(card, { key: 'Enter' });
        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('ignores other keys', () => {
        const handler = jest.fn();
        const { container } = render(
            <CardList>
                <CardList.Card onClick={handler}>
                    <CardList.CardHeader title="X" />
                </CardList.Card>
            </CardList>,
        );
        const card = container.querySelector(
            '[data-card-list-card] > div',
        ) as HTMLElement;
        fireEvent.keyDown(card, { key: 'a' });
        expect(handler).not.toHaveBeenCalled();
    });
});

// ─── Card — selection ──────────────────────────────────────────────

describe('CardList.Card — selection', () => {
    it('renders a checkbox in the top-right when selectable', () => {
        const { container } = render(
            <CardList>
                <CardList.Card selectable selected={false}>
                    <CardList.CardHeader title="X" />
                </CardList.Card>
            </CardList>,
        );
        const checkbox = container.querySelector('[data-card-checkbox]');
        expect(checkbox).not.toBeNull();
        expect(checkbox?.querySelector('input[type="checkbox"]')).not.toBeNull();
    });

    it('does not render the checkbox when selectable=false', () => {
        const { container } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardHeader title="X" />
                </CardList.Card>
            </CardList>,
        );
        expect(container.querySelector('[data-card-checkbox]')).toBeNull();
    });

    it('toggles selection via the checkbox without triggering card onClick', () => {
        const cardClick = jest.fn();
        const onSelectChange = jest.fn();
        const { container } = render(
            <CardList>
                <CardList.Card
                    onClick={cardClick}
                    selectable
                    selected={false}
                    onSelectChange={onSelectChange}
                >
                    <CardList.CardHeader title="X" />
                </CardList.Card>
            </CardList>,
        );
        const checkbox = container.querySelector(
            'input[type="checkbox"]',
        ) as HTMLInputElement;
        fireEvent.click(checkbox);
        expect(onSelectChange).toHaveBeenCalledWith(true);
        // Critical: the card click MUST NOT fire — picking the
        // checkbox is a different intent.
        expect(cardClick).not.toHaveBeenCalled();
    });

    it('marks the card with data-selected + selection ring when selected', () => {
        const { container } = render(
            <CardList>
                <CardList.Card selectable selected={true}>
                    <CardList.CardHeader title="X" />
                </CardList.Card>
            </CardList>,
        );
        const card = container.querySelector('[data-card-list-card]') as HTMLElement;
        expect(card.getAttribute('data-selected')).toBe('true');
        expect(card.className).toContain('ring-2');
    });

    it('honours a custom selectionLabel on the checkbox', () => {
        const { getByLabelText } = render(
            <CardList>
                <CardList.Card
                    selectable
                    selected={false}
                    selectionLabel="Select Acme Corp"
                >
                    <CardList.CardHeader title="Acme Corp" />
                </CardList.Card>
            </CardList>,
        );
        expect(getByLabelText('Select Acme Corp')).toBeTruthy();
    });
});

// ─── Card — propagation guards ────────────────────────────────────

describe('CardList.Card — interactive child propagation guards', () => {
    it('clicks on inner buttons do NOT trigger the card-level onClick', () => {
        const cardClick = jest.fn();
        const inner = jest.fn();
        const { getByText } = render(
            <CardList>
                <CardList.Card onClick={cardClick}>
                    <CardList.CardHeader title="X" />
                    <CardList.CardContent>
                        <button onClick={inner}>Inner action</button>
                    </CardList.CardContent>
                </CardList.Card>
            </CardList>,
        );
        fireEvent.click(getByText('Inner action'));
        expect(inner).toHaveBeenCalledTimes(1);
        expect(cardClick).not.toHaveBeenCalled();
    });

    it('clicks on header `actions` slot do NOT trigger the card click', () => {
        const cardClick = jest.fn();
        const menuClick = jest.fn();
        const { getByText } = render(
            <CardList>
                <CardList.Card onClick={cardClick}>
                    <CardList.CardHeader
                        title="X"
                        actions={
                            <button onClick={menuClick}>⋯</button>
                        }
                    />
                </CardList.Card>
            </CardList>,
        );
        fireEvent.click(getByText('⋯'));
        expect(menuClick).toHaveBeenCalledTimes(1);
        expect(cardClick).not.toHaveBeenCalled();
    });

    it('clicks on inner anchors do NOT trigger the card click', () => {
        const cardClick = jest.fn();
        const { getByText } = render(
            <CardList>
                <CardList.Card onClick={cardClick}>
                    <CardList.CardContent>
                        <a href="#deep">deep link</a>
                    </CardList.CardContent>
                </CardList.Card>
            </CardList>,
        );
        fireEvent.click(getByText('deep link'));
        expect(cardClick).not.toHaveBeenCalled();
    });
});

// ─── CardHeader ────────────────────────────────────────────────────

describe('CardList.CardHeader', () => {
    it('renders the title as h3', () => {
        const { container } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardHeader title="Acme Corp" />
                </CardList.Card>
            </CardList>,
        );
        const heading = container.querySelector('h3');
        expect(heading?.textContent).toBe('Acme Corp');
    });

    it('renders the badge slot when provided', () => {
        const { container, getByText } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardHeader
                        title="X"
                        badge={<span data-testid="my-badge">Active</span>}
                    />
                </CardList.Card>
            </CardList>,
        );
        expect(container.querySelector('[data-card-header-badge]')).not.toBeNull();
        expect(getByText('Active')).toBeTruthy();
    });

    it('renders the subtitle when provided', () => {
        const { getByText } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardHeader title="X" subtitle="acme-corp" />
                </CardList.Card>
            </CardList>,
        );
        expect(getByText('acme-corp')).toBeTruthy();
    });

    it('omits the badge slot wrapper when no badge passed', () => {
        const { container } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardHeader title="X" />
                </CardList.Card>
            </CardList>,
        );
        expect(container.querySelector('[data-card-header-badge]')).toBeNull();
    });
});

// ─── CardContent ──────────────────────────────────────────────────

describe('CardList.CardContent', () => {
    it('renders free-form children when no kv passed', () => {
        const { getByText } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardContent>
                        <p>Custom body</p>
                    </CardList.CardContent>
                </CardList.Card>
            </CardList>,
        );
        expect(getByText('Custom body')).toBeTruthy();
    });

    it('renders kv as a <dl> with dt/dd pairs', () => {
        const { container } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardContent
                        kv={[
                            { label: 'Owner', value: 'ciso@acme.com' },
                            { label: 'Coverage', value: '75%' },
                        ]}
                    />
                </CardList.Card>
            </CardList>,
        );
        const dl = container.querySelector('[data-card-kv]');
        expect(dl?.tagName).toBe('DL');
        expect(dl?.querySelectorAll('dt').length).toBe(2);
        expect(dl?.querySelectorAll('dd').length).toBe(2);
        expect(dl?.querySelectorAll('dt')[0].textContent).toBe('Owner');
        expect(dl?.querySelectorAll('dd')[1].textContent).toBe('75%');
    });

    it('renders both kv and free-form children together', () => {
        const { container, getByText } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardContent kv={[{ label: 'A', value: 'B' }]}>
                        <p>and a paragraph</p>
                    </CardList.CardContent>
                </CardList.Card>
            </CardList>,
        );
        expect(container.querySelector('[data-card-kv]')).not.toBeNull();
        expect(getByText('and a paragraph')).toBeTruthy();
    });

    it('omits the dl entirely when kv is empty', () => {
        const { container } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardContent kv={[]} />
                </CardList.Card>
            </CardList>,
        );
        expect(container.querySelector('[data-card-kv]')).toBeNull();
    });
});

// ─── Compound API ──────────────────────────────────────────────────

describe('CardList — compound surface', () => {
    it('exposes Card / CardHeader / CardContent on the root', () => {
        expect(typeof CardList).toBe('function');
        expect(typeof CardList.Card).toBe('function');
        expect(typeof CardList.CardHeader).toBe('function');
        expect(typeof CardList.CardContent).toBe('function');
    });
});

// ─── Title on a phone ──────────────────────────────────────────────

describe('CardList.CardHeader — the title on a phone', () => {
    it('wraps below md and is cut to one line only from md up', () => {
        const { getByTestId } = render(
            <CardList>
                <CardList.Card>
                    <CardList.CardHeader title="ISO/IEC 27001:2022 Information security management" />
                </CardList.Card>
            </CardList>,
        );
        const classes = getByTestId('card-list-card-title').className.split(/\s+/);
        // A bare `truncate` cut every framework name on a phone (#5882).
        expect(classes).not.toContain('truncate');
        expect(classes).toEqual(expect.arrayContaining(['min-w-0', 'break-words', 'md:truncate']));
    });
});
