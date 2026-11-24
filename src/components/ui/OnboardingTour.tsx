'use client';

/**
 * Driver.js-based product tour.
 *
 * Two surfaces:
 *
 *   • `<OnboardingTourProvider>` — mounted ONCE near the app
 *     shell. Owns the tour-running state, the auto-trigger
 *     decision, and the persistence flag. Children consume it
 *     via `useOnboardingTour()` to start / stop the tour.
 *
 *   • `useOnboardingTour()` — small hook returning
 *     `{ start, dismiss, hasCompleted, running }`. The sidebar
 *     "Take the tour" link calls `start()`; the auto-trigger
 *     uses `running` to avoid double-fires.
 *
 * Driver.js loads via `next/dynamic({ ssr: false })`-equivalent
 * lazy import inside `start()` — the lib chunk stays off the
 * critical path, never ships in SSR, and the user pays the
 * download cost only when they actually run the tour.
 *
 * EVERY WORD COMES FROM THE CATALOGUE (#5904). The step headings and
 * bodies, the progress line, the Next / Previous / Done buttons and the
 * close button's name are all `onboardingTour.*` messages, handed to
 * driver.js as config; left to itself driver.js writes "Next", "Previous",
 * "Done", "Close" and "1 of 7" in English. The popover's phone fit lives in
 * `src/app/globals.css` under `.inflect-onboarding-popover`.
 *
 * INTENTIONAL SEPARATION from the existing tenant setup wizard
 * (`src/components/onboarding/OnboardingWizard.tsx`). The wizard
 * is a DB-backed multi-step config flow; this is an in-page
 * overlay pointing at real UI elements. No code is shared and
 * the structural ratchet at
 * `tests/unit/onboarding-tour-structural.test.ts` enforces it.
 */

import {
    type ReactNode,
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/button-variants';
import { useLocalStorage } from '@/components/ui/hooks';
import {
    DEFAULT_TOUR_STEPS,
    filterStepsForCurrentPage,
    isTourCompleted,
    makeCompletionRecord,
    tourCompletionKey,
    type OnboardingStep,
    type TourCompletionRecord,
} from '@/lib/onboarding-steps';

// ─── Context ──────────────────────────────────────────────────────────

interface OnboardingTourApi {
    /** Start the tour. Filters out steps whose anchor isn't on the current page. */
    start: () => void;
    /** Mark the tour as dismissed without starting it (auto-trigger gate). */
    dismiss: () => void;
    /** Whether the user has completed or dismissed the tour at least once. */
    hasCompleted: boolean;
    /** Whether driver.js is currently driving a tour. */
    running: boolean;
}

const OnboardingTourContext = createContext<OnboardingTourApi | null>(null);

export function useOnboardingTour(): OnboardingTourApi {
    const ctx = useContext(OnboardingTourContext);
    if (!ctx) {
        throw new Error(
            'useOnboardingTour must be called inside <OnboardingTourProvider>',
        );
    }
    return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────────

export interface OnboardingTourProviderProps {
    /** Authenticated user id — completion is tracked per-user. */
    userId: string | null;
    /**
     * When true, a one-time auto-trigger fires shortly after mount
     * for users with no completion record. Defaults to true.
     * Pass `false` from layouts that already host the tour from a
     * different route (avoids a double-fire on internal nav).
     */
    autoTriggerOnFirstLogin?: boolean;
    /**
     * Steps to use. Defaults to `DEFAULT_TOUR_STEPS`. Tests override
     * to keep the assertion surface narrow.
     */
    steps?: ReadonlyArray<OnboardingStep>;
    children: ReactNode;
}

const AUTO_TRIGGER_DELAY_MS = 1200;

export function OnboardingTourProvider({
    userId,
    autoTriggerOnFirstLogin = true,
    steps = DEFAULT_TOUR_STEPS,
    children,
}: OnboardingTourProviderProps) {
    // Per-user completion flag. Anonymous (no userId) gets a
    // sentinel key so we don't auto-trigger before login.
    const t = useTranslations('onboardingTour');
    const completionKey = userId ? tourCompletionKey(userId) : 'inflect:onboarding-tour:anon';
    const [completion, setCompletion] = useLocalStorage<TourCompletionRecord | null>(
        completionKey,
        null,
    );
    const hasCompleted = useMemo(() => isTourCompleted(completion), [completion]);

    const [running, setRunning] = useState(false);
    // Hold a reference to the active driver instance so `dismiss`
    // and `unmount` can call `.destroy()`. Cleanup on unmount
    // matters when the user navigates mid-tour.
    type DriverInstance = { destroy: () => void } | null;
    const driverRef = useRef<DriverInstance>(null);

    // ── Lazy-loaded driver.js bootstrap ───────────────────────────────
    // Wrap the actual driver.js call in a function so the module
    // chunk stays out of the critical path until the user
    // actually runs the tour.
    const start = useCallback(async () => {
        if (running) return;
        if (typeof window === 'undefined') return;

        // Lazy import — chunk only loads when start() is called.
        const [{ driver }] = await Promise.all([
            import('driver.js'),
            // CSS side-effect import — typed via the explicit
            // `declare module 'driver.js/dist/driver.css'` in
            // `src/types/globals.d.ts`. No directive suppression
            // needed.
            import('driver.js/dist/driver.css'),
        ]);

        // The anchor a step points at is the first VISIBLE match outside
        // any overlay. On a phone the desktop sidebar is in the DOM but
        // hidden, and the navigation drawer the button sits in is a
        // dialog that closes as the tour starts — a tap on the popover is
        // outside it and would close it anyway, taking the highlighted
        // item with it. A step with no such anchor is dropped, as one
        // whose anchor is not on the page always was, so a phone's tour
        // is its centred steps.
        const anchors = new Map<string, Element>();
        const visibleSteps = filterStepsForCurrentPage(steps, (sel) => {
            const el = firstVisibleMatch(sel);
            if (el) anchors.set(sel, el);
            return el;
        });
        if (visibleSteps.length === 0) return;

        const driverObj = driver({
            showProgress: true,
            allowClose: true,
            popoverClass: 'inflect-onboarding-popover',
            ...tourChromeText(t),
            steps: visibleSteps.map((s) => ({
                element: s.selector ? anchors.get(s.selector) : undefined,
                popover: {
                    ...tourStepText(t, s),
                    side: s.side,
                },
            })),
            onDestroyStarted: () => {
                // User clicked Close (X) or hit Escape. Persist as
                // `skipped` so the auto-trigger doesn't fire again
                // even on a half-completed run.
                if (driverObj.hasNextStep()) {
                    setCompletion(makeCompletionRecord('skipped'));
                } else {
                    setCompletion(makeCompletionRecord('finished'));
                }
                driverObj.destroy();
            },
            onDestroyed: () => {
                setRunning(false);
                driverRef.current = null;
            },
        });

        driverRef.current = driverObj;
        setRunning(true);
        driverObj.drive();
    }, [running, setCompletion, steps, t]);

    const dismiss = useCallback(() => {
        setCompletion(makeCompletionRecord('skipped'));
    }, [setCompletion]);

    // ── Auto-trigger on first authenticated visit ────────────────────
    // Fires once per provider lifetime, after a short delay so
    // the page has time to paint its anchor elements. Skips when
    // the user has already completed/dismissed, when there's no
    // userId yet (still authenticating), or when autoTrigger is
    // disabled by the parent.
    const autoTriggerFiredRef = useRef(false);
    useEffect(() => {
        if (!autoTriggerOnFirstLogin) return;
        if (!userId) return;
        if (hasCompleted) return;
        if (autoTriggerFiredRef.current) return;
        autoTriggerFiredRef.current = true;
        const t = setTimeout(() => {
            void start();
        }, AUTO_TRIGGER_DELAY_MS);
        return () => clearTimeout(t);
    }, [autoTriggerOnFirstLogin, userId, hasCompleted, start]);

    // Cleanup on unmount — never leave a portal hanging.
    useEffect(() => {
        return () => {
            driverRef.current?.destroy();
        };
    }, []);

    const api = useMemo<OnboardingTourApi>(
        () => ({ start, dismiss, hasCompleted, running }),
        [start, dismiss, hasCompleted, running],
    );

    return (
        <OnboardingTourContext.Provider value={api}>
            {children}
        </OnboardingTourContext.Provider>
    );
}

// ─── The tour's words ─────────────────────────────────────────────────

/** A translator over the `onboardingTour` namespace. */
type TourT = ReturnType<typeof useTranslations>;

/**
 * driver.js's own chrome, in the reader's language. Its progress template
 * keeps driver.js's `{{current}}` / `{{total}}` placeholders, which the
 * catalogue's ICU `{current}` / `{total}` are filled with.
 */
export function tourChromeText(t: TourT) {
    return {
        nextBtnText: t('next'),
        prevBtnText: t('previous'),
        doneBtnText: t('done'),
        closeBtnLabel: t('close'),
        progressText: t('progress', { current: '{{current}}', total: '{{total}}' }),
    };
}

/** One step's heading and body. The closing step names the restart button by its label. */
export function tourStepText(t: TourT, step: OnboardingStep) {
    return {
        title: t(`steps.${step.messageKey}.title`),
        description: t(`steps.${step.messageKey}.body`, { startLabel: t('start') }),
    };
}

/**
 * Where a step never anchors: inert content, or anything inside a dialog —
 * a drawer, sheet or modal, which a tap on the popover (outside it) closes.
 * The phone's navigation drawer is one, and its items duplicate the
 * sidebar's.
 */
const NEVER_ANCHOR_IN = '[inert], [role="dialog"]';

/** The first match for `selector` that has a box on screen outside any overlay, or null. */
function firstVisibleMatch(selector: string): Element | null {
    for (const el of Array.from(document.querySelectorAll(selector))) {
        if (el.getClientRects().length > 0 && !el.closest(NEVER_ANCHOR_IN)) return el;
    }
    return null;
}

// ─── Sidebar trigger button ───────────────────────────────────────────

/**
 * Drop-in trigger for the sidebar footer. Renders a compact
 * link-styled button. Hidden when no provider is mounted (the
 * auth-gated app shell mounts the provider; the unauthenticated
 * /login page does not, so this button never renders there).
 */
export function StartTourButton({
    className,
    label,
    id = 'start-tour-btn',
    onStart,
}: {
    className?: string;
    label?: string;
    id?: string;
    /**
     * Called before the tour starts. The phone's navigation drawer passes its
     * close, so the tour is not run over a drawer that the first tap on the
     * popover would close.
     */
    onStart?: () => void;
}) {
    const ctx = useContext(OnboardingTourContext);
    const t = useTranslations('onboardingTour');
    if (!ctx) return null;
    return (
        <button
            type="button"
            onClick={() => {
                onStart?.();
                void ctx.start();
            }}
            disabled={ctx.running}
            className={
                className ??
                buttonVariants({ variant: 'ghost', size: 'sm', className: 'w-full text-xs justify-start' })
            }
            id={id}
            data-testid="start-tour-btn"
            data-tour-running={ctx.running ? 'true' : 'false'}
        >
            {label ?? t('start')}
        </button>
    );
}
