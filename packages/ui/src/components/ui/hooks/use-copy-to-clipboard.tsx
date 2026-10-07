/**
 * useCopyToClipboard — Epic 56 clipboard hook.
 *
 * Wraps `navigator.clipboard.writeText` with a success flag, error state,
 * and auto-reset timer. SSR-safe (short-circuits when `navigator` is
 * unavailable) and tolerant of browsers without Clipboard API access
 * (falls back to the legacy `document.execCommand('copy')` path).
 *
 *   const { copy, copied, error, reset } = useCopyToClipboard({ timeout: 2000 });
 *   await copy(value);
 *   if (copied) …            // success flag, auto-clears after `timeout`
 *   if (error)  …             // surfaced for inline messaging; never thrown
 *
 * Consumers should treat the returned object as the single source of
 * truth for UI state — don't gate on the returned promise. Instrumenting
 * copies (e.g., recording that a secret was revealed and copied) should
 * happen via the `onSuccess` option passed to `copy()`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseCopyToClipboardOptions {
    /** Auto-reset the `copied` flag after this many ms. 0 disables the timer. */
    timeout?: number;
}

export interface CopyOptions {
    /** Called after the clipboard write resolves. */
    onSuccess?: () => void;
    /** Called when the clipboard write fails (permission, SSR, unsupported). */
    onError?: (error: Error) => void;
}

export type CopyFn = (
    value: string | ClipboardItem,
    options?: CopyOptions,
) => Promise<boolean>;

export interface UseCopyToClipboardResult {
    copy: CopyFn;
    copied: boolean;
    error: Error | null;
    reset: () => void;
}

const DEFAULT_TIMEOUT = 2000;

export function useCopyToClipboard(
    options: UseCopyToClipboardOptions = {},
): UseCopyToClipboardResult {
    const { timeout = DEFAULT_TIMEOUT } = options;
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    const clearTimer = () => {
        if (timer.current) {
            clearTimeout(timer.current);
            timer.current = null;
        }
    };

    const reset = useCallback(() => {
        clearTimer();
        setCopied(false);
        setError(null);
    }, []);

    const copy = useCallback<CopyFn>(
        async (value, copyOpts = {}) => {
            clearTimer();
            setError(null);

            try {
                await writeToClipboard(value);
                setCopied(true);
                copyOpts.onSuccess?.();
                if (Number.isFinite(timeout) && timeout > 0) {
                    timer.current = setTimeout(() => setCopied(false), timeout);
                }
                return true;
            } catch (err) {
                const normalised =
                    err instanceof Error ? err : new Error(String(err));
                setError(normalised);
                setCopied(false);
                copyOpts.onError?.(normalised);
                return false;
            }
        },
        [timeout],
    );

    useEffect(() => {
        return () => clearTimer();
    }, []);

    return { copy, copied, error, reset };
}

/**
 * Perform the clipboard write with a graceful fallback chain:
 *   1. Modern Clipboard API (requires secure context).
 *   2. Legacy `document.execCommand('copy')` for older browsers and
 *      environments (e.g., MFA enrollment pages served on a preview
 *      host without HTTPS).
 *   3. Throw — the hook surfaces the error to the caller.
 */
async function writeToClipboard(value: string | ClipboardItem): Promise<void> {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
        throw new Error("Clipboard unavailable: non-browser environment.");
    }

    // `ClipboardItem` is not defined in every browser (jsdom, Safari on
    // older iOS, etc.) — guard with a typeof check before instanceof.
    if (
        typeof ClipboardItem !== "undefined" &&
        value instanceof ClipboardItem
    ) {
        if (!navigator.clipboard?.write) {
            throw new Error("ClipboardItem write is not supported.");
        }
        await navigator.clipboard.write([value]);
        return;
    }

    if (typeof value !== "string") {
        throw new Error("Clipboard write failed: unsupported value type.");
    }

    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
    }

    if (!legacyWriteText(value)) {
        throw new Error("Clipboard write failed: no supported API.");
    }
}

function legacyWriteText(value: string): boolean {
    if (typeof document === "undefined") return false;
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
        ok = document.execCommand("copy");
    } catch {
        ok = false;
    } finally {
        document.body.removeChild(area);
    }
    return ok;
}
