/**
 * The verification-population floors, and how they are counted.
 *
 * `tests/guards/rendered-coverage-floor.test.ts` holds three counts at or above
 * the floors in `tests/guards/coverage-floors.json`: rendered behavioural tests,
 * E2E specs, and registered high-risk primitives. The guard and the release
 * step that raises the floors (`scripts/raise-coverage-floors.mjs`) both count
 * through this module, so the number the release writes is the number the
 * guard reads.
 *
 * The guard also counts the same three populations at its BASE commit, to
 * refuse a change that removes verification (`countCoverageAt`). That count
 * reads the commit through git and applies the same rules as the live one.
 *
 * CommonJS, and the standard library only, so that both of its readers load
 * it as it is: the release step imports it from an ES module, and Jest
 * requires it from the guard without a transform (Jest's CommonJS runtime
 * cannot load an `.mjs` file).
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Where the floors live, relative to the repository root. */
const FLOORS_FILE = 'tests/guards/coverage-floors.json';

/** The three populations the floors hold, in the order the guard reports them. */
const FLOOR_KEYS = ['rendered', 'e2e', 'registry'];

const REGISTRY_FILE = 'tests/guards/behavioural-coverage-registry.test.ts';

function countFiles(root, rel, suffix) {
    return fs.readdirSync(path.join(root, rel)).filter((f) => f.endsWith(suffix)).length;
}

function registrySizeOf(src) {
    return (src.match(/primitive:\s*'/g) ?? []).length;
}

function registrySize(root) {
    return registrySizeOf(fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8'));
}

function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The direct children of `rel` at `rev` ending in `suffix`, as `countFiles` counts them. */
function countFilesAt(root, rev, rel, suffix) {
    return git(root, ['ls-tree', '--name-only', '-z', rev, '--', `${rel}/`])
        .split('\0')
        .filter((p) => p.endsWith(suffix)).length;
}

/** The live counts in the tree at `root`. */
function countCoverage(root) {
    return {
        rendered: countFiles(root, 'tests/rendered', '.test.tsx'),
        e2e: countFiles(root, 'tests/e2e', '.spec.ts'),
        registry: registrySize(root),
    };
}

/** The counts in the commit `rev`, read through git, by the same rules as `countCoverage`. */
function countCoverageAt(root, rev) {
    return {
        rendered: countFilesAt(root, rev, 'tests/rendered', '.test.tsx'),
        e2e: countFilesAt(root, rev, 'tests/e2e', '.spec.ts'),
        registry: registrySizeOf(git(root, ['show', `${rev}:${REGISTRY_FILE}`])),
    };
}

/** The floors stored at `root`. */
function readFloors(root) {
    return JSON.parse(fs.readFileSync(path.join(root, FLOORS_FILE), 'utf8'));
}

/** The floors stored in the commit `rev`, or null when that commit has no floors file. */
function readFloorsAt(root, rev) {
    let src;
    try {
        src = git(root, ['show', `${rev}:${FLOORS_FILE}`]);
    } catch {
        return null;
    }
    return JSON.parse(src);
}

/**
 * Each floor raised to its live count, never lowered.
 *
 * A count below its floor is the guard's failure to report, not this
 * function's to absorb: lowering a floor here would let the release spend the
 * very regression the guard exists to catch.
 */
function raisedFloors(floors, counts) {
    const next = { ...floors };
    for (const key of FLOOR_KEYS) {
        if (Number.isInteger(counts[key]) && counts[key] > floors[key]) next[key] = counts[key];
    }
    return next;
}

module.exports = {
    FLOORS_FILE,
    FLOOR_KEYS,
    countCoverage,
    countCoverageAt,
    readFloors,
    readFloorsAt,
    raisedFloors,
};
