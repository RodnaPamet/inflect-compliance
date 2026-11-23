'use client';

/**
 * `<PageActions>` — Roadmap-3 PR-1, phone layout since the mobile roadmap P1.6.
 *
 * The single canonical shape for every page-header action cluster. Pages pass
 * their own `<Button>` / `<Link>` children; the primitive owns the geometry.
 *
 * Desktop (md+) — unchanged
 *   `flex md:flex-wrap-reverse items-center sm:justify-end gap-tight min-h-9`.
 *   Right-aligned, `gap-tight` between buttons, and `flex-wrap-reverse` keeps
 *   the rightmost button (typically the primary) rightmost when a wide cluster
 *   wraps. Every action renders as a button, in source order.
 *
 * Phone (below md) — the primary action, at most one more, and a "⋯" menu
 *   Owner decision, 2026-11-22. A phone cannot hold five header buttons: they
 *   wrapped into a ragged, right-aligned stack in REVERSE reading order (that
 *   is what `flex-wrap-reverse` does to a cluster that wraps more than once).
 *   So below md:
 *     • An action wrapped in `<OverflowAction>` leaves the row and becomes an
 *       item of a labelled "⋯" menu (the Popover primitive's `Menu`/`Item`,
 *       which a phone opens as a bottom sheet). The menu lists items in the
 *       order they appear in the page's source.
 *     • Every other action stays a visible button. A page keeps that to the
 *       primary and at most one more — and a destructive action (an agent's
 *       "Stop agent") is never put in the menu: it stays a visible destructive
 *       button.
 *     • `<PrimaryAction>` marks the primary, which a phone shows FIRST:
 *       reading order, primary first. On desktop the same button keeps its
 *       place (conventionally last, i.e. rightmost).
 *     • The cluster wraps normally (not reversed), left-aligned below `sm`,
 *       where `<PageHeader>` stacks it under a full-width title.
 *   Marking is explicit, never guessed from a button's variant: whether an
 *   action can wait behind a menu is a decision about the page, not a style.
 *
 * A page cannot defeat it with a wrapper
 *   A page that passed its actions inside its own `<div className="flex …">`
 *   turned the whole group into ONE flex item that does not wrap, so at 360 px
 *   it was clipped by the shell. A single plain `<div>` child is therefore
 *   unwrapped: its children become the cluster's items, and the wrapper's
 *   classes are dropped. Pass a fragment instead.
 *
 * What it does NOT do
 *   • Doesn't enforce button SIZE — that's the
 *     `tests/guards/page-actions-discipline.test.ts` ratchet's job.
 *   • Doesn't cap the number of visible actions — the page decides which are
 *     overflow. `<PageHeader>` wraps its `actions` slot in this primitive, so
 *     `<EntityDetailLayout>` and `<EntityListPage>` get it for free.
 */
import {
    Children,
    createContext,
    isValidElement,
    useCallback,
    useContext,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ElementType,
    type ReactElement,
    type ReactNode,
} from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { cn } from '@inflect/ui/lib/cn';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';

/**
 * The "⋯" trigger and its menu, loaded after mount. It renders the Popover
 * primitive (Radix popover + the vaul drawer); a static import put that graph
 * into the First Load JS of every page with a header. It is `md:hidden` and
 * inert before hydration, so nothing is lost by loading it late.
 */
const PageActionsMenu = dynamic(
    () => import('./PageActionsMenu').then((m) => m.PageActionsMenu),
    { ssr: false },
);

// ─── Overflow registry ────────────────────────────────────────────────

/** What the "⋯" menu needs to render one overflow action. */
export interface OverflowEntry {
    label: string;
    href?: string;
    disabled?: boolean;
    icon?: ElementType;
    group?: string;
    testId?: string;
    /** Stable; calls the action's latest `onSelect`. */
    select: () => void;
    /** The action's desktop slot — its position orders the menu. */
    anchor: HTMLElement | null;
}

interface OverflowRegistry {
    set: (id: string, entry: OverflowEntry) => void;
    remove: (id: string) => void;
}

const OverflowRegistryContext = createContext<OverflowRegistry | null>(null);

/** Source (document) order, which is the page's reading order. */
function byDocumentPosition(a: OverflowEntry, b: OverflowEntry): number {
    if (!a.anchor || !b.anchor || a.anchor === b.anchor) return 0;
    return a.anchor.compareDocumentPosition(b.anchor) &
        Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
}

/** A flex-layout utility, optionally behind a breakpoint: nothing it draws. */
const LAYOUT_ONLY_CLASS =
    /^(?:[a-z0-9]+:)*(?:flex|inline-flex|flex-(?:row|col|wrap|nowrap|wrap-reverse)|items-[a-z]+|justify-[a-z]+|gap(?:-[xy])?-[\w.]+)$/;

/**
 * A single plain `<div>` child that only lays its children out is a page's own
 * wrapper; its children are the real actions. See the docblock. A div that is
 * a box in its own right — an id, a border, padding, any other prop — is left
 * alone (the admin page's theme chip is one).
 */
function unwrapSingleWrapper(children: ReactNode): ReactNode {
    const items = Children.toArray(children);
    if (items.length !== 1) return children;
    const only = items[0];
    if (!isValidElement(only) || only.type !== 'div') return children;
    const props = (only as ReactElement<{ children?: ReactNode; className?: string }>).props;
    const otherProps = Object.keys(props).filter((k) => k !== 'children' && k !== 'className');
    const classes = (props.className ?? '').split(/\s+/).filter(Boolean);
    if (otherProps.length > 0 || !classes.every((c) => LAYOUT_ONLY_CLASS.test(c))) {
        return children;
    }
    return props.children;
}

// ─── <PageActions> ────────────────────────────────────────────────────

export interface PageActionsProps {
    children: ReactNode;
    /** Layout overrides on the outer cluster element. */
    className?: string;
    /** Forwarded to the outer element (E2E selectors). */
    'data-testid'?: string;
}

export function PageActions({
    children,
    className,
    'data-testid': dataTestId,
}: PageActionsProps) {
    const [entries, setEntries] = useState<ReadonlyMap<string, OverflowEntry>>(
        () => new Map(),
    );
    const registry = useMemo<OverflowRegistry>(
        () => ({
            set: (id, entry) =>
                setEntries((prev) => new Map(prev).set(id, entry)),
            remove: (id) =>
                setEntries((prev) => {
                    if (!prev.has(id)) return prev;
                    const next = new Map(prev);
                    next.delete(id);
                    return next;
                }),
        }),
        [],
    );

    const overflow = [...entries.values()].sort(byDocumentPosition);

    return (
        <OverflowRegistryContext.Provider value={registry}>
            <div
                className={cn(
                    // Phone: normal wrap, left-aligned below `sm` (the title
                    // sits full width above). Desktop: the cluster recipe it
                    // always had — right-aligned, wrap-reverse.
                    'flex flex-wrap md:flex-wrap-reverse items-center justify-start sm:justify-end gap-tight min-h-9',
                    className,
                )}
                data-testid={dataTestId ?? 'page-actions'}
            >
                {unwrapSingleWrapper(children)}
                {overflow.length > 0 && (
                    <div className="flex md:hidden max-md:order-last" data-testid="page-actions-more-slot">
                        <PageActionsMenu entries={overflow} />
                    </div>
                )}
            </div>
        </OverflowRegistryContext.Provider>
    );
}

// ─── <OverflowAction> ─────────────────────────────────────────────────

export interface OverflowActionProps {
    /** The menu item's label — and the default desktop button's. */
    label: string;
    /** Runs when the action is chosen (desktop button click or menu item). */
    onSelect?: () => void;
    /** Navigates instead of `onSelect`. */
    href?: string;
    disabled?: boolean;
    /** A component (not an element), so its identity is stable. */
    icon?: ElementType;
    /**
     * A heading for a run of related menu items ("Related"). Consecutive items
     * with the same group sit under one heading, after a separator.
     */
    group?: string;
    /** Test id for the MENU item (the desktop child keeps its own). */
    'data-testid'?: string;
    /**
     * The desktop rendering, when it is more than a secondary button — e.g.
     * the page's existing `<Link className={buttonVariants(…)} id=…>`. Omit
     * it for a plain `<Button variant="secondary" size="sm">`.
     */
    children?: ReactNode;
}

/**
 * Marks an action that a phone moves into the "⋯" menu. On desktop it renders
 * `children` (or a secondary button) exactly where it stands; below md that
 * render is hidden and the action is an item of the cluster's menu instead.
 * Outside a `<PageActions>` it just renders its desktop form.
 *
 * Never use it for a destructive action — the owner's rule is that those stay
 * visible on a phone.
 */
export function OverflowAction({
    label,
    onSelect,
    href,
    disabled,
    icon: Icon,
    group,
    'data-testid': testId,
    children,
}: OverflowActionProps) {
    const registry = useContext(OverflowRegistryContext);
    const id = useId();
    const anchorRef = useRef<HTMLSpanElement>(null);

    // The latest handler, read only when the action is chosen.
    const onSelectRef = useRef(onSelect);
    useLayoutEffect(() => {
        onSelectRef.current = onSelect;
    });
    const select = useCallback(() => onSelectRef.current?.(), []);

    useEffect(() => {
        if (!registry) return;
        registry.set(id, {
            label,
            href,
            disabled,
            icon: Icon,
            group,
            testId,
            select,
            anchor: anchorRef.current,
        });
    }, [registry, id, label, href, disabled, Icon, group, testId, select]);

    useEffect(() => {
        if (!registry) return;
        return () => registry.remove(id);
    }, [registry, id]);

    const desktop =
        children ??
        (href ? (
            <Link
                href={href}
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
                {Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : null}
                {label}
            </Link>
        ) : (
            <Button
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => onSelectRef.current?.()}
                icon={Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : undefined}
            >
                {label}
            </Button>
        ));

    if (!registry) return <>{desktop}</>;

    // `display: contents` at md+ makes the child a direct flex item of the
    // cluster, exactly as if this wrapper were not there.
    return (
        <span
            ref={anchorRef}
            className="hidden md:contents"
            data-page-action="overflow"
        >
            {desktop}
        </span>
    );
}

// ─── <PrimaryAction> ──────────────────────────────────────────────────

/**
 * Marks the page's primary action. A phone shows it first in the row; desktop
 * leaves it where the page put it. Renders nothing extra when its child renders
 * nothing (e.g. a `<RequirePermission>` that refuses), so the row keeps no gap
 * for it.
 */
export function PrimaryAction({ children }: { children: ReactNode }) {
    return (
        <span
            className="inline-flex max-md:order-first empty:hidden"
            data-page-action="primary"
        >
            {children}
        </span>
    );
}
