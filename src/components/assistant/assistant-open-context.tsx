'use client';

/**
 * Who may open the assistant (#3840).
 *
 * ═══ WHY THE OPEN STATE IS NOT LOCAL TO THE LAUNCHER ═══
 *
 * The roadmap asks for a command-palette entry "so it is reachable the way
 * everything else in the product is". The palette is rendered in
 * `src/app/providers.tsx`, which is ABOVE `AppShell` — so a `useState` inside
 * the launcher is unreachable from the palette, and there is no
 * `CustomEvent`/`dispatchEvent` precedent anywhere in `src/` to borrow for
 * cross-tree signalling.
 *
 * This mirrors the pattern the palette already uses for the one thing it can
 * already toggle: `usePaletteCommands` calls `useTheme()`, whose provider sits
 * in the same file. One more provider in the same place is the idiomatic
 * answer rather than a new mechanism.
 *
 * ═══ `available` IS REGISTERED, NOT RE-DERIVED ═══
 *
 * The palette entry must not appear when the assistant is switched off. The
 * kill switch is server env, and the palette is a client component that
 * cannot read it — so re-deriving the gate there would mean a SECOND copy of
 * it, free to disagree with the first.
 *
 * Instead the launcher registers itself on mount. It only mounts when the
 * flag is on, so the entry's presence follows the button's ACTUAL presence.
 * One gate, one reader, and no way for the palette to offer something the
 * product has removed.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface AssistantOpenValue {
    open: boolean;
    setOpen: (next: boolean) => void;
    /** True while a launcher is mounted — see the header. */
    available: boolean;
    setAvailable: (next: boolean) => void;
}

const AssistantOpenCtx = createContext<AssistantOpenValue | null>(null);

export function AssistantOpenProvider({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    const [available, setAvailable] = useState(false);
    const value = useMemo<AssistantOpenValue>(
        () => ({ open, setOpen, available, setAvailable }),
        [open, available],
    );
    return <AssistantOpenCtx.Provider value={value}>{children}</AssistantOpenCtx.Provider>;
}

/**
 * The assistant's open state.
 *
 * Falls back to an inert value with `available: false` when no provider is
 * mounted. Not a thrown error, deliberately: the palette asks on every render
 * and a tree without the provider — a rendered test of one page, the
 * unauthenticated shell — should get "there is no assistant here" rather than
 * a crash. `useTenantContext` throws in that situation because a missing
 * tenant means the page itself is wrong; a missing assistant just means there
 * is nothing to offer.
 */
export function useAssistantOpen(): AssistantOpenValue {
    const ctx = useContext(AssistantOpenCtx);
    const noopSet = useCallback(() => {}, []);
    const inert = useMemo<AssistantOpenValue>(
        () => ({ open: false, setOpen: noopSet, available: false, setAvailable: noopSet }),
        [noopSet],
    );
    return ctx ?? inert;
}
