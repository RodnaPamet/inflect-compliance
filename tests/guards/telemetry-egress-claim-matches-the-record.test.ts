/**
 * The telemetry denial's claim matches what was actually built (#4566).
 *
 * This paragraph has already been wrong once, in the direction that matters. An
 * earlier `deploy/openshell/README.md` ended "the network rule is the
 * enforcement" — written to say *do not trust the env var, trust the network* —
 * while no network rule existed. It gave exactly the false reassurance it was
 * written to prevent, and an audit had to find it.
 *
 * ═══ WHY THIS PARSES VALUES INSTEAD OF SEARCHING PROSE ═══
 *
 * The obvious shape is `expect(readme).toContain('inflect-egress-telemetry-deny')`,
 * and this repository closes that from both sides: an unmasked whole-file read
 * lands in Class A of `raw-source-assertion-ratchet`, and masking it to escape
 * lands in Class D of `assertion-needle-uniqueness` as `content-transformed`. A
 * first draft of this file did exactly that and pushed both ceilings.
 *
 * It is also the weaker assertion. A name appearing anywhere in a paragraph
 * satisfies `toContain` — including in a sentence saying it used to be
 * something else, which is the precise failure here. So each document is
 * PARSED at the one place the fact lives, and the parsed values are compared.
 *
 * ═══ WHAT IT CANNOT CHECK ═══
 *
 * GCP. CI has no credentials and should not: a guard needing a cloud round trip
 * fails on an outage and passes on a cached answer. The failure this prevents
 * is not "somebody deleted the policy" — nothing in CI can see that — it is
 * "somebody changed one document and left the other saying something else",
 * which is how the original false claim survived.
 *
 * @module guards/telemetry-egress-claim-matches-the-record
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const README = 'deploy/openshell/README.md';
const RECORD = 'infra/network/egress-telemetry-deny.md';

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** As created, 2026-10-31. Both documents are held to these. */
const POLICY = 'inflect-egress-telemetry-deny';
const ASSOCIATION = 'inflect-egress-telemetry-deny-default';

/** The policy name out of the README's fenced summary — `policy  <name>`. */
const readmePolicy = (): string | undefined =>
    /^policy\s+(\S+)/m.exec(read(README))?.[1];

/** The policy name out of the record's table — `| name | `<name>` |`. */
const recordPolicy = (): string | undefined =>
    /\|\s*name\s*\|\s*`([^`]+)`\s*\|/.exec(read(RECORD))?.[1];

/** The association name out of the record's removal commands. */
const recordAssociation = (): string | undefined =>
    /--name=(\S+)/.exec(read(RECORD))?.[1];

/** The hosts the README's fenced summary says are denied. */
const readmeDestFqdns = (): string | undefined =>
    /dest-fqdns:\s*(\S+)/.exec(read(README))?.[1];

/**
 * Commands the record's verification block runs, in order.
 *
 * Backslash continuations are FOLDED first. A per-line match missed the host
 * on the second line of a wrapped `curl`, so the denial command read as a
 * command with no host in it — the assertion below then failed for a parsing
 * reason while the document was correct.
 */
const recordVerifyCommands = (): string[] => {
    const folded = read(RECORD).replace(/\\\n\s*/g, ' ');
    return [...folded.matchAll(/^(?:curl|grep|gcloud)\b[^\n]*/gm)].map((m) => m[0]);
};

describe('the telemetry egress claim matches the recorded resource', () => {
    it('both documents parse — the denominator', () => {
        // Every assertion below is satisfied by a file this parser cannot read,
        // so the parse itself is asserted before anything is compared.
        expect(readmePolicy()).toBeDefined();
        expect(recordPolicy()).toBeDefined();
        expect(recordAssociation()).toBeDefined();
        expect(readmeDestFqdns()).toBeDefined();
        expect(recordVerifyCommands().length).toBeGreaterThanOrEqual(4);
    });

    it('the two documents name the SAME policy, and it is the one created', () => {
        expect(readmePolicy()).toBe(POLICY);
        expect(recordPolicy()).toBe(POLICY);
        expect(readmePolicy()).toBe(recordPolicy());
    });

    it('the association the record tells you to delete is the one that exists', () => {
        // Somebody lifting the denial in an incident reads this name. A wrong
        // one sends them to a resource that is not there, while the denial
        // stays up.
        expect(recordAssociation()).toBe(ASSOCIATION);
        expect(recordAssociation()).toContain(POLICY);
    });

    it('the host denied is the telemetry sink the sinkhole also names', () => {
        // The /etc/hosts line and the firewall rule must be about the same
        // host, or the README describes two controls over different things.
        const fqdn = readmeDestFqdns() as string;
        const sinkhole = /^0\.0\.0\.0\s+(\S+)/m.exec(read(README))?.[1];
        expect(fqdn).toBe(sinkhole);
    });

    it('the verification block carries a positive control, not just the denial', () => {
        /*
            A probe that only shows the telemetry host failing cannot tell a
            working rule from broken egress. The block must therefore run
            something that is EXPECTED to succeed, and the two must be
            distinguishable — asserted as a property of the command list rather
            than by looking for the words.
        */
        const cmds = recordVerifyCommands();
        const curls = cmds.filter((c) => c.startsWith('curl'));
        expect(curls.length).toBeGreaterThanOrEqual(2);
        /*
            Classified by the URL's HOST, not by a substring of the command.

            `c.includes('telemetry.data.nvidia.com')` was the first version and
            CodeQL rejected it as INCOMPLETE URL SUBSTRING SANITIZATION, with
            two high-severity alerts. It was right, even though these strings
            are shell commands out of a markdown file rather than URLs being
            authorised: the host can sit anywhere in a URL, so
            `https://evil.example/?x=telemetry.data.nvidia.com` would have been
            classified as the denial probe and a record carrying only that would
            have passed. Parsing the host cannot be fooled that way, which makes
            this the stronger assertion as well as the clean one.
        */
        const hostOf = (cmd: string): string | null => {
            const url = /https?:\/\/[^\s'"]+/.exec(cmd)?.[0];
            if (url === undefined) return null;
            try {
                return new URL(url).hostname;
            } catch {
                return null;
            }
        };
        /*
            The denied host is READ FROM THE README's own rule rather than
            restated here. An earlier draft had a `SINK_HOST` constant beside
            the policy name, which is a second pin that can disagree with the
            document it is checking — and it was silently undefined after a
            rewrite, which jest reported and tsc would have.
        */
        const sink = readmeDestFqdns();
        expect(sink).toBeDefined();
        const denied = curls.filter((c) => hostOf(c) === sink);
        const control = curls.filter((c) => {
            const host = hostOf(c);
            return host !== null && host !== sink;
        });
        expect(denied.length).toBeGreaterThanOrEqual(1);
        expect(control.length).toBeGreaterThanOrEqual(1);
    });

    it('the verification block reads the firewall log, which is the attributable half', () => {
        // A timeout shows a connection failing. Only the log says WHICH rule
        // denied it, which is the difference between evidence and inference.
        const cmds = recordVerifyCommands();
        const logReads = cmds.filter((c) => c.startsWith('gcloud logging read'));
        expect(logReads.length).toBeGreaterThanOrEqual(1);
        expect(logReads.join(' ')).toContain('firewall');
    });
});
