'use client';

/**
 * The global toast host (#5821).
 *
 * `CopyButton` / `CopyText`, the optimistic-update hook and the Epic 67 undo
 * toasts all emit into this one `sonner` Toaster; without it every `toast()`
 * call is a silent no-op.
 *
 * ═══ THE APP'S THEME, NOT A FIXED ONE ═══
 *
 * It was pinned to `theme="dark"`, so in the light theme every toast was a
 * dark slab on a light page. It now reads `useTheme()` — the same provider the
 * rest of the app is painted from — so it switches with the user's choice.
 *
 * ═══ WHERE IT SITS ═══
 *
 * From `md` up: top-right, as before. Below `md` (the shell's phone/desktop
 * split): bottom-centre. Top-right on a phone sat over the page header and its
 * actions, which are exactly what a person reaches for after an action that
 * toasts. `sonner` takes one `position` per Toaster and has no per-breakpoint
 * form, so the position follows the viewport width. Its own phone styles
 * (below 600px) stretch the toast across the screen and read `mobileOffset`;
 * the bottom offset there adds the home-indicator inset so a toast never sits
 * under it.
 *
 * Until the width is known (the server render and the first client render),
 * it is the desktop position: `sonner` renders no toast before then anyway,
 * so the first toast always lands in the right place.
 */
import { Toaster } from 'sonner';
import { useMediaQuery } from '@/components/ui/hooks';

import { useTheme } from './ThemeProvider';

/** Tailwind's `md`. Below it the shell is the phone layout. */
const MD_BREAKPOINT_PX = 768;

export function AppToaster() {
    const { theme } = useTheme();
    const { width } = useMediaQuery();
    const phone = width !== undefined && width < MD_BREAKPOINT_PX;

    return (
        <Toaster
            theme={theme}
            position={phone ? 'bottom-center' : 'top-right'}
            mobileOffset={{ bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}
            richColors
            closeButton
            duration={3000}
        />
    );
}
