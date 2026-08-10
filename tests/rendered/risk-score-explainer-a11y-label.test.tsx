/**
 * The explainer trigger announces the SCORE and BAND before the verb.
 *
 * A screen-reader user tabbing a risk table hears "20 · High, explain" — not
 * "Explain this score" twenty times with no way to tell the rows apart. That
 * is the whole point of the `label` prop, and it is only observable in the
 * ACCESSIBLE NAME, which is what this asserts.
 *
 * B3-5 — replaces the source-scan in `polish-01-score-chip-a11y.test.ts`,
 * which matched the literal
 * `aria-label={label ? t('explainLabelAria', { label }) : t('explainAria')}`
 * and then pinned the two English strings in `messages/en.json`. That proved
 * the characters existed and the copy had not been edited; it could not tell
 * you the button ends up with a usable name, and it would have gone red on a
 * copy tweak — which the ratchet-lifecycle policy bans.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { RiskScoreExplainer } from '@/components/risks/RiskScoreExplainer';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

const mount = (props: Partial<React.ComponentProps<typeof RiskScoreExplainer>> = {}) =>
    render(
        <KeyboardShortcutProvider>
            <RiskScoreExplainer tenantSlug="acme" riskId="r-1" {...props}>
                <span>20</span>
            </RiskScoreExplainer>
        </KeyboardShortcutProvider>,
    );

describe('RiskScoreExplainer — accessible name', () => {
    it('announces "<score> · <band>, explain" when a label is supplied', () => {
        mount({ label: '20 · High' });
        // Queried by ROLE + NAME: this is exactly what a screen reader
        // computes, rather than an attribute we hope maps to it.
        expect(
            screen.getByRole('button', { name: '20 · High, explain' }),
        ).toBeInTheDocument();
    });

    it('falls back to a generic name when no label is supplied', () => {
        mount();
        expect(
            screen.getByRole('button', { name: 'Explain this score' }),
        ).toBeInTheDocument();
    });

    it('puts the score FIRST — the distinguishing part before the verb', () => {
        // Ordering is the accessibility property that matters in a table:
        // the differentiator has to arrive before the boilerplate, or every
        // row sounds identical until the very end.
        mount({ label: '7 · Low' });
        const name = screen.getByRole('button', { name: /explain/ }).getAttribute('aria-label')!;
        expect(name.indexOf('7 · Low')).toBeLessThan(name.indexOf('explain'));
    });

    it('never announces a bare "undefined" for an empty label', () => {
        // `label=""` is falsy, so it must take the generic branch rather
        // than composing ", explain" onto nothing.
        mount({ label: '' });
        expect(
            screen.getByRole('button', { name: 'Explain this score' }),
        ).toBeInTheDocument();
    });
});
