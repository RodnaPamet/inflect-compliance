/**
 * PR-B polish — Unit coverage for the clipboard-copy helpers in
 * `canvas-export.ts`. The structural ratchet (`p-polish-b`) locks
 * the wiring; this file pins the behavioural contract of
 * `canCopyImageToClipboard()`:
 *
 *   1. Returns true when both `navigator.clipboard.write` AND
 *      global `ClipboardItem` are present.
 *   2. Returns false when either is missing — every menu rendered
 *      in an unsupported browser must hide the item rather than
 *      let the user click into a throw.
 *
 * The image-rendering path (toPng) is tested at the integration
 * layer; mocking html-to-image's foreignObject pipeline isn't
 * worth the surface area.
 */

import { canCopyImageToClipboard } from "@/lib/processes/canvas-export-shared";

const originalClipboard = (globalThis as { navigator?: Navigator }).navigator
    ?.clipboard;
const originalClipboardItem = (globalThis as { ClipboardItem?: unknown })
    .ClipboardItem;

describe("canCopyImageToClipboard", () => {
    afterEach(() => {
        // Restore whatever the test harness had originally.
        if (typeof navigator !== "undefined") {
            (
                navigator as { clipboard?: typeof originalClipboard }
            ).clipboard = originalClipboard;
        }
        (
            globalThis as { ClipboardItem?: unknown }
        ).ClipboardItem = originalClipboardItem;
    });

    it("returns false when navigator.clipboard.write is absent", () => {
        (
            navigator as { clipboard?: { write?: unknown } }
        ).clipboard = {};
        (globalThis as { ClipboardItem?: unknown }).ClipboardItem =
            // Constructor mirrors the real ClipboardItem(items) shape so
            // CodeQL's call-graph doesn't flag the production
            // `new ClipboardItem({...})` as passing a superfluous arg.
            class FakeClipboardItem {
                constructor(_items: Record<string, Blob>) {
                    void _items;
                }
            };
        expect(canCopyImageToClipboard()).toBe(false);
    });

    it("returns false when ClipboardItem is undefined", () => {
        (navigator as { clipboard?: { write?: unknown } }).clipboard = {
            write: async () => {},
        };
        (globalThis as { ClipboardItem?: unknown }).ClipboardItem = undefined;
        expect(canCopyImageToClipboard()).toBe(false);
    });

    it("returns true when both the function and the class are present", () => {
        (navigator as { clipboard?: { write?: unknown } }).clipboard = {
            write: async () => {},
        };
        (globalThis as { ClipboardItem?: unknown }).ClipboardItem =
            // Constructor mirrors the real ClipboardItem(items) shape so
            // CodeQL's call-graph doesn't flag the production
            // `new ClipboardItem({...})` as passing a superfluous arg.
            class FakeClipboardItem {
                constructor(_items: Record<string, Blob>) {
                    void _items;
                }
            };
        expect(canCopyImageToClipboard()).toBe(true);
    });
});
