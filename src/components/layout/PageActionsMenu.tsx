'use client';

/**
 * The phone "⋯" menu of `<PageActions>` — the trigger and the menu it opens.
 *
 * A module of its own so `PageActions` can load it with `next/dynamic`: it
 * pulls in the Popover primitive (Radix popover plus the vaul drawer), and a
 * static import put that graph into the First Load JS of every page with a
 * page header — measured at 3–7 KB per route by the bundle budget. The menu is
 * `md:hidden` and does nothing before hydration, so loading it after mount
 * costs nothing a reader can see. Same split as `toggle-group-select.tsx`.
 */
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@inflect/ui/lib/cn';
import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';
import type { OverflowEntry } from './PageActions';

/**
 * `Popover.Item`'s look for a navigating item. `Popover.Item` is a `<button>`,
 * and a link item must stay a link (middle-click, open in a new tab).
 */
const MENU_LINK_CLASS = cn(
    'flex w-full cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left',
    'pointer-coarse:min-h-11',
    'transition-colors duration-100 ease-out motion-reduce:transition-none',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'text-content-default hover:bg-bg-muted hover:text-content-emphasis',
);

export function PageActionsMenu({
    entries,
}: {
    /** Already in reading order. */
    entries: ReadonlyArray<OverflowEntry>;
}) {
    const t = useTranslations('common.ui');
    const [menuOpen, setMenuOpen] = useState(false);

    const choose = (entry: OverflowEntry) => {
        // Close first: an action that opens a sheet or modal must not open it
        // underneath the menu's own sheet.
        setMenuOpen(false);
        entry.select();
    };

    return (
        <Popover
            openPopover={menuOpen}
            setOpenPopover={setMenuOpen}
            align="end"
            contentLabel={t('moreActions')}
            content={
                <Popover.Menu data-testid="page-actions-menu">
                    {entries.map((entry, index) => {
                        const Icon = entry.icon;
                        const startsGroup =
                            entry.group !== undefined &&
                            entry.group !== entries[index - 1]?.group;
                        return (
                            <OverflowMenuRow
                                key={`${entry.label}-${index}`}
                                group={startsGroup ? entry.group : undefined}
                                separated={startsGroup && index > 0}
                            >
                                {entry.href && !entry.disabled ? (
                                    // A real link, so it can be opened in a new
                                    // tab; it takes the menu item's role and look.
                                    <Link
                                        href={entry.href}
                                        role="menuitem"
                                        className={MENU_LINK_CLASS}
                                        onClick={() => setMenuOpen(false)}
                                        data-testid={entry.testId ?? 'page-actions-menu-item'}
                                    >
                                        {Icon ? (
                                            <span className="inline-flex size-4 shrink-0 items-center justify-center text-content-muted">
                                                <Icon className="h-4 w-4" aria-hidden="true" />
                                            </span>
                                        ) : null}
                                        <span className="flex-1 break-words">{entry.label}</span>
                                    </Link>
                                ) : (
                                    <Popover.Item
                                        icon={Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : undefined}
                                        disabled={entry.disabled}
                                        onClick={() => choose(entry)}
                                        data-testid={entry.testId ?? 'page-actions-menu-item'}
                                    >
                                        {entry.label}
                                    </Popover.Item>
                                )}
                            </OverflowMenuRow>
                        );
                    })}
                </Popover.Menu>
            }
        >
            <Button
                variant="secondary"
                size="icon"
                icon={<MoreHorizontal aria-hidden="true" />}
                aria-label={t('moreActions')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-testid="page-actions-more"
            />
        </Popover>
    );
}

function OverflowMenuRow({
    group,
    separated,
    children,
}: {
    group?: string;
    separated: boolean;
    children: ReactNode;
}) {
    return (
        <>
            {separated ? <Popover.Separator /> : null}
            {group ? (
                <div
                    role="presentation"
                    className="px-2.5 pt-1 text-xs text-content-subtle"
                >
                    {group}
                </div>
            ) : null}
            {children}
        </>
    );
}
