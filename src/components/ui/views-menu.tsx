'use client';

/**
 * `<ViewsMenu>` — the labelled "Views ▾" menu above a list-page table.
 *
 * Extracted from the risks list (P3) and generalised so every main list
 * page folds its secondary navigation into ONE labelled entry point
 * instead of a rail of tooltip-only icon buttons.
 *
 * The problem it solves: an icon rail is undiscoverable. Four glyphs in a
 * row (share / templates / bin / bug) each need a hover to identify, they
 * compete with the columns + filters gears for the same eye-line, and
 * nothing about them says "these are other ways to look at this data".
 * A labelled menu says it in one word and costs one click.
 *
 * What belongs IN the menu: other views of, or destinations reachable
 * from, this list — analytics pages, registries, the deleted-rows
 * toggle, an importer.
 *
 * What stays OUT:
 *   - The page's dashboard icon. It sits to the RIGHT of this trigger as
 *     a standalone icon button — one click to the page's KPI view is the
 *     one shortcut worth spending toolbar width on.
 *   - The columns + filters gears. They are table chrome, not views, and
 *     they render one rung smaller so the hierarchy reads at a glance.
 *   - A two-state layout toggle (register ⇄ heatmap, list ⇄ gallery).
 *     That is the primary control for the table itself and leads the row.
 *
 * Items come in two shapes, both rendered as `role="menuitem"`:
 *   - `href`     — navigation, rendered as a `<Link>`.
 *   - `onSelect` — an in-page action (switch view mode, toggle the
 *                  deleted-rows view), rendered as a `<Popover.Item>`
 *                  carrying `selected` so the current mode is visible
 *                  without opening anything else.
 *
 * Groups with no items after permission filtering disappear, heading and
 * all; a menu with nothing left in it renders nothing at all rather than
 * an empty popover.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { Button } from './button';
import { Popover } from './popover';

export interface ViewsMenuItem {
    /** Stable DOM id — E2E-load-bearing on the migrated pages. */
    id: string;
    label: string;
    /** Leading glyph. Callers pass `<AppIcon …>` so this file imports no icon set. */
    icon?: ReactNode;
    /** Navigation target. Mutually exclusive with `onSelect`. */
    href?: string;
    /** In-page action. Mutually exclusive with `href`. */
    onSelect?: () => void;
    /** Current mode / active toggle — renders the row in its selected tone. */
    selected?: boolean;
    /**
     * A COUNT the destination is waiting on — e.g. proposals awaiting review.
     *
     * Render it ONLY when there is something to report. A badge reading "0" is
     * a notification about the absence of anything to notify, and the trigger
     * is closed most of the time, so the number's only job is to be worth
     * opening the menu for. Callers therefore pass `undefined`, not `0`.
     */
    badge?: string | number;
    /**
     * What `badge` counts, for a screen reader. Required in practice whenever
     * `badge` is set: a bare number read aloud after a label says nothing —
     * the sidebar's own badge learned this (`NavItem.badgeLabel`).
     */
    badgeLabel?: string;
    'data-testid'?: string;
}

export interface ViewsMenuGroup {
    id: string;
    /** Section heading. Omit for an unlabelled leading group. */
    label?: string;
    /** Falsy entries are dropped, so callers can inline permission gates. */
    items: Array<ViewsMenuItem | false | null | undefined>;
}

export interface ViewsMenuProps {
    groups: ViewsMenuGroup[];
    /**
     * Trigger label. Defaults to the shared `common.ui.viewsMenu` string —
     * the menu owns its own copy so twelve call sites don't each thread the
     * same word through. Pass it only to say something different.
     */
    label?: string;
    /** Accessible name for the menu container. Defaults to `common.ui.viewsMenuAria`. */
    ariaLabel?: string;
    /** Trigger id (e.g. "risks-views-menu"). */
    id?: string;
    className?: string;
}

/**
 * The row recipe shared by both item shapes. `<Popover.Item>` owns this
 * for buttons; links can't use that primitive (it renders a `<button>`),
 * so the class list is spelled here once and applied to both.
 */
const ROW_CLASS =
    'flex w-full cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm ' +
    'text-content-default transition-colors duration-100 ease-out motion-reduce:transition-none ' +
    'hover:bg-bg-muted hover:text-content-emphasis ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The trailing count chip. Shared by both item shapes so a link row and an
 * action row cannot drift apart visually.
 *
 * `aria-hidden` on the number plus an `sr-only` sentence, rather than an
 * `aria-label` on the chip: the label has to be READ AFTER the row's own label
 * to make sense ("Proposals — 3 awaiting review"), and an aria-label on the
 * chip would replace the number without ordering it.
 */
function BadgeChip({ badge, badgeLabel }: { badge: string | number; badgeLabel?: string }) {
    return (
        <span className="ml-auto inline-flex shrink-0 items-center">
            <span
                aria-hidden="true"
                className="rounded-full bg-bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-content-emphasis"
            >
                {badge}
            </span>
            {badgeLabel && <span className="sr-only">{`${badge} ${badgeLabel}`}</span>}
        </span>
    );
}

export function ViewsMenu({ groups, label, ariaLabel, id, className }: ViewsMenuProps) {
    const t = useTranslations('common.ui');
    const [open, setOpen] = useState(false);
    const triggerLabel = label ?? t('viewsMenu');
    const menuAria = ariaLabel ?? t('viewsMenuAria');

    const populated = groups
        .map((g) => ({ ...g, items: g.items.filter(Boolean) as ViewsMenuItem[] }))
        .filter((g) => g.items.length !== 0);

    if (populated.length === 0) return null;

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            align="end"
            side="bottom"
            sideOffset={6}
            popoverContentClassName="w-full sm:w-56 p-1"
            content={
                <Popover.Menu aria-label={menuAria}>
                    {populated.map((group, gi) => (
                        <div key={group.id} role="presentation">
                            {gi > 0 && <Popover.Separator />}
                            {group.label && (
                                <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
                                    {group.label}
                                </p>
                            )}
                            {group.items.map((item) =>
                                item.href ? (
                                    <Link
                                        key={item.id}
                                        id={item.id}
                                        href={item.href}
                                        role="menuitem"
                                        data-testid={item['data-testid']}
                                        onClick={() => setOpen(false)}
                                        className={cn(
                                            ROW_CLASS,
                                            item.selected && 'bg-bg-subtle text-content-emphasis',
                                        )}
                                    >
                                        {item.icon && (
                                            <span className="inline-flex size-4 shrink-0 items-center justify-center text-content-muted">
                                                {item.icon}
                                            </span>
                                        )}
                                        <span className="flex-1 break-words">{item.label}</span>
                                        {item.badge !== undefined && (
                                            <BadgeChip
                                                badge={item.badge}
                                                badgeLabel={item.badgeLabel}
                                            />
                                        )}
                                    </Link>
                                ) : (
                                    <Popover.Item
                                        key={item.id}
                                        id={item.id}
                                        icon={item.icon}
                                        selected={item.selected}
                                        right={
                                            item.badge === undefined ? undefined : (
                                                <BadgeChip
                                                    badge={item.badge}
                                                    badgeLabel={item.badgeLabel}
                                                />
                                            )
                                        }
                                        aria-pressed={item.onSelect ? item.selected : undefined}
                                        data-testid={item['data-testid']}
                                        onClick={() => {
                                            item.onSelect?.();
                                            setOpen(false);
                                        }}
                                    >
                                        {item.label}
                                    </Popover.Item>
                                ),
                            )}
                        </div>
                    ))}
                </Popover.Menu>
            }
        >
            <Button variant="secondary" size="sm" id={id} className={className}>
                {triggerLabel}
                <span aria-hidden="true" className="ml-1 -mr-0.5 opacity-60">
                    ▾
                </span>
            </Button>
        </Popover>
    );
}
