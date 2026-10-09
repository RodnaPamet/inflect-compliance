/**
 * Mint (or rotate) the token the grant endpoint authenticates (#3330).
 *
 * ── WHY THIS IS A SIBLING AND NOT UNDER admin/integrations/{id}/ ─────────────
 *
 * Route-permission matching is FIRST-MATCH-WINS, and
 * `^…/admin/integrations(/.*)?$` resolves to `admin.manage`. Nesting this under
 * that prefix would document a WEAKER gate than the handler enforces — the same
 * trap `admin/external-write-policy` and `admin/external-prior-state-read` each
 * state in their own notes, and a sibling path is the fix they chose.
 *
 * `admin.tenant_lifecycle`, OWNER-only, because minting the credential GRANTS
 * the authority it carries: whoever holds it can drive a time-bounded directory
 * write in the customer's own tenant. That is the write-policy class of
 * authority, not the configuration-editing class of the integrations CRUD.
 *
 * ── POST, AND THE SECRET IS IN THE BODY ─────────────────────────────────────
 *
 * POST because it MUTATES: it overwrites any previous value, so running it
 * twice is the rotation path. And because a GET returning a credential invites
 * a browser, a proxy or a log to keep it — `cfnetwork-logs-the-query-string`
 * records how unsuppressable a URL-borne secret is; a body is not logged the
 * same way.
 *
 * ── params ARE ALREADY RESOLVED HERE ────────────────────────────────────────
 *
 * `requirePermission` awaits `routeArgs.params` once and forwards the resolved
 * object, which is why the shape travels as a GENERIC and the handler reads
 * `params.connectionId` directly. An inline `params: { … }` annotation would
 * both fail `PermissionedHandler`'s `TParams extends { tenantSlug: string }`
 * and trip `async-params-route-typing`, which reads the source for exactly that
 * shape.
 */
import { NextResponse } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { describeMintRefusal, mintMcpServerToken } from '@/app-layer/usecases/mcp-server-token';

type TokenParams = { tenantSlug: string; connectionId: string };

const postHandler = requirePermission<TokenParams>(
    'admin.tenant_lifecycle',
    async (_req, { params }, ctx) => {
        const { connectionId } = params;
        if (!connectionId) throw badRequest('connectionId is required');

        const outcome = await mintMcpServerToken(ctx, connectionId);
        if (!outcome.ok) {
            // 404 for a row that is not there, 409 for one that is but cannot
            // take a token. Distinguished because one is fixed by picking a
            // different connection and the other by editing this one.
            const status = outcome.refusal.kind === 'not_found' ? 404 : 409;
            return NextResponse.json(
                { error: describeMintRefusal(outcome.refusal) },
                { status },
            );
        }

        return NextResponse.json({
            // RETURNED ONCE. Not because it becomes unrecoverable — it is
            // stored encrypted and readable, since the endpoint compares
            // against it — but because every extra copy is another place it can
            // leak from. A surface that claims it is gone would be asserting
            // something untrue.
            token: outcome.token,
            rotated: outcome.rotated,
        });
    },
);

export const POST = withApiErrorHandling(postHandler);
