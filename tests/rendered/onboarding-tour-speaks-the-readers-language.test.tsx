/** @jest-environment jsdom */

/**
 * The product tour speaks the reader's language (#5904).
 *
 * driver.js writes its own chrome — "Next", "Previous", "Done", "Close",
 * "1 of 7" — in English unless it is handed the words, and the steps' headings
 * and bodies used to be English literals in `src/lib/onboarding-steps.ts`, so a
 * Bulgarian session got an English tour. Every word now comes from the
 * `onboardingTour` catalogue.
 *
 * driver.js itself is replaced by a recorder: what reaches the reader is the
 * config the provider hands it, so that is what is asserted. Each string is
 * compared with the Bulgarian catalogue AND with the English one, so a step
 * that falls back to English — a literal, a key missing from `bg.json`, a
 * driver.js default left in place — fails here.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

// The repo-wide `next-intl` manual mock reads English only; this one reads
// the catalogue its provider is given, as next-intl does. A missing key comes
// back as the key, as next-intl's default does, never as English.
jest.mock('next-intl', () => {
    const R = require('react') as typeof React;
    const Messages = R.createContext<unknown>({});
    const walk = (root: unknown, path: string): unknown =>
        path
            .split('.')
            .reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                root,
            );
    return {
        NextIntlClientProvider: ({ messages, children }: { messages: unknown; children: React.ReactNode }) =>
            R.createElement(Messages.Provider, { value: messages }, children),
        useTranslations: (namespace?: string) => {
            const messages = R.useContext(Messages);
            return (key: string, params?: Record<string, unknown>) => {
                const path = namespace ? `${namespace}.${key}` : key;
                const found = walk(messages, path);
                if (typeof found !== 'string') return path;
                return found.replace(/\{(\w+)\}/g, (m, name: string) =>
                    params && name in params ? String(params[name]) : m,
                );
            };
        },
    };
});

const mockConfigs: Array<Record<string, unknown>> = [];
jest.mock('driver.js', () => ({
    driver: (config: Record<string, unknown>) => {
        mockConfigs.push(config);
        return { drive: () => undefined, destroy: () => undefined, hasNextStep: () => false };
    },
}));

import { OnboardingTourProvider, StartTourButton } from '@/components/ui/OnboardingTour';
import { DEFAULT_TOUR_STEPS } from '@/lib/onboarding-steps';

const BG = require('../../messages/bg.json');
const EN = require('../../messages/en.json');

type Catalogue = {
    start: string;
    next: string;
    previous: string;
    done: string;
    close: string;
    progress: string;
    steps: Record<string, { title: string; body: string }>;
};
const BG_TOUR = BG.onboardingTour as Catalogue;
const EN_TOUR = EN.onboardingTour as Catalogue;

/** Every English string the tour could fall back to. */
const ENGLISH = new Set<string>([
    EN_TOUR.next,
    EN_TOUR.previous,
    EN_TOUR.done,
    EN_TOUR.close,
    ...Object.values(EN_TOUR.steps).flatMap((s) => [s.title, s.body]),
    // driver.js's own defaults.
    'Next',
    'Previous',
    'Done',
    'Close',
    '{{current}} of {{total}}',
]);

/** The ICU placeholders filled the way the provider fills them. */
function fill(template: string, values: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`);
}

/**
 * Sidebar anchors for the anchored steps. Each selector matches twice: first
 * a hidden copy (the desktop sidebar on a phone, which has no box), then the
 * visible one. jsdom lays nothing out, so a box is stubbed by attribute.
 */
function Anchors() {
    const anchored = DEFAULT_TOUR_STEPS.filter((s) => s.selector !== null);
    return (
        <>
            {anchored.map((s) => {
                const testid = /data-testid="([^"]+)"/.exec(s.selector ?? '')?.[1] ?? '';
                return (
                    <React.Fragment key={s.id}>
                        <a data-testid={testid} data-box="none" />
                        <a data-testid={testid} data-box="visible" />
                    </React.Fragment>
                );
            })}
        </>
    );
}

function mountTour(locale: 'bg' | 'en') {
    return render(
        <NextIntlClientProvider locale={locale} messages={locale === 'bg' ? BG : EN}>
            <OnboardingTourProvider userId="u1" autoTriggerOnFirstLogin={false}>
                <Anchors />
                <StartTourButton />
            </OnboardingTourProvider>
        </NextIntlClientProvider>,
    );
}

async function startTour(): Promise<Record<string, unknown>> {
    fireEvent.click(screen.getByTestId('start-tour-btn'));
    await waitFor(() => expect(mockConfigs).toHaveLength(1));
    return mockConfigs[0];
}

beforeAll(() => {
    jest.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
        const boxes = this.getAttribute('data-box') === 'visible' ? [new DOMRect(0, 0, 100, 40)] : [];
        return Object.assign(boxes, { item: (i: number) => boxes[i] ?? null }) as unknown as DOMRectList;
    });
});

beforeEach(() => {
    mockConfigs.length = 0;
    window.localStorage.clear();
});

describe('the onboarding tour in a Bulgarian session', () => {
    it('labels its start button in Bulgarian', () => {
        mountTour('bg');
        expect(screen.getByTestId('start-tour-btn').textContent).toBe(BG_TOUR.start);
        expect(BG_TOUR.start).not.toBe(EN_TOUR.start);
    });

    it('hands driver.js every step heading and body from the Bulgarian catalogue, none in English', async () => {
        mountTour('bg');
        const config = await startTour();
        const steps = config.steps as Array<{ popover: { title: string; description: string } }>;
        expect(steps).toHaveLength(DEFAULT_TOUR_STEPS.length);

        DEFAULT_TOUR_STEPS.forEach((step, i) => {
            const expected = BG_TOUR.steps[step.messageKey];
            const { title, description } = steps[i].popover;
            expect([step.id, title]).toEqual([step.id, expected.title]);
            expect([step.id, description]).toEqual([step.id, fill(expected.body, { startLabel: BG_TOUR.start })]);
            expect([step.id, ENGLISH.has(title), ENGLISH.has(description)]).toEqual([step.id, false, false]);
        });
    });

    it('hands driver.js its buttons, close label and progress line in Bulgarian', async () => {
        mountTour('bg');
        const config = await startTour();
        expect({
            nextBtnText: config.nextBtnText,
            prevBtnText: config.prevBtnText,
            doneBtnText: config.doneBtnText,
            closeBtnLabel: config.closeBtnLabel,
            progressText: config.progressText,
        }).toEqual({
            nextBtnText: BG_TOUR.next,
            prevBtnText: BG_TOUR.previous,
            doneBtnText: BG_TOUR.done,
            closeBtnLabel: BG_TOUR.close,
            // driver.js fills its own `{{current}}` / `{{total}}`.
            progressText: fill(BG_TOUR.progress, { current: '{{current}}', total: '{{total}}' }),
        });
        for (const key of ['nextBtnText', 'prevBtnText', 'doneBtnText', 'closeBtnLabel', 'progressText']) {
            expect([key, ENGLISH.has(config[key] as string)]).toEqual([key, false]);
        }
        expect(config.progressText).toContain('{{current}}');
        expect(config.progressText).toContain('{{total}}');
    });

    it('points each anchored step at the visible copy of its anchor, not the hidden one', async () => {
        mountTour('bg');
        const config = await startTour();
        const steps = config.steps as Array<{ element?: Element }>;
        DEFAULT_TOUR_STEPS.forEach((step, i) => {
            const el = steps[i].element;
            if (step.selector === null) {
                expect([step.id, el]).toEqual([step.id, undefined]);
            } else {
                expect([step.id, el?.getAttribute('data-box')]).toEqual([step.id, 'visible']);
            }
        });
    });
});

describe('the onboarding tour started from a phone\'s navigation drawer', () => {
    it('closes the drawer first and anchors no step inside it, so the tour is its centred steps', async () => {
        const closeDrawer = jest.fn();
        render(
            <NextIntlClientProvider locale="bg" messages={BG}>
                <OnboardingTourProvider userId="u1" autoTriggerOnFirstLogin={false}>
                    {/* The phone's navigation drawer is a dialog. */}
                    <div role="dialog" aria-label="Navigation">
                        {DEFAULT_TOUR_STEPS.filter((s) => s.selector).map((s) => (
                            <a key={s.id} data-testid={/data-testid="([^"]+)"/.exec(s.selector ?? '')?.[1]} data-box="visible" />
                        ))}
                        <StartTourButton onStart={closeDrawer} />
                    </div>
                </OnboardingTourProvider>
            </NextIntlClientProvider>,
        );
        const config = await startTour();
        expect(closeDrawer).toHaveBeenCalledTimes(1);
        const steps = config.steps as Array<{ element?: Element; popover: { title: string } }>;
        const centred = DEFAULT_TOUR_STEPS.filter((s) => s.selector === null);
        expect(steps.map((s) => s.popover.title)).toEqual(centred.map((s) => BG_TOUR.steps[s.messageKey].title));
        expect(steps.every((s) => s.element === undefined)).toBe(true);
    });
});

describe('the onboarding tour in an English session', () => {
    it('reads the English catalogue', async () => {
        mountTour('en');
        const config = await startTour();
        const steps = config.steps as Array<{ popover: { title: string } }>;
        expect(steps[0].popover.title).toBe(EN_TOUR.steps.welcome.title);
        expect(config.nextBtnText).toBe(EN_TOUR.next);
        expect(config.progressText).toBe('{{current}} of {{total}}');
    });
});
