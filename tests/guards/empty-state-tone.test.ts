/**
 * Roadmap-3 PR-6 — empty-state copy tone discipline.
 *
 * Empty states are where the product talks to the user the
 * most directly. The voice was inconsistent: "No assets yet.
 * Add your first asset above." vs "No risks. Create one above."
 * vs "No findings yet." Three voices, three punctuations, two
 * references to "above" (which is wrong inside Modals/Sheets).
 *
 * Locked voice for `noX` titles
 *
 *   • Single declarative phrase: "No X yet"
 *   • No trailing period
 *   • No "above" / "below" directional language
 *   • No imperative tail ("Add your first…", "Create one…")
 *
 * The "what to do next" guidance moves to a separate
 * `descriptionX` / `actionX` field on the EmptyState component
 * — addressed in a future polish PR. This PR locks the title
 * voice.
 *
 * What this ratchet bans (English locale)
 *
 *   • A `noX` title ending in a period.
 *   • A `noX` title containing "above" or "below".
 *   • A `noX` title containing "Add your first" or "Create one".
 *   • A `noX` title with the redundant "available yet" pattern.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

interface Hit {
    key: string;
    value: string;
    reason: string;
}

function flatten(
    obj: Record<string, unknown>,
    prefix: string[] = [],
): Array<{ key: string; value: string }> {
    const out: Array<{ key: string; value: string }> = [];
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
            out.push({ key: [...prefix, k].join('.'), value: v });
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            out.push(...flatten(v as Record<string, unknown>, [...prefix, k]));
        }
    }
    return out;
}

describe('Empty-state copy tone (Roadmap-3 PR-6)', () => {
    it('every noX-style title in messages/en.json follows the canonical voice', () => {
        const messages = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf-8'),
        );
        const offenders: Hit[] = [];
        for (const { key, value } of flatten(messages)) {
            // Only police keys whose terminal segment is `noX` or
            // `noXAvailable` / `noXYet` (the empty-state shape).
            const last = key.split('.').pop() ?? '';
            if (!/^no[A-Z][A-Za-z]*$/.test(last)) continue;
            // A key that NAMES itself a body or a description is not a title,
            // and the locked voice above is a rule about titles. Without this,
            // the guard's own advice — "move the what-to-do-next guidance to a
            // separate descriptionX field" — produces a new offender, because
            // the moved sentence still starts with `no` and still ends with the
            // period a sentence is supposed to have.
            if (/(Body|Description|Desc|Hint|Help)$/.test(last)) continue;

            // Sanctioned exceptions — keys whose `noX` shape is
            // coincidental (they're not empty-state titles).
            const SANCTIONED = new Set([
                'common.noData',         // "No data available" — table empty fallback
                'login.noAccount',       // "No account?" — sign-in prompt question
                'common.none',           // "None" — generic UI label
                'common.no',             // "No" — Yes/No primitive
                'dashboard.noAlerts',    // emoji prefix + sentence — different shape
                'dashboard.noRecentActivity',  // "No recent activity" — already canonical
                'admin.noNotifications', // already canonical, no period
                'clauses.notStarted',    // not an empty-state — passes the regex but isn't one
                'clauses.notApplicable', // not an empty-state
                'controls.notApplicable',
                'tests.notTested',
            ]);
            if (SANCTIONED.has(key)) continue;
            // Sanctioned namespace: `riskManager.*` keys are the
            // risk-import wizard's conversational error/info
            // messages — they're full sentences with punctuation
            // that legitimately end in periods. They are not
            // empty-state titles.
            if (key.startsWith('riskManager.')) continue;

            // Skip keys that don't START with `no` (the noX regex
            // already filters but be explicit).
            if (!last.startsWith('no')) continue;

            // Now apply the four bans.
            if (value.endsWith('.')) {
                offenders.push({
                    key,
                    value,
                    reason: 'trailing period',
                });
                continue;
            }
            if (/\babove\b|\bbelow\b/i.test(value)) {
                offenders.push({
                    key,
                    value,
                    reason: 'directional language',
                });
                continue;
            }
            if (/Add your first|Create one|Create your first/i.test(value)) {
                offenders.push({
                    key,
                    value,
                    reason: 'imperative tail',
                });
                continue;
            }
            if (/\bavailable yet\b/i.test(value)) {
                offenders.push({
                    key,
                    value,
                    reason: 'redundant "available yet"',
                });
                continue;
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.key} [${o.reason}]: ${o.value}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} empty-state title(s) off-canon.\n\nThe locked voice is "No X yet" — no period, no "above"/"below", no imperative tail, no redundant "available yet". Move "what to do next" guidance to a separate descriptionX/actionX field.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});
