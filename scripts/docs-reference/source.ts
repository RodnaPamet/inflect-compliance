/**
 * What the docs reference generator reads, and how it reads it.
 *
 * The population is git's (`git ls-files`), not a directory walk, for the
 * reason tests/helpers/repo-files.ts gives: a skip list is a denominator
 * nobody checks. Parsing is syntax only (`ts.createSourceFile`), so the
 * generator needs no type-check and no generated Prisma client.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Repo-relative POSIX paths of every file git considers part of the repo. */
export function repoFiles(root: string = REPO_ROOT): string[] {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean).sort();
}

export function readRepoFile(rel: string, root: string = REPO_ROOT): string {
    return fs.readFileSync(path.join(root, rel), 'utf8');
}

export function parse(rel: string, text: string): ts.SourceFile {
    const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
}

/** Depth-first walk over every node of a file. */
export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
    visit(node);
    node.forEachChild((child) => walk(child, visit));
}

/** The 1-based line a node starts on. */
export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** A string literal or a template with no substitutions, else null. */
export function literalText(node: ts.Node | undefined): string | null {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
}

/** `src/app/t/[tenantSlug]/(app)/risks/page.tsx` → its directory's URL segments, groups dropped. */
export function routeSegments(dirRel: string, base: string): string[] {
    return dirRel
        .slice(base.length)
        .split('/')
        .filter((s) => s && !/^\(.*\)$/.test(s));
}
