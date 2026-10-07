"use client";

/**
 * Epic P5-PR-B — Visual diff overlay.
 *
 * Opens as a Modal when the user clicks "Diff" on a history-
 * sidebar row. Fetches the target snapshot via
 * `/api/t/<slug>/processes/<id>/snapshots/<version>`, runs
 * `computeCanvasDiff` against the live graph, and renders the
 * delta summary + a colour-keyed legend.
 *
 * Why Modal (not inline canvas overlay):
 *   - The user wants the live editing surface preserved while
 *     they look at the diff; an inline overlay would either
 *     freeze the canvas or fight it for pointer events.
 *   - The diff is exploratory; "open in a panel, look, close"
 *     is the canonical interaction shape for compliance audit.
 *
 * The detailed per-node + per-edge colouring is rendered in a
 * scrollable list (added / removed / moved / modified). A
 * future iteration can add a side-by-side mini-canvas; for
 * P5-PR-B the textual summary + the per-row classification is
 * the substantive deliverable.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@inflect/ui/components/ui/icons/loading-spinner";
import {
    computeCanvasDiff,
    type CanvasDiff,
    type DiffClass,
    type DiffGraphSnapshot,
} from "@/lib/processes/canvas-diff";

interface SnapshotResponse {
    id: string;
    version: number;
    graphJson: DiffGraphSnapshot;
    createdAt: string;
    createdByName: string | null;
}

export function CanvasDiffOverlay({
    open,
    onOpenChange,
    tenantSlug,
    mapId,
    targetVersion,
    currentSnapshot,
    currentVersion,
}: {
    open: boolean;
    onOpenChange: (next: boolean) => void;
    tenantSlug: string;
    mapId: string;
    targetVersion: number;
    /** The live canvas graph (post-rehydrate) for the diff base. */
    currentSnapshot: DiffGraphSnapshot;
    currentVersion: number;
}) {
    const t = useTranslations("automation.diff");
    const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) {
            setSnapshot(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const res = await fetch(
                    `/api/t/${tenantSlug}/processes/${mapId}/snapshots/${targetVersion}`,
                );
                if (!res.ok) {
                    throw new Error(
                        t("loadErrorStatus", { status: res.status }),
                    );
                }
                const body = (await res.json()) as SnapshotResponse;
                if (cancelled) return;
                setSnapshot(body);
            } catch (err) {
                if (!cancelled) {
                    setError(
                        err instanceof Error ? err.message : t("loadError"),
                    );
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, tenantSlug, mapId, targetVersion, t]);

    const diff: CanvasDiff | null = snapshot
        ? computeCanvasDiff(snapshot.graphJson, currentSnapshot)
        : null;

    return (
        <Modal
            showModal={open}
            setShowModal={(next) =>
                onOpenChange(typeof next === "boolean" ? next : !open)
            }
            title={t("title", { x: targetVersion, y: currentVersion })}
            description={t("description")}
        >
            <Modal.Header
                title={t("title", { x: targetVersion, y: currentVersion })}
                description={t("description")}
            />
            <Modal.Body>
                <div
                    data-testid="canvas-diff-overlay-body"
                    className="flex flex-col gap-default"
                >
                    {loading && (
                        <div className="flex items-center gap-tight text-sm text-content-muted">
                            <LoadingSpinner /> {t("loading")}
                        </div>
                    )}
                    {!loading && error && (
                        <div
                            data-testid="canvas-diff-overlay-error"
                            className="text-sm text-danger-default"
                        >
                            {error}
                        </div>
                    )}
                    {!loading && !error && diff && (
                        <>
                            <DiffSummary diff={diff} />
                            <DiffList
                                title={t("nodeChanges")}
                                entries={Array.from(diff.nodes.entries()).filter(
                                    ([, c]) => c !== "unchanged",
                                )}
                            />
                            <DiffList
                                title={t("edgeChanges")}
                                entries={Array.from(diff.edges.entries()).filter(
                                    ([, c]) => c !== "unchanged",
                                )}
                            />
                        </>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        data-testid="canvas-diff-overlay-close"
                    >
                        {t("close")}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}

function DiffSummary({ diff }: { diff: CanvasDiff }) {
    const t = useTranslations("automation.diff");
    const s = diff.summary;
    const total =
        s.nodesAdded +
        s.nodesRemoved +
        s.nodesMoved +
        s.nodesModified +
        s.edgesAdded +
        s.edgesRemoved +
        s.edgesModified;
    if (total === 0) {
        return (
            <p
                data-testid="canvas-diff-overlay-empty"
                className="text-sm text-content-subtle"
            >
                {t("noChanges")}
            </p>
        );
    }
    return (
        <ul
            data-testid="canvas-diff-summary"
            className="flex flex-wrap gap-tight text-[11px] text-content-muted"
        >
            <SummaryChip
                count={s.nodesAdded}
                label={t("nodesAdded")}
                tone="added"
            />
            <SummaryChip
                count={s.nodesRemoved}
                label={t("nodesRemoved")}
                tone="removed"
            />
            <SummaryChip
                count={s.nodesMoved}
                label={t("nodesMoved")}
                tone="moved"
            />
            <SummaryChip
                count={s.nodesModified}
                label={t("nodesModified")}
                tone="modified"
            />
            <SummaryChip
                count={s.edgesAdded}
                label={t("edgesAdded")}
                tone="added"
            />
            <SummaryChip
                count={s.edgesRemoved}
                label={t("edgesRemoved")}
                tone="removed"
            />
            <SummaryChip
                count={s.edgesModified}
                label={t("edgesModified")}
                tone="modified"
            />
        </ul>
    );
}

function SummaryChip({
    count,
    label,
    tone,
}: {
    count: number;
    label: string;
    tone: Exclude<DiffClass, "unchanged">;
}) {
    if (count === 0) return null;
    return (
        <li className={`rounded-[6px] px-2 py-1 ${toneClass(tone)}`}>
            <span className="font-semibold">{count}</span> {label}
        </li>
    );
}

function DiffList({
    title,
    entries,
}: {
    title: string;
    entries: Array<[string, DiffClass]>;
}) {
    const t = useTranslations("automation.diff");
    if (entries.length === 0) return null;
    const classLabels: Record<string, string> = {
        added: t("classAdded"),
        removed: t("classRemoved"),
        moved: t("classMoved"),
        modified: t("classModified"),
    };
    return (
        <div className="flex flex-col gap-tight">
            <span className="text-[10px] uppercase tracking-wide text-content-subtle">
                {title}
            </span>
            <ul className="flex flex-col gap-tight text-[12px]">
                {entries.map(([key, klass]) => (
                    <li
                        key={key}
                        data-testid="canvas-diff-overlay-row"
                        data-class={klass}
                        className={`rounded-[6px] border border-border-subtle px-2 py-1 ${toneClass(klass)}`}
                    >
                        <span className="font-mono text-[11px]">{key}</span>{" "}
                        <span className="text-[10px] uppercase">
                            {classLabels[klass] ?? klass}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function toneClass(klass: DiffClass): string {
    switch (klass) {
        case "added":
            return "bg-bg-success/40 text-content-success";
        case "removed":
            return "bg-bg-error/40 text-content-error";
        case "moved":
            return "bg-bg-info/40 text-content-info";
        case "modified":
            return "bg-bg-warning/40 text-content-warning";
        default:
            return "";
    }
}
