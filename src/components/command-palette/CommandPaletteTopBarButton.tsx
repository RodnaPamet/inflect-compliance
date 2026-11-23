'use client';

/**
 * A touch trigger for the command palette (#5821).
 *
 * The palette opens on ⌘K / Ctrl+K, which a phone does not have, and the top
 * bar carried no visible way in. This icon, in the top bar below `md`, opens
 * the SAME palette through `useCommandPalette().open` — the provider owns the
 * one open state and `<CommandPalette>` is mounted once in
 * `src/app/providers.tsx`; nothing here renders a palette of its own.
 *
 * `md:hidden`: from `md` up the keyboard shortcut and the sidebar's search row
 * are the ways in, and the bar's desktop layout is unchanged.
 */
import { useTranslations } from 'next-intl';
import { Magnifier } from '@inflect/ui/components/ui/icons/glyphs/magnifier';

import { NAV_BAR_ICON_BUTTON_CLASS } from '@/components/layout/nav-bar';
import { Tooltip } from '@/components/ui/tooltip';

import { useCommandPalette } from './command-palette-provider';

export function CommandPaletteTopBarButton() {
    const tn = useTranslations('nav');
    const { open } = useCommandPalette();
    const label = tn('openCommandPalette');

    return (
        <Tooltip content={label}>
            <button
                type="button"
                onClick={open}
                aria-label={label}
                aria-haspopup="dialog"
                data-testid="command-palette-top-bar-button"
                className={`md:hidden ${NAV_BAR_ICON_BUTTON_CLASS}`}
            >
                <Magnifier className="h-4 w-4" aria-hidden="true" />
            </button>
        </Tooltip>
    );
}
