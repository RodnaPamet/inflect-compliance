/**
 * Controls side-panel interaction ratchet (editable panel redesign, 2026-06).
 *
 * Locks the full Controls table → side-panel interaction:
 *   - single-click the row → SELECT (selection wired)
 *   - single-click the NAME → editable control panel + expands inline tasks
 *   - double-click the row → full detail page
 *   - click an inline task → editable task panel
 *   - both panels render in the docked <AsidePanel> (NO overlay/blur → the
 *     table stays visible); Escape closes
 *   - the panels are EDIT-FIRST (form + Save); the control panel's old "Intent"
 *     field is replaced by an evidence-upload box; each panel has an Activity
 *     tab. There is NO separate quick-edit button and NO edit Sheet.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const controls = read("src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx");
const editPanel = read("src/app/t/[tenantSlug]/(app)/controls/ControlEditPanel.tsx");
const taskPanel = read("src/components/controls-shared/TaskEditPanel.tsx");
const userCombobox = read("src/components/ui/user-combobox.tsx");
const aside = read("src/components/ui/aside-panel.tsx");
const sheet = read("src/components/ui/sheet.tsx");
const evidenceSection = read("src/components/evidence/EvidenceUploadSection.tsx");
const activityFeed = read("src/components/controls-shared/PanelActivityFeed.tsx");

describe("Controls editable side-panel interaction", () => {
    it("the title cell is a <button> that opens the panel + expands inline tasks", () => {
        expect(controls).toMatch(/onClick=\{[\s\S]{0,80}openControlQuickView\(row\.original\)/);
        expect(controls).toMatch(/data-testid={`control-title-/);
        expect(controls).toMatch(/openControlQuickView\(row\.original\);[\s\S]{0,120}row\.toggleExpanded\(true\)/);
    });

    it("row selection stays on; double-click opens the full detail page", () => {
        expect(controls).not.toMatch(/selectionEnabled=\{?false/);
        expect(controls).toMatch(/onRowSelectionChange/);
        expect(controls).toMatch(/onRowClick: handleRowClick/);
        expect(controls).toMatch(/handleRowClick[\s\S]{0,120}\/controls\/\$\{row\.original\.id\}/);
    });

    it("the EDITABLE panels mount (not the old read-only quick-views)", () => {
        expect(controls).toMatch(/<ControlEditPanel/);
        expect(controls).toMatch(/<TaskEditPanel/);
        expect(controls).not.toMatch(/<ControlQuickView/);
        expect(controls).not.toMatch(/<TaskQuickView/);
        // Clicking an inline task opens the task panel; saving refreshes the list.
        expect(controls).toMatch(/onTaskClick=\{setSelectedTask\}/);
        expect(controls).toMatch(/onSaved=\{handlePanelSaved\}/);
    });

    it("the panels surface in the responsive AsidePanel keyed by entity id", () => {
        expect(controls).toMatch(/<AsidePanel[\s\S]{0,400}openOnMount[\s\S]{0,200}onClose=\{closeQuickView\}/);
        // Keyed by ID (not just type) so switching control→control forces a
        // fresh mount → the panel re-seeds from the newly-clicked row.
        expect(controls).toMatch(/key=\{`qv-task-\$\{selectedTask\.id\}`\}/);
        expect(controls).toMatch(/key=\{`qv-control-\$\{selectedControl\.id\}`\}/);
    });

    it("Escape closes the panel", () => {
        expect(controls).toMatch(/useKeyboardShortcut\(\[['"]Escape['"]\], closeQuickView/);
    });

    it("the edit button (quick-edit column) and edit Sheet are REMOVED", () => {
        expect(controls).not.toMatch(/control-quick-edit-/);
        expect(controls).not.toMatch(/<ControlDetailSheet/);
        expect(controls).not.toMatch(/setSheetControlId/);
    });

    it("the panels have NO back / close (✕) chrome buttons", () => {
        // Removed by request — the AsidePanel collapse chevron + Escape +
        // clicking another row remain the close/switch affordances.
        expect(editPanel).not.toMatch(/aria-label="Close quick view"/);
        expect(taskPanel).not.toMatch(/aria-label="Close quick view"/);
        expect(taskPanel).not.toMatch(/data-testid="task-edit-back"/);
    });

    it("the dropdowns are one size smaller (sm trigger)", () => {
        // Combobox triggers pass `size: "sm"` (h-8) instead of the md default.
        expect(editPanel).toMatch(/buttonProps=\{\{[^}]*size:\s*["']sm["']/);
        expect(taskPanel).toMatch(/buttonProps=\{\{[^}]*size:\s*["']sm["']/);
    });

    it("EVERY rail dropdown is sm — category, frequency, AND owner (uniform size ratchet)", () => {
        // The owner picker is a <UserCombobox> (wraps Combobox); it must
        // carry size="sm" so it lines up with the Category/Frequency triggers
        // rather than rendering one size taller. Locks the fix + guards any
        // future dropdown added to the rail from defaulting back to md.
        expect(editPanel).toMatch(/<UserCombobox[\s\S]{0,400}size="sm"/);
        // No rail Combobox may opt back into md/lg.
        expect(editPanel).not.toMatch(/buttonProps=\{\{[^}]*size:\s*["'](?:md|lg)["']/);
        // The UserCombobox forwards its size to the inner Combobox trigger.
        expect(userCombobox).toMatch(/size\?:\s*["']sm["']\s*\|\s*["']md["']\s*\|\s*["']lg["']/);
        expect(userCombobox).toMatch(/\.\.\.\(size\s*\?\s*\{\s*size\s*\}\s*:\s*\{\}\)/);
    });

    describe("control panel = AUTO-SAVED + drag-drop evidence + Activity tab", () => {
        it("auto-saves on change/blur — no Save/Cancel buttons", () => {
            expect(editPanel).toMatch(/data-testid="control-edit-form"/);
            expect(editPanel).toMatch(/method:\s*["']PATCH["']/);
            expect(editPanel).toMatch(/role="region"/);
            // The manual Save/Cancel buttons are gone — edits persist
            // automatically (text debounces + flushes on blur; dropdowns +
            // owner commit on change). A live status line replaces them.
            expect(editPanel).not.toMatch(/data-testid="control-edit-save"/);
            expect(editPanel).not.toMatch(/data-testid="control-edit-cancel"/);
            expect(editPanel).toMatch(/data-testid="control-edit-autosave-status"/);
            // The debounce + flush-on-blur engine is DELEGATED, not inlined.
            // This used to assert the literal
            // `setTimeout(() => void commitFields(), 800)` here AND in the
            // task panel — an assertion that required the two copies to exist
            // and verified nothing about what the debounce did. The engine is
            // now `useAutosaveFields`, covered behaviourally in
            // src/components/ui/hooks/__tests__/use-autosave-fields.test.tsx.
            expect(editPanel).toMatch(/onBlur=\{commitNow\}/);
            expect(editPanel).toMatch(/useAutosaveFields\(/);
            expect(editPanel).not.toMatch(/setTimeout\(/);
        });
        it("mounts the shared drag-drop EvidenceUploadSection (controlId), compact dropzone, no Intent field", () => {
            expect(editPanel).toMatch(/<EvidenceUploadSection/);
            expect(editPanel).toMatch(/linkField="controlId"/);
            // The rail uses the short (compact) dropzone — ~1/3 the height.
            expect(editPanel).toMatch(/compactDropzone/);
            expect(editPanel).not.toMatch(/sheet-intent-input/);
            expect(editPanel).not.toMatch(/panel-intent/);
            expect(editPanel).not.toMatch(/\bintent:\s*draft|form\.intent|update\('intent'/);
        });
        it("has an Activity tab backed by the activity feed", () => {
            expect(editPanel).toMatch(/PanelActivityFeed/);
            expect(editPanel).toMatch(/\/controls\/\$\{control\.id\}\/activity/);
            expect(editPanel).toMatch(/label: tx\("detail\.tabs\.activity"\)/);
            expect(JSON.parse(read("messages/en.json")).controls.detail.tabs.activity).toBe("Activity");
        });
    });

    describe("task panel = AUTO-SAVED + drag-drop evidence + Activity tab", () => {
        it("auto-saves on change/blur — no Save/Cancel buttons", () => {
            expect(taskPanel).toMatch(/data-testid="task-edit-form"/);
            expect(taskPanel).toMatch(/method:\s*["']PATCH["']/);
            expect(taskPanel).toMatch(/role="region"/);
            expect(taskPanel).not.toMatch(/data-testid="task-edit-save"/);
            expect(taskPanel).not.toMatch(/data-testid="task-edit-cancel"/);
            expect(taskPanel).toMatch(/data-testid="task-edit-autosave-status"/);
            expect(taskPanel).toMatch(/onBlur=\{commitNow\}/);
            // Same engine as the control panel — see the note there.
            expect(taskPanel).toMatch(/useAutosaveFields\(/);
            expect(taskPanel).not.toMatch(/setTimeout\(/);
            // Assignee picker lines up at sm with the other rail dropdowns.
            expect(taskPanel).toMatch(/<UserCombobox[\s\S]{0,400}size="sm"/);
            expect(taskPanel).not.toMatch(/buttonProps=\{\{[^}]*size:\s*["'](?:md|lg)["']/);
        });
        it("mounts the shared drag-drop EvidenceUploadSection (taskId), compact dropzone", () => {
            expect(taskPanel).toMatch(/<EvidenceUploadSection/);
            expect(taskPanel).toMatch(/linkField="taskId"/);
            expect(taskPanel).toMatch(/compactDropzone/);
        });
        it("has an Activity tab backed by the activity feed", () => {
            expect(taskPanel).toMatch(/PanelActivityFeed/);
            expect(taskPanel).toMatch(/\/tasks\/\$\{task\.id\}\/activity/);
        });
    });

    describe("EvidenceUploadSection = canonical drag-drop uploader", () => {
        it("wraps FileDropzone and links via the /evidence/uploads POST", () => {
            expect(evidenceSection).toMatch(/<FileDropzone/);
            expect(evidenceSection).toMatch(/evidence\/uploads/);
            expect(evidenceSection).toMatch(/fd\.append\(linkField, linkId\)/);
        });
        it("also offers a URL-link affordance beneath the dropzone", () => {
            expect(evidenceSection).toMatch(/urlLinkEndpoint/);
            expect(evidenceSection).toMatch(/data-testid="evidence-link-url-form"/);
            // Each surface wires its URL-link endpoint.
            expect(editPanel).toMatch(/urlLinkEndpoint=/);
            expect(editPanel).toMatch(/kind: "LINK"/);
            expect(taskPanel).toMatch(/urlLinkEndpoint=/);
        });
        it("the risk/asset attached-evidence panel adopts it (drops EvidenceAddForm)", () => {
            const attached = read("src/components/AttachedEvidencePanel.tsx");
            expect(attached).toMatch(/<EvidenceUploadSection/);
            expect(attached).not.toMatch(/EvidenceAddForm/);
        });
    });

    describe("Activity feed reads as human sentences, not a log", () => {
        it("uses relative time + an action→phrase map, not a raw code dump", () => {
            expect(activityFeed).toMatch(/formatRelativeTime/);
            expect(activityFeed).toMatch(/phraseFor/);
            expect(activityFeed).toMatch(/ACTION_PHRASE/);
            // The old raw-timestamp log column is gone.
            expect(activityFeed).not.toMatch(/formatDateTime/);
        });
    });

    it("the AsidePanel does NOT blur/dim the table (no-blur overlay)", () => {
        // The Sheet primitive accepts an overlay override; the AsidePanel
        // passes a transparent one so the page (table) stays visible.
        expect(sheet).toMatch(/overlayClassName/);
        expect(aside).toMatch(/overlayClassName="fixed inset-0 z-40"/);
    });

    it("openOnMount opens the Sheet ONLY below xl (≥xl uses the docked rail, no overlay)", () => {
        // The bug this locks: opening the Sheet on ≥xl too floated a
        // full-viewport overlay over the table that swallowed the next
        // click, forcing a close-then-reopen to switch rows. ≥xl now relies
        // solely on the docked rail.
        expect(aside).toMatch(/max-width:\s*1279\.98px/);
        expect(aside).toMatch(/if\s*\(belowXl\)\s*setSheetOpen\(true\)/);
    });
});
