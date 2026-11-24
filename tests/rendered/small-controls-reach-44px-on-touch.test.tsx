/**
 * Small shared controls answer a 44px tap on a touch screen.
 *
 * The mobile re-audit (2026-11-23) measured these at 16-23px on every page
 * that uses them: the toast's close button, the `CopyText` button, the
 * `NumberStepper` field, the rich-text toolbar, a stand-alone text link. Each
 * now reaches 44px on a coarse pointer through one of two shared mechanisms,
 * and keeps its desktop size:
 *
 *   - `TOUCH_HIT_AREA_CLASS`: a transparent `::after`, at least 44x44 on a
 *     coarse pointer, centred on a control whose painted size stays small
 *     (toast close, `CopyText`, `TextLink`, `TextButton`, the slider thumb);
 *   - `pointer-coarse:` sizing, where a hit area would answer for a
 *     neighbour's taps or the element renders no pseudo-element (the
 *     stepper's `<input>`, the 4px-apart editor toolbar).
 *
 * jsdom evaluates no media query, so each case asserts that the control
 * carries the mechanism, on the element a tap lands on, beside a positive
 * check that it is the right element (its name, its role, its action).
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { toast } from 'sonner';

import { TOUCH_HIT_AREA_CLASS } from '@inflect/ui/components/ui/hit-area';
import { AppToaster } from '@/components/theme/AppToaster';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { CopyText } from '@/components/ui/copy-text';
import { NumberStepper } from '@/components/ui/number-stepper';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { Slider } from '@/components/ui/slider';
import { TextButton, TextLink } from '@/components/ui/text-link';

beforeAll(() => {
    // TipTap calls `document.elementFromPoint` while mounting; jsdom lacks it.
    Document.prototype.elementFromPoint = () => null;
});

function classesOf(el: Element): string[] {
    return (el.getAttribute('class') ?? '').split(/\s+/);
}

function expectTouchHitArea(el: Element) {
    const cls = classesOf(el);
    for (const token of TOUCH_HIT_AREA_CLASS.split(/\s+/)) expect(cls).toContain(token);
}

describe('TextLink and TextButton: a stand-alone small link is a 44px target', () => {
    it('a TextLink navigates and wears the hit area on a positioned owner', () => {
        render(
            <TextLink href="/forgot-password" tone="underline" className="text-xs">
                Forgot password?
            </TextLink>,
        );
        const link = screen.getByRole('link', { name: 'Forgot password?' });
        expect(link).toHaveAttribute('href', '/forgot-password');
        expectTouchHitArea(link);
        expect(classesOf(link)).toContain('relative');
        expect(classesOf(link)).toContain('text-xs');
    });

    it('an external TextLink is a plain anchor with the same hit area', () => {
        render(
            <TextLink external href="https://example.test" target="_blank" rel="noopener noreferrer">
                Open portal
            </TextLink>,
        );
        const link = screen.getByRole('link', { name: 'Open portal' });
        expect(link).toHaveAttribute('target', '_blank');
        expectTouchHitArea(link);
    });

    it('a TextButton acts in place, is type="button" by default, and wears the hit area', () => {
        const onClick = jest.fn();
        render(<TextButton onClick={onClick}>Register</TextButton>);
        const button = screen.getByRole('button', { name: 'Register' });
        expect(button).toHaveAttribute('type', 'button');
        expectTouchHitArea(button);
        fireEvent.click(button);
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});

describe('CopyText', () => {
    it('the copy button wears the hit area, positioned, with no clipping', () => {
        render(<CopyText value="TSK-1" label="Copy the task key" />);
        const button = screen.getByRole('button', { name: 'Copy the task key' });
        expectTouchHitArea(button);
        expect(classesOf(button)).toContain('relative');
        expect(classesOf(button)).not.toContain('truncate');
    });
});

describe('NumberStepper', () => {
    it('on a coarse pointer the frame is 48px with no inset, the field fills it, the buttons are 44px wide', () => {
        render(
            <NumberStepper value={3} onChange={() => {}} size="sm" ariaLabel="Delegations per turn" />,
        );
        const field = screen.getByRole('spinbutton', { name: 'Delegations per turn' });
        const group = field.closest('[role="group"]') as HTMLElement;
        expect(classesOf(group)).toEqual(expect.arrayContaining(['pointer-coarse:h-12', 'pointer-coarse:p-0']));
        // The field fills the frame instead of sitting at its text's height.
        expect(classesOf(field)).toContain('h-full');
        for (const name of ['Decrease', 'Increase']) {
            const button = within(group).getByRole('button', { name });
            expect(classesOf(button)).toContain('pointer-coarse:min-w-11');
            expect(classesOf(button)).toContain('h-full');
        }
    });
});

describe('RichTextEditor toolbar', () => {
    it('the mode toggle and every format button are 44px on a coarse pointer, and the toggle text is 12px', () => {
        render(<RichTextEditor value="<p>x</p>" contentType="HTML" onChange={() => {}} />);
        const toggle = screen.getByTestId('rich-text-editor-toggle');
        expect(classesOf(toggle)).toContain('pointer-coarse:min-h-11');
        expect(classesOf(toggle)).toContain('text-xs');
        expect(classesOf(toggle)).not.toContain('text-[11px]');

        const bold = screen.getByRole('button', { name: 'Bold' });
        expect(classesOf(bold)).toEqual(expect.arrayContaining(['pointer-coarse:h-11', 'pointer-coarse:w-11']));
        const link = screen.getByTestId('rich-text-editor-link');
        expect(classesOf(link)).toEqual(
            expect.arrayContaining(['pointer-coarse:min-h-11', 'pointer-coarse:min-w-11']),
        );
    });
});

describe('Slider', () => {
    it('the thumb wears the hit area, takes the id and is named by a visible label', async () => {
        render(
            <>
                <span id="lik-label">Likelihood · 3</span>
                <Slider id="risk-likelihood" ariaLabelledBy="lik-label" min={1} max={5} value={3} onChange={() => {}} />
            </>,
        );
        // The thumb is the lazily loaded Radix part (see `slider.tsx`).
        const thumb = await screen.findByRole('slider', { name: 'Likelihood · 3' });
        expect(thumb).toHaveAttribute('id', 'risk-likelihood');
        expect(thumb).not.toHaveAttribute('aria-label');
        expectTouchHitArea(thumb);
    });
});

describe('the toast close button', () => {
    it('wears the hit area on the button sonner renders', async () => {
        render(
            <ThemeProvider>
                <AppToaster />
            </ThemeProvider>,
        );
        act(() => {
            toast('Saved');
        });
        const close = await screen.findByRole('button', { name: /close/i });
        expect(close).toHaveAttribute('data-close-button');
        expectTouchHitArea(close);
    });
});
