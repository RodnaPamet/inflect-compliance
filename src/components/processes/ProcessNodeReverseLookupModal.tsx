"use client";

/**
 * PR-D — "Where is this risk / asset used?" modal (node-mounted links).
 *
 * The node analogue of `ControlReverseLookupModal` (which covers EDGE-mounted
 * controls). Opens from a Risk or Asset detail page and lists every process
 * map that has a `risk` / `asset` node linked to this entity. Each row
 * deep-links to `/t/<slug>/processes?activeId=<mapId>` so the user can jump to
 * the map in the canvas.
 *
 * Read-only: the node picker on each map's canvas is the canonical write
 * surface; this is a navigation surface.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@inflect/ui/components/ui/icons/loading-spinner";

type EntityType = "risk" | "asset";

interface NodeMapRef {
    mapId: string;
    mapName: string;
    mapStatus: string;
    nodeKey: string;
    nodeLabel: string;
}

export function ProcessNodeReverseLookupModal({
    entityType,
    entityId,
    tenantSlug,
    open,
    onOpenChange,
}: {
    entityType: EntityType;
    entityId: string;
    tenantSlug: string;
    open: boolean;
    onOpenChange: (next: boolean) => void;
}) {
    const t = useTranslations("panels.processWhereUsed");
    const [maps, setMaps] = useState<NodeMapRef[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const resource = entityType === "risk" ? "risks" : "assets";

    useEffect(() => {
        // Fetch lazily — only when the modal opens; re-fetch on every open so
        // newly-created maps land without a page reload.
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const res = await fetch(
                    `/api/t/${tenantSlug}/${resource}/${entityId}/process-maps`,
                );
                if (!res.ok) {
                    throw new Error(`Lookup failed (${res.status})`);
                }
                const body = (await res.json()) as { maps?: NodeMapRef[] };
                if (cancelled) return;
                setMaps(body.maps ?? []);
            } catch (err) {
                if (!cancelled) {
                    setError(
                        err instanceof Error ? err.message : t("couldNotLoad"),
                    );
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, tenantSlug, resource, entityId]);

    // Group rows by map — multiple linked nodes within the same map collapse
    // into one row with a count.
    const groups: Array<{
        mapId: string;
        mapName: string;
        mapStatus: string;
        nodeCount: number;
    }> = (() => {
        if (!maps) return [];
        const m = new Map<
            string,
            { mapId: string; mapName: string; mapStatus: string; nodeCount: number }
        >();
        for (const row of maps) {
            const prev = m.get(row.mapId);
            if (prev) {
                prev.nodeCount += 1;
            } else {
                m.set(row.mapId, {
                    mapId: row.mapId,
                    mapName: row.mapName,
                    mapStatus: row.mapStatus,
                    nodeCount: 1,
                });
            }
        }
        return Array.from(m.values()).sort((a, b) =>
            a.mapName.localeCompare(b.mapName),
        );
    })();

    return (
        <Modal
            showModal={open}
            setShowModal={(next) =>
                onOpenChange(typeof next === "boolean" ? next : !open)
            }
            title={t(`title.${entityType}`)}
            description={t(`description.${entityType}`)}
        >
            <Modal.Header
                title={t(`title.${entityType}`)}
                description={t(`description.${entityType}`)}
            />
            <Modal.Body>
                <div
                    data-testid="process-node-reverse-lookup-body"
                    className="flex flex-col gap-default"
                >
                    {loading && (
                        <div className="flex items-center gap-tight text-sm text-content-muted">
                            <LoadingSpinner /> {t("loading")}
                        </div>
                    )}
                    {!loading && error && (
                        <div
                            data-testid="process-node-reverse-lookup-error"
                            className="text-sm text-danger-default"
                        >
                            {error}
                        </div>
                    )}
                    {!loading && !error && groups.length === 0 && (
                        <p
                            data-testid="process-node-reverse-lookup-empty"
                            className="text-sm text-content-subtle"
                        >
                            {t(`empty.${entityType}`)}
                        </p>
                    )}
                    {!loading && !error && groups.length > 0 && (
                        <ul className="flex flex-col gap-tight">
                            {groups.map((g) => (
                                <li
                                    key={g.mapId}
                                    data-testid="process-node-reverse-lookup-row"
                                    className="flex items-center justify-between rounded-[8px] border border-border-subtle px-default py-2"
                                >
                                    <div className="flex flex-col">
                                        <Link
                                            href={`/t/${tenantSlug}/processes?activeId=${g.mapId}`}
                                            className="text-sm font-medium text-content-emphasis hover:underline"
                                        >
                                            {g.mapName}
                                        </Link>
                                        <span className="text-[11px] text-content-subtle">
                                            {t("mapMeta", {
                                                status: g.mapStatus,
                                                count: g.nodeCount,
                                                noun:
                                                    g.nodeCount === 1
                                                        ? t("nodeOne")
                                                        : t("nodeMany"),
                                            })}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        data-testid="process-node-reverse-lookup-close"
                    >
                        {t("close")}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}
