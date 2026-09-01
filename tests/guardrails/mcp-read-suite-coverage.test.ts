/**
 * MCP read-suite coverage ratchet (Phase 2).
 *
 * Extends the Phase-1 cross-tenant-leak lock (mcp-server-coverage) to the WHOLE
 * read-tool suite. Locks:
 *   - every registered read tool is usecase-backed (no direct Prisma) — the
 *     leak lock, applied per tool file;
 *   - every read tool declares a resource scope + a Zod arg schema (scope-gated
 *     + validated) and the funnel audits (asserted in mcp-server-coverage);
 *   - NO read-tool file imports a create/update/delete usecase (read-only lock);
 *   - every list/search tool is bounded (a `limit`/`days` arg — no unbounded
 *     dumps, per the query-shape guardrails);
 *   - the expected tenant-inspection tools are all registered.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { READ_TOOLS } from '@/lib/mcp/tools/registry';
import { PERMISSION_SCHEMA } from '@/lib/permissions';

const ROOT = path.resolve(__dirname, '../..');
const TOOLS_DIR = path.join(ROOT, 'src/lib/mcp/tools');

/** READ-tool implementation files (exclude plumbing + the propose write surface). */
function toolImplFiles(): string[] {
    return fs
        .readdirSync(TOOLS_DIR)
        .filter((n) => n.endsWith('.ts') && n !== 'types.ts' && n !== 'registry.ts' && n !== 'propose-tools.ts')
        .map((n) => path.join(TOOLS_DIR, n));
}

const EXPECTED_TOOLS = [
    'get_compliance_posture',
    'get_tenant_context',
    'list_risks',
    'list_controls',
    'search_controls',
    'find_coverage_gaps',
    'get_framework_status',
    'list_evidence_expiring',
    'list_findings',
    'list_tasks',
];

// Resource scopes the api-key layer understands. DERIVED, not copied: this
// was a hand-written list that had silently fallen three domains behind
// SCOPE_ACTION_MAP, and could not report it — the only assertion over it is a
// containment check, which a stale-but-superset list passes forever.
const KNOWN_RESOURCES = new Set(Object.keys(PERMISSION_SCHEMA));

describe('MCP read suite — registration', () => {
    it('registers the full tenant-inspection tool set', () => {
        const names = READ_TOOLS.map((t) => t.name);
        for (const expected of EXPECTED_TOOLS) {
            expect(names).toContain(expected);
        }
        // Names are unique.
        expect(new Set(names).size).toBe(names.length);
    });
});

describe('MCP read suite — every tool is scope-gated, validated, bounded', () => {
    it('each tool declares a known resource:read scope + a Zod arg schema', () => {
        for (const t of READ_TOOLS) {
            expect(typeof t.name).toBe('string');
            expect(t.description.length).toBeGreaterThan(10);
            expect(t.inputSchema).toBeDefined();
            expect(t.argsSchema).toBeDefined();
            expect(typeof (t.argsSchema as { safeParse?: unknown }).safeParse).toBe('function');
            expect(KNOWN_RESOURCES.has(t.resourceScope.resource)).toBe(true);
            expect(t.resourceScope.action).toBe('read');
            expect(typeof t.run).toBe('function');
        }
    });

    it('every list/search tool is bounded (a limit or days argument)', () => {
        for (const t of READ_TOOLS) {
            if (!/^(list_|search_)/.test(t.name)) continue;
            const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
            const bounded = 'limit' in props || 'days' in props;
            expect(bounded).toBe(true);
        }
    });

    it('every tool input schema forbids unknown properties (additionalProperties:false)', () => {
        for (const t of READ_TOOLS) {
            expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
        }
    });
});

describe('MCP read suite — leak lock + read-only lock (per tool file)', () => {
    const files = toolImplFiles();

    it('every tool file goes through a usecase (no direct Prisma / repository)', () => {
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            expect(src).toMatch(/from ['"]@\/app-layer\/usecases/);
            expect(src).not.toMatch(/from ['"]@\/lib\/prisma['"]/);
            expect(src).not.toMatch(/from ['"]@\/app-layer\/repositories/);
        }
    });

    it('NO tool file imports a create/update/delete usecase (read-only lock)', () => {
        const mutating = /\b(create|update|delete|remove|apply|install|generate|propose|draft|assign|approve|execute)[A-Z]\w*/;
        const offenders: string[] = [];
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(/import\s+\{([^}]*)\}\s+from\s+['"]@\/app-layer\/usecases[^'"]*['"]/g)) {
                for (const n of m[1].split(',').map((s) => s.trim())) {
                    if (mutating.test(n)) offenders.push(`${path.basename(file)}: ${n}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
