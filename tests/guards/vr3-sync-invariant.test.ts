/**
 * VR-3 — Canvas ↔ AutomationRule sync INVARIANT guardrail.
 *
 * The keystone invariant: `ProcessNode` owns geometry, `AutomationRule` owns
 * logic, NEVER mixed. A violation anywhere in VR-4…VR-10 would require a data
 * migration to untangle — so this ratchet ships with the sync service (the
 * roadmap's explicit day-one requirement).
 *
 * Structural enforcement: the sync service is the ONLY place the two
 * projections meet, so we lock its source shape:
 *   1. It never references geometry columns (posX/posY/parentNodeKey) — so
 *      geometry can't leak into a rule write.
 *   2. It never references rule LOGIC columns (triggerFilterJson /
 *      actionConfigJson) when writing a node — the only thing written back to
 *      a node is `ruleId`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

// #3541 — the rule-owning KIND set, imported rather than re-spelled. A guard
// that re-lists the kinds is a second copy of the thing it is checking.
import {
    RULE_OWNING_KINDS,
    STUB_BY_KIND,
} from '@/app-layer/services/canvas-rule-sync';
import {
    AUTOMATION_NODE_ORDER,
    NODE_TAXONOMY,
} from '@/components/processes/node-taxonomy';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

const SYNC = 'src/app-layer/services/canvas-rule-sync.ts';

/** Strip block + line comments so the scan sees CODE only (comments
 * legitimately name the forbidden fields when documenting the invariant). */
function code(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('VR-3 — sync invariant', () => {
    it('the sync service exists with both directions', () => {
        expect(exists(SYNC)).toBe(true);
        const src = code(read(SYNC));
        expect(src).toMatch(/export async function syncCanvasToRules/);
        expect(src).toMatch(/export async function hydrateCanvasFromRules/);
    });

    it('never references geometry columns (no geometry → rule leak)', () => {
        const src = code(read(SYNC));
        for (const geom of ['posX', 'posY', 'parentNodeKey']) {
            expect(src).not.toMatch(new RegExp(geom));
        }
    });

    it('never writes rule logic columns to a node (only ruleId crosses to nodes)', () => {
        const src = code(read(SYNC));
        for (const logic of ['triggerFilterJson', 'actionConfigJson']) {
            expect(src).not.toMatch(new RegExp(logic));
        }
        // the only field written back onto a node is `ruleId`
        expect(src).toMatch(/ruleId: rule\.id/);
    });

    it('the save/load usecase gates sync on AUTOMATION mode', () => {
        const src = read('src/app-layer/usecases/process-map.ts');
        expect(src).toMatch(/syncCanvasToRules/);
        expect(src).toMatch(/hydrateCanvasFromRules/);
        expect(src).toMatch(/canvasMode === 'AUTOMATION'/);
    });
});

/**
 * #3541 — WHICH NODE KINDS OWN A RULE, folded in here rather than given its own
 * file: `no-epic-named-ratchets` ratchets the guard-FILE count downward, so a
 * new assertion belongs in the guard that already owns the subject. This one
 * does — the kind set is the bridge's other invariant, beside the
 * geometry/logic split above.
 *
 * THE DEFECT IT PREVENTS. `canvas-rule-sync.ts` held
 * `const ACTION_KIND = 'action'` in two queries and one filter. #3471 added
 * `agent` as a fifth automation node kind — palette entry, taxonomy metadata,
 * canvas renderer — and the bridge did not learn about it, so an operator could
 * drag an Agent node on, save, and the node owned nothing: no stub rule, no
 * `dataJson.ruleId`, nothing for the inspector to open. It RENDERED, which is
 * what made it look finished. A constant cannot be wrong about a set it does
 * not know it is, so the set is explicit and held here against the two things
 * it must agree with.
 */
describe('the rule-owning node kinds', () => {
    it('are exactly `action` and `agent`', () => {
        // Exact, not a subset. A subset assertion passes for the empty set, and
        // an empty set makes every canvas node inert — the defect, generalised.
        expect([...RULE_OWNING_KINDS].sort()).toEqual(['action', 'agent']);
    });

    it('are all real automation kinds the palette offers', () => {
        // A kind in this set that the palette does not offer is a rule nobody
        // can create; a typo here would be exactly that and would look fine.
        for (const kind of RULE_OWNING_KINDS) {
            expect(AUTOMATION_NODE_ORDER).toContain(kind);
            expect(NODE_TAXONOMY[kind as keyof typeof NODE_TAXONOMY]).toBeDefined();
        }
    });

    it('every one of them has a stub, and every stub names a kind', () => {
        // THE AGREEMENT THAT MATTERS. The create path falls back to the action
        // stub for an unknown kind, which keeps a sixth kind from crashing —
        // and a fallback nobody checks is how a kind silently gets the wrong
        // default. Both directions, so neither table can grow alone.
        for (const kind of RULE_OWNING_KINDS) {
            expect(STUB_BY_KIND[kind]).toBeDefined();
        }
        for (const kind of Object.keys(STUB_BY_KIND)) {
            expect(RULE_OWNING_KINDS.has(kind)).toBe(true);
        }
    });

    it('an AGENT node stubs an INVOKE_AGENT rule, not a notification', () => {
        // The one thing the KIND already decided. Defaulting an agent node to
        // `NOTIFY_USER` would make the operator's first job undoing the
        // default, and the node would read as a notification on the canvas
        // until they did.
        expect(STUB_BY_KIND.agent.actionType).toBe('INVOKE_AGENT');
        expect(STUB_BY_KIND.action.actionType).toBe('NOTIFY_USER');
    });

    it('the agent stub is EMPTY, so the rule cannot be enabled until configured', () => {
        // `agentId` and `workflowKey` are `z.string().min(1)`, so an empty
        // config is refused when somebody tries to ENABLE the rule — which is
        // exactly when it should be refused. A fabricated agent id would pass
        // that check and fail at dispatch with `agent_not_found` instead,
        // moving the error from authoring time to fire time.
        expect(STUB_BY_KIND.agent.actionConfig).toEqual({});
    });

    it('the feeding kinds own nothing — trigger, condition and slaGate', () => {
        // Named individually rather than as "the complement", because the
        // complement is computed from the same set the first test pins and
        // would agree with it by construction.
        for (const kind of ['trigger', 'condition', 'slaGate']) {
            expect(RULE_OWNING_KINDS.has(kind)).toBe(false);
        }
    });
});
