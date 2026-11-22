/**
 * Every trigger the rule builder offers has a producer (found in the A2A
 * production pilot, 2026-11-22).
 *
 * The builder offered "Risk created", "Risk updated", "Risk status changed" and
 * "Risk controls mapped" for as long as it existed, and nothing emitted any of
 * them: the four helpers in `src/app-layer/events/risk.events.ts` had no
 * caller, and the risk usecases wrote audit rows only. A rule on any of them
 * saved, enabled and never ran, with nothing on the page to say why.
 *
 * A PRODUCER is a named function that calls `emitAutomationEvent(...)` (or,
 * as the schedule sweep does, enqueues on `automation-event-dispatch`) and
 * names the event as a string literal in its body (a ternary or a helper's
 * return counts, as the test-plan pause/resume emitter shows), AND that
 * something in `src/` calls. A helper nobody calls is exactly how the risk
 * events were dead while looking wired; one in `src/app-layer/events/` must be
 * called from outside that folder. The catalogue, contracts and labels
 * (`src/app-layer/automation/`, `src/lib/automation/`) never count.
 *
 * Both halves are held: an OFFERED event must have a producer, and a HIDDEN
 * one (`EVENT_LABELS[...].hidden`) must have none, so hiding an event that
 * still fires is caught as well.
 */
import * as fs from 'fs';
import * as ts from 'typescript';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { AUTOMATION_EVENT_NAMES } from '@/app-layer/automation/events';
import { EVENT_LABELS, eventOptionsByDomain } from '@/lib/automation/event-labels';

const CATALOGUE = new Set<string>(AUTOMATION_EVENT_NAMES);
const NEVER_PRODUCERS = ['src/app-layer/automation/', 'src/lib/automation/'];
const HELPER_DIR = 'src/app-layer/events/';
/** The queue a dispatched event lands on; the schedule sweep enqueues on it directly. */
const DISPATCH_QUEUE = 'automation-event-dispatch';

/** `emitAutomationEvent(...)`, or `enqueue('automation-event-dispatch', ...)`. */
function isEmission(call: ts.CallExpression): boolean {
    const callee = (call.expression as ts.Identifier).text;
    if (callee === 'emitAutomationEvent') return true;
    const first = call.arguments[0];
    return callee === 'enqueue' && !!first && ts.isStringLiteral(first) && first.text === DISPATCH_QUEUE;
}

interface Emitter {
    file: string;
    fn: string;
    events: Set<string>;
}

function enclosingFunctionName(node: ts.Node): { name: string; body: ts.Node } | null {
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
        if (ts.isFunctionDeclaration(cur) && cur.name) return { name: cur.name.text, body: cur };
        if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return { name: cur.name.text, body: cur };
        if (
            (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
            ts.isVariableDeclaration(cur.parent) &&
            ts.isIdentifier(cur.parent.name)
        ) {
            return { name: cur.parent.name.text, body: cur };
        }
        cur = cur.parent;
    }
    return null;
}

function catalogueLiteralsIn(node: ts.Node): Set<string> {
    const out = new Set<string>();
    const visit = (n: ts.Node) => {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CATALOGUE.has(n.text)) {
            out.add(n.text);
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
}

function sameFileCallees(body: ts.Node, sf: ts.SourceFile): ts.FunctionDeclaration[] {
    const called = new Set<string>();
    const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) called.add(n.expression.text);
        ts.forEachChild(n, visit);
    };
    visit(body);
    return sf.statements.filter(
        (st): st is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(st) && !!st.name && called.has(st.name.text) && st !== body,
    );
}

function collectEmitters(): { emitters: Emitter[]; sources: Map<string, string> } {
    const emitters: Emitter[] = [];
    const sources = new Map<string, string>();
    for (const abs of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
        const rel = repoRelative(abs);
        if (NEVER_PRODUCERS.some((p) => rel.startsWith(p))) continue;
        const text = fs.readFileSync(abs, 'utf8');
        sources.set(rel, text);
        if (!text.includes('emitAutomationEvent(') && !text.includes(DISPATCH_QUEUE)) continue;
        const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
        const visit = (n: ts.Node) => {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && isEmission(n)) {
                const owner = enclosingFunctionName(n);
                if (owner) {
                    // The event a call names may come from the function body
                    // (a ternary) or from a same-file function the body calls
                    // (the test-plan pause/resume emitter asks one).
                    const events = catalogueLiteralsIn(owner.body);
                    for (const callee of sameFileCallees(owner.body, sf)) {
                        catalogueLiteralsIn(callee).forEach((e) => events.add(e));
                    }
                    emitters.push({ file: rel, fn: owner.name, events });
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);
    }
    return { emitters, sources };
}

/**
 * Whether anything in `src/` calls `fn`, its own declaration aside. A function
 * in `src/app-layer/events/` must be called from outside that folder.
 */
function isCalled(fn: string, ownFile: string, sources: Map<string, string>): boolean {
    const call = new RegExp(`(?<!function\\s)(?<!function\\s\\s)\\b${fn}\\s*\\(`, 'g');
    for (const [rel, text] of sources) {
        if (ownFile.startsWith(HELPER_DIR) && rel.startsWith(HELPER_DIR)) continue;
        if (call.test(text)) return true;
        call.lastIndex = 0;
    }
    return false;
}

const { emitters, sources } = collectEmitters();

function producersOf(event: string): string[] {
    return emitters
        .filter((e) => e.events.has(event))
        .filter((e) => isCalled(e.fn, e.file, sources))
        .map((e) => `${e.file}#${e.fn}`);
}

describe('automation triggers — every offered trigger has a producer', () => {
    const offered = eventOptionsByDomain().flatMap((g) => g.events.map((e) => e.name));
    const hidden = AUTOMATION_EVENT_NAMES.filter((n) => EVENT_LABELS[n].hidden);

    it('finds emitters at all (a detector that finds nothing proves nothing)', () => {
        expect(emitters.length).toBeGreaterThan(10);
        expect(offered.length).toBeGreaterThan(10);
    });

    it('every offered trigger is emitted by a live producer', () => {
        const dead = offered.filter((e) => producersOf(e).length === 0);
        expect(dead).toEqual([]);
    });

    it('the risk triggers are emitted from the risk usecases, not only from an uncalled helper', () => {
        for (const e of ['RISK_CREATED', 'RISK_UPDATED', 'RISK_STATUS_CHANGED', 'RISK_CONTROLS_MAPPED']) {
            expect(producersOf(e).some((p) => p.startsWith('src/app-layer/usecases/'))).toBe(true);
        }
    });

    it('an emitting function that nobody calls does not count', () => {
        // The four risk.events.ts helpers are still uncalled; if they counted,
        // this guard would have passed while every risk trigger was dead.
        const riskHelpers = emitters.filter((e) => e.file === `${HELPER_DIR}risk.events.ts`);
        expect(riskHelpers.length).toBe(4);
        for (const h of riskHelpers) expect(isCalled(h.fn, h.file, sources)).toBe(false);
    });

    it('every hidden trigger really has no producer', () => {
        expect(hidden.length).toBeGreaterThan(0);
        for (const e of hidden) expect({ event: e, producers: producersOf(e) }).toEqual({ event: e, producers: [] });
    });
});
