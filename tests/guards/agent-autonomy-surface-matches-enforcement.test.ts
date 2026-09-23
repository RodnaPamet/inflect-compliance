/**
 * The rung the Tools tab SHOWS and the rung the funnel ENFORCES cannot drift
 * apart silently.
 *
 * ── THE DIVERGENCE ──────────────────────────────────────────────────────────
 *
 * `requiredAutonomyFor(capabilityClass, declared?)` returns the tool's own
 * declared override when it has one, and the class default otherwise. Both
 * enforcement seams in `authorize.ts` pass BOTH arguments. The agent Tools tab
 * passes ONE:
 *
 *     requiredAutonomyFor(mcpToolCapabilityClass(name))
 *
 * and it has to. That surface builds its map from `MCP_TOOL_NAMES`, a LEAF
 * catalogue with no imports at all — that is the whole reason the catalogue
 * exists, so an admin route learning eleven strings does not drag the tool
 * graph, the dashboard cache and the proposal queue in behind it. A leaf
 * holding only names cannot read `authorize.autonomy` off a tool object it
 * does not have.
 *
 * So this is not an arity to fix. It is a divergence that is HARMLESS TODAY
 * and becomes a wrong answer on a governance surface the moment one tool
 * declares an override:
 *
 *   · the Tools tab would show the class default — the LOWER number;
 *   · `aboveCeiling` would answer `false`, rendering no warning;
 *   · and the funnel would refuse every call to that tool, at the rung the
 *     tab never mentioned.
 *
 * An operator would grant a tool the UI said was within reach and watch it
 * 403 forever. Same class as the step/tool misattribution in #2774 and the
 * paused-run hint in #2783: a governance surface stating something
 * confidently and wrongly.
 *
 * ── SO THE TWO ARE PINNED ───────────────────────────────────────────────────
 *
 * The load-bearing assertion is the population one: NO shipped tool declares
 * an `authorize.autonomy` override. It is green today and goes red on exactly
 * the diff that makes the surface start lying — which is the only moment
 * anybody could act on it.
 *
 * IF YOU ARE HERE BECAUSE THIS WENT RED: you added the first tool with its own
 * rung. The fix is not to delete this test. Either give the exposure usecase
 * the override (a name→rung map exported from the catalogue, kept honest by
 * the same equality `mcp-tools-use-shared-authz` already asserts between the
 * catalogue and the registries), or drop the override and let the class decide.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { READ_TOOLS } from '@/lib/mcp/tools/registry';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';

import { codeOf } from '../helpers/source-blocks';

/**
 * `ROOT` computed LOCALLY — `tests/helpers/assertion-reach.ts` constant-folds a
 * `path.resolve(__dirname, …)` and declines an imported identifier, which would
 * put every assertion here in the Class D un-analysable set.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

const ALL_TOOLS = [...READ_TOOLS, ...PROPOSE_TOOLS] as ReadonlyArray<{
    name: string;
    authorize: { autonomy?: number };
}>;

describe('no shipped tool declares a rung of its own', () => {
    it('examined a real population', () => {
        // Every assertion below is satisfied by an empty list, and an empty
        // list is what a renamed export would produce.
        expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(10);
    });

    it('and none of them overrides its class', () => {
        // THE ASSERTION WITH TEETH. Reported as the offending names rather
        // than a count, so the failure says which tool to reconcile.
        const overriding = ALL_TOOLS.filter((t) => typeof t.authorize.autonomy === 'number').map(
            (t) => t.name,
        );
        expect({ toolsWithOwnRung: overriding }).toEqual({ toolsWithOwnRung: [] });
    });
});

describe('which is the only reason the one-argument call is safe', () => {
    const exposure = read('src/app-layer/usecases/agent-tool-exposure.ts');

    it('the Tools tab derives the rung from the CLASS alone', () => {
        // Stated so the failure above has something to point at. If this ever
        // grows a second argument, the pin is discharged and this file should
        // shrink to the equality it was protecting.
        expect(exposure).toContain('requiredAutonomyFor(mcpToolCapabilityClass(name))');
    });

    it('while the enforcement seams pass the override', () => {
        // The other half of the pair. Without this the test above would be
        // pinning a convention rather than a DISAGREEMENT, and the population
        // assertion would be guarding nothing in particular.
        const authorize = read('src/lib/mcp/authorize.ts');
        expect(authorize).toContain('requiredAutonomyFor(tool.capabilityClass, tool.authorize.autonomy)');
    });

    it('and the adapter that offers tools to an agent passes it too', () => {
        // The third consumer, added with the Flue surface. Three readers, two
        // of which honour an override and one of which cannot see it.
        expect(read('src/lib/agentic/flue/tools-adapter.ts')).toContain(
            'requiredAutonomyFor(capability, tool.authorize.autonomy)',
        );
    });

    it('the catalogue really is a leaf, which is why it cannot do better', () => {
        // The constraint that makes this a pin rather than a fix. If the
        // catalogue ever imports the registries, the leaf argument is gone and
        // the exposure usecase can read the override directly.
        const catalogue = read('src/lib/mcp/tool-catalogue.ts');
        expect(catalogue).not.toContain("from './registry'");
        expect(catalogue).not.toContain("from './propose-tools'");
    });
});
