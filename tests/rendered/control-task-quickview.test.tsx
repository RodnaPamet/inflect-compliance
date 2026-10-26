/**
 * Controls side panel — inline task rows + the editable control panel.
 *
 * ControlTaskRows renders REAL <tr>/<td> rows aligned to the parent columns;
 * clicking a row fires onTaskClick (→ task panel). ControlEditPanel is the
 * EDITABLE control side panel: an edit form + an evidence-upload box (replacing
 * the old Intent field) + an Activity tab. (The old read-only ControlQuickView
 * / TaskQuickView were removed.)
 */
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";
import { SWRConfig } from 'swr';

// next-intl is ESM (jest can't parse its export); mock it to resolve real
// en.json values so the panel renders the original English.
jest.mock("next-intl", () => {
    const en = require("../../messages/en.json");
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key
                .split(".")
                .reduce((o: unknown, k) =>
                    o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined, en[ns]);
            if (typeof v !== "string") return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, "g"), String(val));
            return v;
        },
        useLocale: () => "en",
    };
});

jest.mock("@/lib/tenant-context-provider", () => ({
    useTenantHref: () => (p: string) => `/t/acme${p}`,
}));

// UserCombobox (member lookup) reads via useSWR — wrap renders in a fresh
// per-test SWR cache.
const withQuery = (ui: React.ReactElement) => (
    <SWRConfig value={{ provider: () => new Map() }}>
        {ui}
    </SWRConfig>
);

import { ControlTaskRows } from "@/components/controls-shared/ControlTaskRows";
import { ControlEditPanel } from "@/app/t/[tenantSlug]/(app)/controls/ControlEditPanel";

const TASK = {
    id: "t1",
    key: "TSK-9",
    title: "Implement SSO enforcement",
    status: "OPEN",
    severity: "HIGH",
    assignee: { name: "Sam Ray" },
    _count: { evidence: 3 },
};

const CONTROL = {
    id: "c1",
    code: "A.1",
    name: "Access control policy",
    status: "IN_PROGRESS",
    category: "Access Control",
    owner: { id: "u1", name: "Dana Lee", email: "dana@x.io" },
};

describe("ControlTaskRows (aligned inline sub-rows → quick-view)", () => {
    beforeEach(() => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => [TASK],
        })) as unknown as typeof fetch;
    });

    const COLUMN_IDS = ["select", "name", "category", "status", "owner", "evidence", "menu"];
    const renderRows = (onTaskClick = jest.fn()) => {
        const utils = render(
            <table>
                <tbody>
                    <ControlTaskRows
                        tenantSlug="acme"
                        controlId="c1"
                        controlCategory="Access Control"
                        columnIds={COLUMN_IDS}
                        renderEvidence={(n) => <span>{n} evidence</span>}
                        onTaskClick={onTaskClick}
                    />
                </tbody>
            </table>,
        );
        return { ...utils, onTaskClick };
    };

    it("renders task metadata in the matching columns: category / status / owner / evidence", async () => {
        const { container } = renderRows();
        await screen.findByText("Implement SSO enforcement");
        expect(screen.getByText("Access Control")).toBeInTheDocument();
        expect(screen.getByText("Sam Ray")).toBeInTheDocument();
        expect(screen.getByText("3 evidence")).toBeInTheDocument();
        // TP-1: the status badge now renders the shared, localized label
        // (tasks.statusLabels.OPEN = "Open"), not the raw enum value.
        expect(screen.getByText("Open")).toBeInTheDocument();
        const row = container.querySelector('[data-task-quickview="t1"]');
        expect(row?.tagName).toBe("TR");
        expect(row?.className).toContain("cursor-pointer");
        expect(row?.querySelectorAll("td").length).toBe(COLUMN_IDS.length);
    });

    it("clicking anywhere on the task row fires onTaskClick (whole-row target)", async () => {
        const { onTaskClick } = renderRows();
        const badge = await screen.findByText("Open");
        fireEvent.click(badge);
        expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
    });
});

describe("ControlEditPanel (editable control side panel)", () => {
    beforeEach(() => {
        // Broad mock: evidence list + activity feed + member lookups → empty.
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => [],
        })) as unknown as typeof fetch;
    });

    const renderPanel = (canUploadEvidence = true, canWrite = true) =>
        render(
            withQuery(
                <ControlEditPanel
                    tenantSlug="acme"
                    control={CONTROL}
                    canWrite={canWrite}
                    canUploadEvidence={canUploadEvidence}
                    onClose={jest.fn()}
                    onSaved={jest.fn()}
                />,
            ),
        );

    it("is an auto-saved edit form with an evidence-upload box and NO Intent field", () => {
        renderPanel();
        expect(screen.getByTestId("control-edit-panel")).toBeInTheDocument();
        expect(screen.getByTestId("control-edit-form")).toBeInTheDocument();
        // Auto-save: a live status line replaces the manual Save/Cancel buttons.
        expect(screen.getByTestId("control-edit-autosave-status")).toBeInTheDocument();
        expect(screen.queryByTestId("control-edit-save")).not.toBeInTheDocument();
        expect(screen.queryByTestId("control-edit-cancel")).not.toBeInTheDocument();
        // Drag-and-drop evidence upload (shared FileDropzone section).
        expect(screen.getByTestId("evidence-upload-section")).toBeInTheDocument();
        expect(screen.getByTestId("evidence-upload-dropzone")).toBeInTheDocument();
        // The old Intent field is gone, replaced by evidence upload.
        expect(screen.queryByText("Intent")).not.toBeInTheDocument();
        // Seeded from the row.
        expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe(
            "Access control policy",
        );
    });

    it("withholds only the dropzone without `evidence.upload`, keeping the form and the URL link (#4325)", () => {
        // The panel opens on `canWrite && controls.edit`; a FILE upload POSTs to
        // `/evidence/uploads`, which asks `evidence.upload`. A custom role with
        // one and not the other was shown the dropzone and refused.
        //
        // Only the dropzone goes. The URL link posts to the control's own
        // evidence route, which asks `controls.edit`, and the form stays
        // editable. The case above is the positive control.
        renderPanel(false);

        expect(screen.getByTestId("evidence-upload-section")).toBeInTheDocument();
        expect(screen.queryByTestId("evidence-upload-dropzone")).not.toBeInTheDocument();
        expect(screen.getByTestId("evidence-link-url-form")).toBeInTheDocument();

        expect(screen.getByTestId("control-edit-form")).toBeInTheDocument();
        expect((screen.getByLabelText(/Name/) as HTMLInputElement).disabled).toBe(false);
    });

    it("still lists the attached evidence for a read-only role without `evidence.upload`", async () => {
        // Readers, Auditors and AI admins hold no `evidence.upload`. Hiding the
        // whole section on that key took the control's evidence out of their
        // quick view. They get the list, and neither the dropzone nor the link.
        global.fetch = jest.fn(async (url: string) => ({
            ok: true,
            json: async () =>
                String(url).endsWith("/controls/c1/evidence")
                    ? { links: [{ id: "l1", kind: "LINK", url: "https://example.com/report", note: "Pen-test report" }] }
                    : [],
        })) as unknown as typeof fetch;

        renderPanel(false, false);

        expect(await screen.findByTestId("evidence-attached-list")).toBeInTheDocument();
        expect(screen.getByText("Pen-test report")).toBeInTheDocument();
        expect(screen.queryByTestId("evidence-upload-dropzone")).not.toBeInTheDocument();
        expect(screen.queryByTestId("evidence-link-url-form")).not.toBeInTheDocument();
    });

    it("auto-saves the name on blur with a PATCH (no Save click)", async () => {
        renderPanel();
        const fetchMock = global.fetch as jest.Mock;
        fetchMock.mockClear();
        const nameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
        fireEvent.change(nameInput, { target: { value: "Access control policy v2" } });
        fireEvent.blur(nameInput);
        await screen.findByText("Saved");
        const patch = fetchMock.mock.calls.find(
            ([url, opts]) =>
                typeof url === "string" &&
                url.endsWith("/controls/c1") &&
                (opts as RequestInit | undefined)?.method === "PATCH",
        );
        expect(patch).toBeDefined();
        expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({
            name: "Access control policy v2",
        });
    });

    it("does NOT save a name shorter than 3 chars", async () => {
        renderPanel();
        const fetchMock = global.fetch as jest.Mock;
        fetchMock.mockClear();
        const nameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
        fireEvent.change(nameInput, { target: { value: "ab" } });
        fireEvent.blur(nameInput);
        await screen.findByText(/at least 3 characters/i);
        const patched = (fetchMock.mock.calls as Array<[unknown, RequestInit | undefined]>).some(
            ([, opts]) => opts?.method === "PATCH",
        );
        expect(patched).toBe(false);
    });

    it("shows the status as its localized label, not the enum", () => {
        // The badge printed `status.replace(/_/g, " ")` — "NEEDS REVIEW",
        // "NOT STARTED" — while the table beside it shows the label.
        const en = require("../../messages/en.json");
        render(
            withQuery(
                <ControlEditPanel
                    tenantSlug="acme"
                    control={{ ...CONTROL, status: "NEEDS_REVIEW" }}
                    canWrite
                canUploadEvidence
                    onClose={jest.fn()}
                    onSaved={jest.fn()}
                />,
            ),
        );
        const panel = screen.getByTestId("control-edit-panel");
        expect(panel).toHaveTextContent(en.controls.filterEnums.status.NEEDS_REVIEW);
        expect(panel).not.toHaveTextContent("NEEDS REVIEW");
    });

    it("has an Activity tab that shows the feed", async () => {
        renderPanel();
        fireEvent.click(screen.getByText("Activity"));
        // Empty feed (mock returns []).
        expect(await screen.findByText("No activity yet.")).toBeInTheDocument();
        // The edit form is hidden while on the Activity tab.
        expect(screen.queryByTestId("control-edit-form")).not.toBeInTheDocument();
    });
});
