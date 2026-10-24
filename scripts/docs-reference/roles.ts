/**
 * Who holds which permission — computed by calling the app's own
 * `getPermissionsForRole` for every value of the `Role` enum, so the table can
 * only say what the code does. A role added to the enum appears here on the
 * next build; a key added to `PERMISSION_SCHEMA` becomes a row.
 */
export interface RoleMatrixRow {
    area: string;
    action: string;
    /** One entry per role, in `roles` order. */
    held: boolean[];
}

export interface RoleMatrix {
    roles: string[];
    rows: RoleMatrixRow[];
}

/** The values of `enum <name> { … }` in a Prisma schema file, in declaration order. */
export function enumValues(prismaText: string, name: string): string[] {
    const m = new RegExp(`^enum ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(prismaText);
    if (!m) return [];
    return m[1]
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
}

type PermissionSetLike = Record<string, Record<string, boolean>>;

export function roleMatrix(
    roles: readonly string[],
    schema: Record<string, readonly string[]>,
    permissionsFor: (role: string) => PermissionSetLike,
): RoleMatrix {
    const sets = roles.map((r) => permissionsFor(r));
    const rows: RoleMatrixRow[] = [];
    for (const [area, actions] of Object.entries(schema)) {
        for (const action of actions) {
            rows.push({ area, action, held: sets.map((s) => s[area]?.[action] === true) });
        }
    }
    return { roles: [...roles], rows };
}

/** A flat boolean permission set per role (the organisation layer). */
export function flatMatrix(
    roles: readonly string[],
    permissionsFor: (role: string) => Record<string, boolean>,
): { roles: string[]; rows: { key: string; held: boolean[] }[] } {
    const sets = roles.map((r) => permissionsFor(r));
    const keys = Object.keys(sets[0] ?? {});
    return { roles: [...roles], rows: keys.map((key) => ({ key, held: sets.map((s) => s[key] === true) })) };
}
