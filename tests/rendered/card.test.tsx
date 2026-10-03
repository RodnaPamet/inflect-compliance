/**
 * Card primitive — render tests (PR-6).
 *
 * Locks the contract for `<Card density>` so the canonical density
 * scale (comfortable / compact / none) can't drift silently.
 */
/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { Card } from '@/components/ui/card';

describe('Card', () => {
  it('renders glass-card with the comfortable padding by default', () => {
    render(
      <Card data-testid="card">
        Body
      </Card>,
    );
    const el = screen.getByTestId('card');
    expect(el).toHaveClass('glass-card');
    expect(el).toHaveClass('p-6');
  });

  it('renders compact density', () => {
    render(
      <Card density="compact" data-testid="card">
        Body
      </Card>,
    );
    const el = screen.getByTestId('card');
    expect(el).toHaveClass('glass-card');
    expect(el).toHaveClass('p-4');
  });

  it('renders no-padding density', () => {
    render(
      <Card density="none" data-testid="card">
        Body
      </Card>,
    );
    const el = screen.getByTestId('card');
    expect(el).toHaveClass('glass-card');
    // #3151 — the `p-0` is load-bearing, not cosmetic. `.glass-card`
    // carries its own `@apply p-4 md:p-5` in `@layer components`; only a
    // PRESENT utility in `@layer utilities` can outrank it, so emitting
    // nothing at all (what this rung used to do) rendered 16px / 20px.
    // The two negatives below pass in BOTH worlds — they were the whole
    // of this test's coverage and could not see the bug.
    expect(el).toHaveClass('p-0');
    expect(el).not.toHaveClass('p-4');
    expect(el).not.toHaveClass('p-6');
  });

  it('passes additional className through', () => {
    render(
      <Card className="border-border-error" data-testid="card">
        Body
      </Card>,
    );
    const el = screen.getByTestId('card');
    expect(el).toHaveClass('glass-card');
    expect(el).toHaveClass('border-border-error');
  });

  it('renders as the requested element when `as` is provided', () => {
    render(
      <Card as="section" data-testid="card-section">
        Body
      </Card>,
    );
    const el = screen.getByTestId('card-section');
    expect(el.tagName).toBe('SECTION');
  });

  it('forwards arbitrary HTML attributes', () => {
    render(
      <Card id="card-1" aria-label="Risk summary" data-testid="card">
        Body
      </Card>,
    );
    const el = screen.getByTestId('card');
    expect(el).toHaveAttribute('id', 'card-1');
    expect(el).toHaveAttribute('aria-label', 'Risk summary');
  });
});
