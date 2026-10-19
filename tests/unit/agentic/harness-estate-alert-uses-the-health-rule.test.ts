/**
 * The stale-estate alert judges with the health card's rule, never a copy (#3741).
 *
 * `src/lib/agentic/harness-estate-health.ts` is the ONE place an estate is
 * judged FRESH or STALE: one and a half cadences, a zero-row source is EMPTY,
 * a scan counts from `min(asOf, ingestedAt)`. The daily pass that raises a
 * finding for a stale estate must reach that verdict through the same
 * functions, or the card and the alert can disagree about one estate — and the
 * disagreement would be silent, because each would look right on its own.
 *
 * So, over the three modules of the alert (its pure planner, its usecase and
 * its job), parsed as syntax rather than matched as text:
 *
 *   • the usecase IMPORTS `computeEstateHealth` and `freshnessWindowStart` from
 *     the health module and CALLS the first;
 *   • none of them DECLARES any name the health module exports — a local
 *     `staleAfterHours` or `STALE_AFTER_CADENCES` is the copy this forbids;
 *   • none of them holds the cadence multiple as a numeric literal, nor an
 *     hour in milliseconds — the arithmetic a second window would be built from.
 *
 * The population of forbidden names is derived from the health module's own
 * exports, so a rule added there is covered here without an edit; and each
 * detector is shown to find its target in the health module itself, so an
 * empty result means "absent", not "not looked for".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

import { STALE_AFTER_CADENCES } from '@/lib/agentic/harness-estate-health';

const ROOT = path.resolve(__dirname, '../../..');
const HEALTH = 'src/lib/agentic/harness-estate-health.ts';
const HEALTH_SPECIFIERS = ['@/lib/agentic/harness-estate-health', './harness-estate-health'];
const USECASE = 'src/app-layer/usecases/agent-harness-estate-staleness.ts';
const ALERT_MODULES = ['src/lib/agentic/harness-estate-staleness.ts', USECASE, 'src/app-layer/jobs/agent-harness-estate-staleness.ts'];
const HOUR_MS = 3_600_000;

const parse = (rel: string) =>
    ts.createSourceFile(rel, readFileSync(path.join(ROOT, rel), 'utf8'), ts.ScriptTarget.Latest, true);

function each(node: ts.Node, visit: (n: ts.Node) => void): void {
    visit(node);
    node.forEachChild((child) => each(child, visit));
}

/** Every numeric literal's value. `3_600_000` reads as 3600000. */
function numericLiterals(sf: ts.SourceFile): number[] {
    const out: number[] = [];
    each(sf, (n) => {
        if (ts.isNumericLiteral(n)) out.push(Number(n.text.replace(/_/g, '')));
    });
    return out;
}

/** Every name the file declares: functions, variables, classes, interfaces, types, enums — at any depth. */
function declaredNames(sf: ts.SourceFile): string[] {
    const out: string[] = [];
    each(sf, (n) => {
        if (
            (ts.isFunctionDeclaration(n) ||
                ts.isClassDeclaration(n) ||
                ts.isInterfaceDeclaration(n) ||
                ts.isTypeAliasDeclaration(n) ||
                ts.isEnumDeclaration(n)) &&
            n.name
        ) {
            out.push(n.name.text);
        }
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) out.push(n.name.text);
    });
    return out;
}

/** The names a top-level statement exports. */
function exportedNames(sf: ts.SourceFile): string[] {
    const out: string[] = [];
    for (const st of sf.statements) {
        const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported) continue;
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push(d.name.text);
        } else if (
            (ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st)) &&
            st.name
        ) {
            out.push(st.name.text);
        }
    }
    return out;
}

/** Named imports, by module specifier. */
function namedImportsFrom(sf: ts.SourceFile, specifiers: readonly string[]): string[] {
    const out: string[] = [];
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        if (!specifiers.includes(st.moduleSpecifier.text)) continue;
        const bindings = st.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) out.push(el.name.text);
    }
    return out;
}

function calledIdentifiers(sf: ts.SourceFile): string[] {
    const out: string[] = [];
    each(sf, (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.push(n.expression.text);
    });
    return out;
}

const health = parse(HEALTH);
const ruleNames = exportedNames(health);

describe('the detectors find the rule where it lives', () => {
    it('the health module holds the cadence multiple as a literal, and exports the rule by name', () => {
        expect(STALE_AFTER_CADENCES).toBe(1.5);
        expect(numericLiterals(health).filter((v) => v === STALE_AFTER_CADENCES)).toEqual([STALE_AFTER_CADENCES]);
        expect(ruleNames.filter((n) => ['STALE_AFTER_CADENCES', 'staleAfterHours', 'freshnessWindowStart', 'computeEstateHealth'].includes(n)).sort()).toEqual(
            ['STALE_AFTER_CADENCES', 'computeEstateHealth', 'freshnessWindowStart', 'staleAfterHours'],
        );
        expect(declaredNames(health).filter((n) => n === 'computeEstateHealth')).toEqual(['computeEstateHealth']);
    });
});

describe('the stale-estate alert judges with the health module, never a copy', () => {
    it('the usecase imports the rule and its window from the health module, and calls the rule', () => {
        const usecase = parse(USECASE);
        expect(namedImportsFrom(usecase, HEALTH_SPECIFIERS).filter((n) => n === 'computeEstateHealth' || n === 'freshnessWindowStart').sort()).toEqual([
            'computeEstateHealth',
            'freshnessWindowStart',
        ]);
        expect(calledIdentifiers(usecase).filter((n) => n === 'computeEstateHealth')).toEqual(['computeEstateHealth']);
    });

    it.each(ALERT_MODULES)('%s declares no name the health module exports', (rel) => {
        expect(declaredNames(parse(rel)).filter((n) => ruleNames.includes(n))).toEqual([]);
    });

    it.each(ALERT_MODULES)('%s holds neither the cadence multiple nor an hour in milliseconds as a literal', (rel) => {
        expect(numericLiterals(parse(rel)).filter((v) => v === STALE_AFTER_CADENCES || v === HOUR_MS)).toEqual([]);
    });
});
