"use client";

/**
 * Epic P2-PR-C — "Where is this control used?" modal.
 *
 * Opens from the Control detail page's header actions and answers
 * "where does this control show up in the compliance graph?" across
 * four sections:
 *   - Requirements it satisfies (control↔requirement links)
 *   - Risks it mitigates (control↔risk traceability)
 *   - Assets it protects (control↔asset traceability)
 *   - Process maps whose edges are gated by this control
 *
 * Risk / asset rows deep-link to their detail pages; process-map rows
 * deep-link to `/t/<slug>/processes?activeId=<mapId>` so the user can
 * jump to the map in the canvas. Requirement rows are shown as
 * reference text (there is no standalone requirement detail route).
 *
 * Why a modal (not a tab):
 *   - The control detail page already carries eight tabs (Overview /
 *     Tasks / Evidence / Requirements / Traceability / Activity /
 *     Tests / Checks). A "where used" roll-up is a low-frequency
 *     navigation view — a modal is the right disclosure level for
 *     "look up where this is referenced, then jump back".
 *
 * Why read-only (no edit affordance here):
 *   - The canonical write surfaces live elsewhere (the Requirements +
 *     Traceability tabs, and each map's canvas edge picker). This
 *     modal is a navigation surface; edits stay where they live.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/typography";
import { LoadingSpinner } from "@inflect/ui/components/ui/icons/loading-spinner";

interface MapRef {
    mapId: string;
    mapName: string;
    mapStatus: string;
    // A control is placed on a map via an edge (gate) OR a `control` node.
    via: "edge" | "node";
    locationKey: string;
    label: string | null;
}

// control↔requirement link rows (GET /controls/{id}/requirements).
interface RequirementRow {
    id: string;
    fromRequirement?: {
        id?: string;
        code?: string | null;
        title?: string | null;
        description?: string | null;
        framework?: { name?: string } | null;
    } | null;
}

// control traceability payload (GET /controls/{id}/traceability).
interface TraceRiskRow {
    id: string;
    risk?: { id: string; title?: string | null } | null;
}
interface TraceAssetRow {
    id: string;
    asset?: { id: string; name?: string | null } | null;
}
interface TraceabilityResponse {
    risks?: TraceRiskRow[];
    assets?: TraceAssetRow[];
}

export function ControlReverseLookupModal({
    controlId,
    tenantSlug,
    open,
    onOpenChange,
}: {
    controlId: string;
    tenantSlug: string;
    open: boolean;
    onOpenChange: (next: boolean) => void;
}) {
    const t = useTranslations("panels.reverseLookup");
    const [maps, setMaps] = useState<MapRef[] | null>(null);
    const [requirements, setRequirements] = useState<RequirementRow[]>([]);
    const [risks, setRisks] = useState<TraceRiskRow[]>([]);
    const [assets, setAssets] = useState<TraceAssetRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Fetch lazily — only when the modal opens. Re-fetches on every
        // open so newly-created links land without a page reload. All
        // four reads run in parallel; the process-maps read drives the
        // error state (the historic primary section), while the
        // requirement / traceability reads degrade to empty on failure
        // so one flaky endpoint never blanks the whole modal.
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            const base = `/api/t/${tenantSlug}/controls/${controlId}`;
            const [mapsRes, reqRes, traceRes] = await Promise.allSettled([
                fetch(`${base}/process-maps`),
                fetch(`${base}/requirements`),
                fetch(`${base}/traceability`),
            ]);
            if (cancelled) return;

            // Process maps — surfaces error state.
            try {
                if (mapsRes.status !== "fulfilled") throw mapsRes.reason;
                if (!mapsRes.value.ok) {
                    throw new Error(`Lookup failed (${mapsRes.value.status})`);
                }
                const body = (await mapsRes.value.json()) as { maps?: MapRef[] };
                if (!cancelled) setMaps(body.maps ?? []);
            } catch (err) {
                if (!cancelled) {
                    setMaps([]);
                    setError(
                        err instanceof Error ? err.message : t("couldNotLoad"),
                    );
                }
            }

            // Requirements — best-effort.
            try {
                if (reqRes.status === "fulfilled" && reqRes.value.ok) {
                    const rows = (await reqRes.value.json()) as RequirementRow[];
                    if (!cancelled) setRequirements(Array.isArray(rows) ? rows : []);
                } else if (!cancelled) {
                    setRequirements([]);
                }
            } catch {
                if (!cancelled) setRequirements([]);
            }

            // Risks + assets (traceability) — best-effort.
            try {
                if (traceRes.status === "fulfilled" && traceRes.value.ok) {
                    const body = (await traceRes.value.json()) as TraceabilityResponse;
                    if (!cancelled) {
                        setRisks(body.risks ?? []);
                        setAssets(body.assets ?? []);
                    }
                } else if (!cancelled) {
                    setRisks([]);
                    setAssets([]);
                }
            } catch {
                if (!cancelled) {
                    setRisks([]);
                    setAssets([]);
                }
            }

            if (!cancelled) setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [open, tenantSlug, controlId, t]);

    // Group process-map rows by map — multiple placements (edges + control
    // nodes) within the same map collapse into one row with a count.
    const groups: Array<{
        mapId: string;
        mapName: string;
        mapStatus: string;
        placementCount: number;
    }> = (() => {
        if (!maps) return [];
        const m = new Map<
            string,
            { mapId: string; mapName: string; mapStatus: string; placementCount: number }
        >();
        for (const row of maps) {
            const prev = m.get(row.mapId);
            if (prev) {
                prev.placementCount += 1;
            } else {
                m.set(row.mapId, {
                    mapId: row.mapId,
                    mapName: row.mapName,
                    mapStatus: row.mapStatus,
                    placementCount: 1,
                });
            }
        }
        return Array.from(m.values()).sort((a, b) =>
            a.mapName.localeCompare(b.mapName),
        );
    })();

    const rowClass =
        "flex items-center justify-between rounded-[8px] border border-border-subtle px-default py-2";
    const linkClass =
        "text-sm font-medium text-content-emphasis hover:underline";

    const hasAnything =
        groups.length > 0 ||
        requirements.length > 0 ||
        risks.length > 0 ||
        assets.length > 0;

    return (
        <Modal
            showModal={open}
            setShowModal={(next) => onOpenChange(typeof next === "boolean" ? next : !open)}
            title={t("title")}
            description={t("description")}
        >
            <Modal.Header
                title={t("title")}
                description={t("description")}
            />
            <Modal.Body>
                <div
                    data-testid="control-reverse-lookup-body"
                    className="flex flex-col gap-default"
                >
                    {loading && (
                        <div className="flex items-center gap-tight text-sm text-content-muted">
                            <LoadingSpinner /> {t("loading")}
                        </div>
                    )}
                    {!loading && error && (
                        <div
                            data-testid="control-reverse-lookup-error"
                            className="text-sm text-danger-default"
                        >
                            {error}
                        </div>
                    )}
                    {!loading && !error && !hasAnything && (
                        <p
                            data-testid="control-reverse-lookup-empty"
                            className="text-sm text-content-subtle"
                        >
                            {t("empty")}
                        </p>
                    )}

                    {/* Requirements it satisfies */}
                    {!loading && requirements.length > 0 && (
                        <section className="flex flex-col gap-tight">
                            <Heading level={3} className="text-sm">
                                {t("requirementsHeading")}
                            </Heading>
                            <ul className="flex flex-col gap-tight">
                                {requirements.map((r) => {
                                    const req = r.fromRequirement;
                                    const label =
                                        req?.title || req?.description || "—";
                                    return (
                                        <li key={r.id} className={rowClass}>
                                            <span className="text-sm text-content-default">
                                                {req?.code && (
                                                    <span className="mr-2 text-content-subtle">
                                                        {req.code}
                                                    </span>
                                                )}
                                                {label}
                                            </span>
                                            {req?.framework?.name && (
                                                <span className="text-[11px] text-content-subtle">
                                                    {req.framework.name}
                                                </span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    )}

                    {/* Risks it mitigates */}
                    {!loading && risks.length > 0 && (
                        <section className="flex flex-col gap-tight">
                            <Heading level={3} className="text-sm">
                                {t("risksHeading")}
                            </Heading>
                            <ul className="flex flex-col gap-tight">
                                {risks.map((r) =>
                                    r.risk ? (
                                        <li key={r.id} className={rowClass}>
                                            <Link
                                                href={`/t/${tenantSlug}/risks/${r.risk.id}`}
                                                className={linkClass}
                                            >
                                                {r.risk.title || "—"}
                                            </Link>
                                        </li>
                                    ) : null,
                                )}
                            </ul>
                        </section>
                    )}

                    {/* Assets it protects */}
                    {!loading && assets.length > 0 && (
                        <section className="flex flex-col gap-tight">
                            <Heading level={3} className="text-sm">
                                {t("assetsHeading")}
                            </Heading>
                            <ul className="flex flex-col gap-tight">
                                {assets.map((a) =>
                                    a.asset ? (
                                        <li key={a.id} className={rowClass}>
                                            <Link
                                                href={`/t/${tenantSlug}/assets/${a.asset.id}`}
                                                className={linkClass}
                                            >
                                                {a.asset.name || "—"}
                                            </Link>
                                        </li>
                                    ) : null,
                                )}
                            </ul>
                        </section>
                    )}

                    {/* Process maps that gate an edge with this control */}
                    {!loading && !error && groups.length > 0 && (
                        <section className="flex flex-col gap-tight">
                            <Heading level={3} className="text-sm">
                                {t("processMapsHeading")}
                            </Heading>
                            <ul className="flex flex-col gap-tight">
                                {groups.map((g) => (
                                    <li
                                        key={g.mapId}
                                        data-testid="control-reverse-lookup-row"
                                        className={rowClass}
                                    >
                                        <div className="flex flex-col">
                                            <Link
                                                href={`/t/${tenantSlug}/processes?activeId=${g.mapId}`}
                                                className={linkClass}
                                            >
                                                {g.mapName}
                                            </Link>
                                            <span className="text-[11px] text-content-subtle">
                                                {t("mapMeta", {
                                                    status: g.mapStatus,
                                                    count: g.placementCount,
                                                    noun: g.placementCount === 1 ? t("placementOne") : t("placementMany"),
                                                })}
                                            </span>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        data-testid="control-reverse-lookup-close"
                    >
                        {t("close")}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}
