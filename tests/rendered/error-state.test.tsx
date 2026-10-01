/**
 * ErrorState primitive — render tests (PR-8).
 *
 * Locks the contract for `<ErrorState>` so the canonical error
 * surface can't drift silently as adoption grows.
 */
/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorState } from '@/components/ui/error-state';

describe('ErrorState', () => {
  it('renders with the default title and AlertTriangle icon', () => {
    render(<ErrorState />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // The decorative icon container sits above the title.
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders a custom title and description', () => {
    render(
      <ErrorState
        title="Couldn't load risks"
        description="The server returned a 500 — try again in a moment."
      />,
    );
    expect(screen.getByText("Couldn't load risks")).toBeInTheDocument();
    expect(
      screen.getByText('The server returned a 500 — try again in a moment.'),
    ).toBeInTheDocument();
  });

  it('renders a retry button when onRetry is provided', async () => {
    const onRetry = jest.fn();
    render(<ErrorState onRetry={onRetry} />);
    const button = screen.getByRole('button', { name: 'Try again' });
    await userEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('respects a custom retry label', () => {
    render(<ErrorState onRetry={() => undefined} retryLabel="Reload" />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('does NOT render a retry button when onRetry is undefined', () => {
    render(<ErrorState description="Read-only error" />);
    expect(
      screen.queryByRole('button', { name: 'Try again' }),
    ).not.toBeInTheDocument();
  });

  it('renders a secondary action button alongside retry', async () => {
    const onSecondary = jest.fn();
    render(
      <ErrorState
        onRetry={() => undefined}
        secondaryAction={{
          label: 'Go back',
          onClick: onSecondary,
          'data-testid': 'go-back',
        }}
      />,
    );
    const goBack = screen.getByTestId('go-back');
    await userEvent.click(goBack);
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  it('disables the retry button when retryDisabled is true', () => {
    render(<ErrorState onRetry={() => undefined} retryDisabled />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
  });

  it('forwards data-testid to the outer wrapper and derives a retry test id', () => {
    render(
      <ErrorState data-testid="risks-error" onRetry={() => undefined} />,
    );
    expect(screen.getByTestId('risks-error')).toBeInTheDocument();
    expect(screen.getByTestId('risks-error-retry')).toBeInTheDocument();
  });

  it('uses an aria-live=polite alert region so screen readers announce the failure', () => {
    render(<ErrorState />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'polite');
  });

  // ── secondaryAction.href ────────────────────────────────────────
  //
  // `href` was DECLARED on `ErrorStateAction` ("When set, renders as
  // `<a href>` instead of a button") and then dropped: the branch always
  // rendered a `<Button>`, which has nowhere to put an href. So the
  // documented "Go back to dashboard" shape produced a control that
  // looked live and navigated nowhere. The only reason it was not
  // louder is that every call site so far happened to pass `onClick`.
  describe('a secondary action with an href navigates', () => {
    it('renders a real anchor carrying the destination', () => {
      render(
        <ErrorState
          onRetry={() => undefined}
          secondaryAction={{
            label: 'Go back',
            href: '/t/acme/dashboard',
            'data-testid': 'go-back',
          }}
        />,
      );
      const link = screen.getByTestId('go-back');
      // A real <a href>, not a button: middle-click, open-in-new-tab
      // and the browser's own status bar all come from the element.
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', '/t/acme/dashboard');
      // And it is reachable by its accessible role, which a <button>
      // with a dropped href would not be.
      expect(
        screen.getByRole('link', { name: 'Go back' }),
      ).toBe(link);
    });

    it('still renders a button when only onClick is given', () => {
      // The regression guard on the other side: the href branch must
      // not swallow the handler-only shape every current call site uses.
      const onClick = jest.fn();
      render(
        <ErrorState
          secondaryAction={{
            label: 'Contact support',
            onClick,
            'data-testid': 'secondary',
          }}
        />,
      );
      const el = screen.getByTestId('secondary');
      expect(el.tagName).toBe('BUTTON');
      expect(el).not.toHaveAttribute('href');
    });

    it('a disabled link is inert rather than merely dimmed', () => {
      // An anchor has no `disabled` attribute, so "disabled" has to be
      // expressed twice: `pointer-events-none` for the pointer and
      // `aria-disabled` for AT. Asserting only the opacity would have
      // left a greyed-out link that still navigated.
      render(
        <ErrorState
          secondaryAction={{
            label: 'Go back',
            href: '/t/acme/dashboard',
            disabled: true,
            'data-testid': 'go-back',
          }}
        />,
      );
      const link = screen.getByTestId('go-back');
      expect(link).toHaveAttribute('aria-disabled', 'true');
      expect(link).toHaveClass('pointer-events-none');
    });
  });
});
