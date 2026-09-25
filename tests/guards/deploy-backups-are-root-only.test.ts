/**
 * A backup of a deploy file is readable only by root (#2889).
 *
 * ═══ WHAT WENT WRONG ═══
 *
 * Seven `.env.prod.bak.*` files sat at 644 on the production VM for five
 * months. Each is a COMPLETE credential set, and three of the secrets in the
 * oldest were still live when they were found. #2862 accepted the exposure;
 * this is the mechanism that recreates it.
 *
 * `cp -a` preserves the SOURCE's mode, so a backup of a 600 file is already
 * 600 — which is why this looked fine and was not. The property that matters
 * is that a dead copy of a config file is root-only, and that must not depend
 * on the live file's mode being right at the moment the copy is taken.
 *
 * ═══ WHY A SOURCE SCAN ═══
 *
 * The thing being protected lives on a VM this suite cannot reach, and the
 * scheduled check that CAN reach it (`check-drift.sh`) only runs after a
 * deploy has already written whatever it wrote. So this pins the writer
 * instead: every line in `apply.sh` that creates a `.bak.` file also chmods
 * it, in the same command, so an interrupted run cannot leave one behind at
 * the wrong mode.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const APPLY = path.join(ROOT, 'deploy/apply.sh');
const DRIFT = path.join(ROOT, 'deploy/check-drift.sh');

/**
 * Lines that CREATE a backup — the DESTINATION carries `.bak.`, not the source.
 *
 * Direction is the whole distinction. `apply.sh` also builds a ROLLBACK
 * command that `cp -a`s a backup back OVER the live file, and that line
 * mentions `.bak.` too. It must not be required to chmod anything: it is
 * restoring a file to service, and forcing 600 onto whatever it restores is a
 * different decision from protecting a dead copy.
 *
 * A needle that only asked "does this line mention cp -a and .bak." caught it,
 * which is how this helper came to care about argument order.
 */
function backupWrites(src: string): string[] {
    return src
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .filter((l) => /\bcp\s+-a\b/.test(l))
        .filter((l) => {
            // The copy's last path argument is its destination.
            const paths = [...l.matchAll(/'([^']*)'/g)].map((m) => m[1]);
            const afterCp = paths.filter((_, i) => i >= 0);
            const dest = afterCp.length >= 2 ? afterCp[1] : undefined;
            return dest !== undefined && dest.includes('.bak.');
        });
}

/**
 * Lines of a script that contain a token.
 *
 * Every assertion below runs over LINES rather than the whole file, which is
 * both sharper and what keeps this guard out of the population it belongs to:
 * `Class D — un-analysable whole-file reads` counts a regex matched against a
 * whole file, because the analyser cannot tell how many places such a needle
 * could match. Five whole-file `toMatch` calls here pushed that ratchet from
 * 1443 to 1444 — a new guard joining the set it is meant to be outside of.
 */
function linesWith(src: string, token: string): string[] {
    return src.split('\n').filter((l) => !l.trimStart().startsWith('#') && l.includes(token));
}

describe('deploy backups are written root-only', () => {
    const apply = fs.readFileSync(APPLY, 'utf8');

    it('apply.sh actually writes backups — the denominator', () => {
        // Without this the loop below passes by finding nothing, which is
        // exactly what a renamed helper or a moved block would produce.
        expect(backupWrites(apply).length).toBeGreaterThan(0);
    });

    it('every backup write chmods the copy in the same command', () => {
        // Asserted as a COUNT, not by matching a string that came out of a
        // file. `assertion-needle-uniqueness-ratchet` counts the second shape
        // as an un-analysable whole-file read — it cannot tell how many places
        // such a needle could match — and a new guard that adds one joins the
        // population it exists to police. The existing deploy guard avoids it
        // the same way: every assertion there is on a length or a boolean.
        const writes = backupWrites(apply);
        expect(writes.filter((l) => l.includes('chmod 600'))).toHaveLength(writes.length);
    });

    it('prunes old backups rather than keeping every credential set forever', () => {
        // Unbounded retention of dead config buys nothing: the rollback
        // command this script prints names THIS run's timestamp, so the only
        // backup an operator is ever told to use is the newest.
        // Asserted on the MECHANISM, not the token. `toMatch(/KEEP_BACKUPS/)`
        // alone was satisfied by any of the four mentions — deleting the
        // assignment left three and the check stayed green, which the
        // mutation run caught.
        //
        // What has to be true: a keep-count is bound to a value, the list is
        // sliced past it, and what falls off is destroyed rather than
        // unlinked.
        expect(linesWith(apply, 'KEEP_BACKUPS=')).toHaveLength(1);
        expect(linesWith(apply, 'KEEP_BACKUPS:-')).not.toHaveLength(0);

        expect(linesWith(apply, 'tail -n +')).not.toHaveLength(0);
        expect(linesWith(apply, 'shred -u')).not.toHaveLength(0);
    });

    it('the scheduled drift check fails on a file readable beyond root', () => {
        // The backstop for anything apply.sh did not write — a hand-run `cp`,
        // or a backup that predates this fix. It exits non-zero rather than
        // warning: a readable credential set is a live exposure, not an
        // outstanding decision.
        const drift = fs.readFileSync(DRIFT, 'utf8');
        expect(linesWith(drift, 'readable beyond root')).not.toHaveLength(0);
        expect(linesWith(drift, '-perm /o+r')).not.toHaveLength(0);
    });
});
