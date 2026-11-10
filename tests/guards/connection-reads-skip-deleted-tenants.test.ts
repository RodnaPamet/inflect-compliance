/**
 * A read of integration connections across tenants skips deleted workspaces (#5017).
 *
 * THE DEFECT. The nightly dispatchers chose their connections with
 * `{ provider, isEnabled: true }` and nothing else. A soft-deleted workspace's
 * connections stay enabled, so it went on calling its customer's directory,
 * HRIS and cloud accounts every night until the tenant purge, 90 days later.
 * Found on production on 2026-11-10: a member-less test workspace had failed
 * its Entra sync every night for a month, and soft-deleting it would not have
 * stopped the dispatch. Ten queries had the shape.
 *
 * THE RULE, asked of every `integrationConnection.findMany` under `src/`: when
 * its `where` is not scoped to one tenant (no `tenantId` key), it names
 * `tenant: { deletedAt: null }`. A tenant-scoped read is already inside a
 * workspace somebody resolved, so it is left alone.
 *
 * Read from the syntax tree, not the text: a comment naming the filter, or the
 * filter on a neighbouring call, cannot satisfy it. A `where` the walk cannot
 * read as an object literal fails the guard rather than passing it.
 */
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';

import { repoFiles, repoRelative } from '../helpers/repo-files';

interface Site {
    file: string;
    line: number;
    verdict: 'tenant-scoped' | 'skips-deleted' | 'MISSING' | 'UNREADABLE';
}

function propertyNamed(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
    return obj.properties.find(
        (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
    );
}

function hasShorthand(obj: ts.ObjectLiteralExpression, name: string): boolean {
    return obj.properties.some((p) => ts.isShorthandPropertyAssignment(p) && p.name.text === name);
}

/** `tenant: { deletedAt: null }` in this object literal. */
function skipsDeletedTenant(where: ts.ObjectLiteralExpression): boolean {
    const tenant = propertyNamed(where, 'tenant');
    if (!tenant || !ts.isObjectLiteralExpression(tenant.initializer)) return false;
    const deletedAt = propertyNamed(tenant.initializer, 'deletedAt');
    return deletedAt !== undefined && deletedAt.initializer.kind === ts.SyntaxKind.NullKeyword;
}

function classify(call: ts.CallExpression): Site['verdict'] {
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return 'UNREADABLE';
    const where = propertyNamed(arg, 'where');
    if (!where || !ts.isObjectLiteralExpression(where.initializer)) return 'UNREADABLE';
    const w = where.initializer;
    if (propertyNamed(w, 'tenantId') || hasShorthand(w, 'tenantId')) return 'tenant-scoped';
    return skipsDeletedTenant(w) ? 'skips-deleted' : 'MISSING';
}

/** `<anything>.integrationConnection.findMany(...)` */
function isConnectionFindMany(node: ts.Node): node is ts.CallExpression {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    return (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'findMany' &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === 'integrationConnection'
    );
}

function sitesIn(file: string): Site[] {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('integrationConnection.findMany')) return [];
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const out: Site[] = [];
    const visit = (node: ts.Node): void => {
        if (isConnectionFindMany(node)) {
            out.push({
                file: repoRelative(file),
                line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                verdict: classify(node),
            });
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

const SITES = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).flatMap(sitesIn);

describe('cross-tenant reads of integration connections skip deleted workspaces (#5017)', () => {
    it('finds the population, so an empty scan cannot pass', () => {
        // Ten cross-tenant reads were fixed by #5017, and the tenant-scoped
        // reads outnumber them. A walk that found none would be broken.
        expect(SITES.filter((s) => s.verdict === 'skips-deleted').length).toBeGreaterThanOrEqual(10);
        expect(SITES.filter((s) => s.verdict === 'tenant-scoped').length).toBeGreaterThan(0);
    });

    it('every read not scoped to one tenant names tenant: { deletedAt: null }', () => {
        expect(SITES.filter((s) => s.verdict === 'MISSING').map((s) => `${s.file}:${s.line}`)).toEqual([]);
    });

    it('every read has a where the walk can read', () => {
        expect(SITES.filter((s) => s.verdict === 'UNREADABLE').map((s) => `${s.file}:${s.line}`)).toEqual([]);
    });

    it('the reads #5017 fixed are among the reads that skip deleted workspaces', () => {
        const skipping = new Set(SITES.filter((s) => s.verdict === 'skips-deleted').map((s) => s.file));
        for (const file of [
            'src/app-layer/jobs/identity-sync.ts',
            'src/app-layer/jobs/hris-sync.ts',
            'src/app-layer/jobs/identity-joiner.ts',
            'src/app-layer/jobs/identity-leaver.ts',
            'src/app-layer/jobs/cloud-posture-collect-dispatch.ts',
            'src/app-layer/jobs/sharepoint-delta-sync.ts',
            'src/app-layer/jobs/agent-credential-hygiene.ts',
            'src/app-layer/jobs/integration-passport-sweep.ts',
            'src/app-layer/usecases/webhook-processor.ts',
            'src/lib/observability/connection-freshness.ts',
        ]) {
            expect(skipping.has(file)).toBe(true);
        }
    });
});
