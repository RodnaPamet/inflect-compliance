/**
 * Vaul stub for the jsdom test project.
 *
 * Vaul's Drawer reads from the document scrolling-element + uses
 * pointer-event math (transform.match(...) + scroll-position-based
 * gestures) that crashes under React 19's stricter ref + pointer
 * lifecycle. The Modal primitive uses Vaul on mobile (matchMedia
 * mock falls through to "mobile" in jsdom), so every Modal test
 * transitively trips this incompatibility.
 *
 * Tests just want to render the modal content — they don't care
 * about the drawer's drag gestures. The mock below renders every
 * Drawer.* slot as a plain div so children are visible and
 * keyboard/click interactions still flow through.
 *
 * Re-evaluate this stub when:
 *   - Vaul ships a React 19 fix (track upstream).
 *   - Or we move Modal off Vaul.
 */

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";

// The real Vaul Drawer mounts a Radix Dialog under the hood — so
// any `<Drawer.Title>` etc. lives inside a valid Dialog context.
// The stub mirrors this: `Drawer.Root` is a Radix `Dialog.Root`,
// `Drawer.Portal` / `Drawer.Overlay` / `Drawer.Content` /
// `Drawer.Title` / `Drawer.Description` / `Drawer.Close` map to
// the matching Radix primitives. This way Modal renders in
// jsdom under React 19 without exercising Vaul's pointer-event
// math (which crashes on `transform.match(...)`).

interface RootProps {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: React.ReactNode;
    autoFocus?: boolean;
}

// vaul's Root takes `autoFocus` (default false) and its Content reads it
// from context; see Content below.
const AutoFocusContext = React.createContext(false);

function Root({ open, onOpenChange, children, autoFocus = false }: RootProps) {
    return (
        <AutoFocusContext.Provider value={autoFocus}>
            <Dialog.Root open={open} onOpenChange={onOpenChange}>
                {children}
            </Dialog.Root>
        </AutoFocusContext.Provider>
    );
}

function PassThroughDiv(
    props: React.HTMLAttributes<HTMLDivElement>,
) {
    return <div {...props} />;
}

// Vaul's drawers ignore Escape by default — they're closed via
// drag-to-dismiss / explicit close button, not the keyboard. The
// stub mirrors that so tests that assert "Escape blocked when
// preventDefaultClose is set" still pass: Radix Dialog.Content's
// `onEscapeKeyDown` defaults to closing; we preventDefault.
//
// Open auto-focus is mirrored too, because it is what a focus test is about:
// vaul 1.x calls the caller's `onOpenAutoFocus` and THEN prevents Radix's
// default unless the Root got `autoFocus`, so a drawer moves no focus on open
// unless the caller does it. A stub that let Radix focus the first tabbable
// would pass a "focus lands in the sheet" test that real vaul fails.
const Content = React.forwardRef<
    HTMLDivElement,
    React.ComponentProps<typeof Dialog.Content>
>(function VaulContent(props, ref) {
    const autoFocus = React.useContext(AutoFocusContext);
    return (
        <Dialog.Content
            // Real vaul tags its surface this way; a test can then tell the
            // drawer branch from the desktop Dialog one.
            data-vaul-drawer=""
            ref={ref}
            {...props}
            onOpenAutoFocus={(e) => {
                props.onOpenAutoFocus?.(e);
                if (!autoFocus) e.preventDefault();
            }}
            onEscapeKeyDown={(e) => {
                e.preventDefault();
                props.onEscapeKeyDown?.(e);
            }}
        />
    );
});

export const Drawer = {
    Root,
    Portal: Dialog.Portal,
    Trigger: Dialog.Trigger,
    Content,
    Title: Dialog.Title,
    Description: Dialog.Description,
    Overlay: Dialog.Overlay,
    Close: Dialog.Close,
    Handle: PassThroughDiv,
    NestedRoot: Root,
};
