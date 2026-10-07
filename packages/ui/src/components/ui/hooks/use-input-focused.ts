import { useEffect, useState } from "react";

/**
 * `true` while an editable element has focus anywhere in the document.
 *
 * Handy for gating page-level shortcuts (`?` for help, `/` for search)
 * so they don't steal keystrokes while the user is typing. Epic 57's
 * `useKeyboardShortcut` already skips shortcuts when the event target
 * is editable — this hook is the reciprocal view for callers that need
 * to *render differently* based on focus (e.g. fading a hint bar when
 * the user starts typing) rather than to register a shortcut.
 *
 * ## Recognised editable targets
 *
 * Matches Epic 57's `isEditableTarget` policy verbatim:
 *
 *   - `<input>` (all types except `type="button"` and the like — we
 *     don't bother excluding those because focus on a button is rare
 *     and the signal "user is interacting with a focusable element" is
 *     still useful when we can't tell).
 *   - `<textarea>`
 *   - `<select>` — browsers absorb many keystrokes for option matching.
 *   - `[contenteditable]` / `[contenteditable="true"]` / role=textbox /
 *     role=combobox / role=searchbox — Lexical, Tiptap, cmdk, custom
 *     rich-text surfaces.
 *
 * Matching Epic 57 matters because consumers that branch on
 * `useInputFocused() === true` should see the same answer the shortcut
 * registry is using — otherwise you get "I'm shadowing this shortcut
 * but your badge disagrees" drift.
 *
 * ## SSR safety
 *
 * Returns `false` on the server and during the first client render (no
 * `document` / no focus target to inspect). Hydrates from the real
 * `document.activeElement` inside an effect, so consumers start in a
 * neutral state and flip to the real value without a mismatch warning.
 */

const INPUT_ROLES = new Set(["textbox", "combobox", "searchbox"]);

function isEditable(el: Element | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if ((el as HTMLElement).isContentEditable) return true;
    const editableAttr = el.getAttribute("contenteditable");
    if (editableAttr !== null && editableAttr !== "false") return true;
    const role = el.getAttribute("role");
    if (role && INPUT_ROLES.has(role)) return true;
    return false;
}

export function useInputFocused(): boolean {
    const [isInputFocused, setIsInputFocused] = useState(false);

    useEffect(() => {
        if (typeof document === "undefined") return;

        const sync = () => {
            setIsInputFocused(isEditable(document.activeElement));
        };

        // Initialise from the real activeElement on mount — a returning
        // user tab-focuses a field before our effect runs, and we don't
        // want to lie about focus until the next focusin event.
        sync();

        // `focusin` / `focusout` bubble; `focus` / `blur` do not. Bubbling
        // lets us listen once at the window without per-element binding.
        window.addEventListener("focusin", sync);
        window.addEventListener("focusout", sync);
        return () => {
            window.removeEventListener("focusin", sync);
            window.removeEventListener("focusout", sync);
        };
    }, []);

    return isInputFocused;
}
