/**
 * #3671 — no code path calls Microsoft Graph to disable a service principal
 * except through the external write dispatch.
 *
 * The claim has a precise shape, and each `describe` below holds one link of
 * it against the IMPORT GRAPH of `src/` as git lists it:
 *
 *   1. ONE GRAPH SEAM. Exactly one source file speaks the Graph
 *      `servicePrincipals/` resource: the provider client
 *      `providers/entra-id/service-principal.ts`.
 *   2. ONE CALLER OF IT. Exactly one module imports that client: the usecase
 *      behind the outbound endpoint.
 *   3. ONE CALLER OF THAT. Exactly one module imports the usecase: the route
 *      `src/app/api/mcp/entra-service-principal/route.ts`. A route is an
 *      HTTP entrypoint, so the only way in is a request — and the only intended
 *      requester is the external write dispatch, through a connection.
 *   4. NOT AGENT-FACING. Nothing under `src/lib/mcp/` — the server an agent
 *      speaks to — imports any of the three.
 *   5. ONE SENDER. Exactly one module calls `callTool` with a journal row's
 *      ADVERTISED (write) tool name: `external-write-dispatch.ts`. The request
 *      path the orphan pass uses calls `callTool` only with the paired READ,
 *      and imports no Graph client and no `fetch`.
 *
 * If a job is ever given a shortcut — "just disable it directly" — one of these
 * fails, and the failure names the file that broke the shape.
 *
 * Why an import graph and not a grep for a function name: a grep for
 * `disableServicePrincipal(` passes when the second caller renames its import,
 * and fails on this file's own prose. Import specifiers are resolved to paths,
 * and comments are masked before the one text test (link 1) runs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const CLIENT = 'src/app-layer/integrations/providers/entra-id/service-principal.ts';
const USECASE = 'src/app-layer/usecases/entra-service-principal-dispatch.ts';
const ROUTE = 'src/app/api/mcp/entra-service-principal/route.ts';
const DISPATCH = 'src/app-layer/usecases/external-write-dispatch.ts';
const REQUEST_PATH = 'src/app-layer/usecases/agent-service-principal-disable.ts';
const ORPHAN_PASS = 'src/app-layer/usecases/agent-owner-orphan-pass.ts';

const SOURCES = repoRelativeFiles().filter(
    (f) => f.startsWith('src/') && /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts'),
);
const SOURCE_SET = new Set(SOURCES);

const textOf = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const parsed = new Map<string, ts.SourceFile>();
function sourceFile(rel: string): ts.SourceFile {
    let sf = parsed.get(rel);
    if (!sf) {
        sf = ts.createSourceFile(rel, textOf(rel), ts.ScriptTarget.Latest, true);
        parsed.set(rel, sf);
    }
    return sf;
}

/** Resolve an import specifier from `fromRel` to a repo-relative source path, or null. */
function resolveSpecifier(fromRel: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        if (SOURCE_SET.has(candidate)) return candidate;
    }
    return null;
}

/** Every module a file imports or re-exports, static or dynamic. */
function importsOf(rel: string): Set<string> {
    const out = new Set<string>();
    const visit = (node: ts.Node) => {
        let spec: string | null = null;
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            && node.moduleSpecifier
            && ts.isStringLiteral(node.moduleSpecifier)
        ) {
            spec = node.moduleSpecifier.text;
        } else if (
            ts.isCallExpression(node)
            && node.arguments.length > 0
            && ts.isStringLiteral(node.arguments[0])
            && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
            spec = (node.arguments[0] as ts.StringLiteral).text;
        }
        if (spec !== null) {
            const resolved = resolveSpecifier(rel, spec);
            if (resolved) out.add(resolved);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile(rel));
    return out;
}

const importGraph = new Map(SOURCES.map((f) => [f, importsOf(f)] as const));
const importersOf = (target: string) =>
    SOURCES.filter((f) => f !== target && importGraph.get(f)!.has(target)).sort();

/** The text of every `callTool(...)` call's second argument in a file. */
function callToolSecondArgs(rel: string): string[] {
    const out: string[] = [];
    const sf = sourceFile(rel);
    const visit = (node: ts.Node) => {
        if (
            ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === 'callTool'
            && node.arguments.length >= 2
        ) {
            out.push(node.arguments[1].getText(sf));
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

describe('the population this guard reads is real', () => {
    it('found every file it names — otherwise every assertion below has no subject', () => {
        for (const f of [CLIENT, USECASE, ROUTE, DISPATCH, REQUEST_PATH, ORPHAN_PASS]) {
            expect(SOURCE_SET.has(f)).toBe(true);
        }
        expect(SOURCES.length).toBeGreaterThan(500);
    });
});

describe('1. one Graph seam for the servicePrincipals resource', () => {
    it('only the provider client names the Graph servicePrincipals resource in code', () => {
        const speakers = SOURCES.filter((f) => codeOf(textOf(f)).includes('/servicePrincipals/'));
        expect(speakers).toEqual([CLIENT]);
    });
});

describe('2-3. the client is reached only through the endpoint usecase, and that only through the route', () => {
    it('exactly one module imports the client: the endpoint usecase', () => {
        expect(importersOf(CLIENT)).toEqual([USECASE]);
    });

    it('exactly one module imports the endpoint usecase: the outbound route', () => {
        expect(importersOf(USECASE)).toEqual([ROUTE]);
    });

    it('no source module imports the route — HTTP is the only way in', () => {
        expect(importersOf(ROUTE)).toEqual([]);
    });
});

describe('4. none of it is reachable from the agent-facing MCP server', () => {
    it('nothing under src/lib/mcp/ imports the client, the usecase or the route', () => {
        const agentFacing = SOURCES.filter((f) => f.startsWith('src/lib/mcp/'));
        expect(agentFacing.length).toBeGreaterThan(0);
        const reaching = agentFacing.filter((f) => {
            const deps = importGraph.get(f)!;
            return deps.has(CLIENT) || deps.has(USECASE) || deps.has(ROUTE);
        });
        expect(reaching).toEqual([]);
    });
});

describe('5. the dispatch is the one sender, and the request path only reads', () => {
    it('exactly one module calls callTool with a journal row\'s advertised (write) tool name', () => {
        const senders = SOURCES.filter((f) =>
            callToolSecondArgs(f).some((arg) => arg.includes('advertisedToolName')),
        );
        expect(senders).toEqual([DISPATCH]);
    });

    it('the request path calls callTool only with the paired READ', () => {
        const args = callToolSecondArgs(REQUEST_PATH);
        expect(args.length).toBeGreaterThan(0);
        expect(args).toEqual(args.map(() => 'readRef.toolName'));
    });

    it('neither the request path nor the orphan pass imports a Graph client or calls fetch', () => {
        const graphClients = SOURCES.filter((f) =>
            f.startsWith('src/app-layer/integrations/providers/entra-id/'),
        );
        expect(graphClients).toContain(CLIENT);
        for (const f of [REQUEST_PATH, ORPHAN_PASS]) {
            const deps = importGraph.get(f)!;
            expect(graphClients.filter((g) => deps.has(g))).toEqual([]);
            const sf = sourceFile(f);
            const fetches: string[] = [];
            const visit = (node: ts.Node) => {
                if (
                    ts.isCallExpression(node)
                    && ts.isIdentifier(node.expression)
                    && /^(fetch|safeFetch|resilientFetch)$/.test(node.expression.text)
                ) {
                    fetches.push(node.expression.text);
                }
                ts.forEachChild(node, visit);
            };
            visit(sf);
            expect(fetches).toEqual([]);
        }
    });
});
