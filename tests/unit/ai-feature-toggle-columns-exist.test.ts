/**
 * The AI toggle column names are string literals. This proves they are real.
 *
 * ═══ WHY A STRING LITERAL HERE IS LOAD-BEARING ═══
 *
 * `AI_TOGGLE_COLUMN` maps each switch to a `TenantSecuritySettings` column, and
 * both the gate and the admin usecase build Prisma `select` objects from it with
 * computed keys. A computed key is not type-checked against the Prisma model, so
 * renaming a column in `auth.prisma` leaves every call site compiling.
 *
 * The failure that follows is not a 500 on one page. `checkTenantToggle` wraps
 * its read in a `catch` that FAILS CLOSED, so a bad column name becomes "AI
 * availability could not be confirmed" on every AI request for every tenant — a
 * total outage whose cause is a string in a file nobody edited. That is worth a
 * test of its own.
 *
 * ═══ THE COMPARISON IS A FUNCTION, SO IT CAN BE DRIVEN TO FAIL ═══
 *
 * `missingColumns` is exported and tested against inputs that DO disagree. An
 * inline comparison here would be green forever once the schema matched, and a
 * neutered comparison would stay green — the exact hole found in the enum check
 * (#3905) before the same extraction fixed it.
 */
import * as fs from 'fs';
import * as path from 'path';

import { AI_TOGGLE_COLUMN } from '@/app-layer/ai/risk-assessment/tenant-toggle-columns';
import { codeOf } from '../helpers/source-blocks';

const SCHEMA = path.join(process.cwd(), 'prisma/schema/auth.prisma');
const MODEL = 'TenantSecuritySettings';

/**
 * Strip `//` and `///` comments before parsing.
 *
 * A commented-out field reads exactly like a live one to a regex, so a column
 * deleted-but-left-commented would pass. The inverse of the same hazard cost a
 * day on #3905, where a regex matched an `@@map` inside a `///` doc comment and
 * invented a type that did not exist. A scar is not a wound.
 */
export function stripLineComments(source: string): string {
    return source
        .split('\n')
        .map((line) => codeOf(line))
        .join('\n');
}

/** Field names declared on one Prisma model. */
export function fieldsOf(schema: string, model: string): string[] {
    const body = new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(
        stripLineComments(schema),
    );
    if (!body) return [];
    return body[1]
        .split('\n')
        .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+\S/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name) && !name!.startsWith('@'));
}

/** Which of `columns` the model does not declare. The pure comparison. */
export function missingColumns(columns: readonly string[], fields: readonly string[]): string[] {
    const declared = new Set(fields);
    return columns.filter((column) => !declared.has(column));
}

describe('AI toggle columns exist on the model they name', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const fields = fieldsOf(schema, MODEL);

    it('parses a plausible number of fields (the parser itself works)', () => {
        // A regex that silently matched nothing would make the real assertion
        // below pass only when `AI_TOGGLE_COLUMN` was empty — which it is not —
        // but the denominator is still the thing that proves the parse happened.
        expect(fields.length).toBeGreaterThan(10);
        expect(fields).toContain('tenantId');
    });

    it('every mapped column is declared on TenantSecuritySettings', () => {
        const columns = Object.values(AI_TOGGLE_COLUMN);
        expect(columns).toHaveLength(4);
        expect(missingColumns(columns, fields)).toEqual([]);
    });

    it('the four columns are Boolean with a default of true', () => {
        // The DEFAULT is half the design: an absent row must read as all-on, and
        // `toggleStatesFrom`'s `?? true` and this default have to agree. If the
        // schema ever said `@default(false)`, a tenant created after the change
        // would have AI off while the code reported it on.
        const body = /^model\s+TenantSecuritySettings\s*\{([\s\S]*?)^\}/m.exec(
            stripLineComments(schema),
        )?.[1];
        expect(body).toBeTruthy();
        for (const column of Object.values(AI_TOGGLE_COLUMN)) {
            const line = body!.split('\n').find((l) => new RegExp(`^\\s*${column}\\s`).test(l));
            expect(line).toBeTruthy();
            expect(line).toMatch(/\bBoolean\b/);
            expect(line).toMatch(/@default\(true\)/);
        }
    });

    it('a migration adds the columns, so the live table has them too', () => {
        // The schema file is what Prisma GENERATES from; the table is what the
        // gate reads. A column added to the schema with no migration typechecks,
        // generates a client, and then fails closed at runtime — the same
        // outage. `prisma migrate resolve` can record a row without running any
        // DDL, so the test looks for the DDL text itself.
        const dir = path.join(process.cwd(), 'prisma/migrations');
        const sql = fs
            .readdirSync(dir)
            .filter((name) => fs.existsSync(path.join(dir, name, 'migration.sql')))
            .map((name) => fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8'))
            .join('\n');
        for (const column of Object.values(AI_TOGGLE_COLUMN)) {
            expect(sql).toContain(`"${column}"`);
        }
    });
});

describe('missingColumns can fail, in both directions', () => {
    it('names a column the model does not declare', () => {
        expect(missingColumns(['aiEnabled', 'nope'], ['aiEnabled'])).toEqual(['nope']);
    });

    it('is empty when every column is declared', () => {
        expect(missingColumns(['aiEnabled'], ['aiEnabled', 'other'])).toEqual([]);
    });

    it('is not fooled by a near-miss name', () => {
        // Substring matching would pass `aiEnable` against `aiEnabled`.
        expect(missingColumns(['aiEnable'], ['aiEnabled'])).toEqual(['aiEnable']);
    });
});

describe('stripLineComments', () => {
    it('removes a commented-out field so it cannot read as declared', () => {
        expect(fieldsOf('model M {\n  // ghost Boolean\n  real Boolean\n}', 'M')).toEqual(['real']);
    });

    it('removes a /// doc comment that mentions a field name', () => {
        expect(fieldsOf('model M {\n  /// ghost Boolean here\n  real Boolean\n}', 'M')).toEqual([
            'real',
        ]);
    });
});
