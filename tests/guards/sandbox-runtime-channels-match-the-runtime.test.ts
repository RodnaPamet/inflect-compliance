/**
 * THE CHANNEL LIST IS EXHAUSTIVE, OR IT IS WORSE THAN NO LIST (#4001).
 *
 * `REPORTING_CHANNELS` is what the admin page renders as "the ways this runtime
 * can send data". A reader draws a conclusion from it that a list which quietly
 * stopped being complete does not support — and that is the specific failure
 * which would make the page harmful rather than merely stale, because an
 * incomplete enumeration of egress paths reads exactly like a complete one.
 *
 * So this guard holds the list against the gateway's own vocabulary, and it
 * fails in BOTH directions:
 *
 *   • a channel naming an environment variable the runtime does not define —
 *     the page would describe a control that does not exist;
 *   • a reporting variable the runtime defines that no channel claims — the
 *     page would omit an egress path, which is the dangerous direction.
 *
 * ── WHY THE VOCABULARY IS COMMITTED AND NOT PROBED ──────────────────────
 *
 * The honest source would be the gateway binary, and this guard deliberately
 * does not read it. A guard that shelled out to `strings` against a binary
 * under `~/openshell` would pass or fail on whether a developer happened to
 * have a release unpacked, which is not a property of this repository. It would
 * also be unrunnable in CI and on any machine but one.
 *
 * So the vocabulary below is COMMITTED, with the release it was read from, and
 * this guard holds the product's list against it. Re-pinning the release means
 * re-reading the vocabulary, which is the same discipline as the vendored
 * skills' manifest.
 */
import { type ReportingChannelKey, REPORTING_CHANNELS } from '@/app-layer/usecases/sandbox-runtime-config';
import { collectorSandboxPolicy } from '@/lib/agentic/openshell/collector-policy';
import { PINNED_GATEWAY_RELEASE } from '@/lib/agentic/openshell/pinned-release';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every reporting-related `OPENSHELL_*` variable the v0.1.6 gateway defines.
 *
 * Re-read from `openshell-gateway` 0.1.6 (commit ac7f615c) by extracting
 * `OPENSHELL_[A-Z0-9_]+` and splitting on the prefix, because the binary's
 * string table runs adjacent names together — an unsplit scan reports
 * concatenations as if they were variables.
 *
 * SEVEN, not eight, and unchanged from 0.1.5 — the 0.1.6 re-read found the
 * same seven and the same artifact. A naive scan also yields
 * `OPENSHELL_TELEMETRY_ENABLEDI`, which is `OPENSHELL_TELEMETRY_ENABLED`
 * followed by the first character of the next string. It is recorded here
 * because the artifact is reproducible, and a future re-read that counts eight
 * has not found a new variable.
 */
const RUNTIME_REPORTING_VARS = [
    'OPENSHELL_OCSF_JSON',
    'OPENSHELL_OCSF_LOG_DIR',
    'OPENSHELL_OTLP_ENDPOINT',
    'OPENSHELL_OTLP_OCSF_ENDPOINT',
    'OPENSHELL_OTLP_OCSF_SCHEMA_VERSION',
    'OPENSHELL_TELEMETRY_ENABLED',
    'OPENSHELL_TELEMETRY_ENDPOINT',
] as const;

/** The artifact a naive scan produces, kept so a re-read can recognise it. */
const KNOWN_SCAN_ARTIFACTS = ['OPENSHELL_TELEMETRY_ENABLEDI'] as const;

describe('the reporting channels match the runtime that has them', () => {
    const claimed = REPORTING_CHANNELS.flatMap((c) => c.envVars);

    it('reads a list with channels in it', () => {
        // The denominator. Both set comparisons below are satisfied by an empty
        // list against an empty vocabulary.
        expect(REPORTING_CHANNELS.length).toBeGreaterThanOrEqual(4);
        expect(RUNTIME_REPORTING_VARS.length).toBe(7);
    });

    it('claims no variable the runtime does not define', () => {
        const unknown = claimed.filter((v) => !(RUNTIME_REPORTING_VARS as readonly string[]).includes(v));
        expect(unknown).toEqual([]);
    });

    it('leaves no reporting variable unclaimed — the dangerous direction', () => {
        const unclaimed = RUNTIME_REPORTING_VARS.filter((v) => !claimed.includes(v));
        expect(unclaimed).toEqual([]);
    });

    it('claims each variable exactly once', () => {
        // A variable governing two channels would make one row's state
        // unexplainable from its own name.
        expect(new Set(claimed).size).toBe(claimed.length);
    });

    it('does not mistake the known scan artifact for a variable', () => {
        for (const artifact of KNOWN_SCAN_ARTIFACTS) {
            expect(claimed).not.toContain(artifact);
            expect(RUNTIME_REPORTING_VARS as readonly string[]).not.toContain(artifact);
            // And it IS a prefix of a real one, which is why it fooled a scan.
            expect(RUNTIME_REPORTING_VARS.some((v) => artifact.startsWith(v))).toBe(true);
        }
    });

    it('the FIXTURE can express a fifth channel, so the guard can fail', () => {
        /*
            #4001 asks for `a-control-that-cannot-express-failure` to be applied
            to this guard itself: "a guard whose fixture cannot produce the
            failing input is green forever… the fixture must be able to express
            a fifth channel."

            The assertions above compare VARIABLE sets, and the control below
            proves a made-up variable is caught. This proves the channel-shaped
            version: a fifth channel, with a variable the runtime does not
            define, is rejected — and a fifth channel whose variable the runtime
            DOES define but which no channel claimed would be caught by the
            unclaimed direction.

            Constructed here rather than mutated into the real export, because
            the real export is what the page renders: a test that edited it
            would be asserting against a list no deploy has.
        */
        const fifth = {
            key: 'future-channel' as ReportingChannelKey,
            chartKey: null,
            envVars: ['OPENSHELL_FUTURE_SINK'],
            defaultsOn: false,
        };
        const withFifth = [...REPORTING_CHANNELS, fifth];
        expect(withFifth.length).toBe(REPORTING_CHANNELS.length + 1);

        // The claims-nothing-unknown direction catches it.
        const claimedWithFifth = withFifth.flatMap((c) => c.envVars);
        const unknown = claimedWithFifth.filter(
            (v) => !(RUNTIME_REPORTING_VARS as readonly string[]).includes(v),
        );
        expect(unknown).toEqual(['OPENSHELL_FUTURE_SINK']);

        // And the dangerous direction catches the opposite: a runtime variable
        // no channel claims. Simulated by dropping a channel rather than adding
        // one, which is the same arithmetic from the other side.
        const withoutFirst = REPORTING_CHANNELS.slice(1).flatMap((c) => c.envVars);
        const unclaimed = RUNTIME_REPORTING_VARS.filter((v) => !withoutFirst.includes(v));
        expect(unclaimed).toEqual([...REPORTING_CHANNELS[0].envVars]);
    });

    it('the comparison can fail in both directions', () => {
        // The positive control. Each half is a set difference, and a set
        // difference against the wrong set is green for the wrong reason.
        expect(['OPENSHELL_MADE_UP'].filter((v) => !(RUNTIME_REPORTING_VARS as readonly string[]).includes(v))).toEqual([
            'OPENSHELL_MADE_UP',
        ]);
        expect(RUNTIME_REPORTING_VARS.filter((v) => !['OPENSHELL_OCSF_JSON'].includes(v)).length).toBe(6);
    });
});

/**
 * 5.3 (#3973) — AN UPGRADE MUST FAIL A TEST, NOT AN AUDIT.
 *
 * The block above ends by saying "re-pinning the release means re-reading the
 * vocabulary, which is the same discipline as the vendored skills' manifest".
 * That sentence was true as an intention and enforced by nothing. The release
 * appeared in this repository 34 times across 13 files, every one of them as
 * PROSE — and prose does not fail. Somebody could bump the gateway and leave
 * every recorded measurement describing a version no longer in use, with a
 * green build.
 *
 * ═══ WHY THE ENFORCEMENT DEFAULT IS THE FACT THAT MATTERS ═══
 *
 * #3927 calls it "the most consequential fact in the roadmap", and the
 * measurement confirmed the third-party report: an endpoint with `enforcement`
 * unset runs in AUDIT mode. `NETWORK_ENFORCEMENT_MODE_UNSPECIFIED` is zero on
 * the wire and documented as "log violations and allow traffic", so an endpoint
 * that omits the field, one whose field a proxy dropped, and one explicitly set
 * to audit are the same bytes — and all three allow the traffic they appear to
 * forbid.
 *
 * Every verdict the scanner and the skill derive from a policy rests on that.
 * A release that changed it — making the zero value deny, or renaming the enum
 * so our explicit value stops matching — would silently invert what a policy
 * means, and the issue is explicit about where that discovery should happen:
 * in CI, not in a client's estate.
 *
 * ═══ THE MECHANISM, AND WHY IT IS A VERSION CHECK ═══
 *
 * A test cannot read the default out of a release: the honest source is the
 * gateway binary, and the block above already records why this file refuses to
 * shell out to one — it would pass or fail on whether a developer happened to
 * have a release unpacked, which is not a property of this repository.
 *
 * So each fact carries the release it was VERIFIED AGAINST, and the pin is a
 * constant rather than a sentence. Move the pin and every fact's provenance is
 * stale, which fails here by name. The upgrade is then blocked until somebody
 * re-measures and re-records — which is precisely the "re-verify the phase 0.1
 * facts" bullet, enforced instead of requested.
 */
/*
    IMPORTED, not declared — #4567.

    This was its own literal, and `src/` recorded the same release in eight
    docblocks and nowhere a machine could read. So nothing in the product could
    answer "is the gateway running the release we verified against": there was
    no expected value to compare a reported one with.

    The constant now lives in `src/lib/agentic/openshell/pinned-release.ts` and
    this file reads it. Two pins that can disagree are worse than one — each
    looks authoritative alone and the disagreement is visible only to somebody
    comparing them, which is the same reasoning the vendored-skills assertion
    below already applies to VENDORED.md.
*/
const PINNED_RELEASE: string = PINNED_GATEWAY_RELEASE;

/** `0.1.5` -> [0,1,5], so releases compare as numbers and not as strings. */
const semver = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => Number(n));
const newerThan = (a: string, b: string): boolean => {
    const [x, y] = [semver(a), semver(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
};

/**
 * The phase 0.1 facts that were ESTABLISHED, each against a release.
 *
 * Only the closed ones. Listing an open question here with a `verifiedAgainst`
 * would be the exact failure this guard exists to prevent — a record that reads
 * as measured when it is not.
 */
/**
 * A release newer than the pin that we KNOW about and have deliberately not
 * adopted, with the reason.
 *
 * ═══ WHY THIS EXISTS, AND WHY IT IS NOT A HOLE IN THE SCAN BELOW ═══
 *
 * The scan asks that nothing claim a release newer than the pin, to catch the
 * half-done upgrade — a version bumped in one place while every recorded
 * measurement stayed behind. Without this register it also forbids something
 * valuable: WRITING DOWN that an upgrade exists while the decision to take it
 * is still open.
 *
 * That is backwards. 0.1f (#3931) found v0.1.6 the day after it shipped, and
 * under the original scan the only way to record the finding was to perform the
 * upgrade — so the cheapest path was to say nothing, which is the state this
 * whole guard exists to prevent. A discovery should be recordable before it is
 * actioned, and an entry here is the record.
 *
 * It is NOT an exemption. An entry must name the version, the date it was seen
 * and why it is not adopted; the scan still refuses any newer version that is
 * NOT registered; and the entry does not relax the fact provenance above, so
 * moving `PINNED_RELEASE` still reddens every fact until it is re-measured.
 */
const KNOWN_NEWER_RELEASES: ReadonlyArray<{
    readonly version: string;
    readonly seen: string;
    readonly reason: string;
}> = [
    // EMPTY: the pin caught up. The 0.1.6 entry recorded here while the
    // decision was pending was deleted in the diff that moved the pin, which is
    // what the register's own shape test requires — an entry the pin has
    // reached is not a pending upgrade, it is a stale line that reads like one.
] as const;

const VERIFIED_FACTS = [
    {
        id: '0.1a',
        issue: 3926,
        verifiedAgainst: '0.1.6',
        fact: 'policy schema version 2; filesystem_policy/landlock/process are static, network_policies is dynamic. 0.1.6 additionally REFUSES TO START without OIDC, mTLS user/operator auth or gateway JWTs configured',
    },
    {
        id: '0.1b',
        issue: 3927,
        verifiedAgainst: '0.1.6',
        fact: 'enforcement unset runs in AUDIT mode — UNSPECIFIED is zero on the wire and logs-and-allows',
    },
    {
        id: '0.1d',
        issue: 3929,
        verifiedAgainst: '0.1.6',
        fact: 'the dropped-tool MCP rule defect is NOT established as fixed: upstream #4679 is open, and the release exposes no proposal flow and no policy-body read to observe it',
    },
    {
        id: '0.1e',
        issue: 3930,
        verifiedAgainst: '0.1.6',
        fact: 'telemetry is ON by default and event-driven; OPENSHELL_TELEMETRY_ENABLED=false turns it off completely (3013 bytes vs 0, reproduced, same activity)',
    },
    {
        id: '0.1g',
        issue: 3932,
        verifiedAgainst: '0.1.6',
        fact: 'the OCSF log records no sandbox lifecycle decision — created, policy changed, network denied and deleted all produce zero records; deletion is recoverable from neither the log nor the API afterwards. 0.1.6 WIDENED the auth-adjacent coverage (denials, accepted credentials, SSH session tokens, sandbox token checks) and now logs successful logons, but none of the five decision kinds',
    },
    {
        id: '0.1f',
        issue: 3931,
        verifiedAgainst: '0.1.6',
        fact: 'there is no NVIDIA-published JS SDK; the official SDK is Python (requires_python >=3.11), so no flue-style isolation applies',
    },
    {
        id: '0.1c',
        issue: 3928,
        verifiedAgainst: '0.1.6',
        fact: 'landlock best_effort is the default; hard_requirement refuses to start rather than skipping paths',
    },
] as const;

/**
 * Still open, and deliberately carrying no release.
 *
 * 0.1e is worth a word: 4.3 (#3964) measured that the telemetry setting's
 * effect is NOT observable — the variable is absent from `--help`, an invalid
 * value is accepted silently, and three traced runs were indistinguishable. So
 * "can telemetry be turned off completely" is not merely unanswered, there is
 * evidence that answering it from outside the process may not be possible.
 */
const OPEN_QUESTIONS: ReadonlyArray<{
    readonly id: string;
    readonly issue: number;
    readonly question: string;
}> = [
    // EMPTY, and that is the point: every phase 0.1 question is answered, each
    // against the pinned release. The list stays rather than being deleted
    // because the exhaustiveness check below reads both halves, and because an
    // upgrade can reopen a question — moving an entry back here is how that is
    // recorded.
] as const;


/**
 * Lines in a gateway TOML that ACTIVELY disable inbound authentication.
 *
 * Returns the offending lines rather than a boolean, so a failure names what it
 * found instead of asserting `false === true`.
 */
const activeUnauthenticatedSwitches = (text: string): readonly string[] => {
    const out: string[] = [];
    for (const raw of text.split('\n')) {
        // A TOML comment runs to end of line. `#` is not legal in a bare key
        // and `true`/`false` carry no quotes, so cutting at the first `#` is
        // exact for the shape being hunted — see the detector proof.
        const line = raw.split('#')[0];
        const m = /^\s*allow_unauthenticated_users\s*=\s*(\S+)/.exec(line);
        if (!m) continue;
        if (m[1] === 'false') continue;
        out.push(raw.trim());
    }
    return out;
};

describe('an upgrade fails a test rather than an audit (#3973)', () => {
    it('every established fact was verified against the release that is pinned', () => {
        // THE FORCING FUNCTION. Bump `PINNED_RELEASE` and this fails, naming
        // each fact whose provenance went stale, until somebody re-measures.
        expect(VERIFIED_FACTS.length).toBeGreaterThanOrEqual(3);
        const stale = VERIFIED_FACTS.filter((f) => f.verifiedAgainst !== PINNED_RELEASE).map(
            (f) => `${f.id} (#${f.issue}) verified against ${f.verifiedAgainst}`,
        );
        expect(stale).toEqual([]);
    });

    it('no open question is recorded as an established fact', () => {
        // The two lists must stay disjoint, or an unanswered question acquires
        // a provenance it never had. 0.1d and 0.1e are the ones at risk: both
        // have partial evidence, which is the state most easily mistaken for an
        // answer.
        // `Set<string>`, not the inferred literal union. `as const` on both
        // lists makes the ids literal types, and tsc then REJECTED
        // `verified.has(q.id)` outright — proof that the two lists are disjoint
        // today, which is a nice guarantee and not the one this test wants: it
        // evaporates the moment somebody adds the overlap, which is exactly the
        // mistake worth catching. So the comparison is widened deliberately.
        const verified = new Set<string>(VERIFIED_FACTS.map((f) => f.id));
        expect(OPEN_QUESTIONS.filter((q) => verified.has(q.id))).toEqual([]);

        // THE DENOMINATOR IS THE WHOLE OF 0.1, not a floor on either list.
        //
        // This read `OPEN_QUESTIONS.length >= 4` until 0.1f was answered, and
        // answering it turned the assertion red — a floor on the open list
        // makes progress a failure, which is precisely backwards. The property
        // worth holding is that every 0.1 sub-item is classified in EXACTLY one
        // list, so the two together are exhaustive and neither can quietly lose
        // an item.
        const ALL_0_1 = ['0.1a', '0.1b', '0.1c', '0.1d', '0.1e', '0.1f', '0.1g'];
        const classified = [...verified, ...OPEN_QUESTIONS.map((q) => q.id)].sort();
        expect(classified).toEqual([...ALL_0_1].sort());
    });

    it('nothing in the repository claims a release NEWER than the pin', () => {
        // The half-done upgrade: a version bumped in one place while the pin,
        // and therefore every recorded measurement, stayed behind.
        //
        // NEWER, not different, and that asymmetry is the point. Older mentions
        // are legitimate history — the spike notes name v0.1.2, v0.1.3 and
        // v0.1.4 as the releases inherited defects were found on, and forcing
        // those to the pin would destroy the provenance. Requiring equality
        // would also need an allowlist that grows on every upgrade, which is a
        // second thing to forget.
        //
        // The pattern has no leading `\b`: `v0.1.2` has a word character
        // before the digit, so `\b0\.1\.` never matches it, and a first draft
        // of this scan reported the spike notes as clean.
        const RELEASE = /v?0\.1\.\d+/g;
        const offenders: string[] = [];
        for (const rel of repoRelativeFiles()) {
            if (!/\.(ts|tsx|md|toml|ya?ml|json|service|sh)$/.test(rel)) continue;
            const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            if (!/openshell/i.test(text)) continue;
            for (const m of text.match(RELEASE) ?? []) {
                if (!newerThan(m, PINNED_RELEASE)) continue;
                // Registered above with a date and a reason, or it is an
                // offender. Normalised past the optional `v`, so `v0.1.6` and
                // `0.1.6` are the same release.
                const bare = m.replace(/^v/, '');
                if (KNOWN_NEWER_RELEASES.some((k) => k.version === bare)) continue;
                offenders.push(`${rel}: ${m}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('every registered newer release is really newer, dated, and reasoned', () => {
        // A register whose entries are not newer than the pin is dead weight —
        // and worse, it reads as a list of pending upgrades when it is a list
        // of nothing. An entry that the pin has caught up with must be deleted
        // in the diff that moves the pin.
        for (const k of KNOWN_NEWER_RELEASES) {
            expect(newerThan(k.version, PINNED_RELEASE)).toBe(true);
            expect(k.seen).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            // A reason long enough to be a reason. The shape this guards is an
            // entry added to silence the scan with "TODO" in the field.
            expect(k.reason.length).toBeGreaterThan(40);
        }
    });

    it('the scan reaches the files that name the release, and can see a newer one', () => {
        // A denominator and a control in one. The assertion above is satisfied
        // by a scan that reads nothing, and by a comparison that calls nothing
        // newer.
        let claiming = 0;
        for (const rel of repoRelativeFiles()) {
            if (!/\.(ts|tsx|md|toml|ya?ml|json|service|sh)$/.test(rel)) continue;
            const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            if (/openshell/i.test(text) && text.includes(PINNED_RELEASE)) claiming++;
        }
        expect(claiming).toBeGreaterThanOrEqual(8);

        // DERIVED FROM THE PIN, never written as literals, for three reasons
        // and all three were found by this file failing its own scan.
        //
        // A literal next-patch version here IS a mention of a release newer
        // than the pin, so the scan above reported this file as an offender:
        // a test's control inputs read as production claims. Writing the same
        // versions into THIS COMMENT to explain that reported it again, which
        // is why the explanation now names no version at all.
        //
        // And a hardcoded control stops testing anything once the pin passes
        // it — a fixed "newer" version is not newer than its successor — so the
        // assertion would need editing by whoever upgrades, the person least
        // likely to notice it had gone quiet.
        const shift = (index: number, by: number): string => {
            const parts = semver(PINNED_RELEASE);
            parts[index] += by;
            return parts.join('.');
        };
        expect(newerThan(shift(2, 1), PINNED_RELEASE)).toBe(true); // next patch
        expect(newerThan(shift(1, 1), PINNED_RELEASE)).toBe(true); // next minor
        expect(newerThan(shift(2, -1), PINNED_RELEASE)).toBe(false); // previous patch
        expect(newerThan(PINNED_RELEASE, PINNED_RELEASE)).toBe(false);
        // Numeric, not lexicographic: shifting the patch into double digits
        // produces a version that is GREATER numerically and SMALLER as a
        // string, which is the comparison a naive `>` on strings gets wrong.
        expect(newerThan(shift(2, 5), PINNED_RELEASE)).toBe(true);
    });

    it('the vendored skills are pinned to the same release', () => {
        // #3973's third bullet: "re-pin the vendored developer skills (4.6) to
        // the same release, update VENDORED.md and the NOTICE commit".
        //
        // Before this, the release was pinned in TWO independent places — here
        // and as literals in `vendored-openshell-skills`/`VENDORED.md` — with
        // nothing holding them equal. Two pins that can disagree are worse than
        // one, because each looks authoritative on its own and the disagreement
        // is only visible to somebody comparing them.
        //
        // Asserted over the extracted row rather than the manifest's text: a
        // whole-file match would also be satisfied by the prose further down,
        // which explains what the pin is for and names it in passing.
        const md = fs.readFileSync(path.join(REPO_ROOT, '.claude/skills/VENDORED.md'), 'utf8');
        const tagRows = md.split('\n').filter((l) => /^\|\s*Tag\s*\|/.test(l));
        // Exactly one row, or the extraction is reading something else.
        expect(tagRows.length).toBe(1);
        expect(tagRows.filter((l) => !l.includes(PINNED_RELEASE))).toEqual([]);
    });

    it('the unit cannot protect /root without moving HOME — 0.1.6 writes state there', () => {
        /*
            THE BUG THIS PREVENTS HAPPENED, on the first real provisioning.

            The unit sets `ProtectHome=yes`, which is correct. The 0.1.6 gateway
            writes its state to `$HOME/.local/state/openshell/gateway`, so with
            root's own HOME it died on startup:

                Error:   × failed to create /root/.local/state/openshell/gateway
                  ╰─▶ Read-only file system (os error 30)

            Three attempts in five minutes, then StartLimitBurst stopped it —
            the unit behaved exactly as its own comment promises, which is how
            the failure was legible rather than an endless loop.

            `XDG_STATE_HOME` is the lever you would reach for and it DOES NOT
            WORK: the string does not occur in the 0.1.6 binary at all, so the
            path comes from HOME and only HOME moves it. The fix is therefore a
            PAIR — a systemd-owned StateDirectory, and HOME pointing into it —
            and either line alone leaves a gateway that cannot start.

            So the rule is conditional on ProtectHome rather than absolute: a
            future unit that drops ProtectHome does not need the redirect, and a
            guard that demanded it anyway would be asserting a preference.
        */
        const unit = fs.readFileSync(
            path.join(REPO_ROOT, 'deploy/openshell/openshell-gateway.service'),
            'utf8',
        );
        // Directives only. Every explanation above lives in this file as a
        // comment, including the literal text of the directives, so a scan that
        // did not drop comment lines would pass on the prose.
        const directives = unit
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('#'));

        // DENOMINATOR: a renamed unit read as '' satisfies everything below.
        expect(directives.length).toBeGreaterThan(15);

        const protectsHome = directives.filter((l) => /^ProtectHome\s*=\s*(yes|read-only|tmpfs)$/i.test(l));
        const stateDirs = directives
            .map((l) => /^StateDirectory\s*=\s*(\S+)$/.exec(l))
            .filter((m): m is RegExpExecArray => m !== null)
            .map((m) => m[1]);
        const homes = directives
            .map((l) => /^Environment\s*=\s*HOME=(\S+)$/.exec(l))
            .filter((m): m is RegExpExecArray => m !== null)
            .map((m) => m[1]);

        // Not vacuous: the unit DOES protect /root today, so the branch below
        // is the one that runs. If this ever goes to zero the rule stops
        // applying and this line says so instead of leaving a silent pass.
        expect(protectsHome.length).toBeGreaterThanOrEqual(1);

        if (protectsHome.length > 0) {
            expect(stateDirs.length).toBeGreaterThanOrEqual(1);
            expect(homes.length).toBeGreaterThanOrEqual(1);
            // And HOME must land INSIDE what systemd owns. `HOME=/opt/anything`
            // would satisfy the two counts above and still be a directory
            // nothing creates, which is the same failure with a new path.
            expect(homes.filter((h) => !stateDirs.some((d) => h === `/var/lib/${d}`))).toEqual([]);
        }
    });

    it('the cost control ships with the deployment, not beside it', () => {
        /*
            The VM runs under a hard 5 USD/month cap, and the arithmetic that
            satisfies it is a RUNTIME BUDGET of about 38 hours a month: the only
            always-on charge is the boot disk, and a VM left running for a month
            would cost roughly 17x the cap. The idle-shutdown timer is what makes
            that budget hold, so it is a deployment artefact rather than an
            operator habit — and it is only a control if provisioning cannot
            quietly skip it.
        */
        const dir = path.join(REPO_ROOT, 'deploy/openshell');
        for (const f of [
            'openshell-idle-shutdown',
            'openshell-idle-shutdown.service',
            'openshell-idle-shutdown.timer',
        ]) {
            expect(fs.existsSync(path.join(dir, f))).toBe(true);
        }

        // The window the README claims must be the window the script enforces.
        // Two numbers in two files drift, and the drift looks like nothing.
        const script = fs.readFileSync(path.join(dir, 'openshell-idle-shutdown'), 'utf8');
        const timer = fs.readFileSync(path.join(dir, 'openshell-idle-shutdown.timer'), 'utf8');
        const strikes = /STRIKES_NEEDED=(\d+)/.exec(script);
        const interval = /OnUnitActiveSec=(\d+)min/.exec(timer);
        expect(strikes).not.toBeNull();
        expect(interval).not.toBeNull();
        const windowMinutes =
            Number((strikes as RegExpExecArray)[1]) * Number((interval as RegExpExecArray)[1]);
        expect(windowMinutes).toBe(20);

        // A failed scrape must NOT be read as idle. This is the property that
        // keeps a broken metrics endpoint from shutting the VM down exactly
        // when something is wrong, and it was mutation-proved on the host.
        const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
        const readmeLines = readme.split('\n');
        expect(readmeLines.filter((l) => l.includes('openshell-idle-shutdown.timer')).length)
            .toBeGreaterThanOrEqual(2);
    });

    it('the code that 0.1b justifies still writes enforcement on every endpoint', () => {
        // Ties the FACT to the CODE that depends on it. The unit suite asserts
        // this too, for a different reason — that the policy is correct. Here it
        // is the other direction: if the audit-mode default were ever refuted,
        // THIS is the code whose justification would have evaporated, and the
        // assertion names the fact so the two move together.
        const benchmarks = [
            'aws_compliance.benchmark.soc_2',
            'azure_compliance.benchmark.soc_2',
            'gcp_compliance.benchmark.cis_v300',
        ];
        let endpoints = 0;
        for (const b of benchmarks) {
            for (const e of collectorSandboxPolicy(b).networkPolicies) {
                endpoints++;
                // Explicit, and the one value that enforces. An absent field is
                // the same bytes as audit.
                expect(e.enforcement).toBe('NETWORK_ENFORCEMENT_MODE_ENFORCE');
            }
        }
        expect(endpoints).toBeGreaterThanOrEqual(6);
    });

    it("the deployment README's OPERATOR instructions name the pin, not an older release", () => {
        /*
            THE GAP THIS CLOSES, found by auditing my own upgrade diff rather
            than by a failing test.

            `nothing in the repository claims a release NEWER than the pin`
            above is one-directional. It cannot see a STALE OLDER claim, and the
            upgrade left three: the SDK-pairing sentence, the observed Docker
            socket traffic, and — the one that matters — a precondition reading
            `openshell-gateway 0.1.5 at /usr/local/bin` sitting directly above a
            line that said `--version` must print 0.1.6. An operator working
            that checklist would have installed the wrong binary and then been
            told by the next line that they were wrong.

            It is NOT a blanket "no older release is mentioned" rule, and that
            is the whole design question here. This README names 0.1.5 seven
            more times on purpose: the tag-movement evidence is a record of what
            `:0.1.5` resolved to before and after upstream re-pushed it, and a
            rule that forbade it would force the deletion of the measurement
            that justifies digest pinning in the first place.

            So the rule is scoped to the two places where a release number is an
            INSTRUCTION rather than a record — the precondition checklist and
            the Release row — because those are the ones where being stale
            causes an action, not a misreading.
        */
        const md = fs.readFileSync(path.join(REPO_ROOT, 'deploy/openshell/README.md'), 'utf8');

        const fenced = /## Preconditions before enabling\s*\n+```\n([\s\S]*?)\n```/.exec(md);
        expect(fenced).not.toBeNull();
        const checklist = (fenced as RegExpExecArray)[1].split('\n');

        // TWO denominators. Without them a renamed heading, a reflowed fence or
        // a checklist that stops naming versions all pass by examining nothing.
        expect(checklist.filter((l) => l.trim().startsWith('[')).length).toBeGreaterThanOrEqual(7);
        const versioned = checklist.filter((l) => /\b0\.\d+\.\d+\b/.test(l));
        expect(versioned.length).toBeGreaterThanOrEqual(2);

        expect(versioned.filter((l) => !l.includes(PINNED_RELEASE))).toEqual([]);

        // The Release row of the summary table, which is the first thing a
        // reader takes the deployment's version from.
        const releaseRows = md.split('\n').filter((l) => /^\|\s*Release\s*\|/.test(l));
        expect(releaseRows.length).toBe(1);
        expect(releaseRows.filter((l) => !l.includes(PINNED_RELEASE))).toEqual([]);
    });

    it('the deployed gateway config never turns 0.1.6 authentication back off', () => {
        /*
            A NEW RULE THE UPGRADE CREATED, which is the shape #3973 asks for.

            v0.1.5 started with no inbound authentication configured and only
            WARNED. v0.1.6 refuses to start — verified on the lab VM against
            this release. That refusal is the strongest control this deployment
            has, because the gateway's compute driver talks to a Docker socket
            that is root-equivalent on its host.

            It has exactly one documented off switch,
            `allow_unauthenticated_users`, which upstream marks "trusted local
            development only". Setting it would restore the 0.1.5 behaviour
            silently: the gateway would start, the warning would scroll past
            once, and nothing in this repository would be red. So the upgrade's
            own hardening gets a detector, rather than resting on nobody
            thinking to add one line to a TOML file.

            `= false` is deliberately ALLOWED. Writing the switch off explicitly
            is a reasonable thing for a config to document, and a guard that
            fails the safe spelling of its own rule is a guard people delete.
        */
        const rel = 'deploy/openshell/gateway.toml';
        const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

        // THE DENOMINATOR, and it is not decorative here: every assertion
        // below is satisfied by an empty file, a renamed file read as '', or a
        // path typo. This says the scan read the real config.
        //
        // Asserted as COUNTS of parsed structure rather than as
        // `expect(text).toContain(…)`, which is a whole-file assertion and
        // lands in `assertion-needle-uniqueness`'s un-analysable census — a
        // ratchet with a ceiling this file should not be spending.
        const lines = text.split('\n').map((l) => l.trim());
        expect(text.length).toBeGreaterThan(2000);
        expect(lines.filter((l) => /^\[openshell/.test(l)).length).toBeGreaterThanOrEqual(4);

        expect(activeUnauthenticatedSwitches(text)).toEqual([]);

        // AND the file still EXPLAINS the hatch, in a COMMENT. Without this the
        // rule's reason lives only in a test, where the person editing the TOML
        // will not see it. Counting comment lines rather than matching the
        // whole file also makes the claim exact: the key must appear ONLY in
        // prose, which is the same fact the detector proof relies on.
        const explained = lines.filter(
            (l) => l.startsWith('#') && l.includes('allow_unauthenticated_users'),
        );
        expect(explained.length).toBeGreaterThanOrEqual(1);
    });

    describe('detector proof — the bait in the real file is why this is not a grep', () => {
        /*
            `gateway.toml` NAMES `allow_unauthenticated_users = true` inside a
            comment, as part of explaining why it must never be set. A plain
            `grep -q` for the key, or even for the whole assignment, fails on
            the very file it is meant to clear — the scar, not the wound. So the
            detector strips comments, and these cases prove it strips them
            without going blind to the real thing.
        */
        it('finds an ACTIVE assignment, however it is spelled', () => {
            expect(activeUnauthenticatedSwitches('allow_unauthenticated_users = true')).toHaveLength(1);
            expect(activeUnauthenticatedSwitches('  allow_unauthenticated_users=true')).toHaveLength(1);
            expect(
                activeUnauthenticatedSwitches('allow_unauthenticated_users = true # just for today'),
            ).toHaveLength(1);
            // A value that is neither boolean is still not `false`, and a
            // detector that only knew the string `true` would pass it.
            expect(activeUnauthenticatedSwitches('allow_unauthenticated_users = 1')).toHaveLength(1);
        });

        it('is not fooled by the real file\'s commented explanation', () => {
            expect(
                activeUnauthenticatedSwitches('# `allow_unauthenticated_users = true` is forbidden'),
            ).toEqual([]);
            expect(
                activeUnauthenticatedSwitches('   #   allow_unauthenticated_users = true'),
            ).toEqual([]);
        });

        it('allows the switch written explicitly OFF', () => {
            expect(activeUnauthenticatedSwitches('allow_unauthenticated_users = false')).toEqual([]);
        });

        it('does not fire on a different key that merely contains the name', () => {
            // `#` is not legal in a bare TOML key, so cutting the line at the
            // first `#` cannot truncate the assignment being hunted: the only
            // thing a `#` can hide is a quoted string, and this key's value is
            // a bare boolean. Stated here because it is the assumption the
            // comment-stripping rests on.
            expect(
                activeUnauthenticatedSwitches('deny_allow_unauthenticated_users_audit = true'),
            ).toEqual([]);
        });
    });
});
