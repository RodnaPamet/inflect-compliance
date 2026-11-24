/**
 * Epic 60 — polish primitives.
 *
 * Render + interaction + a11y coverage for Accordion, TabSelect,
 * ToggleGroup, Slider, NumberStepper.
 *
 * Each primitive gets:
 *   - a render smoke (doesn't throw, renders expected labels)
 *   - an interaction assertion (click / keyboard drives state as
 *     advertised — onSelect called, increments by step, etc.)
 *   - axe-core pass at the top of every describe for WCAG 2.1 AA
 *
 * We don't snapshot the DOM. Class-level "this looks right" drift is
 * caught by the design-system-drift guardrail; these tests are for
 * behaviour + accessibility.
 */

import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { TabSelect } from '@/components/ui/tab-select';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Slider } from '@/components/ui/slider';
import { NumberStepper } from '@/components/ui/number-stepper';

// ── Accordion ──────────────────────────────────────────────────────────

describe('Accordion', () => {
    function Harness() {
        return (
            <Accordion type="single" collapsible defaultValue="item-1">
                <AccordionItem value="item-1">
                    <AccordionTrigger>First</AccordionTrigger>
                    <AccordionContent>One</AccordionContent>
                </AccordionItem>
                <AccordionItem value="item-2">
                    <AccordionTrigger>Second</AccordionTrigger>
                    <AccordionContent>Two</AccordionContent>
                </AccordionItem>
            </Accordion>
        );
    }

    it('renders triggers + default-open content', () => {
        render(<Harness />);
        expect(screen.getByRole('button', { name: 'First' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Second' })).toBeInTheDocument();
        expect(screen.getByText('One')).toBeInTheDocument();
    });

    it('toggles items on click', async () => {
        render(<Harness />);
        const user = userEvent.setup();

        // Second starts closed.
        expect(screen.queryByText('Two')).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Second' }));
        expect(await screen.findByText('Two')).toBeInTheDocument();
    });

    it('passes axe', async () => {
        const { container } = render(<Harness />);
        const results = await axe(container);
        expect(results).toHaveNoViolations();
    });

    it('supports the "plus" trigger variant without regressing behaviour', async () => {
        render(
            <Accordion type="single" collapsible>
                <AccordionItem value="x">
                    <AccordionTrigger variant="plus">Plus header</AccordionTrigger>
                    <AccordionContent>Body</AccordionContent>
                </AccordionItem>
            </Accordion>,
        );

        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Plus header' }));
        expect(await screen.findByText('Body')).toBeInTheDocument();
    });
});

// ── TabSelect ──────────────────────────────────────────────────────────

describe('TabSelect', () => {
    type Id = 'overview' | 'findings' | 'evidence';

    function Harness({ onSelect }: { onSelect?: (id: Id) => void }) {
        const [sel, setSel] = useState<Id>('overview');
        return (
            <TabSelect<Id>
                options={[
                    { id: 'overview', label: 'Overview' },
                    { id: 'findings', label: 'Findings' },
                    { id: 'evidence', label: 'Evidence' },
                ]}
                selected={sel}
                onSelect={(id: Id) => {
                    setSel(id);
                    onSelect?.(id);
                }}
            />
        );
    }

    it('renders a tablist with one selected tab', () => {
        render(<Harness />);
        expect(screen.getByRole('tablist')).toBeInTheDocument();
        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(3);
        const selected = tabs.filter(
            (t) => t.getAttribute('aria-selected') === 'true',
        );
        expect(selected).toHaveLength(1);
        expect(selected[0]).toHaveAccessibleName('Overview');
    });

    it('clicking a tab selects it', async () => {
        const onSelect = jest.fn();
        render(<Harness onSelect={onSelect} />);
        const user = userEvent.setup();

        await user.click(screen.getByRole('tab', { name: 'Findings' }));
        expect(onSelect).toHaveBeenCalledWith('findings');
    });

    it('ArrowRight from the selected tab moves selection + focus', () => {
        const onSelect = jest.fn();
        render(<Harness onSelect={onSelect} />);

        const overview = screen.getByRole('tab', { name: 'Overview' });
        overview.focus();

        fireEvent.keyDown(overview, { key: 'ArrowRight' });
        expect(onSelect).toHaveBeenCalledWith('findings');
    });

    it('End jumps to the last tab', () => {
        const onSelect = jest.fn();
        render(<Harness onSelect={onSelect} />);
        const overview = screen.getByRole('tab', { name: 'Overview' });
        overview.focus();

        fireEvent.keyDown(overview, { key: 'End' });
        expect(onSelect).toHaveBeenCalledWith('evidence');
    });

    it('roving tabindex: only the selected tab is tabbable', () => {
        render(<Harness />);
        const tabs = screen.getAllByRole('tab');
        expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);
        expect(tabs.filter((t) => t.tabIndex === -1)).toHaveLength(2);
    });

    it('passes axe', async () => {
        const { container } = render(<Harness />);
        const results = await axe(container);
        expect(results).toHaveNoViolations();
    });
});

// ── ToggleGroup ────────────────────────────────────────────────────────

describe('ToggleGroup', () => {
    function Harness({
        onSelect,
        size,
    }: {
        onSelect?: (v: string) => void;
        size?: 'default' | 'sm';
    }) {
        const [sel, setSel] = useState<string>('7d');
        return (
            <ToggleGroup
                size={size}
                options={[
                    { value: '7d', label: '7d' },
                    { value: '30d', label: '30d' },
                    { value: '90d', label: '90d' },
                ]}
                selected={sel}
                selectAction={(v) => {
                    setSel(v);
                    onSelect?.(v);
                }}
            />
        );
    }

    it('renders a radiogroup with one checked radio', () => {
        render(<Harness />);
        expect(screen.getByRole('radiogroup')).toBeInTheDocument();
        const radios = screen.getAllByRole('radio');
        expect(radios).toHaveLength(3);
        const checked = radios.filter(
            (r) => r.getAttribute('aria-checked') === 'true',
        );
        expect(checked).toHaveLength(1);
    });

    it('selects on click', async () => {
        const onSelect = jest.fn();
        render(<Harness onSelect={onSelect} />);
        const user = userEvent.setup();

        await user.click(screen.getByRole('radio', { name: '30d' }));
        expect(onSelect).toHaveBeenCalledWith('30d');
    });

    it('ArrowRight cycles', () => {
        const onSelect = jest.fn();
        render(<Harness onSelect={onSelect} />);
        const first = screen.getByRole('radio', { name: '7d' });
        first.focus();

        fireEvent.keyDown(first, { key: 'ArrowRight' });
        expect(onSelect).toHaveBeenCalledWith('30d');
    });

    it('size=sm renders compact and still passes a11y', async () => {
        const { container } = render(<Harness size="sm" />);
        const results = await axe(container);
        expect(results).toHaveNoViolations();
    });

    it('disabled option is not focusable and does not fire selectAction', async () => {
        const onSelect = jest.fn();
        function D() {
            const [sel, setSel] = useState<string>('a');
            return (
                <ToggleGroup
                    options={[
                        { value: 'a', label: 'A' },
                        { value: 'b', label: 'B', disabled: true },
                        { value: 'c', label: 'C' },
                    ]}
                    selected={sel}
                    selectAction={(v) => {
                        setSel(v);
                        onSelect(v);
                    }}
                />
            );
        }

        render(<D />);
        const user = userEvent.setup();

        // userEvent respects the disabled attribute.
        await user.click(screen.getByRole('radio', { name: 'B' }));
        expect(onSelect).not.toHaveBeenCalled();

        // Keyboard cycle from A jumps over B to C (B is not in the
        // rovable set).
        const a = screen.getByRole('radio', { name: 'A' });
        a.focus();
        fireEvent.keyDown(a, { key: 'ArrowRight' });
        expect(onSelect).toHaveBeenCalledWith('c');
    });
});

// ── Slider ─────────────────────────────────────────────────────────────

describe('Slider', () => {
    function Harness({ onChange }: { onChange?: (v: number) => void }) {
        const [v, setV] = useState(25);
        return (
            <Slider
                value={v}
                onChange={(next) => {
                    setV(next);
                    onChange?.(next);
                }}
                min={0}
                max={100}
                step={5}
                ariaLabel="Volume"
                hint="0 — 100"
            />
        );
    }

    // The Radix part loads on demand (see "Loading" in `slider.tsx`), so the
    // thumb is found with `findByRole`.
    it('renders a slider with the given value and aria-label', async () => {
        render(<Harness />);
        const slider = await screen.findByRole('slider', { name: 'Volume' });
        expect(slider).toHaveAttribute('aria-valuemin', '0');
        expect(slider).toHaveAttribute('aria-valuemax', '100');
        expect(slider).toHaveAttribute('aria-valuenow', '25');
    });

    it('ArrowRight increments by step', async () => {
        const onChange = jest.fn();
        render(<Harness onChange={onChange} />);

        const slider = await screen.findByRole('slider', { name: 'Volume' });
        slider.focus();
        fireEvent.keyDown(slider, { key: 'ArrowRight' });
        expect(onChange).toHaveBeenCalledWith(30);
    });

    it('Home jumps to min, End jumps to max', async () => {
        const onChange = jest.fn();
        render(<Harness onChange={onChange} />);
        const slider = await screen.findByRole('slider', { name: 'Volume' });
        slider.focus();

        fireEvent.keyDown(slider, { key: 'Home' });
        expect(onChange).toHaveBeenLastCalledWith(0);

        fireEvent.keyDown(slider, { key: 'End' });
        expect(onChange).toHaveBeenLastCalledWith(100);
    });

    it('renders the hint', () => {
        render(<Harness />);
        expect(screen.getByText('0 — 100')).toBeInTheDocument();
    });

    it('respects disabled', async () => {
        render(
            <Slider
                value={50}
                onChange={jest.fn()}
                min={0}
                max={100}
                disabled
                ariaLabel="Off"
            />,
        );
        // Radix flags `data-disabled` on the thumb rather than
        // aria-disabled. Either is WCAG-accepted; we assert the
        // attribute Radix emits.
        expect(await screen.findByRole('slider', { name: 'Off' })).toHaveAttribute(
            'data-disabled',
        );
    });

    it('passes axe', async () => {
        const { container } = render(<Harness />);
        await screen.findByRole('slider', { name: 'Volume' });
        const results = await axe(container);
        expect(results).toHaveNoViolations();
    });
});

// ── NumberStepper ──────────────────────────────────────────────────────

describe('NumberStepper', () => {
    function Harness({
        onChange,
        min,
        max,
        step,
        size,
    }: {
        onChange?: (v: number) => void;
        min?: number;
        max?: number;
        step?: number;
        size?: 'default' | 'sm';
    }) {
        const [v, setV] = useState(5);
        return (
            <NumberStepper
                value={v}
                onChange={(next) => {
                    setV(next);
                    onChange?.(next);
                }}
                min={min}
                max={max}
                step={step}
                size={size}
                decrementAriaLabel="Decrease retention days"
                incrementAriaLabel="Increase retention days"
            />
        );
    }

    it('renders a spinbutton + two buttons', () => {
        render(<Harness />);
        expect(screen.getByRole('spinbutton')).toHaveValue('5');
        expect(
            screen.getByRole('button', { name: 'Decrease retention days' }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole('button', { name: 'Increase retention days' }),
        ).toBeInTheDocument();
    });

    it('increments on plus click', async () => {
        const onChange = jest.fn();
        render(<Harness onChange={onChange} step={2} />);
        const user = userEvent.setup();

        await user.click(
            screen.getByRole('button', { name: 'Increase retention days' }),
        );
        expect(onChange).toHaveBeenCalledWith(7);
    });

    it('clamps to min/max on step overshoot', async () => {
        const onChange = jest.fn();
        render(<Harness onChange={onChange} min={0} max={6} step={10} />);
        const user = userEvent.setup();

        await user.click(
            screen.getByRole('button', { name: 'Increase retention days' }),
        );
        expect(onChange).toHaveBeenCalledWith(6);
    });

    it('decrement button disables at min', () => {
        render(<Harness min={5} />);
        expect(
            screen.getByRole('button', { name: 'Decrease retention days' }),
        ).toBeDisabled();
    });

    it('increment button disables at max', () => {
        render(<Harness max={5} />);
        expect(
            screen.getByRole('button', { name: 'Increase retention days' }),
        ).toBeDisabled();
    });

    it('ArrowUp in input increments; ArrowDown decrements', () => {
        const onChange = jest.fn();
        render(<Harness onChange={onChange} />);
        const input = screen.getByRole('spinbutton');

        fireEvent.keyDown(input, { key: 'ArrowUp' });
        expect(onChange).toHaveBeenLastCalledWith(6);

        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(onChange).toHaveBeenLastCalledWith(5);
    });

    it('Escape reverts an uncommitted (non-numeric) draft', () => {
        render(<Harness />);
        const input = screen.getByRole('spinbutton') as HTMLInputElement;

        fireEvent.focus(input);
        // Empty string is a valid in-progress state that does NOT fire
        // onChange (the component holds it locally). Escape should
        // revert the draft to the committed value.
        fireEvent.change(input, { target: { value: '' } });
        expect(input).toHaveValue('');

        fireEvent.keyDown(input, { key: 'Escape' });
        expect(input).toHaveValue('5');
    });

    it('disabled disables input + both buttons', () => {
        render(
            <NumberStepper
                value={3}
                onChange={jest.fn()}
                disabled
                decrementAriaLabel="-"
                incrementAriaLabel="+"
            />,
        );
        expect(screen.getByRole('spinbutton')).toBeDisabled();
        expect(screen.getByRole('button', { name: '-' })).toBeDisabled();
        expect(screen.getByRole('button', { name: '+' })).toBeDisabled();
    });

    it('size=sm renders and still passes a11y', async () => {
        const { container } = render(<Harness size="sm" />);
        const results = await axe(container);
        expect(results).toHaveNoViolations();
    });
});
