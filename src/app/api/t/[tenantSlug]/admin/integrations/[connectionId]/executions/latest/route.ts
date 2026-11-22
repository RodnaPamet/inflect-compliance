import { NextRequest } from 'next/server';
import type { IntegrationExecutionStatus } from '@prisma/client';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getConnectionHeader, getLatestExecutionForConnection } from '@/app-layer/usecases/integrations';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; connectionId: string };

/**
 * The statuses a caller may narrow to. Spelled out rather than read from the
 * generated enum, and checked against it by `satisfies`, so a status added to
 * the schema is not accepted here until somebody decides it should be.
 */
const STATUSES = [
    'PENDING',
    'RUNNING',
    'PASSED',
    'FAILED',
    'ERROR',
    'NOT_APPLICABLE',
    'PARTIAL',
] as const satisfies readonly IntegrationExecutionStatus[];

const isStatus = (s: string): s is (typeof STATUSES)[number] =>
    (STATUSES as readonly string[]).includes(s);

/** An automation key is a dotted provider-and-check name, e.g. `legacy-mcp.reconcile`. */
const AUTOMATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * GET /api/t/[tenantSlug]/admin/integrations/[connectionId]/executions/latest
 *     ?automationKey=<key>[&status=<status>]
 *
 * The newest execution of ONE kind on this connection (#5313, item 10), and
 * `null` when there is none. Its sibling `executions` returns the 50 newest
 * rows of every kind, which is a history, not an answer to "when did this
 * last run": a connection whose last match run is older than 50 other runs
 * read as never matched. This read asks for the kind, so it does not.
 *
 * Same key as the sibling (`admin.manage`, the `admin/integrations` rule) and
 * no wider: it returns one of the rows that route can already return. It
 * carries the connection header too, so a page that needs only the latest run
 * and the connection's name makes one request, and a connection that does not
 * exist is a 404 rather than "never run".
 */
export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (req: NextRequest, { params }, ctx) => {
        const { connectionId } = await params;
        const query = new URL(req.url).searchParams;

        const automationKey = query.get('automationKey');
        if (!automationKey || !AUTOMATION_KEY.test(automationKey)) {
            throw badRequest('automationKey is required, and names one kind of run');
        }
        const status = query.get('status');
        if (status !== null && !isStatus(status)) {
            throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
        }

        const connection = await getConnectionHeader(ctx, connectionId);
        const execution = await getLatestExecutionForConnection(ctx, connectionId, automationKey, {
            status: status ?? undefined,
        });
        return jsonResponse({ connection, execution });
    }),
);
