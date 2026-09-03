/**
 * MCP server coverage ratchet — the cross-tenant-leak lock.
 *
 * IC's MCP server is a THIN ADAPTER that MUST inherit the existing security
 * model: every tool/resource call runs Bearer TenantApiKey → verifyApiKey →
 * RequestContext → enforceApiKeyScope → usecase (runInTenantContext RLS +
 * permission) → appendAuditEntry. A tool that queries Prisma directly, skips
 * the scope gate, or mutates without human approval is a cross-tenant data
 * leak or a silent-agent-write. This guard locks all of that structurally.
 *
 * Phase 1 is READ-ONLY. The propose-not-commit write lock lands with its own
 * ratchet (mcp-propose-coverage) in Phase 3; this guard additionally asserts
 * NO MCP source imports a create/update/delete usecase today.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

import { VALID_SCOPES } from '@/lib/auth/api-key-auth';

const ROOT = path.resolve(__dirname, '../..');
// codeOf() masks comments at the READ SEAM (#2246), so a COMMENT naming a
// thing cannot satisfy an assertion meant to be about CODE. Masking is the
// DEFAULT (`read`) so a new assertion inherits it; `readRaw` is for the files
// where a `//` is content rather than a comment — the `https://` of a URL in
// YAML / JSON / Markdown — and masking would delete real text.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const MCP_DIR = path.join(ROOT, 'src/lib/mcp');
const ROUTE = 'src/app/api/mcp/route.ts';

/** Every .ts file under src/lib/mcp (recursive), excluding tests. */
function mcpSourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            if (fs.statSync(full).isDirectory()) walk(full);
            else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
        }
    };
    walk(MCP_DIR);
    return out;
}

/** Tool/resource implementation files (exclude protocol/types/auth/registry plumbing). */
function toolImplFiles(): string[] {
    return mcpSourceFiles().filter((f) => {
        const rel = path.relative(MCP_DIR, f);
        return rel.startsWith('tools/') && !rel.endsWith('types.ts') && !rel.endsWith('registry.ts');
    });
}

describe('MCP server — cross-tenant-leak lock', () => {
    it('NO MCP source imports the Prisma client or a repository directly', () => {
        // The one thing this PR cannot ship: a tool that bypasses the tenant
        // chain by querying Prisma itself. Every read MUST go through a usecase
        // (which binds RLS via runInTenantContext).
        const offenders: string[] = [];
        for (const file of mcpSourceFiles()) {
            const src = codeOf(fs.readFileSync(file, 'utf8'));
            if (/from ['"]@\/lib\/prisma['"]/.test(src)) offenders.push(`${path.relative(ROOT, file)}: imports @/lib/prisma`);
            if (/from ['"]@prisma\/client['"]/.test(src) && /new PrismaClient/.test(src)) offenders.push(`${path.relative(ROOT, file)}: instantiates PrismaClient`);
            if (/from ['"]@\/app-layer\/repositories/.test(src)) offenders.push(`${path.relative(ROOT, file)}: imports a repository`);
            // A file that binds RLS itself must IMPORT runInTenantContext — the
            // MCP layer must not (it goes through usecases, which bind RLS).
            // Match the import, not prose mentions in comments.
            if (/import[\s\S]*?\b(runInTenantContext|runInTenantReadContext)\b[\s\S]*?from ['"]@\/lib\/db/.test(src)) {
                offenders.push(`${path.relative(ROOT, file)}: imports runInTenantContext directly (must go through a usecase)`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the route file does not query Prisma directly either', () => {
        const src = read(ROUTE);
        expect(src).not.toMatch(/from ['"]@\/lib\/prisma['"]/);
        expect(src).not.toMatch(/from ['"]@\/app-layer\/repositories/);
    });
});

describe('MCP server — authentication inherits the TenantApiKey chain', () => {
    const auth = read('src/lib/mcp/auth.ts');
    const route = read(ROUTE);

    it('authenticates via verifyApiKey (no parallel auth path)', () => {
        expect(auth).toMatch(/verifyApiKey/);
        expect(auth).toMatch(/from ['"]@\/lib\/auth\/api-key-auth['"]/);
        // No bespoke token hashing / key lookup in the MCP layer.
        expect(auth).not.toMatch(/createHash|findUnique|tenantApiKey/);
    });

    it('gates the whole surface behind an MCP capability scope (mcp:read / mcp:propose)', () => {
        // The endpoint requires an MCP capability; read tools further require
        // mcp:read, propose tools mcp:propose. A REST key without any MCP scope
        // is refused.
        expect(auth).toMatch(/mcp:read/);
        expect(auth).toMatch(/mcp:propose/);
        expect(auth).toMatch(/throw forbidden\(/);
    });

    it('the route authenticates every request before dispatch', () => {
        expect(route).toMatch(/authenticateMcpRequest\(req\)/);
        // Auth must precede body dispatch.
        expect(route.indexOf('authenticateMcpRequest')).toBeLessThan(route.indexOf('dispatchMcp'));
    });

    it('mcp:read + mcp:propose are registered scopes; there is no write-direct scope', () => {
        expect(VALID_SCOPES).toContain('mcp:read');
        expect(VALID_SCOPES).toContain('mcp:propose');
        expect(VALID_SCOPES).not.toContain('mcp:write');
    });
});

describe('MCP server — every read tool is usecase-backed, scope-gated, audited', () => {
    it('every tool implementation calls exactly an existing usecase (no direct data access)', () => {
        const files = toolImplFiles();
        expect(files.length).toBeGreaterThanOrEqual(1);
        for (const file of files) {
            const src = codeOf(fs.readFileSync(file, 'utf8'));
            expect(src).toMatch(/from ['"]@\/app-layer\/usecases/);
        }
    });

    it('the execution funnel enforces the resource scope AND audits every call', () => {
        const registry = read('src/lib/mcp/tools/registry.ts');
        expect(registry).toMatch(/enforceApiKeyScope\(/);
        expect(registry).toMatch(/appendAuditEntry\(/);
        expect(registry).toMatch(/actorType:\s*['"]API_KEY['"]/);
    });

    it('resource reads are scope-gated + usecase-backed too', () => {
        const resources = read('src/lib/mcp/resources.ts');
        expect(resources).toMatch(/enforceApiKeyScope\(/);
        expect(resources).toMatch(/from ['"]@\/app-layer\/usecases/);
    });
});

describe('MCP server — propose-not-commit lock (no direct entity mutation)', () => {
    it('NO MCP source imports an ENTITY create/update/delete usecase', () => {
        // The load-bearing safety property: an MCP tool may NEVER create a real
        // record directly. Propose tools call `createAgentProposal` (the
        // human-approval QUEUE, allowed) — imports from the `agent-proposals`
        // usecase module are exempt; imports of entity create/update/delete
        // usecases (createRisk, createControl, …) are forbidden.
        const mutating = /\b(create|update|delete|remove|apply|install|generate|draft)[A-Z]\w*/;
        const offenders: string[] = [];
        for (const file of mcpSourceFiles()) {
            const src = codeOf(fs.readFileSync(file, 'utf8'));
            for (const m of src.matchAll(/import\s+\{([^}]*)\}\s+from\s+['"](@\/app-layer\/usecases[^'"]*)['"]/g)) {
                const modulePath = m[2];
                if (modulePath.includes('agent-proposals')) continue; // the proposal queue is allowed
                for (const n of m[1].split(',').map((s) => s.trim())) {
                    if (mutating.test(n)) offenders.push(`${path.relative(ROOT, file)}: imports entity-mutating usecase ${n}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('MCP server — AISVS C9/C10 applicability documented', () => {
    it('the implementation note records the AISVS agentic + MCP-security applicability', () => {
        const note = readRaw('docs/implementation-notes/2026-07-01-mcp-server.md');
        expect(note).toMatch(/AISVS/);
        expect(note).toMatch(/C9/);
        expect(note).toMatch(/C10/);
    });
});
