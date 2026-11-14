/**
 * #5316 item 8 — the digital-sovereignty step is Bulgarian in the Bulgarian UI.
 *
 * The maturity band (`Exposed` … `Sovereign-ready`) came from an English label
 * in the scorer, and all 30 questions and 150 options were English literals in
 * the content bank, so a `bg` user saw English under translated headings. The
 * bank now carries ids and scores only; the copy lives in `messages/<locale>`.
 *
 * Rendered against the REAL `bg` catalogue, so a string that bypasses next-intl
 * shows up here as English.
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const bg = jest.requireActual('../../messages/bg.json');
    const lookup = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            bg,
        );
    const interpolate = (s: string, params?: Record<string, unknown>) =>
        params ? s.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m)) : s;
    const cache = new Map<string, unknown>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) {
                cache.set(ns, (key: string, params?: Record<string, unknown>) => {
                    const v = lookup(`${ns}.${key}`);
                    return typeof v === 'string' ? interpolate(v, params) : `${ns}.${key}`;
                });
            }
            return cache.get(ns);
        },
        useLocale: () => 'bg',
    };
});

import { SovereigntySelfAssessmentStep } from '@/components/onboarding/SovereigntySelfAssessmentStep';
import { DIGITAL_SOVEREIGNTY_ASSESSMENT } from '@/data/self-assessments/digital-sovereignty';
import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

const CYRILLIC = /[Ѐ-ӿ]/;
type QuestionCopy = { text: string; options: Record<string, string> };
const bgQuestions = bg.onboarding.sovereignty.questions as Record<string, QuestionCopy>;
const enQuestions = en.onboarding.sovereignty.questions as Record<string, QuestionCopy>;
const allQuestions = DIGITAL_SOVEREIGNTY_ASSESSMENT.dimensions.flatMap((d) => d.questions);

describe('digital-sovereignty copy is in the catalogues, in both locales', () => {
    it('every question has its text and five option labels in en and bg', () => {
        expect(allQuestions).toHaveLength(30);
        for (const q of allQuestions) {
            for (const cat of [enQuestions, bgQuestions]) {
                expect(cat[q.id]?.text).toBeTruthy();
                expect(Object.keys(cat[q.id]?.options ?? {}).sort()).toEqual(
                    q.options.map((o) => `s${o.score}`).sort(),
                );
            }
            // Bulgarian, not the English copied across.
            expect(bgQuestions[q.id].text).toMatch(CYRILLIC);
            expect(bgQuestions[q.id].text).not.toBe(enQuestions[q.id].text);
        }
    });

    it('carries no question the bank does not ask', () => {
        const ids = new Set(allQuestions.map((q) => q.id));
        expect(Object.keys(enQuestions).filter((k) => !ids.has(k))).toEqual([]);
        expect(Object.keys(bgQuestions).filter((k) => !ids.has(k))).toEqual([]);
    });
});

describe('SovereigntySelfAssessmentStep in Bulgarian', () => {
    it('renders the questions, the options and the maturity band in Bulgarian', () => {
        render(<SovereigntySelfAssessmentStep tenantSlug="acme" />);

        const first = DIGITAL_SOVEREIGNTY_ASSESSMENT.dimensions[0];
        fireEvent.click(screen.getByText(bg.onboarding.sovereignty.dimensions.cloudJurisdiction));

        const q = first.questions[0];
        const card = screen.getByTestId(`sovereignty-question-${q.id}`);
        expect(within(card).getByText(bgQuestions[q.id].text)).toBeInTheDocument();
        expect(within(card).queryByText(enQuestions[q.id].text)).toBeNull();
        expect(within(card).getByText(bgQuestions[q.id].options.s4)).toBeInTheDocument();

        // Answer the top option: overall 4 → the top band, in Bulgarian.
        fireEvent.click(within(card).getAllByRole('radio')[4]);
        const band = screen.getByTestId('sovereignty-band');
        expect(band).toHaveTextContent(bg.onboarding.sovereignty.bands.sovereignReady);
        expect(band).not.toHaveTextContent('Sovereign-ready');
    });
});
