'use client';

/**
 * The always-on assistant launcher (#3835-#3837, #3839, #3840, #3842, #3843).
 *
 * ═══ WHY IT LIVES IN `AppShell` AND NOT `AppShellFrame` ═══
 *
 * The frame's docstring reads "The app shell's FRAME — layout, drawer state,
 * collapse state. No content", and T07 of #3003 split it out precisely
 * because product decisions had accumulated there: "A product vendoring
 * these files byte-identical had to carry a diff through all of it." An
 * assistant launcher is product content. Mounting it in the frame would
 * reintroduce exactly what that split fixed.
 *
 * Mounting in `AppShell` is also what puts it on every authenticated page
 * with no per-page wiring — and, because `AppShell` is only rendered by the
 * tenant and org app layouts, it is structurally absent from the public
 * trust-center and every unauthenticated route rather than hidden there by a
 * runtime check that could be got wrong.
 *
 * ═══ THE CORNER IS FREE — VERIFIED, NOT ASSUMED ═══
 *
 * Toasts render TOP-right (`sonner`, `src/app/providers.tsx`), so the Epic 67
 * undo toasts and their countdown bars cannot collide with this. Mobile
 * navigation is a drawer (`MobileNavDrawer`), not a persistent bottom bar,
 * and `src/components/layout` has no other fixed bottom-anchored element.
 *
 * ═══ Z-ORDER ═══
 *
 * `z-30`, which is BELOW the `z-40` used by both the Sheet overlay
 * (`sheet.tsx`) and the Modal overlay (`modal.tsx`). A floating button
 * sitting over an open confirm dialog is a misclick waiting to happen, and
 * the numbers are read off those two files rather than picked to look low.
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import { useTranslations } from 'next-intl';
// Nucleo is the canonical icon family — `tests/guards/no-lucide.test.ts`
// treats a new lucide import site as a regression and says so: "Migrate the
// icon to Nucleo ... Adding to LEGACY_LUCIDE_USERS requires a written reason
// AND confirmation that no Nucleo equivalent exists." Both of these have one.
import { Sparkle3, Xmark } from '@inflect/ui/components/ui/icons/nucleo';

import { Button } from '@/components/ui/button';
import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';
import { useTenantContext } from '@/lib/tenant-context-provider';

import { useAssistantOpen } from './assistant-open-context';
import { AssistantSheet } from './AssistantSheet';

export function AssistantLauncher() {
    const t = useTranslations('assistant');
    // The ROLE half of the gate.
    //
    // `enforceFeatureGate`'s predicate 3 is `ctx.permissions.canWrite` —
    // Editor, Admin or Owner. A READER is refused every time, so the button is
    // not shown to one.
    //
    // ═══ WHEN TO HIDE AND WHEN TO EXPLAIN ═══
    //
    // The distinction this draws, and the reason the plan gate is deliberately
    // NOT here:
    //
    //   · ALWAYS refused for this user — the master switch off, the feature
    //     off, the role insufficient — nothing they do in this session changes
    //     it, so a button is a trap. Hide it.
    //   · Refused for a reason that can CHANGE or that they can act on — the
    //     plan entitlement — hide it and the feature is undiscoverable to
    //     someone who could buy it. Show it and let the refusal say why
    //     (#3849).
    //
    // The route permission is `controls.view`, which admits a reader, on the
    // reasoning that proposing is reader-safe because it only queues. That
    // reasoning is about the TRANSPORT; the feature gate is stricter, and
    // where the two disagree the gate wins because it is what actually
    // refuses. Noted rather than changed: loosening predicate 3 is a product
    // decision about who may use AI, not a wiring fix.
    const { permissions } = useTenantContext();
    // Shared with the command palette rather than local — see
    // `assistant-open-context.tsx` for why the state cannot live here.
    const { open, setOpen, setAvailable } = useAssistantOpen();
    const launcherRef = useRef<HTMLButtonElement>(null);
    const labelId = useId();

    // Tell the palette the assistant exists. This component only mounts when
    // the kill switch is on, so registering here means the palette entry
    // follows the button's real presence instead of re-deriving the gate from
    // a flag it cannot read.
    useEffect(() => {
        setAvailable(true);
        return () => setAvailable(false);
    }, [setAvailable]);

    const close = useCallback(() => {
        setOpen(false);
        // Focus returns to the launcher, which is where it came from. Without
        // this a keyboard user lands back at the top of the document and has
        // to traverse the whole page to get anywhere.
        launcherRef.current?.focus();
    }, [setOpen]);

    const toggle = useCallback(() => {
        if (open) {
            close();
        } else {
            setOpen(true);
        }
    }, [open, close, setOpen]);

    // Epic 57: through the registry, with a `description`, so it appears in the
    // shortcut list like every other binding. Never
    // `document.addEventListener('keydown', …)`.
    //
    // `allowWhenOverlayOpen` is deliberately NOT set: while a modal is open the
    // user is in the middle of something, and opening a side panel over it is
    // not what the keystroke should do.
    useKeyboardShortcut(
        'mod+shift+a',
        () => {
            toggle();
        },
        { description: t('shortcutDescription') },
    );

    // AFTER every hook, never before: an early return above them changes the
    // hook call order between renders, which React refuses. The shortcut
    // registration is harmless for a reader because the button it toggles is
    // not rendered — and `useKeyboardShortcut` is in the registry either way,
    // which is the lesser of the two wrongs available at this position.
    if (!permissions.canWrite) return null;

    return (
        <>
            <div
                // The wrapper carries the safe-area inset as PADDING while the
                // offsets stay at 0 (#3837). A hardcoded `bottom-4` lands under
                // the iOS home indicator; padding that resolves to 0px on
                // desktop is correct in both places without a media query.
                className="fixed bottom-0 right-0 z-30 p-4"
                style={{
                    paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
                    paddingRight: 'calc(1rem + env(safe-area-inset-right, 0px))',
                }}
            >
                <Button
                    ref={launcherRef}
                    type="button"
                    variant="primary"
                    onClick={toggle}
                    // While the window is open this button IS the close
                    // affordance, rather than a second control competing with
                    // the sheet's own dismissal.
                    aria-label={open ? t('closeLauncher') : t('openLauncher')}
                    aria-expanded={open}
                    aria-haspopup="dialog"
                    data-testid="assistant-launcher"
                    className={[
                        // Round, 48px: a comfortable touch target that stays
                        // inside the 44px floor on a phone.
                        'h-12 w-12 rounded-full p-0',
                        'flex items-center justify-center',
                        // A VISIBLE focus state, not just the browser default
                        // that a custom background can swallow.
                        'focus-visible:outline-none focus-visible:ring-2',
                        'focus-visible:ring-border-focus focus-visible:ring-offset-2',
                        'focus-visible:ring-offset-bg-page',
                        // Motion is opt-out per #3842: `motion-reduce` drops the
                        // transition, not the state change, so the button still
                        // responds — it just does not animate.
                        //
                        // No grow-on-hover. The motion-language ratchet bans
                        // hover transforms outside its exempt list, and the
                        // effect was decoration — the Button variant already
                        // carries its own hover treatment.
                        'transition-colors motion-reduce:transition-none',
                    ].join(' ')}
                >
                    {open ? (
                        <Xmark className="h-5 w-5" aria-hidden="true" />
                    ) : (
                        <Sparkle3 className="h-5 w-5" aria-hidden="true" />
                    )}
                </Button>
            </div>

            <AssistantSheet open={open} onClose={close} titleId={labelId} />
        </>
    );
}
