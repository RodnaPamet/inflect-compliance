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
 * From `md` up toasts render TOP-right (`sonner`, `src/app/providers.tsx`),
 * so the Epic 67 undo toasts and their countdown bars cannot collide with
 * this. Below `md` they render bottom-centre — and below `md` this button is
 * not rendered at all (see the next section). Mobile navigation is a drawer
 * (`MobileNavDrawer`), not a persistent bottom bar, and `src/components/layout`
 * has no other fixed bottom-anchored element.
 *
 * ═══ NOT ON A PHONE (#5813, owner decision 2026-11-22) ═══
 *
 * Below `md` the floating button is hidden and the assistant opens from an
 * icon in the top bar beside the bell (`AssistantTopBarButton`). A button
 * fixed over a 360px page covered the last row of a list, a select, a form's
 * primary action — and the shell reserves no space for it, so scrolling to
 * the end did not uncover what lay underneath. The sheet is still mounted
 * HERE, once, whichever of the two opened it: both drive the same shared open
 * state, so there is one sheet and one conversation.
 *
 * ═══ NOT ON THE AUTH GATE ═══
 *
 * `/t/<slug>/auth/*` (the MFA challenge) renders inside the tenant app
 * layout, so this mounted there too. A person who has not finished signing
 * in has nothing to ask the assistant about, and the server would refuse the
 * turn. The launcher neither renders nor registers there, so the top-bar icon
 * and the palette entry — which follow the registration — vanish with it.
 *
 * ═══ Z-ORDER ═══
 *
 * `z-30`, which is BELOW the `z-40` used by both the Sheet overlay
 * (`sheet.tsx`) and the Modal overlay (`modal.tsx`). A floating button
 * sitting over an open confirm dialog is a misclick waiting to happen, and
 * the numbers are read off those two files rather than picked to look low.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Sparkle3, Xmark } from '@inflect/ui/components/ui/icons/glyphs';

import { Button } from '@/components/ui/button';
import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';
import { useTenantContext } from '@/lib/tenant-context-provider';

import { useAssistantOpen } from './assistant-open-context';

/**
 * The sheet loads on first use, not with the page (#5054).
 *
 * This launcher is mounted by the tenant layout, so whatever it imports
 * statically is First Load JS on EVERY tenant page, whether or not the person
 * ever opens the assistant. The sheet (the textarea, the stream reducer, the
 * history window) is most of that, and adding the multi-line input and
 * history to it put the heaviest tenant page over its bundle budget. So it is
 * fetched the first time the assistant opens, warmed when the pointer reaches
 * the launcher or it takes focus, and then stays mounted: closing and
 * reopening keeps the conversation exactly as before.
 */
const loadAssistantSheet = () => import('./AssistantSheet');
const AssistantSheet = dynamic(() => loadAssistantSheet().then((m) => m.AssistantSheet), {
    ssr: false,
    loading: () => null,
});

/**
 * Warm the sheet's chunk. Exported for the top-bar entry point, which warms it
 * on pointer-enter and focus exactly as the floating button does.
 */
export function warmAssistantSheet(): void {
    void loadAssistantSheet();
}

/**
 * The routes inside the tenant app layout where no assistant entry point is
 * offered: the sign-in gates under `/t/<slug>/auth/` (the MFA challenge).
 * See the header.
 */
const AUTH_GATE_PATH = /^\/t\/[^/]+\/auth(?:\/|$)/;

export function isAssistantSuppressedPath(pathname: string | null): boolean {
    return pathname != null && AUTH_GATE_PATH.test(pathname);
}

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
    const { open, setOpen, setAvailable, returnFocusRef } = useAssistantOpen();
    const pathname = usePathname();
    const launcherRef = useRef<HTMLButtonElement>(null);
    const labelId = useId();
    // Once opened, by the button, the shortcut or the command palette, the
    // sheet stays mounted for the rest of the visit. Set during render, the
    // documented way to derive state from a prop change.
    const [sheetMounted, setSheetMounted] = useState(false);
    if (open && !sheetMounted) setSheetMounted(true);
    const warmSheet = useCallback(() => {
        warmAssistantSheet();
    }, []);

    // Tell the palette the assistant exists. This component only mounts when
    // the kill switch is on, so registering here means the palette entry
    // follows the button's real presence instead of re-deriving the gate from
    // a flag it cannot read.
    //
    // Only for a viewer who may USE it (#5171): a READER is never rendered the
    // launcher, so registering for them put "Ask the assistant" in the palette
    // and bound mod+shift+A to a sheet the server refuses them.
    // ...and never on the sign-in gate (see the header).
    const canUse = permissions.canWrite && !isAssistantSuppressedPath(pathname);
    useEffect(() => {
        if (!canUse) return;
        setAvailable(true);
        return () => setAvailable(false);
    }, [setAvailable, canUse]);

    const close = useCallback(() => {
        setOpen(false);
        // Focus returns to where it came from: the top-bar icon when that
        // opened it (it records itself in `returnFocusRef`), otherwise this
        // launcher. Without this a keyboard user lands back at the top of the
        // document and has to traverse the whole page to get anywhere.
        const returnTo = returnFocusRef.current?.isConnected
            ? returnFocusRef.current
            : launcherRef.current;
        returnFocusRef.current = null;
        returnTo?.focus();
    }, [setOpen, returnFocusRef]);

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
        // Disabled rather than skipped, so the hook order holds: a READER gets
        // no binding and no entry in the shortcut list (#5171).
        { description: t('shortcutDescription'), enabled: canUse },
    );

    // AFTER every hook, never before: an early return above them changes the
    // hook call order between renders, which React refuses.
    if (!canUse) return null;

    return (
        <>
            <div
                // The wrapper carries the safe-area inset as PADDING while the
                // offsets stay at 0 (#3837). A hardcoded `bottom-4` lands under
                // the iOS home indicator; padding that resolves to 0px on
                // desktop is correct in both places without a media query.
                //
                // `hidden md:block`: no floating button on a phone (#5813) —
                // the top bar carries the entry point there.
                className="fixed bottom-0 right-0 z-30 hidden p-4 md:block"
                style={{
                    paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
                    paddingRight: 'calc(1rem + env(safe-area-inset-right, 0px))',
                }}
            >
                <Button
                    ref={launcherRef}
                    type="button"
                    variant="primary"
                    onClick={() => {
                        // Opened from here, so focus comes back here.
                        returnFocusRef.current = null;
                        toggle();
                    }}
                    onPointerEnter={warmSheet}
                    onFocus={warmSheet}
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

            {sheetMounted && <AssistantSheet open={open} onClose={close} titleId={labelId} />}
        </>
    );
}
