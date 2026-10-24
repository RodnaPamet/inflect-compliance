/**
 * Contended JSON files keep their own serialisation format (#3290).
 *
 * THE DEFECT
 * ──────────
 * Several JSON files are edited by multiple branches at once and each has its
 * own format, with nothing asserting it. A writer that guesses — a conflict
 * resolver's default indent, a `json.dumps` kwarg, a formatter-on-save —
 * rewrites the whole file while the intended change is one line. The merge is
 * CLEAN, nothing is flagged, and every branch behind it now conflicts on lines
 * nobody meant to touch.
 *
 * Three incidents in one day, all caught by a habit rather than a control:
 *
 *   1. `ci-checks-unreachable-before-merge.json` — adding ONE registry entry
 *      with `json.dumps(..., sort_keys=True)` gave 35 insertions / 30 deletions,
 *      because `sort_keys` also reorders each entry's inner keys. Caught only by
 *      checking the diff was purely additive; redone as +5/-0.
 *   2. `doc-classification.json` — a resolver defaulted to 2-space against the
 *      file's 4 and turned a 3-line change into a whole-file rewrite, on a file
 *      THREE branches were editing. It would have merged cleanly.
 *   3. `messages/en.json` + `bg.json` — caught pre-commit by reading
 *      `git diff --numstat`, specifically because of incident 2.
 *
 * "Look at the diffstat before committing" is a habit, not a control. This is
 * the control.
 *
 * WHY ROUND-TRIP AND NOT "PARSES AS JSON"
 * ───────────────────────────────────────
 * Every one of these files parses fine in every format. Parseability is exactly
 * what makes the corruption invisible, so the assertion has to be that
 * `serialise(parse(raw)) === raw` BYTE FOR BYTE under the file's own declared
 * format — which also documents that format where a writer will look for it.
 *
 * MEASURED: there is no convention to converge on
 * ──────────────────────────────────────────────
 *   ci-checks-unreachable-before-merge.json   indent 4   ASCII-escaped
 *   doc-classification.json                   indent 4   non-ASCII literal
 *   messages/en.json                          indent 2   non-ASCII literal
 *   messages/bg.json                          indent 2   non-ASCII literal
 *   ui-core-classification.json               indent 1   MIXED — see EXEMPT
 *
 * Four distinct formats, each undiscoverable without measuring the file first.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

interface Format {
    readonly indent: number;
    /** true = non-ASCII is `\uXXXX`-escaped, as Python's `ensure_ascii=True`. */
    readonly escapeNonAscii: boolean;
    readonly trailingNewline: boolean;
    /**
     * sha256 of every key in document order, which the round-trip CANNOT see.
     *
     * A MUTATION RUN FOUND THIS GAP, and it is the gap that matters: re-writing
     * the registry with `sort_keys=True` changes 32 lines on disk — reordering
     * each entry's inner keys from `kind/reason/coveredBy` to
     * `coveredBy/kind/reason` — and the round-trip still PASSED, because
     * `JSON.parse` -> `JSON.stringify` reproduces whatever order is on disk.
     *
     * So the format check alone would have missed INCIDENT 1, the one that
     * motivated this guard. A digest is one line per file instead of thousands
     * of key names, and any reorder changes it.
     */
    /**
     * OPTIONAL, and the omissions are deliberate — see `messages/*.json` below.
     *
     * Only declare it where key order is an INVARIANT. A file that legitimately
     * gains keys on most PRs has no stable key order, so a digest there fails on
     * every honest addition and trains people to update the hash reflexively,
     * which destroys the signal it exists to carry.
     */
    readonly keyOrderSha?: string;
}

const GOVERNED: Readonly<Record<string, Format>> = {
    'tests/guardrails/ci-checks-unreachable-before-merge.json': {
        indent: 4,
        escapeNonAscii: true,
        trailingNewline: true,
        // Updated 2026-10-10: one entry added for `laya-image.yml:build-scan-push`,
        // Step 6d's dispatch-only image publish. The digest moves when a key is
        // added, which is the point — it makes editing a contended file a
        // deliberate act recorded in two places rather than one.
        //
        // Updated again 2026-10-11: one entry added for `ci.yml:laya-image`, the
        // path-scoped PR build of that same image. 72 keys. The file diff is
        // +6/-1 — five lines of new entry plus one replaced `coveredBy` value —
        // so the FORMAT half round-tripped untouched and only the key-order
        // digest moved, which is this pin working as designed.
        //
        // Updated again 2026-10-14: one entry added for
        // `main-ci-failure-notice.yml:notice` (#3505) — the `workflow_run` job
        // that opens an issue when a run on `main` fails. The diff is +5/-0, a
        // pure append, so again only this digest moved. Worth noting WHY that
        // job had to be registered rather than fixed: it is the one job in the
        // repo that is unreachable from a pull request ON PURPOSE, since its
        // whole function is to react to a run that has already merged.
        //
        // And again, hours later: TWO entries REMOVED — `ci.yml:laya-image` and
        // `laya-image.yml:build-scan-push` — because the Laya image estate was
        // retired (owner decision, same day). 19 keys down to 17.
        //
        // The two edits CONFLICTED on this line, which is the pin working as
        // designed and worth recording as the worked example: both branches were
        // green alone, both moved the digest, and git cannot merge two different
        // hashes. Resolving it meant re-applying the deletion to the version of
        // the registry that already carried the addition and recomputing — not
        // picking a side, which would have left the file and the digest
        // describing different documents.
        //
        // First time this pin has recorded a DELETION rather than an addition.
        // The digest cannot tell the two apart, which is why the reason is
        // written rather than inferred from the count.
        // Updated again 2026-10-17: one entry added for
        // `skills-evaluate.yml:record` (#3666), the manual job that records
        // skill evaluations with the repository secret. A pure append, +5/-0.
        // Updated again 2026-10-20: one entry added for
        // `scanner-image.yml:build-scan-push`, the dispatch-only publish of the
        // harness scanner's image for Inflect's own estate. A pure append, +5/-0.
        // And again the same day: `scanner-vm.yml:scanner-vm`, the dispatch-only
        // workflow that configures and starts that scanner on the VM. +5/-0.
        // Updated 2026-10-23: two entries for the public docs site —
        // `docs-site.yml:deploy` (main-only Pages deploy) and
        // `docs-site.yml:pull_request.paths` (its path-scoped PR build). A
        // textual insert before `ghcr-publish.yml`, +10/-0; no key moved.
        //
        // Updated 2026-10-24 for `queue-failure-attribution.yml:attribute`
        // (#3307), inserted in ALPHABETICAL position after
        // `queue-candidate-sweep.yml:sweep` rather than appended: a mid-file
        // insert touches only its own lines, where appending rewrites the
        // previous entry's closing brace and two PRs then conflict on a line
        // neither of them meant to edit. +5/-0.
        keyOrderSha: 'd6f555ec86fd3a08982491d35d1eb80f0fa3a8331595327de9414c379c4257ea',
    },
    'docs/_status/doc-classification.json': {
        indent: 4,
        escapeNonAscii: false,
        trailingNewline: true,
        // Moved 2026-10-13 by ADDING one entry (the TypeSafe customer notice),
        // not by reordering: the file is sorted and the new key landed in its
        // sorted position, so the diff is three lines. Recorded here because
        // this pin cannot tell an addition from a `sort_keys` rewrite — and the
        // first attempt at that edit WAS the rewrite this pin exists for, a
        // `json.dumps(indent=2, sort_keys-style)` that changed 831 lines while
        // the file still parsed.
        //
        // Moved 2026-10-17 by ADDING two entries in their sorted positions
        // (docs/a2a-threat-model.md and docs/integration-passport.md, step 0c
        // of the agentic IAM plan). No existing key moved.
        // Moved 2026-10-17 the same way: one entry added in sorted position
        // (docs/agentic-audit-procedures.md, step 0d of #3654).
        // Moved again 2026-10-17 by one sorted ADDITION, the scanner DPIA
        // (#3664): a three-line diff, +3/-0.
        // Moved 2026-10-18 by one sorted ADDITION, docs/a2a-mapping.md (step
        // 2e, #3673): +3/-0.
        // Moved 2026-10-19 by one sorted ADDITION,
        // docs/agent-harness-scanner-onboarding.md (step 4a, #3678): +3/-0.
        // Moved 2026-10-19 by one sorted ADDITION,
        // docs/agentic-audit-reliance-memo.md (step 4d, #3681): +3/-0.
        // Moved 2026-10-19 by one sorted ADDITION,
        // docs/agentic-iam-managed-service.md (step 4e, #3682): +3/-0.
        // Moved 2026-10-20 by one sorted ADDITION,
        // docs/sap-agent-integration-roadmap.md (the SAP roadmap, #3859): +3/-0.
        // Worth recording what the writer did, since this pin is aimed at it: the
        // edit re-serialised the whole `docs` map through `sorted()` — the
        // rewrite shape this digest exists for. It was a no-op only because the
        // file was already sorted, which the +3/-0 diff is the evidence for. The
        // digest moved because of the ADDITION, as it does for every honest one;
        // it is not evidence that nothing else moved. The diff is.
        // Moved 2026-10-20 by one sorted ADDITION,
        // docs/adr/0003-a2a-host-consumers.md (#3861): +3/-0. The guard that
        // found it was `docs-accuracy`'s "every doc on disk is classified" —
        // the ADR had been committed three commits earlier and never
        // classified, which no amount of reading the diff had surfaced.
        // Moved 2026-10-21 by one sorted ADDITION, docs/runbooks/joule-byoa.md
        // (#3865, the Joule BYOA runbook): +3/-0 against main.
        //
        // Worth recording what went wrong first, since this pin is aimed at it.
        // The first attempt appended THREE entries at the end of the map with a
        // Python `json.dump(indent=4)` — so the keys were out of sorted position
        // AND two of them were `docs/implementation-notes/**`, which this file's
        // own `description` field says in as many words must never appear here
        // because that subtree is classified BY PATH. The file documented its own
        // constraint and I added the entries anyway. CI caught it three ways at
        // once: this digest, the round-trip, and docs-accuracy's path-derived
        // check.
        //
        // Moved 2026-10-21 by one sorted ADDITION,
        // docs/adr/0004-interactive-agent-runs.md (#3868 step 1, M1's ADR):
        // +3/-0, inserted textually after the 0003 entry so no existing key
        // moved. 153 entries.
        //
        // Worth recording, because the pin caught the writer rather than the
        // diff this time. The first attempt DID use a Python round-trip —
        // `json.dumps(indent=4)` through an OrderedDict — and it produced the
        // correct +3/-0 for the `docs` map while silently rewriting the
        // `description` field, because `json.dumps` defaults to
        // `ensure_ascii=True` and this file is declared `escapeNonAscii: false`.
        // Every em-dash in that one long line became `\u2014`. The diffstat read
        // 4 insertions / 1 deletion and looked like a one-line touch; what it
        // actually was is the whole-file-rewrite class, scoped to the only line
        // containing non-ASCII. Reverted and redone as a textual insert.
        //
        // So the two halves of this Format caught different things: the
        // `escapeNonAscii` round-trip would have caught the revert-worthy part,
        // and this digest caught the honest addition. Neither sees the other's.
        //
        // Moved 2026-10-22 for `docs/sap/metadata/README.md` (#3871 prep), a
        // +3/-0 textual insert. The digest changes on ANY added key, so this
        // line moving is expected and is not evidence of a reorder — the
        // failure message's "shape of a sort_keys rewrite" hint fits the
        // reorder case and reads as an accusation in the addition case. Both
        // writers were tried here and produced the SAME digest, because the
        // file is already fully sorted; the textual insert was kept anyway, per
        // the note above.
        //
        // Moved 2026-10-23 for `docs/docs-site.md` (the public docs site), a
        // +3/-0 textual insert in sorted position.
        // Moved 2026-10-24 for `docs/a2a-host-consumer-pilot-runbook.md`
        // (#4054), the same shape: a +3/-0 textual insert in sorted position,
        // before `docs/a2a-mapping.md` because 'h' < 'm'. No existing entry
        // moved, which is the distinction this digest exists to draw — the
        // round-trip cannot tell one added key from a `sort_keys` rewrite.
        // Moved 2026-10-24 by three sorted ADDITIONS, the Claude agent designs
        // (docs/claude-agent-sdk-design.md, docs/claude-managed-agents-design.md,
        // docs/claude-tool-runner-design.md), one contiguous textual insert
        // between `docs/ci-local.md` and `docs/cloud-storage.md`: +9/-0.
        keyOrderSha: '89576449fd9001551aa131d753dab3fe4e14291ba391d22e32cc59675315fe40',
    },
    // NO keyOrderSha for the two catalogues, deliberately. They gain keys on
    // essentially every i18n PR — #3289 added eighteen while this guard was in
    // CI, which is how the omission got measured rather than guessed. A digest
    // here would fail on every honest addition, so every i18n PR would carry two
    // hash updates and people would start updating them without reading, which
    // is worse than no check.
    //
    // The FORMAT check still applies and is the hazard that matters for these:
    // a resolver re-indenting a 5,000-key catalogue is the rewrite that makes
    // every concurrent i18n branch conflict. Key ORDER here is not an invariant;
    // indent and escaping are.
    'messages/en.json': { indent: 2, escapeNonAscii: false, trailingNewline: true },
    'messages/bg.json': { indent: 2, escapeNonAscii: false, trailingNewline: true },
};

/**
 * Files that cannot be governed, with the measurement that says why.
 *
 * `ui-core-classification.json` is MIXED-ENCODING: literal non-ASCII for its
 * first ~34,000 characters and `\uXXXX` escapes after that. Measured, the first
 * divergence is at character 34,064 — the file has `—` where any uniform
 * serialiser emits a literal em-dash. NO single (indent, escapeNonAscii) pair
 * reproduces it, so ANY programmatic rewrite of that file is lossy by
 * construction.
 *
 * Listed rather than silently omitted: leaving the worst file out of the table
 * with no record would be the same invisible gap this guard exists to close.
 * Normalising it means one deliberate commit whose diff is enormous ON PURPOSE
 * and contains nothing else — at which point delete this entry and govern it.
 */
const EXEMPT: Readonly<Record<string, string>> = {
    'docs/_status/ui-core-classification.json':
        'mixed encoding: literal non-ASCII before char ~34064, \\uXXXX escapes after. ' +
        'No uniform serialiser round-trips it; normalise in a dedicated commit first.',
};

function escapeNonAsciiChars(s: string): string {
    let out = '';
    for (const ch of s) {
        const cp = ch.codePointAt(0) ?? 0;
        out += cp > 127 ? `\\u${cp.toString(16).padStart(4, '0')}` : ch;
    }
    return out;
}

/**
 * The serialisation half of a `Format`. `keyOrderSha` is a RECORDED FACT about
 * the file, not an input to writing it, so asking for it here would force the
 * exemption probe below to invent a digest it has no use for.
 */
type Serialisation = Omit<Format, 'keyOrderSha'>;

function serialise(parsed: unknown, fmt: Serialisation): string {
    let out = JSON.stringify(parsed, null, fmt.indent);
    if (fmt.escapeNonAscii) out = escapeNonAsciiChars(out);
    return fmt.trailingNewline ? `${out}\n` : out;
}

/**
 * Every key in document order, depth-first, as one newline-joined string.
 *
 * Arrays contribute their index so a reordered array of objects is visible too.
 */
function keyOrder(value: unknown, prefix = ''): string[] {
    if (Array.isArray(value)) {
        return value.flatMap((v, i) => keyOrder(v, `${prefix}[${i}]`));
    }
    if (value !== null && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>).flatMap((k) => [
            `${prefix}.${k}`,
            ...keyOrder((value as Record<string, unknown>)[k], `${prefix}.${k}`),
        ]);
    }
    return [];
}

function keyOrderSha(parsed: unknown): string {
    return createHash('sha256').update(keyOrder(parsed).join('\n')).digest('hex');
}

/** First differing character index, or -1. */
function firstDiff(a: string, b: string): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : n;
}

describe('#3290 — contended JSON files round-trip byte-identically', () => {
    it('the table is non-trivial and every entry names a file that exists', () => {
        // Denominator beside the result: a table that lost its entries, or whose
        // paths rotted, would pass every assertion below over nothing.
        expect(Object.keys(GOVERNED).length).toBeGreaterThanOrEqual(4);
        // The digest is opt-in, so it could silently become opt-out-of-entirely.
        // At least one file must carry one, or the key-order half of this guard
        // governs nothing while still reading as present.
        const withDigest = Object.values(GOVERNED).filter((f) => f.keyOrderSha !== undefined);
        expect(withDigest.length).toBeGreaterThanOrEqual(2);
        for (const rel of [...Object.keys(GOVERNED), ...Object.keys(EXEMPT)]) {
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
        }
    });

    it.each(Object.keys(GOVERNED))('%s round-trips byte-identically', (rel) => {
        const fmt = GOVERNED[rel] as Format;
        const abs = path.join(ROOT, rel);
        const raw = fs.readFileSync(abs, 'utf-8');
        const ours = serialise(JSON.parse(raw), fmt);
        if (raw !== ours) {
            const i = firstDiff(raw, ours);
            throw new Error(
                `${rel} is not in its declared format ` +
                    `(indent ${fmt.indent}, ${fmt.escapeNonAscii ? 'ASCII-escaped' : 'non-ASCII literal'}).\n\n` +
                    `  first difference at character ${i} of ${raw.length}\n` +
                    `    on disk: ${JSON.stringify(raw.slice(i, i + 40))}\n` +
                    `    declared: ${JSON.stringify(ours.slice(i, i + 40))}\n\n` +
                    `Something rewrote this file in a different format — a conflict\n` +
                    `resolver's default indent, a formatter-on-save, or a serialiser\n` +
                    `kwarg such as \`sort_keys\`. The file still PARSES, which is why\n` +
                    `nothing else caught it, and every branch editing it now conflicts\n` +
                    `on lines nobody meant to touch.\n\n` +
                    `Re-serialise it in the declared format, or — if the format was\n` +
                    `changed deliberately — update this table in the same diff.`,
            );
        }

        // THE HALF THE ROUND-TRIP IS BLIND TO. Reordering keys leaves the
        // serialisation self-consistent, so only a recorded digest catches it.
        if (fmt.keyOrderSha === undefined) return;
        const sha = keyOrderSha(JSON.parse(raw));
        if (sha !== fmt.keyOrderSha) {
            throw new Error(
                `${rel} has the right FORMAT but its KEY ORDER changed.\n\n` +
                    `  recorded: ${fmt.keyOrderSha}\n` +
                    `  on disk:  ${sha}\n\n` +
                    `The round-trip check cannot see this — \`JSON.parse\` then\n` +
                    `\`JSON.stringify\` reproduces whatever order is on disk, so a\n` +
                    `reordered file is still self-consistent. This is the shape of a\n` +
                    `\`sort_keys=True\` rewrite: on the registry it changes 32 lines\n` +
                    `while every other check stays green.\n\n` +
                    `If keys were reordered deliberately, update the digest in the\n` +
                    `same diff. If not, restore the original order — a reorder makes\n` +
                    `every concurrent branch conflict on lines nobody edited.`,
            );
        }
    });

    it('every EXEMPT file is still genuinely un-round-trippable', () => {
        // A stale exemption is worse than none: it reads as considered and
        // governs nothing. If someone normalises the file, this fails and says
        // to delete the entry — the same no-stale discipline the ratchets use.
        for (const [rel, reason] of Object.entries(EXEMPT)) {
            const raw = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
            const parsed = JSON.parse(raw);
            const anyMatches = [1, 2, 4]
                .flatMap((indent) => [true, false].map((esc) => ({ indent, esc })))
                .some(
                    ({ indent, esc }) =>
                        serialise(parsed, {
                            indent,
                            escapeNonAscii: esc,
                            trailingNewline: true,
                        }) === raw ||
                        serialise(parsed, {
                            indent,
                            escapeNonAscii: esc,
                            trailingNewline: false,
                        }) === raw,
                );
            if (anyMatches) {
                throw new Error(
                    `${rel} is EXEMPT but now round-trips under a uniform format.\n` +
                        `Recorded reason: ${reason}\n\n` +
                        `It was normalised. Delete its EXEMPT entry and add it to\n` +
                        `GOVERNED with the format that matches, in this same diff.`,
                );
            }
        }
    });
});
