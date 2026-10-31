import { listTrainingAssignments } from '@/app-layer/usecases/training';
import { TRAINING_LIST_CAP } from '@/lib/training-list';
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
 */
export default async function TrainingPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const gate = await gateAdminPage('/admin/training', params);
    if (!gate.allowed) return gate.forbidden;
    const all = (await listTrainingAssignments(gate.ctx)) as unknown as AssignmentRow[];
    // The usecase reads one past the cap: more than the cap means there are more.
    const truncated = all.length > TRAINING_LIST_CAP;
    const rows = all.slice(0, TRAINING_LIST_CAP);
    return <TrainingClient initialRows={JSON.parse(JSON.stringify(rows))} truncated={truncated} />;
}
