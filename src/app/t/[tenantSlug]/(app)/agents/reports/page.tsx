/** BISECT PROBE A — not for merge. Reports page stubbed to remove its client
 *  subtree (ReportsClient, Metric, ExportPackButton) from the webpack graph. */
export default async function AgentReportsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    await params;
    return null;
}
