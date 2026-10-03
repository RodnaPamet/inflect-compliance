"use client";

/**
 * Epic 54 — canonical responsive Modal.
 *
 * The single source of truth for modal dialogs across the app. Page
 * authors compose this primitive for every create/edit/confirm flow;
 * do not build bespoke overlays with `fixed inset-0 bg-black/60`.
 *
 * Architecture:
 *   - Radix Dialog on desktop (focus trap, `inert`, Escape, portal).
 *   - Vaul Drawer on mobile (drag-to-dismiss, native feel).
 *   - One controlled `showModal` / `setShowModal` pair opens either.
 *   - Structured slots: `<Modal.Header>`, `<Modal.Body>`, `<Modal.Footer>`,
 *     `<Modal.Actions>`, `<Modal.Close>`. The body scrolls independently
 *     so long forms never trap the header/footer offscreen.
 *
 * Design-token alignment:
 *   - Every surface / text / border class is a semantic token; the Epic 51
 *     theme toggle flips the modal in lock-step with the rest of the app.
 *
 * Accessibility:
 *   - Always ships a `Dialog.Title` — either the `<Modal.Header title=…>`
 *     the consumer renders, or a visually-hidden fallback using the
 *     `title` prop. Radix refuses to mount without a title, so the
 *     fallback also prevents runtime warnings.
 *   - `description` is wired to `aria-describedby`.
 *   - Floating close button carries `aria-label="Close"` and focus-visible
 *     ring via the shared `focus-visible:ring-ring` token.
 *   - Radix's own open/close auto-focus is left in place: focus moves INTO
 *     the dialog on open and back to the trigger on close. `preventAutoFocus`
 *     opts a caller out of both.
 *   - Escape, backdrop click, and drag-to-dismiss all route through the
 *     same `closeModal` path so `preventDefaultClose` works for unsaved-
 *     state guards regardless of surface.
 */

import { cn } from "@/lib/cn";
import * as Dialog from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, Info, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
    ComponentProps,
    Dispatch,
    FormEventHandler,
    ReactNode,
    SetStateAction,
    useRef,
    useState,
    type HTMLAttributes,
} from "react";
import { Drawer } from "vaul";
import { Button } from "./button";
import { useMediaQuery } from "./hooks";
import { OverlayDepthProvider } from "./overlay-depth";
import { ProgressiveBlur } from "./progressive-blur";
import { Tooltip } from "./tooltip";
import { Heading } from '@/components/ui/typography';
import {
    keyboardAvoidanceStyle,
    useKeyboardInset,
} from "@/lib/hooks/use-keyboard-inset";

// ─── Size variants ──────────────────────────────────────────────────

const modalContentVariants = cva(
    [
        // Base layout: centred, full-width on small screens, capped height
        // with independent body scroll. Header/footer pinned via the slot
        // components below.
        "fixed inset-0 z-40 m-auto h-fit w-full",
        "flex max-h-[min(85vh,680px)] flex-col",
        // B3 — brand-tinted focal-glow texture + elegant border + glass-edge
        // highlight (the class provides bg, border, and shadow; see
        // globals.css `.surface-popup-texture`).
        "surface-popup-texture text-content-emphasis",
        "p-0 sm:rounded-lg",
        // Tier-2 "fly-in" entrance + snappy exit (see tailwind.config.js).
        // State-gated so Radix's Presence runs the exit animation on close
        // before unmounting — the panel pops in on open, shrinks away on
        // dismiss. prefers-reduced-motion flattens both to 1ms (tokens.css).
        "scrollbar-hide overflow-hidden",
        "data-[state=open]:animate-modal-fly-in data-[state=closed]:animate-modal-fly-out",
    ],
    {
        variants: {
            size: {
                // Confirm dialogs — tight, centred, quick to read.
                xs: "max-w-sm",
                // Small forms (1-3 fields).
                sm: "max-w-md",
                // Default CRUD forms.
                md: "max-w-lg",
                // Longer forms / side-by-side inputs.
                lg: "max-w-2xl",
                // Data-entry panels with lots of content.
                xl: "max-w-4xl",
                // Full-width on desktop (rare — use Sheet instead).
                full: "max-w-[calc(100vw-2rem)]",
            },
        },
        defaultVariants: {
            size: "md",
        },
    },
);

// ─── Responsive presentation helper (exported) ──────────────────────

export type ModalPresentation = "dialog" | "drawer";

/**
 * Resolve the presentation surface for a modal given the viewport and
 * caller preferences. Exported so advanced consumers (sheets, custom
 * overlays) can share the exact decision logic.
 */
export function resolveModalPresentation(opts: {
    isMobile: boolean;
    desktopOnly?: boolean;
}): ModalPresentation {
    if (opts.desktopOnly) return "dialog";
    return opts.isMobile ? "drawer" : "dialog";
}

// ─── Props ──────────────────────────────────────────────────────────

export interface ModalProps extends VariantProps<typeof modalContentVariants> {
    children: ReactNode;
    /** Additional class for the Dialog.Content / Drawer.Content surface. */
    className?: string;
    /** Controlled open state. Omit both to use the intercepting-route pattern. */
    showModal?: boolean;
    setShowModal?: Dispatch<SetStateAction<boolean>>;
    /** Fires before the close happens (both surfaces). */
    onClose?: () => void;
    /** Force dialog even on mobile (rare — drops drag-to-dismiss). */
    desktopOnly?: boolean;
    /** Ignore backdrop / Escape closes unless the user drags on mobile. */
    preventDefaultClose?: boolean;
    drawerRootProps?: ComponentProps<typeof Drawer.Root>;
    // ── A11y ──
    /** Accessible name for the dialog. Required for screen readers. */
    title?: string;
    /** Longer description; becomes `aria-describedby` content. */
    description?: string;
    /** Render a floating close button on desktop. Default: true. */
    showCloseButton?: boolean;
    /**
     * Opt out of Radix's open/close auto-focus. On the desktop Dialog that is
     * both halves; on the phone drawer, which vaul already keeps from moving
     * focus in, it is the return to the opener on close.
     *
     * The default — Radix's own behaviour — is what a dialog owes a keyboard
     * user: focus moves into the dialog on open and returns to the trigger on
     * close. This primitive used to prevent BOTH unconditionally, so focus
     * stayed on the page behind the overlay and a screen-reader user was never
     * told the dialog had opened.
     *
     * Set this only when the content manages focus itself and Radix's first
     * pass would fight it.
     */
    preventAutoFocus?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────

function ModalRoot({
    children,
    className,
    size,
    showModal,
    setShowModal,
    onClose,
    desktopOnly,
    preventDefaultClose,
    drawerRootProps,
    title,
    description,
    showCloseButton = true,
    preventAutoFocus = false,
}: ModalProps) {
    const t = useTranslations("common");
    const router = useRouter();
    const { isMobile } = useMediaQuery();

    // The mobile drawer caps its height at `max-h-[92vh]` — the LAYOUT
    // viewport, which does not shrink when the soft keyboard opens. Any field
    // near the bottom of a long form then sits behind the keyboard.
    const keyboard = useKeyboardInset();

    // The control the dialog was opened from, so focus can go back to it. See
    // restoreOpener for why Radix cannot do this for us.
    const restoreFocusRef = useRef<HTMLElement | null>(null);

    // ─── Focus, both halves, on BOTH surfaces ───────────────────────────
    //
    // This primitive used to pass `(e) => e.preventDefault()` to both
    // auto-focus events unconditionally, which broke the two halves of a
    // dialog's focus contract at once: focus never entered the dialog (so a
    // keyboard user's next Tab continued through the page behind the overlay,
    // and a screen reader announced nothing), and it never came back on close
    // (so dismissing a dialog dropped the user at the top of the document).
    //
    // The historical reason given was "so cmdk / filter popovers keep focus
    // control". Neither needs it: the command palette mounts its own Radix
    // Dialog and handles onOpenAutoFocus itself, and <Popover> takes
    // onOpenAutoFocus / onCloseAutoFocus as props. The tooltip flicker it also
    // guarded against is handled at the source — <Tooltip> gates its
    // focus-open on `:focus-visible`, so programmatic focus does not pop a
    // tooltip.
    //
    // Both handlers go on the desktop Dialog.Content AND the phone
    // Drawer.Content. Vaul's Drawer.Content is a Radix Dialog.Content
    // underneath, so it fires the same two events, and it has the same
    // missing trigger, so it lost focus to <body> on close exactly as the
    // Dialog did before it got this handler.
    const recordOpener = (event: Event) => {
        // Radix's FocusScope reads the outgoing `document.activeElement` and
        // THEN dispatches this event, so focus has not moved yet: this is
        // still the control the user opened the dialog from. Recorded here
        // because the close handler below has to put it back by hand.
        restoreFocusRef.current =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        // On the drawer, vaul then prevents the open half itself unless its
        // Root gets `autoFocus`; that is vaul's call and left alone here.
        if (preventAutoFocus) event.preventDefault();
    };
    const restoreOpener = (event: Event) => {
        // Not simply "let Radix do it". Radix's own onCloseAutoFocus
        // preventDefaults unconditionally and focuses `context.triggerRef` —
        // i.e. <Dialog.Trigger> / <Drawer.Trigger>, which a CONTROLLED modal
        // never renders. That ref is null for all 76 of this primitive's call
        // sites, so focus lands on <body>, and FocusScope's own correct restore
        // is suppressed by the same preventDefault. Merely removing our
        // handler therefore fixes the open half and leaves the close half
        // exactly as broken.
        //
        // So claim the event (our handler runs first, and
        // composeEventHandlers skips Radix's once the default is prevented)
        // and do the restore ourselves.
        event.preventDefault();
        if (preventAutoFocus) return;
        const target = restoreFocusRef.current;
        // An intercepting-route modal's trigger can be gone by now; focusing a
        // detached node is a silent no-op, so check rather than pretend it
        // worked.
        if (target?.isConnected) target.focus();
    };

    const closeModal = ({ dragged }: { dragged?: boolean } = {}) => {
        if (preventDefaultClose && !dragged) return;
        onClose?.();
        if (setShowModal) setShowModal(false);
        else router.back();
    };

    const presentation = resolveModalPresentation({ isMobile, desktopOnly });

    const fallbackDialogTitle = (
        <VisuallyHidden.Root>
            <Dialog.Title>{title ?? t("ui.dialog")}</Dialog.Title>
            <Dialog.Description>{description ?? ""}</Dialog.Description>
        </VisuallyHidden.Root>
    );
    const fallbackDrawerTitle = (
        <VisuallyHidden.Root>
            <Drawer.Title>{title ?? t("ui.dialog")}</Drawer.Title>
            <Drawer.Description>{description ?? ""}</Drawer.Description>
        </VisuallyHidden.Root>
    );

    if (presentation === "drawer") {
        return (
            <Drawer.Root
                open={setShowModal ? showModal : true}
                onOpenChange={(open) => {
                    if (!open) closeModal({ dragged: true });
                }}
                {...drawerRootProps}
            >
                <Drawer.Portal>
                    <Drawer.Overlay
                        data-modal-overlay
                        className="fixed inset-0 z-50 bg-bg-overlay backdrop-blur"
                    />
                    <Drawer.Content
                        // Back to the opener on close, as on desktop: see
                        // recordOpener / restoreOpener above.
                        onOpenAutoFocus={recordOpener}
                        onCloseAutoFocus={restoreOpener}
                        onPointerDownOutside={(e) => {
                            if (
                                e.target instanceof Element &&
                                e.target.closest("[data-sonner-toast]")
                            ) {
                                e.preventDefault();
                            }
                        }}
                        // KEYBOARD AVOIDANCE. `max-h-[92vh]` below is the
                        // LAYOUT viewport, which does not shrink when the soft
                        // keyboard opens — so the bottom of this sheet, and any
                        // input in it, ends up BEHIND the keyboard. This caps to
                        // what is actually visible. See use-keyboard-inset.ts.
                        style={keyboardAvoidanceStyle(keyboard)}
                        className={cn(
                            "fixed bottom-0 left-0 right-0 z-50 flex flex-col",
                            // Mobile drawer shares the desktop modal's
                            // focal-glow texture (background + border +
                            // glass edge) for parity — replaces the flat
                            // bg-bg-default/border-border-subtle.
                            "surface-popup-texture max-h-[92vh] rounded-t-[10px] text-content-emphasis",
                            className,
                        )}
                    >
                        <DrawerHandle />
                        {fallbackDrawerTitle}
                        <div
                            data-modal-body-wrapper
                            className="flex flex-1 flex-col overflow-hidden rounded-t-[10px] bg-inherit"
                        >
                            {/* Mobile modal IS a drawer. A Combobox rendered in
                                here must not open a second one. */}
                            <OverlayDepthProvider>
                                {children}
                            </OverlayDepthProvider>
                        </div>
                    </Drawer.Content>
                </Drawer.Portal>
            </Drawer.Root>
        );
    }

    return (
        <Dialog.Root
            open={setShowModal ? showModal : true}
            onOpenChange={(open) => {
                if (!open) closeModal();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay
                    id="modal-backdrop"
                    data-modal-overlay
                    className="data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out fixed inset-0 z-40 bg-bg-overlay backdrop-blur-md"
                />
                <Dialog.Content
                    // Focus in on open, back to the opener on close: see
                    // recordOpener / restoreOpener above.
                    onOpenAutoFocus={recordOpener}
                    onCloseAutoFocus={restoreOpener}
                    onPointerDownOutside={(e) => {
                        if (
                            e.target instanceof Element &&
                            e.target.closest("[data-sonner-toast]")
                        ) {
                            e.preventDefault();
                        }
                    }}
                    className={cn(modalContentVariants({ size }), className)}
                >
                    {fallbackDialogTitle}
                    {children}
                    {showCloseButton && !preventDefaultClose ? (
                        <Tooltip content={t("close")} shortcut="Esc">
                            <Dialog.Close asChild>
                                <button
                                    type="button"
                                    aria-label={t("close")}
                                    className="absolute right-3 top-3 rounded-md p-1.5 text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    data-modal-close
                                >
                                    <X className="size-4" />
                                </button>
                            </Dialog.Close>
                        </Tooltip>
                    ) : null}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

// ─── Structured slots ───────────────────────────────────────────────

function DrawerHandle() {
    return (
        <div className="sticky top-0 z-20 flex shrink-0 items-center justify-center rounded-t-[10px] bg-inherit">
            <div className="my-3 h-1 w-12 rounded-full bg-border-emphasis" />
        </div>
    );
}

/**
 * Pinned header. Rendering this automatically declares the Dialog.Title
 * (so you don't need `title=` on <Modal>). Long body content scrolls
 * underneath the header stays visible.
 */
function Header({
    title,
    description,
    className,
    children,
    ...rest
}: HTMLAttributes<HTMLDivElement> & {
    title?: ReactNode;
    description?: ReactNode;
}) {
    return (
        <div
            data-modal-header
            className={cn(
                "flex shrink-0 flex-col gap-1 border-b border-border-subtle px-5 py-4",
                className,
            )}
            {...rest}
        >
            {title ? (
                <Dialog.Title asChild>
                    <Heading level={2}>
                        {title}
                    </Heading>
                </Dialog.Title>
            ) : null}
            {description ? (
                <Dialog.Description asChild>
                    <p className="text-sm text-content-muted">{description}</p>
                </Dialog.Description>
            ) : null}
            {children}
        </div>
    );
}

/**
 * Scrollable content area. The body takes the remaining height between
 * pinned header and footer so long forms scroll inside the modal without
 * the overlay itself scrolling.
 */
type ProgressiveBlurEdge = boolean | "top" | "bottom" | "both";

interface BodyProps extends HTMLAttributes<HTMLDivElement> {
    /**
     * Epic 64 — paint a `<ProgressiveBlur>` overlay at the body's
     * scroll edge so long content tapers off rather than abruptly
     * cutting at the footer. `true` shorthand = `"both"`.
     *
     * Off by default to keep every existing call site visually
     * unchanged. Opt in on long-form modals (linked-items lists,
     * scrollable forms) where the affordance materially helps.
     */
    progressiveBlur?: ProgressiveBlurEdge;
}

function Body({ className, progressiveBlur = false, children, ...rest }: BodyProps) {
    if (!progressiveBlur) {
        return (
            <div
                data-modal-body
                className={cn(
                    "scrollbar-thin flex-1 overflow-y-auto px-5 py-4 text-sm text-content-default",
                    className,
                )}
                {...rest}
            >
                {children}
            </div>
        );
    }
    const edge = progressiveBlur === true ? "both" : progressiveBlur;
    return (
        <div
            data-modal-body
            data-modal-body-progressive-blur={edge}
            className={cn(
                "scrollbar-thin relative flex-1 overflow-y-auto px-5 py-4 text-sm text-content-default",
                className,
            )}
            {...rest}
        >
            {children}
            <ProgressiveBlur side={edge} size="3rem" />
        </div>
    );
}

/**
 * Pinned footer — typically holds `<Modal.Actions>` or bespoke buttons.
 */
function Footer({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            data-modal-footer
            className={cn(
                "flex shrink-0 items-center justify-end gap-tight border-t border-border-subtle px-5 py-3",
                className,
            )}
            {...rest}
        />
    );
}

/**
 * Conventional "Cancel | Save" action row. Wraps children in a footer so
 * callers don't need to compose both.
 */
function Actions({
    className,
    children,
    align = "right",
    ...rest
}: HTMLAttributes<HTMLDivElement> & { align?: "left" | "right" | "between" }) {
    return (
        <Footer
            className={cn(
                align === "left" && "justify-start",
                align === "between" && "justify-between",
                className,
            )}
            {...rest}
        >
            {children}
        </Footer>
    );
}

/**
 * Convenience wrapper that renders a `<form>` inside the modal body so
 * the body owns the scroll while form submission flows through a single
 * `onSubmit` handler. Pair with `<Modal.Actions>` for Cancel/Save.
 */
function Form({
    children,
    className,
    onSubmit,
    ...rest
}: Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & {
    onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
    return (
        <form
            noValidate
            onSubmit={onSubmit}
            data-modal-form
            className={cn("flex flex-1 flex-col overflow-hidden", className)}
            {...rest}
        >
            {children}
        </form>
    );
}

// ─── Confirm dialog sugar ───────────────────────────────────────────

export type ConfirmTone = "danger" | "warning" | "info";

export interface ConfirmModalProps {
    showModal: boolean;
    setShowModal: Dispatch<SetStateAction<boolean>>;
    /** Dialog heading (required). */
    title: string;
    /** Body copy describing consequences. */
    description?: ReactNode;
    /** Tone drives icon + primary button color. Default: `"warning"`. */
    tone?: ConfirmTone;
    /** Primary action label. Default: "Confirm". */
    confirmLabel?: string;
    /** Secondary action label. Default: "Cancel". */
    cancelLabel?: string;
    /**
     * Called when the user clicks the primary action. If it returns a
     * Promise, the button shows a pending state until it settles and
     * closes the modal on success.
     */
    onConfirm: () => void | Promise<unknown>;
    /** Called when the user cancels or dismisses. Always fires on close. */
    onCancel?: () => void;
}

const toneIcon: Record<ConfirmTone, React.JSX.Element> = {
    danger: (
        <AlertTriangle className="size-5 text-content-error" aria-hidden="true" />
    ),
    warning: (
        <AlertTriangle className="size-5 text-content-warning" aria-hidden="true" />
    ),
    info: <Info className="size-5 text-content-info" aria-hidden="true" />,
};

const tonePrimaryVariant: Record<ConfirmTone, "destructive" | "primary"> = {
    danger: "destructive",
    warning: "primary",
    info: "primary",
};

/**
 * Prebuilt confirmation dialog. Use for destructive ops (delete, remove,
 * revoke), irreversible transitions (close a cycle), or any action
 * that needs a "are you sure?" gate.
 */
function Confirm({
    showModal,
    setShowModal,
    title,
    description,
    tone = "warning",
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
}: ConfirmModalProps) {
    const t = useTranslations("common");
    const resolvedConfirmLabel = confirmLabel ?? t("ui.confirm");
    const resolvedCancelLabel = cancelLabel ?? t("cancel");

    // The props doc has always promised a pending state; the implementation
    // never had one. A confirm wired to a slow DELETE therefore looked inert
    // for as long as the request took, and a second click fired `onConfirm` a
    // second time — two deletes, or two of whatever the caller did.
    const [pending, setPending] = useState(false);

    const handleConfirm = async () => {
        if (pending) return;
        const result = onConfirm();
        if (result instanceof Promise) {
            setPending(true);
            try {
                await result;
            } catch {
                // Keep open so the caller can surface an error — and clear the
                // pending state, or the dialog is left with a dead button and
                // the user cannot retry.
                setPending(false);
                return;
            }
            setPending(false);
        }
        setShowModal(false);
    };

    const handleCancel = () => {
        // Cancelling mid-flight would close over an in-flight promise whose
        // `setShowModal(false)` then runs against a dialog the user already
        // dismissed. The confirm button is disabled while pending; so is this.
        if (pending) return;
        onCancel?.();
        setShowModal(false);
    };

    return (
        <ModalRoot
            showModal={showModal}
            setShowModal={setShowModal}
            size="xs"
            title={title}
            description={typeof description === "string" ? description : undefined}
            onClose={onCancel}
            showCloseButton={false}
            // Escape and the backdrop must not dismiss a confirm whose action
            // is already running.
            preventDefaultClose={pending}
        >
            <Header>
                <div className="flex items-start gap-compact">
                    <span className="mt-0.5 shrink-0">{toneIcon[tone]}</span>
                    <div className="flex min-w-0 flex-col gap-1">
                        <Dialog.Title asChild>
                            <Heading level={2}>
                                {title}
                            </Heading>
                        </Dialog.Title>
                        {description ? (
                            <Dialog.Description asChild>
                                <p className="text-sm text-content-muted">
                                    {description}
                                </p>
                            </Dialog.Description>
                        ) : null}
                    </div>
                </div>
            </Header>
            <Actions>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-modal-cancel
                    disabled={pending}
                    onClick={handleCancel}
                >
                    {resolvedCancelLabel}
                </Button>
                <Button
                    type="button"
                    variant={tonePrimaryVariant[tone]}
                    size="sm"
                    data-modal-confirm
                    // `loading` paints the spinner AND sets `disabled`, so the
                    // double-submit is closed in the DOM and not only by the
                    // guard at the top of handleConfirm.
                    loading={pending}
                    onClick={handleConfirm}
                >
                    {resolvedConfirmLabel}
                </Button>
            </Actions>
        </ModalRoot>
    );
}

// ─── Composite export ───────────────────────────────────────────────

export const Modal = Object.assign(ModalRoot, {
    Header,
    Body,
    Footer,
    Actions,
    Form,
    Confirm,
    Close: Dialog.Close,
});
