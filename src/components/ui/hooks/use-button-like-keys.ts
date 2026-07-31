import type { KeyboardEvent } from 'react';

/**
 * Make a non-button element behave like a button for keyboard and AT users.
 *
 * ── Why this is a primitive and not an inline handler ───────────────
 *
 * A clickable `<tr>` / `<div>` needs FOUR things to be usable without a mouse,
 * and writing them inline means writing all four correctly every time:
 *
 *   - `role="button"`   so AT announces it as actionable
 *   - `tabIndex={0}`    so it is reachable at all
 *   - Enter **and Space** — Space is the one people forget, and it is the key
 *     most users press on something announced as a button
 *   - `preventDefault()` on Space, or the page scrolls underneath the user
 *
 * `useEnterSubmit` does not fit: it is about submitting a FORM from an input,
 * deliberately ignores Space, and has IME/multiline rules that are meaningless
 * here.
 *
 * Living in `src/components/ui` rather than in a page also keeps the Epic 60
 * ratchet honest — it caps inline `e.key === 'Enter'` handlers under
 * `src/app/**` precisely so this behaviour is centralised rather than
 * re-derived per surface.
 *
 * Prefer a real `<button>` when the markup allows it. This exists for the cases
 * where it does not — a table row that expands, most obviously, where nesting a
 * button around `<td>`s is not valid HTML.
 *
 * @example
 * <tr {...buttonLikeKeys(onToggle, { expanded })}>…</tr>
 */
export function buttonLikeKeys(
    onActivate: () => void,
    opts: { expanded?: boolean; disabled?: boolean } = {},
) {
    const { expanded, disabled } = opts;
    return {
        role: 'button' as const,
        // -1 keeps a disabled row focusable-by-script but out of the tab order,
        // matching how a disabled button drops out of sequential navigation.
        tabIndex: disabled ? -1 : 0,
        ...(expanded !== undefined ? { 'aria-expanded': expanded } : {}),
        ...(disabled ? { 'aria-disabled': true as const } : {}),
        onClick: disabled ? undefined : onActivate,
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (disabled) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            // Space scrolls the page by default; Enter can submit an ancestor
            // form. Neither is what activating this element should do.
            event.preventDefault();
            onActivate();
        },
    };
}
