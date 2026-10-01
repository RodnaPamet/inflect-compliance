'use client';

/**
 * The phone navigation drawer, on the shared left Sheet.
 *
 * T07 of #3003, and an owner-approved behaviour change. What stood here
 * was a hand-rolled drawer: its own backdrop, its own panel, its own
 * `inert` bookkeeping — a second overlay implementation living beside
 * the Sheet primitive and drifting from it. T03 added
 * `direction="left"` to Sheet for exactly this, so the drawer now slides
 * in from the edge the nav rail occupies rather than arriving from the
 * opposite side.
 *
 * THE CONVERSION IS NOT A DROP-IN, and most of this file is the reason.
 * The hand-rolled version had earned four behaviours; a bare
 * `<Sheet direction="left">` keeps one of them. Each of the other three
 * is reinstated here deliberately:
 *
 *   ESCAPE stays on the shared shortcut system. Vaul closes on Escape by
 *     itself, which would have been the easy answer and the wrong one:
 *     its handler is unconditional, so it cannot respect precedence
 *     against the other Escape bindings that may be live (selection
 *     clear, filter clear), and a contributor grepping for shortcut
 *     sources would no longer find this one. So vaul's is suppressed via
 *     `onEscapeKeyDown` and the binding is registered at
 *     `scope: 'overlay'`, priority 5 — above selection clear (2) and
 *     filter clear (1), below any modal stacked over the drawer. The
 *     scope works unchanged because Sheet's own backdrop already carries
 *     the `data-sheet-overlay` marker the scope reads.
 *
 *   FOCUS RETURN is explicit, not inherited. A probe of a controlled
 *     Sheet (open from a button, Escape to close) left focus on neither
 *     the opener nor `<body>`, so the primitive cannot be relied on for
 *     it here. Note this is VAUL, not a Radix Dialog — the Radix
 *     `onCloseAutoFocus` mechanism that T03 fixed for Modal does not
 *     apply, and should not be assumed to. The opener is captured at
 *     open time and restored on close, guarded so focus is only reclaimed
 *     when the drawer is the thing that lost it.
 *
 *   ROUTE-CHANGE CLOSE moved UP to `AppShellFrame`, which owns the open
 *     state. It is not missing; it is one level out, where the state it
 *     mutates lives.
 *
 * The fourth — `inert` while closed — is the one Sheet genuinely
 * replaces: the panel is portalled and unmounted rather than parked
 * off-screen, so there is nothing closed to make inert.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Sheet } from '@/components/ui/sheet';
import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';

export interface MobileNavDrawerProps {
    open: boolean;
    onClose: () => void;
    children: ReactNode;
}

export function MobileNavDrawer({ open, onClose, children }: MobileNavDrawerProps) {
    const tn = useTranslations('nav');

    useKeyboardShortcut('Escape', onClose, {
        enabled: open,
        scope: 'overlay',
        priority: 5,
        description: 'Close navigation drawer',
    });

    // Return focus to whatever opened the drawer.
    //
    // The opener is captured rather than passed in: the trigger lives in a
    // sibling component (the top bar's hamburger), and threading a ref from
    // there to here would couple two components that otherwise share only
    // `open` and `onClose`. `document.activeElement` at the moment of opening
    // is the same element on every path that can open this.
    const openerRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        if (open) {
            openerRef.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
            return;
        }
        const opener = openerRef.current;
        openerRef.current = null;
        // Only reclaim focus the drawer is actually losing. On first mount —
        // and on any close the user did not trigger from inside the panel —
        // focus is somewhere legitimate and stealing it would be its own bug.
        if (opener && opener.isConnected && document.activeElement === document.body) {
            opener.focus();
        }
    }, [open]);

    return (
        <Sheet
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            direction="left"
            // Also passed on the root so the dialog has an accessible name
            // even if a future refactor drops the header.
            title={tn('openNavigationMenu')}
            // No `data-testid` here: vaul's `ContentProps` does not admit one,
            // and the panel is better found by its accessible NAME — which is
            // the thing a screen-reader user navigates by, so a test that
            // queries it exercises the same handle the user has.
            contentProps={{
                // Suppress vaul's own Escape so the shared binding above is
                // the single handler. Without this both fire: harmless today
                // (they agree), but it puts a second, precedence-blind closer
                // on a key the app arbitrates centrally.
                onEscapeKeyDown: (event) => event.preventDefault(),
            }}
        >
            {/* The header is here for the CLOSE BUTTON, not the heading.
                Body-only was the first shape and it left the panel with no
                visible way out: Escape, a backdrop tap and a swipe all work,
                but none of them is an affordance a user can SEE, and the
                drawer this replaces had a close button — `sidebar-state-language`
                asserts it has a focus-visible ring, which Sheet's does.
                The title doubles as the panel's visible name; it is the same
                string the root passes for the accessible name, so the two
                cannot drift. */}
            <Sheet.Header title={tn('openNavigationMenu')} />
            <Sheet.Body>
                {/* `nav-drawer` is a CONTRACT, not decoration. The drawer this
                    replaced carried it on its panel and `tests/e2e/
                    responsive.spec.ts` scopes its nav-item queries through it;
                    dropping it took that spec from passing to "element(s) not
                    found" on all three attempts. It sits on a wrapper inside
                    the body because vaul's `ContentProps` does not admit a
                    `data-*` attribute on `Drawer.Content` itself. */}
                <div data-testid="nav-drawer">{children}</div>
            </Sheet.Body>
        </Sheet>
    );
}
