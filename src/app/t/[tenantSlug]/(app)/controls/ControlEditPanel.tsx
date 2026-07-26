"use client";

/**
 * Control side-panel — EDITABLE (replaces the old read-only ControlQuickView).
 *
 * Opened by a single click on a control name. Two tabs:
 *   - Details: edit the control (name / category / frequency /
 *     owner) inline + an EVIDENCE UPLOAD box (replaces the old "Intent" field).
 *   - Activity: the control's hash-chained audit feed.
 *
 * Renders inside the docked <AsidePanel> (no overlay → the table stays
 * visible). Replaces the separate quick-edit Sheet, so there's no more table
 * blur and no separate edit button.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { buildCategoryOptions } from "@/lib/controls/control-categories";
import { Heading } from "@/components/ui/typography";
import { StatusBadge } from "@/components/ui/status-badge";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { UserCombobox } from "@/components/ui/user-combobox";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { EvidenceUploadSection } from "@/components/evidence/EvidenceUploadSection";
import { PanelTabs } from "./PanelTabs";
import { PanelActivityFeed } from "./PanelActivityFeed";

/** The subset of control row fields the panel needs to seed + display. */
export interface PanelControl {
    id: string;
    code?: string | null;
    annexId?: string | null;
    name: string;
    status?: string | null;
    category?: string | null;
    frequency?: string | null;
    ownerUserId?: string | null;
    owner?: { id?: string; name?: string | null; email?: string | null } | null;
}

const buildFrequencyOptions = (tx: (key: string) => string): ComboboxOption[] => [
    { value: "AD_HOC", label: tx("freq.adHoc") },
    { value: "DAILY", label: tx("freq.daily") },
    { value: "WEEKLY", label: tx("freq.weekly") },
    { value: "MONTHLY", label: tx("freq.monthly") },
    { value: "QUARTERLY", label: tx("freq.quarterly") },
    { value: "ANNUALLY", label: tx("freq.annually") },
];

type Tab = "details" | "activity";

export function ControlEditPanel({
    tenantSlug,
    control,
    canWrite,
    onSaved,
}: {
    tenantSlug: string;
    control: PanelControl;
    canWrite: boolean;
    /** Retained for API compatibility (AsidePanel owns the close affordance). */
    onClose?: () => void;
    /** Called after a successful save so the list reflects new name/owner. */
    onSaved: () => void;
}) {
    const tx = useTranslations("controls");
    const FREQUENCY_OPTIONS = buildFrequencyOptions(tx);
    const [tab, setTab] = useState<Tab>("details");
    const base = `/api/t/${tenantSlug}/controls/${control.id}`;

    // ── Edit form (seeded from the row) — AUTO-SAVED, no Save button ──
    // Field edits persist automatically: text fields debounce (~800ms) +
    // flush on blur; dropdowns + the owner picker commit on change. A
    // single "Saving…/Saved" status replaces the old Cancel/Save buttons.
    const [name, setName] = useState(control.name ?? "");
    const [category, setCategory] = useState(control.category ?? "");
    // Canonical ISO 27002 themes + the current value preserved as an option
    // when it's a legacy/granular/custom string, so a non-theme category shows
    // honestly and round-trips instead of reading as "—".
    const CATEGORY_OPTIONS = useMemo(
        () => buildCategoryOptions(category, (theme) => tx(`categoryLabels.${theme}`)),
        [category, tx],
    );
    const [frequency, setFrequency] = useState(control.frequency ?? "");
    const [ownerId, setOwnerId] = useState(control.owner?.id ?? control.ownerUserId ?? "");
    const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [error, setError] = useState("");

    // Latest field values, so a debounced/blurred commit PATCHes the
    // current form, never a stale closure. `update()` is the sole writer.
    const fieldsRef = useRef({
        name: control.name ?? "",
        category: control.category ?? "",
        frequency: control.frequency ?? "",
    });
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const nameInvalid = name.trim().length < 3;

    const commitFields = useCallback(async () => {
        if (!canWrite) return;
        const f = fieldsRef.current;
        if (f.name.trim().length < 3) {
            setError(tx("detail.errors.nameMin"));
            setSaveState("error");
            return;
        }
        setSaveState("saving");
        setError("");
        try {
            const res = await fetch(base, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: f.name.trim(),
                    category: f.category.trim() || null,
                    frequency: f.frequency || null,
                }),
            });
            if (!res.ok) {
                // Server reached but rejected the save (validation / auth /
                // conflict) — a distinct, translated outcome.
                setError(tx("detail.errors.saveFailed"));
                setSaveState("error");
                return;
            }
            setSaveState("saved");
            onSaved();
        } catch {
            // fetch() itself threw — network / offline / DNS. Route through
            // t() (never the raw technical Error string, which is untranslated).
            setError(tx("detail.errors.network"));
            setSaveState("error");
        }
    }, [canWrite, base, onSaved, tx]);

    const scheduleCommit = useCallback(() => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void commitFields(), 800);
    }, [commitFields]);

    const commitNow = useCallback(() => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        void commitFields();
    }, [commitFields]);

    /** Update a field's ref + state in lockstep, then save (debounced or now). */
    const update = useCallback(
        (partial: Partial<typeof fieldsRef.current>, immediate: boolean) => {
            fieldsRef.current = { ...fieldsRef.current, ...partial };
            if (partial.name !== undefined) setName(partial.name);
            if (partial.category !== undefined) setCategory(partial.category);
            if (partial.frequency !== undefined) setFrequency(partial.frequency);
            if (immediate) commitNow();
            else scheduleCommit();
        },
        [commitNow, scheduleCommit],
    );

    /** Owner persists via its own POST endpoint, on change. */
    const commitOwner = useCallback(
        async (userId: string) => {
            if (!canWrite) return;
            setSaveState("saving");
            setError("");
            try {
                const res = await fetch(`${base}/owner`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ownerUserId: userId || null }),
                });
                if (!res.ok) {
                    setError(tx("detail.errors.ownerUpdateFailed"));
                    setSaveState("error");
                    return;
                }
                setSaveState("saved");
                onSaved();
            } catch {
                setError(tx("detail.errors.network"));
                setSaveState("error");
            }
        },
        [canWrite, base, onSaved, tx],
    );

    return (
        <div className="space-y-default" role="region" aria-label={tx("detail.editorAria.control")} data-testid="control-edit-panel">
            <div className="flex items-center gap-tight">
                {(control.code || control.annexId) && (
                    <span className="font-mono text-xs text-content-muted">
                        {control.code || control.annexId}
                    </span>
                )}
                {control.status && (
                    <StatusBadge size="sm">{control.status.replace(/_/g, " ")}</StatusBadge>
                )}
            </div>

            {/* Reflect the edited local state (not the stale `control.name` prop)
                so the header tracks the name field live while editing. */}
            <Heading level={3} className="break-words">{name}</Heading>

            <PanelTabs<Tab>
                tabs={[{ id: "details", label: tx("detail.tabs.details") }, { id: "activity", label: tx("detail.tabs.activity") }]}
                active={tab}
                onSelect={setTab}
            />

            {tab === "details" ? (
                <div className="space-y-default">
                    {error && (
                        <div className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error" role="alert">
                            {error}
                        </div>
                    )}
                    {/* Auto-saved edit form (PATCH on change/blur) — no Save button. */}
                    <div className="space-y-default" data-testid="control-edit-form">
                        <fieldset className="space-y-default" disabled={!canWrite}>
                            <FormField label={tx("detail.fields.name")} required>
                                <Input
                                    id="panel-name-input"
                                    type="text"
                                    size="sm"
                                    value={name}
                                    onChange={(e) => update({ name: e.target.value }, false)}
                                    onBlur={commitNow}
                                    required
                                    minLength={3}
                                    invalid={nameInvalid}
                                />
                            </FormField>
                            <div>
                                <label className="mb-1 block text-sm text-content-default" htmlFor="panel-category-input">
                                    {tx("detail.fields.category")}
                                </label>
                                <Combobox
                                    id="panel-category-input"
                                    name="category"
                                    options={CATEGORY_OPTIONS}
                                    selected={CATEGORY_OPTIONS.find((o) => o.value === category) ?? null}
                                    setSelected={(o) => update({ category: o?.value ?? "" }, true)}
                                    placeholder="—"
                                    searchPlaceholder={tx("detail.fields.searchCategories")}
                                    disabled={!canWrite}
                                    matchTriggerWidth
                                    forceDropdown
                                    buttonProps={{ className: "w-full", size: "sm" }}
                                    caret
                                />
                            </div>
                            <div>
                                <label className="mb-1 block text-sm text-content-default" htmlFor="panel-frequency-input">
                                    {tx("detail.fields.frequency")}
                                </label>
                                <Combobox
                                    id="panel-frequency-input"
                                    name="frequency"
                                    options={FREQUENCY_OPTIONS}
                                    selected={FREQUENCY_OPTIONS.find((o) => o.value === frequency) ?? null}
                                    setSelected={(o) => update({ frequency: o?.value ?? "" }, true)}
                                    placeholder="—"
                                    disabled={!canWrite}
                                    hideSearch
                                    matchTriggerWidth
                                    forceDropdown
                                    buttonProps={{ className: "w-full", size: "sm" }}
                                    caret
                                />
                            </div>
                            <FormField label={tx("detail.fields.owner")} description={tx("detail.fields.ownerHint")}>
                                <UserCombobox
                                    id="panel-owner-input"
                                    name="ownerUserId"
                                    tenantSlug={tenantSlug}
                                    disabled={!canWrite}
                                    size="sm"
                                    selectedId={ownerId || null}
                                    onChange={(userId) => {
                                        setOwnerId(userId ?? "");
                                        void commitOwner(userId ?? "");
                                    }}
                                    placeholder={control.owner?.name || control.owner?.email || tx("detail.fields.unassigned")}
                                />
                            </FormField>
                        </fieldset>
                        {canWrite && (
                            <p
                                className="text-xs text-content-muted"
                                data-testid="control-edit-autosave-status"
                                aria-live="polite"
                            >
                                {saveState === "saving"
                                    ? tx("detail.autosave.saving")
                                    : saveState === "saved"
                                      ? tx("detail.autosave.saved")
                                      : saveState === "error"
                                        ? tx("detail.autosave.notSaved")
                                        : tx("detail.autosave.auto")}
                            </p>
                        )}
                    </div>

                    {/* Drag-and-drop evidence upload (canonical FileDropzone, compact in the rail). */}
                    <EvidenceUploadSection
                        tenantSlug={tenantSlug}
                        linkField="controlId"
                        linkId={control.id}
                        canWrite={canWrite}
                        compactDropzone
                        listEndpoint={`/controls/${control.id}/evidence`}
                        urlLinkEndpoint={`/controls/${control.id}/evidence`}
                        urlLinkBody={(url, note) => ({ kind: "LINK", url, note: note || undefined })}
                    />
                </div>
            ) : (
                <PanelActivityFeed tenantSlug={tenantSlug} endpoint={`/controls/${control.id}/activity`} />
            )}
        </div>
    );
}
