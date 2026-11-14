/**
 * The workflow registry answers for its OWN keys only (#5304).
 *
 * `REGISTRY` is a plain object, so a lookup of `constructor` or `toString`
 * returned an `Object.prototype` member. A run started with such a key passed
 * the "unknown workflow" check, was admitted and written, and then crashed in
 * the driver on `def.steps.length`; a host consumer or peer grant naming one was
 * stored as valid and could never run.
 */
import {
    getWorkflowDefinition,
    listWorkflowDefinitions,
    registerWorkflow,
} from '@/lib/agentic/workflow-registry';

const PROTOTYPE_KEYS = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__proto__',
    '__defineGetter__',
];

describe('getWorkflowDefinition', () => {
    it.each(PROTOTYPE_KEYS)('does not resolve the Object.prototype member %s', (key) => {
        expect(getWorkflowDefinition(key)).toBeUndefined();
    });

    it('still resolves every registered definition by its key', () => {
        const defs = listWorkflowDefinitions();
        expect(defs.length).toBeGreaterThan(0);
        for (const def of defs) expect(getWorkflowDefinition(def.key)).toBe(def);
    });

    it('still refuses a duplicate registration', () => {
        const [first] = listWorkflowDefinitions();
        expect(() => registerWorkflow(first)).toThrow(/Duplicate workflow key/);
    });
});
