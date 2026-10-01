/**
 * `<ToggleGroup>` renders option labels in the case they were authored.
 *
 * The option recipe carried `capitalize`. CSS `text-transform:
 * capitalize` upper-cases the first letter of EVERY word, which is an
 * English-newspaper convention rather than a general orthographic rule.
 * Bulgarian capitalises only the first word of a phrase, so the
 * calendar's own shipped labels came out wrong:
 *
 *   "Топлинна карта"  →  "Топлинна Карта"
 *   "Хронология"      →  (unchanged — single word, so the defect was
 *                         invisible on most labels)
 *
 * No primitive can make that call per locale, and nothing needed it to:
 * every ToggleGroup option label in the app is either a message-catalog
 * string or a literal already written in its final case ('Active',
 * 'OIDC', 'S'/'M'/'L', the uppercase locale codes the i18n guardrail
 * pins). The transform was redundant in English and wrong elsewhere.
 *
 * jsdom applies no stylesheet, so this test cannot observe the rendered
 * glyphs. What it can prove is that the primitive no longer ASKS for the
 * transform — and that the text it emits is byte-identical to the text
 * it was handed, which is the behaviour the labels depend on.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

import { ToggleGroup } from '@/components/ui/toggle-group';

/** A real shipped label pair: the Bulgarian calendar view options. */
const BG_OPTIONS = [
    { value: 'month', label: 'Месец' },
    { value: 'heatmap', label: 'Топлинна карта' },
    { value: 'gantt', label: 'Хронология' },
];

function renderGroup(options = BG_OPTIONS, selected = 'month') {
    return render(
        <ToggleGroup
            options={options}
            selected={selected}
            selectAction={() => undefined}
            ariaLabel="View"
        />,
    );
}

describe('ToggleGroup option labels', () => {
    test('no option asks for a CSS case transform', () => {
        renderGroup();
        for (const option of screen.getAllByRole('radio')) {
            const classes = Array.from(option.classList);
            // `capitalize`, `uppercase` and `lowercase` are all
            // locale-blind transforms; none belongs on a label whose
            // text came from a message catalog.
            expect(
                classes.filter((c) =>
                    ['capitalize', 'uppercase', 'lowercase'].includes(c),
                ),
            ).toEqual([]);
        }
    });

    test('the emitted text is exactly the text supplied', () => {
        renderGroup();
        // The population, so a label silently dropped would show up as
        // a count mismatch rather than a passing subset.
        const rendered = screen
            .getAllByRole('radio')
            .map((el) => el.textContent);
        expect(rendered).toEqual(BG_OPTIONS.map((o) => o.label));
        // Spelled out for the one that the transform used to break.
        expect(screen.getByText('Топлинна карта')).toBeInTheDocument();
    });

    test('an already-capitalised English label is untouched too', () => {
        renderGroup(
            [
                { value: 'ACTIVE', label: 'Active' },
                { value: 'PAUSED', label: 'Paused' },
            ],
            'ACTIVE',
        );
        expect(
            screen.getAllByRole('radio').map((el) => el.textContent),
        ).toEqual(['Active', 'Paused']);
    });

    test('the radiogroup contract is intact — the class removal changed nothing else', () => {
        renderGroup();
        expect(screen.getByRole('radiogroup')).toBeInTheDocument();
        const options = screen.getAllByRole('radio');
        expect(options).toHaveLength(BG_OPTIONS.length);
        expect(options[0]).toHaveAttribute('aria-checked', 'true');
        expect(options[1]).toHaveAttribute('aria-checked', 'false');
    });
});
