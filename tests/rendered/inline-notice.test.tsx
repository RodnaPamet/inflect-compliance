/**
 * InlineNotice primitive — render tests (PR-10).
 *
 * Locks the contract for `<InlineNotice>` so the canonical inline
 * banner surface can't drift silently as adoption grows.
 */
/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Info } from 'lucide-react';
import { InlineNotice } from '@/components/ui/inline-notice';

describe('InlineNotice', () => {
    it('error variant renders inside role="alert"', () => {
        render(<InlineNotice variant="error">Something failed</InlineNotice>);
        expect(screen.getByRole('alert')).toHaveTextContent('Something failed');
    });

    it('success/info/warning render inside role="status"', () => {
        const { rerender } = render(
            <InlineNotice variant="success">Saved</InlineNotice>,
        );
        expect(screen.getByRole('status')).toHaveTextContent('Saved');
        rerender(<InlineNotice variant="info">Heads up</InlineNotice>);
        expect(screen.getByRole('status')).toHaveTextContent('Heads up');
        rerender(<InlineNotice variant="warning">Be careful</InlineNotice>);
        expect(screen.getByRole('status')).toHaveTextContent('Be careful');
    });

    it('renders aria-live=polite on every variant', () => {
        const { rerender, container } = render(
            <InlineNotice variant="error">err</InlineNotice>,
        );
        expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
        rerender(<InlineNotice variant="success">ok</InlineNotice>);
        expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    });

    it('renders the title before the body when supplied', () => {
        render(
            <InlineNotice variant="info" title="Heads up">
                We restored from cache.
            </InlineNotice>,
        );
        expect(screen.getByText('Heads up')).toBeInTheDocument();
        expect(screen.getByText('We restored from cache.')).toBeInTheDocument();
    });

    it('renders the dismiss button only when onDismiss is supplied', () => {
        const onDismiss = jest.fn();
        const { rerender } = render(
            <InlineNotice variant="error">x</InlineNotice>,
        );
        expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
        rerender(
            <InlineNotice variant="error" onDismiss={onDismiss}>
                x
            </InlineNotice>,
        );
        expect(
            screen.getByRole('button', { name: /dismiss/i }),
        ).toBeInTheDocument();
    });

    it('clicking the dismiss button calls onDismiss', async () => {
        const onDismiss = jest.fn();
        render(
            <InlineNotice variant="error" onDismiss={onDismiss}>
                x
            </InlineNotice>,
        );
        await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('honours a custom dismissLabel', () => {
        render(
            <InlineNotice
                variant="error"
                onDismiss={() => {}}
                dismissLabel="Close"
            >
                x
            </InlineNotice>,
        );
        expect(
            screen.getByRole('button', { name: 'Close' }),
        ).toBeInTheDocument();
    });

    it('gives the dismiss button a target, not just a glyph', () => {
        // The icon is 14px and the padding was `p-0.5`, so the whole tap
        // area was 18px — under WCAG 2.2 2.5.8's 24px minimum, and the
        // thing a finger actually has to hit. `size-6` is the 24px floor;
        // `pointer-coarse:size-11` is 44px on a touch screen, where the
        // 24px floor is not enough. Neither moves the glyph, so nothing
        // changes visually with a mouse.
        render(
            <InlineNotice variant="error" onDismiss={() => {}}>
                x
            </InlineNotice>,
        );
        const cls = screen.getByRole('button', { name: /dismiss/i }).className;
        expect(cls).toContain('size-6');
        expect(cls).toContain('pointer-coarse:size-11');
        // The padding that produced the 18px target is gone, and the glyph
        // is centred in the box instead.
        expect(cls).not.toContain('p-0.5');
        expect(cls).toContain('items-center');
        expect(cls).toContain('justify-center');
    });

    it('renders an icon override when supplied', () => {
        render(
            <InlineNotice variant="info" icon={Info} data-testid="my-notice">
                Tip
            </InlineNotice>,
        );
        const root = screen.getByTestId('my-notice');
        expect(root.querySelector('svg')).not.toBeNull();
    });

    it('omits the icon when icon={null}', () => {
        render(
            <InlineNotice variant="info" icon={null} data-testid="my-notice">
                Plain
            </InlineNotice>,
        );
        const root = screen.getByTestId('my-notice');
        // No leading icon — only the (potential) dismiss icon would
        // render, and we didn't pass onDismiss.
        expect(root.querySelector('svg')).toBeNull();
    });

    it('forwards data-testid + id to the outer wrapper', () => {
        render(
            <InlineNotice
                variant="success"
                id="save-banner"
                data-testid="save-banner"
            >
                ok
            </InlineNotice>,
        );
        const node = screen.getByTestId('save-banner');
        expect(node).toHaveAttribute('id', 'save-banner');
    });

    it('applies the per-variant token classes', () => {
        const { rerender } = render(
            <InlineNotice variant="error" data-testid="n">
                x
            </InlineNotice>,
        );
        expect(screen.getByTestId('n').className).toMatch(/bg-bg-error/);
        expect(screen.getByTestId('n').className).toMatch(/border-border-error/);
        rerender(
            <InlineNotice variant="success" data-testid="n">
                x
            </InlineNotice>,
        );
        expect(screen.getByTestId('n').className).toMatch(/bg-bg-success/);
        expect(screen.getByTestId('n').className).toMatch(
            /border-border-success/,
        );
    });
});
