/**
 * Typography primitives — render + shape tests.
 *
 * Locks the contract for `<Heading>`, `<Eyebrow>`, `<Caption>`,
 * `<TextLink>` so the design-system shape can't drift silently.
 */
/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import {
  Heading,
  Eyebrow,
  Caption,
  TextLink,
} from '@/components/ui/typography';

describe('Heading', () => {
  it('renders a level-1 heading by default with the canonical h1 styling', () => {
    render(<Heading>Page title</Heading>);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveClass('text-2xl');
    expect(heading).toHaveClass('font-semibold');
    expect(heading).toHaveClass('text-content-emphasis');
  });

  it('matches level → tag for L1/L2/L3', () => {
    const { rerender } = render(<Heading level={1}>L1</Heading>);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    rerender(<Heading level={2}>L2</Heading>);
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
    rerender(<Heading level={3}>L3</Heading>);
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
  });

  it('honours the `as` override when supplied', () => {
    render(
      <Heading level={1} as="div" data-testid="div-heading">
        Title
      </Heading>,
    );
    const el = screen.getByTestId('div-heading');
    expect(el.tagName).toBe('DIV');
    // Visual style still corresponds to level 1
    expect(el).toHaveClass('text-2xl');
  });

  it('applies muted tone when requested', () => {
    render(<Heading tone="muted">Muted</Heading>);
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass(
      'text-content-muted',
    );
  });

  it('passes through arbitrary className additions', () => {
    render(<Heading className="mt-4">Title</Heading>);
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('mt-4');
  });
});

describe('Eyebrow', () => {
  it('renders the canonical small uppercase muted label', () => {
    render(<Eyebrow data-testid="eyebrow">Section</Eyebrow>);
    const el = screen.getByTestId('eyebrow');
    expect(el).toHaveClass('text-xs');
    expect(el).toHaveClass('uppercase');
    expect(el).toHaveClass('tracking-wider');
    expect(el).toHaveClass('text-content-muted');
    expect(el).toHaveClass('font-semibold');
  });
});

describe('Caption', () => {
  it('renders muted descriptive copy', () => {
    render(<Caption data-testid="caption">Helpful description</Caption>);
    const el = screen.getByTestId('caption');
    expect(el.tagName).toBe('P');
    expect(el).toHaveClass('text-sm');
    expect(el).toHaveClass('text-content-muted');
  });
});

describe('TextLink', () => {
  it('renders an anchor with the default tone', () => {
    render(
      <TextLink href="/x" data-testid="link">
        Open
      </TextLink>,
    );
    const el = screen.getByTestId('link');
    expect(el.tagName).toBe('A');
    expect(el).toHaveClass('text-content-emphasis');
    expect(el).toHaveClass('font-medium');
    expect(el).toHaveClass('transition-colors');
  });

  it('respects the muted tone variant', () => {
    render(
      <TextLink href="/x" tone="muted" data-testid="link-muted">
        Aside
      </TextLink>,
    );
    expect(screen.getByTestId('link-muted')).toHaveClass('text-content-muted');
  });

  it('respects the underline tone variant', () => {
    render(
      <TextLink href="/x" tone="underline" data-testid="link-underline">
        Learn more
      </TextLink>,
    );
    const el = screen.getByTestId('link-underline');
    expect(el).toHaveClass('underline');
    expect(el).toHaveClass('underline-offset-2');
  });

  it('forwards arbitrary anchor attributes', () => {
    render(
      <TextLink
        href="/x"
        target="_blank"
        rel="noopener"
        data-testid="link-attrs"
      >
        External
      </TextLink>,
    );
    const el = screen.getByTestId('link-attrs');
    expect(el).toHaveAttribute('target', '_blank');
    expect(el).toHaveAttribute('rel', 'noopener');
  });

  it('exposes a focus-visible ring via the shared semantic token', () => {
    render(
      <TextLink href="/x" data-testid="link-focus">
        Focus me
      </TextLink>,
    );
    expect(screen.getByTestId('link-focus')).toHaveClass(
      'focus-visible:ring-ring',
    );
  });

  // ── Brand-coloured link text is AA-safe ──────────────────────────
  //
  // Every brand tone painted `text-[var(--brand-default)]`, a FILL
  // token. As text on the light theme that is #D04A02 — ~4:1 on
  // `--bg-page`, under WCAG 1.4.3's 4.5:1 for body text. The tones most
  // likely to sit mid-paragraph, where 1.4.3 applies squarely, were the
  // ones failing. `--content-brand` exists for this and is guarded on
  // the measured RATIO in
  // `tests/guardrails/token-contrast-content-brand.test.ts`.
  //
  // These assert the TOKEN rather than a ratio on purpose: the ratio is
  // a property of the token (asserted where the token is declared), and
  // what can regress here is a primitive reaching for the fill token
  // again.
  describe('brand-coloured tones use the AA-safe content token', () => {
    it.each(['brand', 'link'] as const)(
      '`%s` tone paints text-content-brand at rest',
      (tone) => {
        render(
          <TextLink href="/x" tone={tone} data-testid="l">
            Open
          </TextLink>,
        );
        expect(screen.getByTestId('l')).toHaveClass('text-content-brand');
      },
    );

    it.each([
      ['default', 'hover:text-content-brand'],
      ['muted', 'hover:text-content-emphasis'],
      ['brand', 'hover:text-content-emphasis'],
      ['link', 'hover:text-content-emphasis'],
      ['underline', 'hover:text-content-emphasis'],
    ] as const)(
      '`%s` tone hovers to %s — never into the brand FILL ramp',
      (tone, expectedHover) => {
        render(
          <TextLink href="/x" tone={tone} data-testid="l">
            Open
          </TextLink>,
        );
        const classes = Array.from(screen.getByTestId('l').classList);
        // Nothing reaching into the brand fill ramp as TEXT, at rest or
        // on hover, in ANY tone — the assertion that would have caught
        // the original defect. The every-tone sweep matters: `default`
        // was failing too, and a test that checked only the two tones
        // named "brand" would have missed it.
        expect(
          classes.filter((c) => /^(?:hover:)?text-\[var\(--brand-/.test(c)),
        ).toEqual([]);
        expect(classes).toContain(expectedHover);
      },
    );

    it('hover is a real change — never the same value as rest', () => {
      // `brand` used to hover to `--brand-emphasis`, which on the light
      // theme is the SAME hex as `--content-brand`: a hover state that
      // changed nothing a user could see. Comparing the two token names
      // catches a repeat without hard-coding either value.
      for (const tone of ['brand', 'link'] as const) {
        const { unmount } = render(
          <TextLink href="/x" tone={tone} data-testid="l">
            Open
          </TextLink>,
        );
        const classes = Array.from(screen.getByTestId('l').classList);
        const rest = classes.find((c) => /^text-content-/.test(c));
        const hover = classes.find((c) => /^hover:text-content-/.test(c));
        expect({ tone, rest, hover }).toEqual({
          tone,
          rest: expect.any(String),
          hover: expect.any(String),
        });
        expect(hover).not.toBe(`hover:${rest}`);
        unmount();
      }
    });

    it('the `link` tone still underlines on hover', () => {
      // The hover SHADE changed; the hover affordance must not have.
      render(
        <TextLink href="/x" tone="link" data-testid="l">
          click here
        </TextLink>,
      );
      expect(screen.getByTestId('l')).toHaveClass('hover:underline');
    });
  });
});
