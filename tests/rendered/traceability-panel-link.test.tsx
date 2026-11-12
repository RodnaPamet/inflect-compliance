/**
 * TraceabilityPanel — Link form regressions.
 *
 * Mounts the real `<TraceabilityPanel>` (entityType=asset) and asserts
 * the two bugs reported on the asset detail page:
 *
 *   1. Opening BOTH the Link Risk and Link Control forms then committing
 *      one of them must leave the OTHER form open. Pre-fix the shared
 *      `linkMutation.onSuccess` callback closed all three `showAdd*`
 *      flags unconditionally, so the second form disappeared mid-flow.
 *
 *   2. Control / risk / asset options in the Combobox are rendered via
 *      `optionDescription` so the cmdk row uses the wrapping
 *      (description-mode) layout — i.e. no `truncate` class on the
 *      label span — keeping long names readable.
 */
/** @jest-environment jsdom */

import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { TooltipProvider } from "@/components/ui/tooltip";

const toastError = jest.fn();
jest.mock("@inflect/ui/components/ui/hooks/use-toast", () => ({
    ...jest.requireActual("@inflect/ui/components/ui/hooks/use-toast"),
    useToast: () => ({ error: toastError, success: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));

import TraceabilityPanel from "@/components/TraceabilityPanel";

// ─── jsdom — pin to desktop so Combobox uses Popover, not Drawer ────
// `tests/rendered/setup.ts` stubs matchMedia to always return
// `matches: false`, which makes `useMediaQuery` resolve to `mobile`
// and switches Combobox into Vaul Drawer mode — the dropdown
// listbox under test doesn't render in that branch. Force desktop
// by reporting a match on the desktop min-width query.
const originalMatchMedia = window.matchMedia;
beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: (query: string) => ({
            matches: query.includes("1024"),
            media: query,
            onchange: null,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        }),
    });
});
afterAll(() => {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: originalMatchMedia,
    });
});

// ─── fetch mock ─────────────────────────────────────────────────────

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetch }).fetch =
        fetchMock as unknown as typeof fetch;
});

const EMPTY_TRACE = { risks: [], controls: [], assets: [] };

const AVAILABLE_RISKS = [
    { id: "risk-1", title: "Phishing attack against credentialed staff", status: "OPEN" },
    { id: "risk-2", title: "Lost mobile device", status: "MITIGATING" },
];

const AVAILABLE_CONTROLS = [
    {
        id: "ctrl-1",
        code: "AC-2",
        // Deliberately long — pre-fix this triggered `truncate` on the
        // option label span. With `optionDescription` wired up the row
        // switches to flex-col + whitespace-normal and the name wraps.
        name: "Information Security Policy Management and Acceptable Use Procedure for Enterprise SaaS Applications",
        status: "APPROVED",
    },
    { id: "ctrl-2", code: "AC-3", name: "Account management", status: "DESIGN" },
];

function ok(json: unknown) {
    return {
        ok: true,
        status: 200,
        json: async () => json,
    } as unknown as Response;
}

function setupRoutes(): void {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (url.endsWith("/assets/asset-1/traceability")) return Promise.resolve(ok(EMPTY_TRACE));
        if (url.endsWith("/risks")) return Promise.resolve(ok(AVAILABLE_RISKS));
        if (url.endsWith("/controls")) return Promise.resolve(ok(AVAILABLE_CONTROLS));
        if (init?.method === "POST" && url.endsWith("/assets/asset-1/controls")) {
            return Promise.resolve(ok({ id: "link-1" }));
        }
        return Promise.resolve(ok({}));
    });
}

function mountPanel() {
    setupRoutes();
    // Fresh per-test SWR cache (the panel reads traceability via useSWR);
    // dedupingInterval 0 keeps the link → revalidate cycle deterministic.
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider delayDuration={0}>
                <TraceabilityPanel
                    apiBase="/api/t/acme/"
                    entityType="asset"
                    entityId="asset-1"
                    canLinkControlRisk
                    canLinkAsset
                    tenantHref={(p) => p}
                    tenantSlug="acme"
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

describe("TraceabilityPanel — link form regressions", () => {
    it("committing one Link form leaves the other open", async () => {
        const user = userEvent.setup();
        mountPanel();

        await waitFor(() => {
            expect(screen.getByText("No risks linked")).toBeInTheDocument();
        });

        // Open BOTH forms.
        await user.click(screen.getByRole("button", { name: "Link Risk" }));
        await user.click(screen.getByRole("button", { name: "Link Control" }));

        // Each form's rationale field has a name, not just a placeholder (#4991).
        expect(screen.getAllByRole("textbox", { name: "Rationale (optional)" })).toHaveLength(2);

        // Wait for the available-controls fetch to populate so the
        // combobox has options to render.
        await waitFor(() => {
            const calls = fetchMock.mock.calls.map(([u]) =>
                typeof u === "string" ? u : (u as URL).toString(),
            );
            expect(calls.some((u) => u.endsWith("/controls"))).toBe(true);
        });

        // Open the Control popover and pick ctrl-2.
        const controlTrigger = document.getElementById("control-select") as HTMLButtonElement;
        await user.click(controlTrigger);
        // Label format is `${code} — ${name}` since the fix.
        const option = await screen.findByText("AC-3 — Account management");
        await user.click(option);

        // Confirm the link.
        const confirm = document.getElementById("confirm-control-link") as HTMLButtonElement;
        await waitFor(() => {
            expect(confirm).not.toBeDisabled();
        });
        await act(async () => {
            await user.click(confirm);
        });

        // After success: Control form gone, Risk form STILL THERE.
        await waitFor(() => {
            expect(document.getElementById("control-select")).not.toBeInTheDocument();
        });
        expect(document.getElementById("risk-select")).toBeInTheDocument();
    });

    it("control combobox options render with optionDescription (no truncate on label)", async () => {
        const user = userEvent.setup();
        mountPanel();

        await waitFor(() => {
            expect(screen.getByText("No risks linked")).toBeInTheDocument();
        });

        await user.click(screen.getByRole("button", { name: "Link Control" }));

        // Wait for the available-controls fetch to populate.
        await waitFor(() => {
            const calls = fetchMock.mock.calls.map(([u]) =>
                typeof u === "string" ? u : (u as URL).toString(),
            );
            expect(calls.some((u) => u.endsWith("/controls"))).toBe(true);
        });

        const controlTrigger = document.getElementById("control-select") as HTMLButtonElement;
        await user.click(controlTrigger);

        // The long control name renders; locate the label span — it must
        // NOT carry the `truncate` class (the description-mode branch in
        // Combobox suppresses it), and the description ("Status: …")
        // must appear as a separate node.
        const labelNode = await screen.findByText(
            "AC-2 — Information Security Policy Management and Acceptable Use Procedure for Enterprise SaaS Applications",
        );
        expect(labelNode.className).not.toMatch(/\btruncate\b/);
        expect(screen.getByText("Status: APPROVED")).toBeInTheDocument();
    });
});

describe("TraceabilityPanel — each section follows the key its route takes (#5227)", () => {
    function mountControl(flags: { canLinkControlRisk: boolean; canLinkAsset: boolean }) {
        fetchMock.mockImplementation(() => Promise.resolve(ok(EMPTY_TRACE)));
        return render(
            <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
                <TooltipProvider delayDuration={0}>
                    <TraceabilityPanel
                        apiBase="/api/t/acme/"
                        entityType="control"
                        entityId="ctrl-9"
                        {...flags}
                        tenantHref={(p) => p}
                        tenantSlug="acme"
                    />
                </TooltipProvider>
            </SWRConfig>,
        );
    }

    it("controls.edit without assets.edit offers risk links, not asset links", async () => {
        mountControl({ canLinkControlRisk: true, canLinkAsset: false });
        await waitFor(() => expect(screen.getByText("No risks linked")).toBeInTheDocument());
        expect(screen.getByRole("button", { name: "Link Risk" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Link Asset" })).toBeNull();
    });

    it("assets.edit without controls.edit offers asset links, not risk links", async () => {
        mountControl({ canLinkControlRisk: false, canLinkAsset: true });
        await waitFor(() => expect(screen.getByText("No risks linked")).toBeInTheDocument());
        expect(screen.getByRole("button", { name: "Link Asset" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Link Risk" })).toBeNull();
    });

    it("a refused link says why", async () => {
        toastError.mockReset();
        const user = userEvent.setup();
        mountPanel();
        fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : (input as URL).toString();
            if (init?.method === "POST") {
                return Promise.resolve({
                    ok: false,
                    status: 403,
                    json: async () => ({ error: { code: "FORBIDDEN", message: "You cannot edit assets." } }),
                } as unknown as Response);
            }
            if (url.endsWith("/assets/asset-1/traceability")) return Promise.resolve(ok(EMPTY_TRACE));
            if (url.endsWith("/controls")) return Promise.resolve(ok(AVAILABLE_CONTROLS));
            return Promise.resolve(ok([]));
        });
        await waitFor(() => expect(screen.getByText("No risks linked")).toBeInTheDocument());
        await user.click(screen.getByRole("button", { name: "Link Control" }));
        await user.click(document.getElementById("control-select") as HTMLButtonElement);
        await user.click(await screen.findByText("AC-3 — Account management"));
        const confirm = document.getElementById("confirm-control-link") as HTMLButtonElement;
        await waitFor(() => expect(confirm).not.toBeDisabled());
        await act(async () => {
            await user.click(confirm);
        });
        await waitFor(() => expect(toastError).toHaveBeenCalledWith("You cannot edit assets."));
        // The form stays open for another try.
        expect(document.getElementById("control-select")).toBeInTheDocument();
    });
});
