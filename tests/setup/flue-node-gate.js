/**
 * `globalSetup` of the `flue` Jest project: refuse a Node too old to run it.
 *
 * The flue project loads its ESM-only packages (`@flue/runtime`, pi-ai, and the
 * `.mjs` side of dual packages such as `dedent`, which Jest's own test framework
 * pulls in) through Node's native `require(esm)`, which Jest uses from Node 24.9
 * on. Under an older Node every suite failed at load with "Must use import to
 * load ES Module: …/dedent/dist/dedent.mjs", which names neither the project nor
 * the cause, and reads like a broken dependency. This says what is wrong instead.
 *
 * Jest runs a project's `globalSetup` only when a test of that project is
 * selected, so a run of the node or jsdom projects is untouched.
 *
 * CommonJS on purpose: Jest loads it outside the project's ESM transform.
 */
'use strict';

/** The first Node release on which Jest loads an ES module through `require`. */
const FLUE_MIN_NODE = [24, 9];

/**
 * Why the flue project cannot run on this Node, or null when it can.
 * @param {string} version a `process.versions.node` value, e.g. "22.22.0"
 * @returns {string | null}
 */
function flueNodeRefusal(version) {
    const [major, minor] = String(version).split('.').map((n) => Number.parseInt(n, 10));
    const [minMajor, minMinor] = FLUE_MIN_NODE;
    const ok = major > minMajor || (major === minMajor && minor >= minMinor);
    if (ok) return null;
    return (
        `The flue test project needs Node ${minMajor}.${minMinor} or later, and this is Node ${version}. ` +
        'It loads ESM-only packages through Node\'s require(esm), which Jest uses from Node 24.9 on. ' +
        'The repository pins Node 24 (.nvmrc, package.json engines), and CI runs it.'
    );
}

module.exports = async function flueNodeGate() {
    const refusal = flueNodeRefusal(process.versions.node);
    if (refusal) throw new Error(refusal);
};
module.exports.flueNodeRefusal = flueNodeRefusal;
module.exports.FLUE_MIN_NODE = FLUE_MIN_NODE;
