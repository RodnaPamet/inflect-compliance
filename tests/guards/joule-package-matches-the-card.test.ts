/**
 * THE JOULE PACKAGE AND THE AGENT CARD CANNOT DRIFT (#3865).
 *
 * Two surfaces route requests to the same workflow, and they are edited in
 * different places by different people:
 *
 *   `deploy/joule/.../scenarios/invoke_agent.yaml`  Joule matches user intent
 *                                                   on its `description`
 *   the host-consumer agent card                    a spec-reading host reads
 *                                                   `skills[].description`
 *
 * Two independently maintained copies of "when to call this agent" diverge, and
 * the divergence is silent: Joule starts sending requests the card does not
 * advertise, or stops sending ones it does, and nothing fails. So the card's
 * copy is the SOURCE and this file is what makes that true rather than
 * aspirational.
 *
 * The card's is the source because it is the one a reviewer already reads — it
 * ships in `sap-transaction-review.ts` beside the workflow and is held by the
 * R19 scans in `a2a-host-card-skills.test.ts`. The YAML is a deployment
 * artefact nobody diffs.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { sapTransactionReviewWorkflow } from '@/lib/agentic/workflows/sap-transaction-review';
import { advertisedA2aSkills } from '@/lib/agentic/a2a/host-card-skills';

const ROOT = path.resolve(__dirname, '../..');
const PKG = 'deploy/joule';

/** Every file `joule deploy` needs, so a missing one is reported as missing. */
const FILES = [
    'da.sapdas.yaml',
    'capability/capability.sapdas.yaml',
    'capability/capability_context.yaml',
    'capability/functions/call_agent.yaml',
    'capability/scenarios/invoke_agent.yaml',
] as const;

/**
 * Read a package file, or `null` if it is not there.
 *
 * `null` rather than a throw, and the reads happen INSIDE the tests rather than
 * at describe scope, because of what the first draft did: renaming one file away
 * made the whole suite report
 *
 *     Test suite failed to run — ENOENT …
 *     Tests: 0 total
 *
 * Zero tests beside a failed suite says the module never loaded, which tells a
 * reader nothing about what was being defended. A guard whose failure mode is a
 * crash cannot report its own violation — so this one names the missing file
 * instead, and the test below is what makes that true.
 */
const read = (rel: string): string | null => {
    try {
        return readFileSync(path.join(ROOT, PKG, rel), 'utf8');
    } catch {
        return null;
    }
};

/** The same read, for a test that has already established the file is there. */
const must = (rel: string): string => {
    const body = read(rel);
    expect(body).not.toBeNull();
    return body ?? '';
};

describe('the package is present at all', () => {
    it('ships every file joule deploy needs, and NAMES any that are missing', () => {
        // The first assertion on purpose: every test below reads one of these,
        // and without this one a deleted file is a crash rather than a finding.
        expect(FILES.filter((f) => read(f) === null)).toEqual([]);
    });
});

/**
 * The file with its `#` comment lines removed.
 *
 * Needed because these files EXPLAIN what must not appear in them, so a naive
 * substring match hits the warning rather than a field — which is exactly how
 * this guard failed on its first run: `da.sapdas.yaml` names
 * `enable_native_agenticness` in a comment saying not to include it. A comment
 * hit usually means the thing was deliberately kept OUT.
 */
const code = (rel: string) =>
    must(rel)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');

/** Collapse YAML folded-scalar wrapping so prose compares as prose. */
const flatten = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('the scenario description is the card’s skill description', () => {
    const scenario = () => must('capability/scenarios/invoke_agent.yaml');

    it('carries the workflow’s a2aSkill description verbatim', () => {
        const fromCard = sapTransactionReviewWorkflow.a2aSkill?.description;
        expect(fromCard).toBeTruthy();
        // The YAML's `description:` block, up to the next top-level key.
        const block = /description:\s*>\s*\n([\s\S]*?)\n\w/.exec(scenario());
        expect(block).not.toBeNull();
        expect(flatten(block![1])).toBe(flatten(fromCard!));
    });

    it('the workflow is actually advertised, or this guard pins a dead string', () => {
        // The denominator. If `sap-transaction-review` stopped carrying
        // `a2aSkill`, the assertion above would still pass against a card that
        // advertises nothing — so the advertised set is checked too.
        expect(advertisedA2aSkills().map((s) => s.id)).toContain('sap-transaction-review');
    });
});

describe('the two values SAP’s toolkit fails deploy on', () => {
    const capability = () => must('capability/capability.sapdas.yaml');
    const da = () => must('da.sapdas.yaml');

    it('the capability namespace is joule.ext, which deploy requires', () => {
        // `SKILL.md:319` — any other namespace fails with a namespace
        // validation error. Asserted because SAP's own reference examples show
        // `com.sap.paa`, so a reader following the examples would break deploy.
        expect(capability()).toMatch(/namespace:\s*joule\.ext\b/);
    });

    it('the two schema versions are the right way round', () => {
        // `SKILL.md:318`: the capability is 3.28.0 and the DA descriptor is
        // 1.4.0. They are easy to swap and the failure is a deploy-time error
        // nobody reads as a version mix-up.
        expect(capability()).toMatch(/schema_version:\s*3\.28\.0/);
        expect(da()).toMatch(/schema_version:\s*1\.4\.0/);
    });

    it('the DA descriptor carries neither field that needs 1.5.0-beta', () => {
        // The toolkit's reference names both explicitly as deploy-breaking
        // under 1.4.0. Asserted over `code(...)`, not the raw file: the file's
        // own comment names them in order to warn, and matching that would be
        // reading a scar as a wound.
        const daCode = code('da.sapdas.yaml');
        expect(daCode).not.toContain('enable_native_agenticness');
        expect(daCode).not.toContain('conversational_search');
        // The comment IS still there, which is the point of stripping it.
        expect(da()).toContain('enable_native_agenticness');
    });
});

describe('the alias and the destination agree', () => {
    const capability = () => must('capability/capability.sapdas.yaml');
    const fn = () => must('capability/functions/call_agent.yaml');

    it('the function’s system_alias is one the capability declares', () => {
        // A mismatch here deploys cleanly and fails at call time, which is the
        // worst place for it: the operator sees Joule fail to reach the agent
        // with nothing naming the alias.
        const declared = [...capability().matchAll(/^\s{2}(\w+):\s*$/gm)].map((m) => m[1]);
        const used = /system_alias:\s*(\w+)/.exec(fn())?.[1];
        expect(used).toBeTruthy();
        expect(declared).toContain(used!);
    });
});

describe('the function reads the answer where Inflect writes it', () => {
    const fn = () => must('capability/functions/call_agent.yaml');

    it('renders status.message.parts[0].text — the part #3863 added', () => {
        // The join between the two systems, and the reason J3 exists: this
        // action renders that text for EVERY state, so a response without a
        // text part shows a Joule user nothing.
        expect(fn()).toContain('result.body.status.message.parts[0].text');
    });

    it('takes the task id from result.body.id, which is the run id', () => {
        // `taskFor` returns the run id as the task `id`, and the host's
        // tasks/get branch looks the run up by it. If either side changed, a
        // follow-up turn would silently start a new task instead of resuming.
        expect(fn()).toContain('result.body.id');
        expect(fn()).toContain('result.body.contextId');
    });

    it('sends no body on the first turn, so a new task is created', () => {
        expect(fn()).toMatch(/contextId == null \|\| contextId\.isEmpty\(\)/);
    });
});
