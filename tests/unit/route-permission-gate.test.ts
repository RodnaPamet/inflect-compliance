/**
 * The analyser `admin-route-coverage` stands on: which permission gate wraps
 * each exported route handler, read from the syntax tree. Each case is a shape
 * a real route uses, or a shape that must NOT count as a gate (#4441).
 */
import { handlerGates, requirementLabel } from '../helpers/route-permission-gate';

const gated = (keys: string[], mode: 'any' | 'all' = 'all') => ({ kind: 'gated', keys, mode });

describe('handlerGates', () => {
    it('reads the key of a gate wrapped in withApiErrorHandling', () => {
        const gates = handlerGates(`
            export const POST = withApiErrorHandling(requirePermission('admin.manage', async (req, _a, ctx) => ok()));
        `);
        expect(gates.get('POST')).toEqual(gated(['admin.manage']));
    });

    it('follows a file-level const to the gate', () => {
        const gates = handlerGates(`
            const putHandler = requirePermission('admin.tenant_lifecycle', async () => ok());
            export const PUT = withApiErrorHandling(putHandler);
        `);
        expect(gates.get('PUT')).toEqual(gated(['admin.tenant_lifecycle']));
    });

    it('reads the object form and the any/all helpers', () => {
        const gates = handlerGates(`
            export const GET = withApiErrorHandling(requirePermission(
                { keys: ['admin.agent_registry_view', 'admin.agent_registry'], mode: 'any' }, h));
            export const POST = withApiErrorHandling(requireAnyPermission(['a.b', 'c.d'], h));
            export const PUT = withApiErrorHandling(requireAllPermissions(['a.b', 'c.d'], h));
            export const DELETE = withApiErrorHandling(requirePermission<{ tenantSlug: string }>(['a.b', 'c.d'], h));
        `);
        expect(gates.get('GET')).toEqual(gated(['admin.agent_registry_view', 'admin.agent_registry'], 'any'));
        expect(gates.get('POST')).toEqual(gated(['a.b', 'c.d'], 'any'));
        expect(gates.get('PUT')).toEqual(gated(['a.b', 'c.d'], 'all'));
        expect(gates.get('DELETE')).toEqual(gated(['a.b', 'c.d'], 'all'));
    });

    it('does not count an import, a comment or a call inside the handler body as the gate', () => {
        const gates = handlerGates(`
            import { requirePermission } from '@/lib/security/permission-middleware';
            // Gated by requirePermission('admin.manage', …).
            export const GET = withApiErrorHandling(async (req) => {
                requirePermission('admin.manage', h);
                return ok();
            });
        `);
        expect(gates.get('GET')).toEqual({ kind: 'ungated' });
    });

    it('treats an exported function declaration as ungated: nothing can wrap it', () => {
        const gates = handlerGates(`export async function GET(req) { return ok(); }`);
        expect(gates.get('GET')).toEqual({ kind: 'ungated' });
    });

    it('reports a requirement that is not a literal as unreadable rather than guessing', () => {
        const gates = handlerGates(`
            const KEY = 'admin.manage';
            export const GET = withApiErrorHandling(requirePermission(KEY, h));
            export { other as POST };
        `);
        expect(gates.get('GET')).toMatchObject({ kind: 'unreadable' });
        expect(gates.get('POST')).toMatchObject({ kind: 'unreadable' });
    });

    it('lists only HTTP method exports', () => {
        const gates = handlerGates(`
            export const dynamic = 'force-dynamic';
            export const GET = withApiErrorHandling(requirePermission('admin.view', h));
        `);
        expect([...gates.keys()]).toEqual(['GET']);
    });
});

describe('requirementLabel', () => {
    it('is the key itself for one key, whatever the mode', () => {
        expect(requirementLabel(['admin.manage'], 'any')).toBe('admin.manage');
        expect(requirementLabel(['admin.manage'], 'all')).toBe('admin.manage');
    });

    it('sorts several keys and names the mode, so order never matters and mode always does', () => {
        expect(requirementLabel(['b.y', 'a.x'], 'any')).toBe('any(a.x, b.y)');
        expect(requirementLabel(['a.x', 'b.y'], 'any')).toBe(requirementLabel(['b.y', 'a.x'], 'any'));
        expect(requirementLabel(['a.x', 'b.y'], 'all')).not.toBe(requirementLabel(['a.x', 'b.y'], 'any'));
    });
});
