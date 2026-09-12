import { setEmployeeManager, SetEmployeeManagerSchema } from '@/app-layer/usecases/personnel';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * #2492 — set (or clear) one employee's manager without an HRIS feed.
 *
 * ═══ THE URL NAMES THE FIELD, AND THAT IS PART OF THE DESIGN ═══
 *
 * This is deliberately NOT `PATCH /personnel/[employeeId]`. Employee's
 * documented two-write-seam rule (CLAUDE.md) exists because `status` is what
 * makes a worker a candidate for a real disable in a customer's directory, and
 * a general update route is the shape that quietly acquires a second writer on
 * it. A route whose last segment is `manager` cannot grow one without moving,
 * which is a diff a reviewer sees. The usecase carries the other two rails —
 * a `.strict()` one-key schema and a one-column Prisma `data` literal — and
 * `tests/guards/employee-status-single-write-seam.test.ts` fails if any of the
 * three is taken away.
 *
 * PUT, not PATCH: the body replaces the single value the URL names. `null`
 * clears it, which is how "reports to nobody" is said.
 *
 * ═══ personnel.manage, THE SAME KEY THAT CREATES AN EMPLOYEE ═══
 *
 * True for OWNER and ADMIN only (`@/lib/permissions`) — EDITOR, READER and
 * AUDITOR hold `personnel.view` and not `manage`. That is the population that
 * can already create the row, and an org chart decides who receives the
 * offboarding mail about a colleague, so it is not a wider authority than the
 * one beside it. `requirePermission` rather than a usecase-only assert,
 * because a denial there writes a hash-chained AUTHZ_DENIED row and an
 * in-usecase `forbidden()` writes nothing (C.1, LAYER 1). The usecase keeps
 * its own check as defence in depth for non-HTTP callers.
 *
 * ═══ IN `PRIVILEGED_ROOTS` AS A NARROW LEAF ═══
 *
 * `personnel` as a whole is NOT a privileged root, and adding a
 * `ROUTE_PERMISSIONS` rule without a root to discover it from makes the rule
 * an orphan that turns the coverage guardrail red (the reasoning
 * `calendar/connections/route.ts` records). So this directory — this route
 * alone, not its `/personnel` siblings — is registered as a leaf root,
 * following the `assets/[id]/purge` precedent. The sibling
 * `personnel/route.ts` keeps its unregistered `requirePermission`, unchanged.
 */
type ManagerParams = { tenantSlug: string; employeeId: string };

export const PUT = withApiErrorHandling(
    requirePermission<ManagerParams>('personnel.manage', async (req, { params }, ctx) => {
        const { employeeId } = await params;
        const body = await parseJsonBody(req, SetEmployeeManagerSchema);
        const employee = await setEmployeeManager(ctx, employeeId, body);
        return jsonResponse(employee);
    }),
);
