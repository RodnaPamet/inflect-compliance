"use client";

/**
 * Read-only activity feed for the control / task side-panel "Activity" tab.
 * Fetches the entity's hash-chained audit entries (newest first) and renders
 * each as a plain-language sentence — "Dana Lee changed the status · 2 hours
 * ago" — rather than a raw action-code log. Shared by both edit panels.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { formatRelativeTime } from "@/lib/format-date";

interface ActivityEntry {
    id: string;
    action: string;
    details?: string | null;
    createdAt: string | Date;
    user?: { name?: string | null; email?: string | null } | null;
}

// Action code → i18n key suffix under `controls.activity.<suffix>`. The
// resolved phrase reads "{actor} {phrase}" (e.g. "Dana Lee changed the
// status"). Several codes share a phrase, so they map to the same key.
// An unmapped action falls back to the lowercased, space-separated code so
// it still reads as a sentence ("Dana Lee status changed") rather than
// "STATUS_CHANGED".
const ACTION_PHRASE: Record<string, string> = {
    CREATED: "created",
    UPDATED: "updatedDetails",
    EDITED: "updatedDetails",
    STATUS_CHANGED: "statusChanged",
    STATE_CHANGED: "statusChanged",
    ASSIGNED: "assigneeChanged",
    ASSIGNEE_CHANGED: "assigneeChanged",
    REASSIGNED: "reassigned",
    OWNER_CHANGED: "ownerChanged",
    DUE_DATE_CHANGED: "dueDateChanged",
    PRIORITY_CHANGED: "priorityChanged",
    SEVERITY_CHANGED: "severityChanged",
    EVIDENCE_ADDED: "evidenceAdded",
    EVIDENCE_UPLOADED: "evidenceUploaded",
    EVIDENCE_LINKED: "evidenceLinked",
    EVIDENCE_REMOVED: "evidenceRemoved",
    EVIDENCE_DETACHED: "evidenceRemoved",
    COMMENT_ADDED: "commented",
    COMMENTED: "commented",
    LINKED: "linked",
    UNLINKED: "unlinked",
    ARCHIVED: "archived",
    DELETED: "deleted",
    TASK_CREATED: "taskCreated",
    TASK_COMPLETED: "taskCompleted",
    TEST_COMPLETED: "testCompleted",
    TEST_LOGGED: "testCompleted",
    TEST_PASSED: "testPassed",
    TEST_FAILED: "testFailed",
};

// Audit actions are entity-prefixed (CONTROL_OWNER_CHANGED, TASK_UPDATED, …).
// Strip the leading entity so the shared verb phrases match.
const ENTITY_PREFIX = /^(CONTROL|TASK|RISK|ASSET|POLICY|VENDOR|AUDIT|EVIDENCE)_/;

const phraseFor = (action: string, t: (key: string) => string): string => {
    const up = action?.toUpperCase?.() ?? "";
    const keySuffix = ACTION_PHRASE[up] ?? ACTION_PHRASE[up.replace(ENTITY_PREFIX, "")];
    return keySuffix
        ? t(`activity.${keySuffix}`)
        : (action ?? "").replace(/_/g, " ").toLowerCase();
};

/**
 * Reduce a raw audit `details` string to NARRATIVE ONLY — never code.
 *
 * Audit details are authored as "<human phrase> Context: {json}", and some
 * carry a raw change-dump (`{"name":…,"category":…}`) or a bare id
 * ("Owner set to: cmq12y…"). The Activity tab must read as prose, so we:
 *   1. cut the machine "Context: {…}" suffix,
 *   2. drop any embedded JSON object/array blob,
 *   3. strip raw uuid / cuid identifier tokens,
 *   4. trim leftover assignment labels / dangling punctuation, and
 *   5. drop the whole detail unless real words (or a date/number) survive —
 *      a lone leftover label like "Owner" is noise the verb phrase already says.
 */
export function humanizeDetail(raw?: string | null): string | null {
    if (!raw) return null;
    let s = raw.split(/\s*Context:\s*/i)[0];
    s = s.replace(/\{[\s\S]*\}/g, " ").replace(/\[[\s\S]*\]/g, " ");
    s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ");
    s = s.replace(/\bc[a-z0-9]{20,}\b/gi, " ");
    s = s.replace(/\s+/g, " ").trim();
    // Drop a trailing "… set to:" / "… changed to:" assignment label left
    // behind once its id was stripped.
    s = s.replace(/\b[\w ]*\b(set|changed|assigned|updated)\s+to\s*:?\s*$/i, "").trim();
    // Trim dangling separators/punctuation at either end.
    s = s.replace(/^[—\-:,.\s]+|[—\-:,\s]+$/g, "").trim();
    if (!s) return null;
    // A lone short label (no second word, no number) carries no narrative.
    if (s.split(/\s+/).filter(Boolean).length < 2 && !/\d/.test(s)) return null;
    return s;
}

export function PanelActivityFeed({
    tenantSlug,
    endpoint,
}: {
    tenantSlug: string;
    /** Tenant-scoped path, e.g. `/controls/{id}/activity` or `/tasks/{id}/activity`. */
    endpoint: string;
}) {
    const tx = useTranslations("controls");
    const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let active = true;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEntries(null);
        setError(false);
        fetch(`/api/t/${tenantSlug}${endpoint}`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
            .then((data) => {
                if (!active) return;
                setEntries(Array.isArray(data) ? data : (data?.rows ?? []));
            })
            .catch(() => active && setError(true));
        return () => {
            active = false;
        };
    }, [tenantSlug, endpoint]);

    if (error) {
        return <p className="py-3 text-xs text-content-error">{tx("detail.activity.error")}</p>;
    }
    if (entries === null) {
        return <p className="py-3 text-xs text-content-subtle">{tx("detail.activity.loading")}</p>;
    }
    if (entries.length === 0) {
        return <p className="py-3 text-xs text-content-subtle">{tx("detail.activity.empty")}</p>;
    }

    // Entries only render after the client fetch, so a render-time `now` is
    // safe (no SSR hydration mismatch).
    const now = new Date();

    return (
        <ol className="space-y-default" data-testid="panel-activity-feed">
            {entries.map((e) => {
                const actor = e.user?.name || e.user?.email || tx("detail.activity.system");
                const detail = humanizeDetail(e.details);
                return (
                    <li key={e.id} className="border-l-2 border-border-subtle pl-3">
                        <p className="break-words text-sm text-content-default">
                            <span className="font-medium text-content-emphasis">
                                {actor}
                            </span>{" "}
                            {phraseFor(e.action, tx)}
                            {detail ? (
                                <span className="text-content-muted"> — {detail}</span>
                            ) : (
                                "."
                            )}
                        </p>
                        <p className="mt-0.5 text-[11px] text-content-subtle">
                            {formatRelativeTime(e.createdAt, now, { addSuffix: true })}
                        </p>
                    </li>
                );
            })}
        </ol>
    );
}
