import { listTrainingAssignments } from '@/app-layer/usecases/training';
import { gateAdminPage } from '../_lib/admin-page-gate';
import { TrainingClient, type AssignmentRow } from './TrainingClient';

export const dynamic = 'force-dynamic';

/**
 * Training (PR-6) — Server Component. Security-awareness training assignments.
 * Part of the people layer (personnel.view).
 *
 * Gated here, before the read (`admin.view` + `personnel.view`): the admin
 * layout is a client component and cannot keep this page's rows out of the
 * payload. See `../_lib/admin-page-requirements.ts`.
 *
 * Renders the first page for the filters in the URL (`?q=`, `?status=`), which
 * the filter bar writes; changing a filter re-renders this page with the new
 * first page. "Load more" then reads the next pages from `GET /training` with
 * the same filters (#5764 item 6).
 */
export default async function TrainingPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams?: Promise<{ q?: string | string[]; status?: string | string[] }>;
}) {
    const gate = await gateAdminPage('/admin/training', params);
    if (!gate.allowed) return gate.forbidden;
    const sp = (await searchParams) ?? {};
    const page = await listTrainingAssignments(gate.ctx, {
        q: typeof sp.q === 'string' ? sp.q : null,
        status: sp.status ?? null,
    });
    const rows: AssignmentRow[] = page.rows.map((r) => ({
        id: r.id,
        status: r.status,
        assignedAt: r.assignedAt.toISOString(),
        dueAt: r.dueAt ? r.dueAt.toISOString() : null,
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        employee: { fullName: r.employee.fullName, workEmail: r.employee.workEmail },
        course: { name: r.course.name },
    }));
    return (
        <TrainingClient
            initialRows={rows}
            initialNextCursor={page.nextCursor}
            total={page.total}
            filters={page.filters}
        />
    );
}
