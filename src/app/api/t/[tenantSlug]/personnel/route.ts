import { listEmployees, createEmployee, CreateEmployeeSchema } from '@/app-layer/usecases/personnel';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * PR-4 — personnel roster. GET lists employees (personnel.view); POST adds a
 * manual record (personnel.manage). HRIS-synced records arrive via hris-sync.
 *
 * GET answers `{ employees, truncated, total }` (#4470): the rows, whether the
 * roster cap cut them, and how many match. `status` may repeat to ask for
 * several statuses; `q` searches name and work email.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('personnel.view', async (req, _routeArgs, ctx) => {
        const sp = req.nextUrl.searchParams;
        const roster = await listEmployees(ctx, {
            status: sp.getAll('status'),
            search: sp.get('q') ?? undefined,
        });
        return jsonResponse(roster);
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('personnel.manage', async (req, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, CreateEmployeeSchema);
        const employee = await createEmployee(ctx, body);
        return jsonResponse(employee, { status: 201 });
    }),
);
