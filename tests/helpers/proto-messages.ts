/**
 * READ MESSAGE FIELDS AND ENUM VALUES OUT OF A `.proto` FILE (#3866).
 *
 * The A2A v1.0 line ships no committed JSON Schema — `a2a.json` is a
 * non-normative build artifact, deliberately absent from source control — so
 * the canonical definition is `specification/a2a.proto`. This reads it, so a
 * v1.0 card is checked against upstream BYTES rather than against a
 * transcription of them.
 *
 * ## Deliberately a reader, not a parser
 *
 * It understands exactly the constructs the A2A proto uses for the messages we
 * care about, and `PROTO_CONSTRUCTS` publishes that list. The failure mode of a
 * small reader is BLINDNESS — a field shape it does not recognise is silently
 * absent from its output, and an absent field passes every "is it required"
 * check. So the companion test re-derives the constructs the file actually uses
 * and asserts they are a subset, exactly as the v0.3 JSON Schema validator does
 * with its keyword vocabulary.
 *
 * What it does NOT do: imports, services, options beyond field_behavior, oneofs,
 * reserved ranges, or any semantic validation. Those are not needed to answer
 * "which fields does AgentCard require", and pretending otherwise would be a
 * parser nobody asked for.
 */

/** Field-shape constructs this reader understands. */
export const PROTO_CONSTRUCTS = ['scalar', 'message', 'repeated', 'optional', 'map', 'enum'] as const;

export interface ProtoField {
    /** As written in the proto: snake_case. */
    readonly name: string;
    /** The declared type, e.g. `string`, `AgentInterface`, `map<string, SecurityScheme>`. */
    readonly type: string;
    readonly repeated: boolean;
    readonly optional: boolean;
    /** Carries `(google.api.field_behavior) = REQUIRED`. */
    readonly required: boolean;
}

/** `lowerCamelCase`, which is how protobuf JSON renders a snake_case field. */
export function jsonName(protoFieldName: string): string {
    return protoFieldName.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * One field declaration. POSITIONAL groups, not named ones: this tsconfig
 * targets below ES2018, so `(?<name>…)` is a typecheck error even though jest
 * runs it happily — the second time that gap has bitten in this work, after a
 * `/s` flag in #3863.
 *
 *   1 modifiers (`repeated` / `optional`)   2 type   3 name   4 options
 */
const FIELD = /^(?:(repeated|optional)\s+)?(map<[^>]+>|[A-Za-z_][\w.]*)\s+([a-z_][\w]*)\s*=\s*\d+\s*(\[[^\]]*\])?\s*;/;

/**
 * Every top-level message, mapped to its fields.
 *
 * Nested messages are returned under their own bare name as well, because the
 * A2A proto nests a few and a caller asking for `AgentCardSignature` should not
 * have to know whether it was declared inside something.
 */
export function protoMessages(src: string): Map<string, readonly ProtoField[]> {
    const out = new Map<string, readonly ProtoField[]>();
    const lines = src.split('\n');
    // A stack of open message names, so a nested message's fields are not
    // attributed to its parent — which is the bug a line-based reader makes.
    const stack: Array<{ name: string; fields: ProtoField[] }> = [];
    let depth = 0;

    for (const raw of lines) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        if (!line) continue;

        const opened = /^message\s+([A-Za-z_]\w*)\s*\{/.exec(line);
        if (opened) {
            stack.push({ name: opened[1], fields: [] });
            depth += 1;
            continue;
        }
        if (line.startsWith('enum ') && line.includes('{')) {
            // Entered an enum: its members are not fields. Tracked by depth so
            // the closing brace does not pop a message.
            depth += 1;
            stack.push({ name: `__enum__${line}`, fields: [] });
            continue;
        }
        if (line === '}' || line.startsWith('}')) {
            const done = stack.pop();
            depth = Math.max(0, depth - 1);
            if (done && !done.name.startsWith('__enum__')) out.set(done.name, done.fields);
            continue;
        }
        const top = stack[stack.length - 1];
        if (!top || top.name.startsWith('__enum__')) continue;

        const m = FIELD.exec(line);
        if (!m) continue;
        const mods = m[1] ?? '';
        top.fields.push({
            name: m[3],
            type: m[2],
            repeated: mods.includes('repeated'),
            optional: mods.includes('optional'),
            required: (m[4] ?? '').includes('REQUIRED'),
        });
    }
    return out;
}

/** The members of a named enum, in declaration order. */
export function protoEnumValues(src: string, enumName: string): readonly string[] {
    const start = new RegExp(`^enum\\s+${enumName}\\s*\\{`, 'm').exec(src);
    if (!start) return [];
    const rest = src.slice(start.index + start[0].length);
    const body = rest.slice(0, rest.indexOf('\n}'));
    return body
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .flatMap((l) => {
            const m = /^([A-Z][A-Z0-9_]*)\s*=\s*\d+\s*;/.exec(l);
            return m ? [m[1]] : [];
        });
}

/**
 * Which of `PROTO_CONSTRUCTS` a message's fields actually use.
 *
 * The anti-blindness probe: a construct appearing in the file but not here
 * means the reader skipped a line, and a skipped field is one no assertion can
 * miss because it is simply not in the output.
 */
export function constructsUsed(fields: readonly ProtoField[]): Set<string> {
    const used = new Set<string>();
    for (const f of fields) {
        if (f.repeated) used.add('repeated');
        if (f.optional) used.add('optional');
        if (f.type.startsWith('map<')) used.add('map');
        else if (/^[a-z]/.test(f.type)) used.add('scalar');
        else used.add('message');
    }
    return used;
}
