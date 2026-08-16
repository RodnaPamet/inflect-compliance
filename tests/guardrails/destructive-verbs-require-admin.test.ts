/**
 * A destructive verb requires ADMIN — on EVERY register, and on the SINGLE
 * path as well as the bulk one.
 *
 * `deleteTask` shipped gated on `assertCanWriteTasks` while every peer
 * (`deleteRisk`, `deleteAsset`, `deleteEvidence`, `deleteControl`,
 * `deletePolicy`) required ADMIN. That was not merely inconsistent, it was
 * BYPASSABLE: `bulkDeleteTask` has always been `assertCanAdmin`, so an EDITOR
 * refused the bulk verb could loop `DELETE /tasks/{id}` and reach the same
 * outcome. A gate one call site can iterate around is not a gate.
 *
 * Two audits missed it — my own, and `bulk-actions-rollout` — for the same
 * reason: both checked INTERNAL consistency (does bulk match single on this
 * surface?) rather than PEER consistency (does this surface match every other
 * surface for the same verb class?). This asserts the peer relation directly,
 * which is the thing neither audit could see.
 *
 * SCOPE. Only the tenant registers a user reaches from a list page. Verbs that
 * are inherently privileged by another mechanism (platform-admin, org-scope,
 * job-internal) are out, and each exclusion is named rather than pattern-matched
 * so adding a register cannot silently opt out.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * register → file, single-delete fn, bulk-delete fn. Either may be `null`
 * where that path does not ship: vendors have NO single-delete usecase at all,
 * only `bulkDeleteVendor`, so a vendor is deletable exclusively in bulk.
 * Writing that down beats asserting a function that was never there — an
 * earlier draft of this file invented `deleteVendor` and reported its absence
 * as a missing gate.
 */
const REGISTERS: ReadonlyArray<{
    name: string;
    file: string;
    single: string | null;
    bulk: string | null;
}> = [
    { name: 'task', file: 'src/app-layer/usecases/task.ts', single: 'deleteTask', bulk: 'bulkDeleteTask' },
    { name: 'risk', file: 'src/app-layer/usecases/risk.ts', single: 'deleteRisk', bulk: 'bulkDeleteRisk' },
    { name: 'asset', file: 'src/app-layer/usecases/asset.ts', single: 'deleteAsset', bulk: 'bulkDeleteAsset' },
    { name: 'evidence', file: 'src/app-layer/usecases/evidence.ts', single: 'deleteEvidence', bulk: 'bulkDeleteEvidence' },
    { name: 'policy', file: 'src/app-layer/usecases/policy.ts', single: 'deletePolicy', bulk: 'bulkDeletePolicy' },
    { name: 'control', file: 'src/app-layer/usecases/control/mutations.ts', single: 'deleteControl', bulk: 'bulkDeleteControl' },
    { name: 'vendor', file: 'src/app-layer/usecases/vendor.ts', single: null, bulk: 'bulkDeleteVendor' },
    // Added after the cross-surface sweep found deleteProcessMap on
    // assertCanWrite. Worth its own note: ProcessMap is in NEITHER
    // SOFT_DELETE_MODELS nor the SoftDeletableModel union, so unlike every
    // other register here a mistaken delete has no restore path for any role.
    // That makes the ADMIN gate the only thing standing between an EDITOR and
    // an unrecoverable loss of control-coverage evidence.
    { name: 'process map', file: 'src/app-layer/usecases/process-map.ts', single: 'deleteProcessMap', bulk: null },
];

/** Any of these satisfies "requires ADMIN". */
const ADMIN_GATE = /assertCanAdmin(Policies|Vendors|Tasks)?\(|admin\.manage/;

describe('destructive verbs require ADMIN on every register', () => {
    it('covers the registers a user reaches from a list page (parser sanity)', () => {
        // A broken list would make every assertion below vacuously pass.
        expect(REGISTERS.length).toBeGreaterThanOrEqual(7);
        for (const r of REGISTERS) {
            expect(fs.existsSync(path.join(ROOT, r.file))).toBe(true);
        }
    });

    it.each(REGISTERS.filter((r) => r.single).map((r) => [r.name, r] as const))(
        '%s: the SINGLE delete requires ADMIN',
        (_name, r) => {
            const body = functionBodyOf(read(r.file), r.single as string);
            expect(body).toMatch(ADMIN_GATE);
        },
    );

    it.each(REGISTERS.filter((r) => r.bulk).map((r) => [r.name, r] as const))(
        '%s: the BULK delete requires ADMIN',
        (_name, r) => {
            const body = functionBodyOf(read(r.file), r.bulk as string);
            expect(body).toMatch(ADMIN_GATE);
        },
    );

    /**
     * The bypass, asserted as a relation rather than two independent facts.
     * A future PR that lowers EITHER side re-opens it, and checking them
     * separately would let a reviewer read one green tick as covering both.
     */
    it.each(REGISTERS.filter((r) => r.bulk && r.single).map((r) => [r.name, r] as const))(
        '%s: single and bulk agree, so the bulk gate is not loopable',
        (_name, r) => {
            const src = read(r.file);
            const single = ADMIN_GATE.test(functionBodyOf(src, r.single as string));
            const bulk = ADMIN_GATE.test(functionBodyOf(src, r.bulk as string));
            expect({ verb: r.name, single, bulk }).toEqual({
                verb: r.name,
                single: true,
                bulk: true,
            });
        },
    );
});

/**
 * The counter-case, so this file cannot be read as "raise everything to ADMIN".
 * #1884 drew the line deliberately: destructive verbs ADMIN, RECOVERABLE verbs
 * EDITOR. Pinning the recoverable side means a future sweep that flattens the
 * distinction fails here instead of quietly removing an EDITOR's job.
 */
describe('recoverable bulk verbs stay at EDITOR', () => {
    const vendor = 'src/app-layer/usecases/vendor.ts';

    it.each(['bulkSetVendorStatus', 'bulkAssignVendor'])(
        '%s is EDITOR-gated, not ADMIN',
        (fn) => {
            const body = functionBodyOf(read(vendor), fn);
            expect(body).toMatch(/assertCanManageVendors\(/);
            expect(body).not.toMatch(/assertCanAdmin\(/);
        },
    );
});
