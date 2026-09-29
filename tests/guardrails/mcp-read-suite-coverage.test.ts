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
/**
 * The READ-tool files, recognised by the type they declare rather than by
 * excluding three filenames. A name-exclusion list is a hand-maintained
 * denominator, and it had never heard of a non-tool module living beside the
 * tools — the per-domain redaction table joined the population silently and was
 * asked to import a usecase it has no business importing.
 */
function toolImplFiles(): string[] {
    return fs
        .readdirSync(TOOLS_DIR)
        .filter((n) => n.endsWith('.ts'))
        .map((n) => path.join(TOOLS_DIR, n))
        .filter((f) => /:\s*McpReadTool</.test(fs.readFileSync(f, 'utf8')));
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

    it('the population is real — seven read-tool files declare a tool today', () => {
        // A filter that silently emptied would make every loop below pass while
        // checking nothing.
        expect(files.length).toBeGreaterThanOrEqual(7);
    });

    it('every tool file goes through a usecase (no direct Prisma / repository)', () => {
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            expect(src).toMatch(/from ['"]@\/app-layer\/usecases/);
            expect(src).not.toMatch(/from ['"]@\/lib\/prisma['"]/);
            expect(src).not.toMatch(/from ['"]@\/app-layer\/repositories/);
        }
    });

    /**
     * The ONE admitted mutating import, and why.
     *
     * `external-tools.ts` stopped being read-only when #2861 gave it the
     * external write path. At `PROPOSE_ONLY` a write becomes an `AgentProposal`
     * for a human to approve, which needs `createAgentProposal`.
     *
     * Worth stating plainly: this lock is a NAME-BASED PROXY and that file was
     * already past it. `recordIntent` writes an `ExternalWriteJournal` row from
     * the same function and matches none of the verbs above, so the DRY_RUN
     * write path has been importing a mutating usecase since #2983 without this
     * guard noticing. Admitting one import by name is narrower than the hole
     * that was already open, and it is recorded rather than silent.
     *
     * Every OTHER assertion in this block still applies to the file unchanged —
     * it still goes through a usecase, still imports no Prisma and no
     * repository — and every other tool file remains absolutely read-only.
     */
    const READ_ONLY_LOCK_EXEMPT: Readonly<Record<string, string>> = {
        'external-tools.ts: createAgentProposal':
            '#2861 — at PROPOSE_ONLY an external write is queued as a proposal for human '
            + 'approval. This file is the external WRITE path, not a read tool.',
    };

    it('exempts nothing that has stopped being imported', () => {
        // An exemption that outlives its import is a hole nobody reopened
        // deliberately. Same shape the index and N+1 maps use.
        for (const key of Object.keys(READ_ONLY_LOCK_EXEMPT)) {
            const [base, name] = key.split(': ');
            const file = files.find((f) => path.basename(f) === base);
            expect(file).toBeDefined();
            expect(fs.readFileSync(file!, 'utf8')).toContain(name);
        }
    });

    it('NO tool file imports a create/update/delete usecase (read-only lock)', () => {
        const mutating = /\b(create|update|delete|remove|apply|install|generate|propose|draft|assign|approve|execute)[A-Z]\w*/;
        const offenders: string[] = [];
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(/import\s+\{([^}]*)\}\s+from\s+['"]@\/app-layer\/usecases[^'"]*['"]/g)) {
                for (const n of m[1].split(',').map((s) => s.trim())) {
                    const key = `${path.basename(file)}: ${n}`;
                    if (mutating.test(n) && !(key in READ_ONLY_LOCK_EXEMPT)) offenders.push(key);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
