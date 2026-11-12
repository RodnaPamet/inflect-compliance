import { redirect } from 'next/navigation';

/**
 * Legacy /dashboard redirect shim.
 *
 * Delegates to the workspace picker at /tenants, which resolves where a
 * session may land: one reachable workspace goes straight to it, several
 * show the picker, and an SSO-scoped session or a workspace refused by the
 * Entra gate is honoured (#5093). The shim used to send everyone to their
 * OLDEST membership, without an ACTIVE filter and without reading the
 * session's scope, so the edge then refused it or opened the wrong
 * workspace.
 */
export default function DashboardRedirect() {
    redirect('/tenants');
}
