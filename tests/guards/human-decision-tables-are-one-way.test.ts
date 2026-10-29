/**
 * A TABLE RECORDING A PERSON'S DECISION IS ONE-WAY AT THE DATABASE (#4435).
 *
 * `docs/new-subsystem-checklist.md` §2 asks that a model recording a PERSON's
 * decision about rows a machine writes be one-way at the database — a
 * `BEFORE UPDATE` trigger, and no `DELETE` for `app_user` — so the row is
 * evidence rather than a mutable field.
 *
 * That section's ratchet enforces only `ISOLATION_TESTED` membership. The
 * one-way requirement beside it had NO gate, and the consequence was measured:
 * `AgentHarnessAcceptance` shipped in `20261017210000` with
 * `GRANT SELECT, INSERT, UPDATE, DELETE`, one day BEFORE
 * `AgentServicePrincipalConfirmation` established the pattern it is measured
 * against, and nothing noticed for twelve days. Fixing that instance without
 * this guard would leave the class open.
 *
 * WHAT THIS CANNOT DO, STATED SO NOBODY READS MORE INTO IT. "Records a
 * person's decision about machine-written rows" is a judgement about meaning,
 * not a property of the schema, so it cannot be detected — a new table of this
 * class still has to be added to `HUMAN_DECISION_TABLES` by whoever knows that
 * is what they built. What the guard removes is the other half of the problem:
 * a table that IS on the list silently losing its protections, and a reviewer
 * having to remember the rule exists.
 *
 * It reads the migrations rather than a live database, so it runs in the
 * `scan` project with no Postgres — and it computes the NET effect in filename
 * order, because a later migration re-granting DELETE is exactly the
 * regression worth catching and a first-match scan would miss it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseSchemaModels } from '../helpers/prisma-schema-models';

const ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(ROOT, 'prisma/migrations');

/** Each entry says WHOSE decision the table holds, and about what. */
const HUMAN_DECISION_TABLES: Readonly<Record<string, string>> = {
    AgentServicePrincipalConfirmation:
        "A person confirming that a scanner's discovered principal really is the registered agent it was " +
        'reconciled to. The machine proposes the link; the human affirms it.',
    AgentHarnessAcceptance:
        "The agent owner accepting a HARNESS_SHORTFALL derived from scanner-ingested scan items — who " +
        'accepted, on what justification, until when. Extending it in place would make one row stand for ' +
        'several decisions, so the trigger freezes `expiresAt` (owner decision, 2026-10-29).',
};

function migrationSqlInOrder(): Array<{ name: string; sql: string }> {
    if (!fs.existsSync(MIGRATIONS)) return [];
    return fs
        .readdirSync(MIGRATIONS, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort() // timestamp-prefixed, so lexical order IS apply order
        .map((name) => ({ name, sql: path.join(MIGRATIONS, name, 'migration.sql') }))
        .filter((m) => fs.existsSync(m.sql))
        .map((m) => ({ name: m.name, sql: fs.readFileSync(m.sql, 'utf8') }));
}

const ALL = migrationSqlInOrder();

/** Does `app_user` hold DELETE on `table` after every migration has run? */
function deleteHeldByAppUser(table: string): boolean {
    let held = false;
    const grant = new RegExp(`GRANT\\s+([^;]*?)\\s+ON\\s+"${table}"\\s+TO\\s+app_user`, 'gi');
    const revoke = new RegExp(`REVOKE\\s+([^;]*?)\\s+ON\\s+"${table}"\\s+FROM\\s+app_user`, 'gi');
    for (const { sql } of ALL) {
        // Walk both kinds in the order they appear WITHIN the file too.
        const events: Array<{ at: number; kind: 'grant' | 'revoke'; privs: string }> = [];
        for (const m of sql.matchAll(grant)) events.push({ at: m.index ?? 0, kind: 'grant', privs: m[1] });
        for (const m of sql.matchAll(revoke)) events.push({ at: m.index ?? 0, kind: 'revoke', privs: m[1] });
        events.sort((a, b) => a.at - b.at);
        for (const e of events) {
            if (!/\bDELETE\b|\bALL\b/i.test(e.privs)) continue;
            held = e.kind === 'grant';
        }
    }
    return held;
}

function beforeUpdateTrigger(table: string): string | null {
    const re = new RegExp(`CREATE\\s+TRIGGER\\s+(\\w+)[\\s\\S]{0,200}?BEFORE\\s+UPDATE\\s+ON\\s+"${table}"`, 'i');
    for (const { sql } of ALL) {
        const m = re.exec(sql);
        if (m) return m[1];
    }
    return null;
}

describe("a table holding a person's decision is one-way at the database", () => {
    it('reads the migrations at all (guards against a vacuous pass)', () => {
        // Every assertion below iterates migration text. An empty read would
        // pass all of them while checking nothing.
        expect(ALL.length).toBeGreaterThan(50);
        expect(Object.keys(HUMAN_DECISION_TABLES).length).toBeGreaterThanOrEqual(2);
    });

    it('the detector can tell a granted DELETE from a revoked one', () => {
        // The control. Both halves are asserted on REAL tables, so a detector
        // that answered one way for everything could not pass this.
        expect(deleteHeldByAppUser('AgentHarnessScan')).toBe(true);
        expect(deleteHeldByAppUser('AgentHarnessAcceptance')).toBe(false);
    });

    it('every listed table has a BEFORE UPDATE trigger', () => {
        const missing = Object.keys(HUMAN_DECISION_TABLES).filter((t) => beforeUpdateTrigger(t) === null);
        expect(missing).toEqual([]);
    });

    it('no listed table leaves DELETE with app_user', () => {
        const deletable = Object.keys(HUMAN_DECISION_TABLES).filter(deleteHeldByAppUser);
        expect(deletable).toEqual([]);
    });

    it('every listed table exists in the schema, and carries a written reason', () => {
        // A stale entry is a hole that looks like a decision: the table is gone
        // or renamed, and the entry excuses nothing while implying the question
        // was considered.
        // Through the structured parser, not a regex over the concatenated
        // schema text. Two reasons, and the second is why this was rewritten:
        // a `^model\s+X` needle is also satisfied by the name appearing inside
        // a comment or another model's field, and an interpolated needle over
        // a whole-file read is invisible to
        // `tests/guardrails/assertion-needle-uniqueness-ratchet` — which is the
        // ratchet that exists to notice exactly that.
        const declared = new Set(parseSchemaModels().map((m) => m.name));
        const absent = Object.keys(HUMAN_DECISION_TABLES).filter((t) => !declared.has(t));
        expect(absent).toEqual([]);
        const unreasoned = Object.entries(HUMAN_DECISION_TABLES)
            .filter(([, reason]) => reason.length <= 60)
            .map(([table]) => table);
        expect(unreasoned).toEqual([]);
    });
});
