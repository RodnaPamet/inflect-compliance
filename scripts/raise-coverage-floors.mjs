#!/usr/bin/env node
/**
 * Raise the verification-population floors to the live counts.
 *
 * Runs as semantic-release's prepare step (`@semantic-release/exec` in
 * `.releaserc.json`), so every release locks in the rendered tests, E2E specs
 * and registered primitives that merged since the last one, and the release
 * commit carries `tests/guards/coverage-floors.json` to main. Pull requests no
 * longer edit the floors, which is what made two of them conflict on one line
 * whenever both added a test.
 *
 * It only ever RAISES a floor, and it never fails the release: a prepare step
 * that exits non-zero stops the whole release, and a floor left where it was
 * costs nothing that the next release will not recover. Any problem is a
 * warning on the release run, and the exit code is 0.
 *
 * Usage: node scripts/raise-coverage-floors.mjs   (from the repository root)
 */
import fs from 'node:fs';
import path from 'node:path';

import floorsLib from './lib/coverage-floors.js';

const { FLOOR_KEYS, FLOORS_FILE, countCoverage, raisedFloors, readFloors } = floorsLib;

const root = process.cwd();

try {
    const floors = readFloors(root);
    const counts = countCoverage(root);
    const next = raisedFloors(floors, counts);
    const moved = FLOOR_KEYS.filter((k) => next[k] !== floors[k]);
    if (moved.length === 0) {
        console.log(`[coverage-floors] unchanged: ${FLOOR_KEYS.map((k) => `${k} ${floors[k]}`).join(', ')}`);
    } else {
        fs.writeFileSync(path.join(root, FLOORS_FILE), `${JSON.stringify(next, null, 2)}\n`);
        console.log(`[coverage-floors] raised: ${moved.map((k) => `${k} ${floors[k]} → ${next[k]}`).join(', ')}`);
    }
} catch (err) {
    console.warn(`[coverage-floors] left unchanged: ${err instanceof Error ? err.message : String(err)}`);
}
