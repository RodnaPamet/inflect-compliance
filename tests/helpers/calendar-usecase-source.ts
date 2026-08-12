/**
 * The calendar usecase's source, as one string.
 *
 * `compliance-calendar.ts` became `compliance-calendar/` (index + shared +
 * loaders/*). Four guards read it by path to assert things about its content —
 * hrefs, tenant predicates, deadline projections. Rather than have each
 * re-derive the new layout (and silently read only part of it when a fifth file
 * appears), they all come through here.
 *
 * Concatenation is safe for these guards because every one of them asks
 * "does this text appear / does this loader carry this predicate", never
 * "how many times in total" — and the block splitter below bounds each loader
 * by the next declaration, so a loader's assertions cannot bleed into its
 * neighbour's even across a file boundary.
 */
import * as fs from 'fs';
import * as path from 'path';

const DIR = path.join(
    process.cwd(),
    'src/app-layer/usecases/compliance-calendar',
);

/** Every .ts file in the usecase directory, deepest last, concatenated. */
export function readCalendarUsecase(): string {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.ts')) files.push(full);
        }
    };
    walk(DIR);
    if (files.length === 0) {
        throw new Error(`no calendar usecase sources found under ${DIR}`);
    }
    return files.sort().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

export interface LoaderBlock {
    name: string;
    body: string;
}

/**
 * Split the concatenated source into `load*Events` blocks.
 *
 * Bounded by the NEXT declaration, never by a byte offset and never by slicing
 * between two declaration NAMES — a reorder there yields a backwards slice,
 * which is silently empty and makes every `not.toMatch` inside it pass while
 * checking nothing.
 */
export function calendarLoaderBlocks(src = readCalendarUsecase()): LoaderBlock[] {
    // `export ` is optional: loaders are exported now that they live in their
    // own modules, and were not before the split.
    const re = /^(?:export )?async function (load\w+)\(/gm;
    const starts: Array<{ name: string; index: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) starts.push({ name: m[1], index: m.index });
    return starts.map((s, i) => ({
        name: s.name,
        body: src.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : src.length),
    }));
}
