/**
 * Epic 67 — TraceabilityPanel unlink rollout.
 *
 * Mounts the real `<TraceabilityPanel>` against a mocked fetch +
 * `useToastWithUndo`-aware sonner shim. Asserts:
 *
 *   - clicking Unlink does NOT fire the DELETE synchronously
 *   - the row optimistically disappears from the rendered table
 *   - after the 5s undo window, fetch DELETE is called exactly once
 *   - clicking Undo within the window cancels the commit and restores
 *     the row to the table
 *
 * The real foundation hook (`useToastWithUndo`) is imported as-is —
 * no replacement — so this is a true integration test of the
 * Epic 66→67 wiring.
 */
/** @jest-environment jsdom */

import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { TooltipProvider } from "@/components/ui/tooltip";

// ─── sonner shim ────────────────────────────────────────────────────
// The hook calls `toast.custom((t) => <UndoToast … />)` synchronously
// from the trigger. We render the captured element into a portalised
// host so its onUndo prop is reachable as a real DOM button.

const dismissedIds: Array<string | number> = [];
let nextSonnerId = 1;

interface CustomCall {
    id: number;
    factory: (id: number) => React.ReactElement;
}
const customCalls: CustomCall[] = [];

jest.mock("sonner", () => ({
    toast: {
        custom: (factory: (id: number) => React.ReactElement) => {
            const id = nextSonnerId++;
            customCalls.push({ id, factory });
            return id;
        },
        dismiss: (id: string | number) => {
            dismissedIds.push(id);
            return id;
        },
    },
}));

// ─── fetch mock ─────────────────────────────────────────────────────

const fetchMock = jest.fn();
beforeEach(() => {
    customCalls.length = 0;
    dismissedIds.length = 0;
    nextSonnerId = 1;
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetch }).fetch =
        fetchMock as unknown as typeof fetch;
});

import TraceabilityPanel from "@/components/TraceabilityPanel";
import { __resetPendingUndoToastsForTest } from "@/components/ui/hooks/use-toast-with-undo";

beforeEach(() => {
    __resetPendingUndoToastsForTest();
});

// ─── Test harness ───────────────────────────────────────────────────

const TRACE_DATA = {
    risks: [
        {
            id: "trace-link-1",
            rationale: "primary",
            risk: { id: "risk-7", title: "Phishing", status: "OPEN", score: 9 },
        },
        {
            id: "trace-link-2",
            rationale: null,
            risk: { id: "risk-8", title: "Lost device", status: "MITIGATING", score: 6 },
        },
    ],
    controls: [],
    assets: [],
};

function ok(json: unknown) {
    return {
        ok: true,
        status: 200,
        json: async () => json,
    } as unknown as Response;
}

function setupRoute(): void {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (url.endsWith("/controls/ctrl-1/traceability")) return Promise.resolve(ok(TRACE_DATA));
        return Promise.resolve(ok({}));
    });
}

function mountPanel() {
    setupRoute();
    // Fresh per-test SWR cache (the panel reads traceability via useSWR);
    // a shared global cache would leak optimistic mutations between tests
    // and dedupe would serve stale data on the next mount. dedupingInterval
    // 0 keeps the rapid optimistic-write → revalidate cycle deterministic.
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider delayDuration={0}>
                <TraceabilityPanel
                    apiBase="/api/t/acme/"
                    entityType="control"
                    entityId="ctrl-1"
                    canLinkControlRisk
                    canLinkAsset
                    tenantHref={(p) => p}
                    tenantSlug="acme"
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

function clickUndo(): void {
    // Pull onUndo + pendingId off the captured factory's React element
    // and call it directly. We deliberately don't render the UndoToast
    // into the DOM — TraceabilityPanel test scope ends at "did the
    // trigger wire onUndo to the snapshot restore". The UI of the
    // toast itself has its own dedicated test in undo-toast.test.tsx.
    const last = customCalls[customCalls.length - 1];
    if (!last) throw new Error("no toast captured");
    const element = last.factory(last.id);
    const props = (element as unknown as {
        props: { onUndo: (id: string) => void; pendingId: string };
    }).props;
    props.onUndo(props.pendingId);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("TraceabilityPanel — unlink delayed-commit", () => {
    it("does not call fetch DELETE synchronously when Unlink is clicked", async () => {
        mountPanel();
        await waitFor(() => {
            expect(screen.getByText("Phishing")).toBeInTheDocument();
        });

        fetchMock.mockClear();
        // Re-route fetch so the only call we expect after this point
        // is the DELETE itself.
        fetchMock.mockResolvedValue(ok({}));

        fireEvent.click(screen.getByLabelText("Unlink risk", { selector: "#unlink-risk-risk-7" }));

        // Microtask flush — give optimistic setQueryData a tick.
        await act(async () => {
            await Promise.resolve();
        });

        const deleteCalls = fetchMock.mock.calls.filter(
            ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
        );
        expect(deleteCalls).toHaveLength(0);
        expect(customCalls).toHaveLength(1);
    });

    it("optimistic remove — the row disappears from the table immediately", async () => {
        mountPanel();
        await waitFor(() => {
            expect(screen.getByText("Phishing")).toBeInTheDocument();
        });

        fireEvent.click(screen.getByLabelText("Unlink risk", { selector: "#unlink-risk-risk-7" }));

        // The Phishing row goes via TanStack's notify scheduler
        // (setTimeout 0 internally). `waitFor` polls past that tick;
        // the second row must remain visible.
        await waitFor(() => {
            expect(screen.queryByText("Phishing")).not.toBeInTheDocument();
        });
        expect(screen.getByText("Lost device")).toBeInTheDocument();
    });

    it("after 5s the DELETE fires exactly once for the unlinked id", async () => {
        // Mount + load data under real timers (TanStack scheduler needs
        // them). Switch to fake timers ONCE the row is visible so we
        // can advance past the 5s undo window without waiting in
        // wall-clock time. Use `advanceTimersByTimeAsync` (Jest 30+)
        // which yields between batches so React's setState scheduler
        // gets to flush the optimistic cache write.
        mountPanel();
        await waitFor(() => {
            expect(screen.getByText("Phishing")).toBeInTheDocument();
        });

        fetchMock.mockClear();
        fetchMock.mockResolvedValue(ok({}));

        jest.useFakeTimers();
        try {
            fireEvent.click(
                screen.getByLabelText("Unlink risk", { selector: "#unlink-risk-risk-7" }),
            );

            await act(async () => {
                await jest.advanceTimersByTimeAsync(4999);
            });
            const before = fetchMock.mock.calls.filter(
                ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
            );
            expect(before).toHaveLength(0);

            await act(async () => {
                await jest.advanceTimersByTimeAsync(2);
            });

            const after = fetchMock.mock.calls.filter(
                ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
            );
            expect(after).toHaveLength(1);
            expect(after[0]?.[0]).toBe("/api/t/acme/controls/ctrl-1/risks/risk-7");
        } finally {
            jest.useRealTimers();
        }
    });

    it("clicking Undo cancels the commit and restores the row", async () => {
        mountPanel();
        await waitFor(() => {
            expect(screen.getByText("Phishing")).toBeInTheDocument();
        });

        fetchMock.mockClear();
        fetchMock.mockResolvedValue(ok({}));

        jest.useFakeTimers();
        try {
            fireEvent.click(
                screen.getByLabelText("Unlink risk", { selector: "#unlink-risk-risk-7" }),
            );

            // Yield zero fake-time so React commits the cache write.
            await act(async () => {
                await jest.advanceTimersByTimeAsync(0);
            });

            // Optimistically gone.
            expect(screen.queryByText("Phishing")).not.toBeInTheDocument();

            await act(async () => {
                await jest.advanceTimersByTimeAsync(2000);
                clickUndo();
                await jest.advanceTimersByTimeAsync(0);
            });

            // Restored.
            expect(screen.getByText("Phishing")).toBeInTheDocument();

            // Drive past the original deadline — fetch DELETE must NOT
            // run, even though the original timer would have fired.
            await act(async () => {
                await jest.advanceTimersByTimeAsync(10_000);
            });
            const deleteCalls = fetchMock.mock.calls.filter(
                ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
            );
            expect(deleteCalls).toHaveLength(0);
        } finally {
            jest.useRealTimers();
        }
    });
});
