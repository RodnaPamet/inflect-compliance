/**
 * Epic 49 — Compliance Calendar page (server component shell).
 *
 * Thin shell: it resolves nothing beyond the route param and hands off to the
 * client island, which fetches its own range via SWR.
 *
 * Why no server-side prefetch: the previous version ran the full 17-source
 * aggregation for a now±180d window and passed it as `initialData` — but the
 * client's default (month) view requests a DIFFERENT window
 * (startOfMonth−7d…endOfMonth+7d), so the keys never matched and the payload
 * was discarded on every load (an expensive aggregation thrown away, plus a
 * whole-payload `JSON.stringify` on every render through the SWR options).
 * The client owns range selection, so it owns the fetch.
 */

import { CalendarClient } from './CalendarClient';

export const dynamic = 'force-dynamic';

export default async function CalendarPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    return <CalendarClient tenantSlug={tenantSlug} />;
}
