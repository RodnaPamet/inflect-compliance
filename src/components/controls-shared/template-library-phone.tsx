'use client';

/**
 * The phone layout's shared parts for the two template libraries:
 * `controls/templates` and `frameworks/[frameworkKey]/templates` (Mobile 4.3,
 * owner decision 2026-11-23: a phone layout, per the roadmap — search first,
 * paginated, a real checkbox per row, a sticky install bar).
 *
 * Both libraries hold a few hundred templates, and both rendered every one of
 * them on a phone: a page of 18,000 to 222,000 px with the install action at
 * the top or the end of it. Below `md` each page now shows its search, then a
 * page of cards that grows with "Show more", and a bar pinned to the bottom of
 * the screen that names how many templates are selected and installs them.
 *
 * The parts carry no text of their own: each page passes its own words, from
 * its own catalogue namespace.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TOUCH_HIT_AREA_CLASS } from '@/components/ui/hit-area';
import { cn } from '@inflect/ui/lib/cn';

/** Templates shown per step on a phone. */
export const TEMPLATE_PHONE_PAGE_SIZE = 20;

/**
 * How many templates a phone shows. Starts at one page, grows a page per
 * `showMore`, and starts over whenever `signature` (the search and filters)
 * changes, so a new search never opens on page five of the old one.
 */
export function useProgressiveCount(signature: string, pageSize = TEMPLATE_PHONE_PAGE_SIZE) {
    const [state, setState] = useState({ signature, count: pageSize });
    const count = state.signature === signature ? state.count : pageSize;
    const showMore = useCallback(
        () => setState({ signature, count: count + pageSize }),
        [signature, count, pageSize],
    );
    return { count, showMore };
}

/** "Show more", full width and finger-sized, under a page of cards. */
export function TemplateShowMore({ label, onClick, id }: { label: string; onClick: () => void; id: string }) {
    return (
        <Button variant="secondary" className="min-h-11 w-full" onClick={onClick} id={id}>
            {label}
        </Button>
    );
}

/**
 * A card's selection box: a real checkbox, painted at 24px, that takes a
 * 44px tap on a touch screen. A `<label htmlFor={id}>` around the card's text
 * makes the rest of the card toggle it too.
 */
export function TemplateSelectBox({
    id,
    checked,
    onCheckedChange,
    label,
}: {
    id: string;
    checked: boolean;
    onCheckedChange: () => void;
    label: string;
}) {
    return (
        <Checkbox
            id={id}
            size="lg"
            checked={checked}
            onCheckedChange={onCheckedChange}
            aria-label={label}
            className={cn('relative mt-0.5', TOUCH_HIT_AREA_CLASS)}
            data-testid="template-select"
        />
    );
}

/**
 * A selectable card's body: the select box, then the card's text as the
 * box's `<label>`, so a tap anywhere on the text selects the card too.
 */
export function TemplateSelectRow({
    id,
    checked,
    onCheckedChange,
    label,
    children,
}: {
    id: string;
    checked: boolean;
    onCheckedChange: () => void;
    label: string;
    children: ReactNode;
}) {
    return (
        <>
            <TemplateSelectBox id={id} checked={checked} onCheckedChange={onCheckedChange} label={label} />
            <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                {children}
            </label>
        </>
    );
}

/**
 * The phone's install bar: pinned to the bottom of the screen, clear of the
 * home indicator, for as long as the library is on screen. It is there
 * before anything is selected (the button says 0 and is disabled), so the
 * count is visible throughout and the action never moves. Hidden from `md`
 * up, where each page keeps its own install button.
 */
export function TemplateInstallDock({
    installLabel,
    onInstall,
    disabled,
    clearLabel,
    onClear,
    id,
}: {
    installLabel: string;
    onInstall: () => void;
    disabled: boolean;
    /** Offered while something is selected. */
    clearLabel?: string;
    onClear?: () => void;
    id: string;
}) {
    return (
        <div
            className="sticky bottom-0 z-30 -mx-4 border-t border-border-subtle bg-bg-elevated px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 md:hidden"
            role="region"
            aria-label={installLabel}
            data-testid="template-install-dock"
        >
            <div className="flex items-center gap-compact">
                {clearLabel && onClear && (
                    <Button variant="ghost" className="min-h-11 shrink-0" onClick={onClear} id={`${id}-clear`}>
                        {clearLabel}
                    </Button>
                )}
                <Button variant="primary" className="min-h-11 flex-1" onClick={onInstall} disabled={disabled} id={id}>
                    {installLabel}
                </Button>
            </div>
        </div>
    );
}
