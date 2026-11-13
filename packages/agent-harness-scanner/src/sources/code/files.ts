/**
 * WHICH FILES THE CODE SOURCE READS, AND HOW FAR (#3737).
 *
 * Every configured root is walked depth-first in sorted order, so two scans of
 * one tree read it identically. Each bound is a stated maximum, and reaching one
 * is reported — never absorbed:
 *
 *   • a file over `MAX_FILE_BYTES` that names a framework (or a model
 *     provider's SDK: `markersFor`), more than `MAX_FILES` candidates, or more
 *     than `MAX_TOTAL_BYTES` read → BYTE_CAP. A file over `MAX_FILE_BYTES` and
 *     up to `MAX_MARKER_SCAN_BYTES` is still read, and only searched for such
 *     a name: a file that names none cannot define an agent (the rule every
 *     smaller file is held to), so a minified bundle somebody vendored does
 *     not leave the tree unread. A file over `MAX_MARKER_SCAN_BYTES` is not
 *     opened → BYTE_CAP;
 *   • the scan's deadline → TIME_BOX;
 *   • a root or entry that is missing or not readable → UNREACHABLE, or
 *     AUTH_FAILED when the operating system refused the read;
 *   • a source file that starts with a UTF-16 byte-order mark is not text this
 *     reader decodes → UNPARSEABLE, never passed over as holding no agent;
 *   • a SYMBOLIC LINK is never followed — it could leave the root or loop — and
 *     is a location not read, so UNREACHABLE. Point a root at its target to
 *     read it.
 *
 * Directories that hold dependencies or build output (`node_modules`, virtual
 * environments, `dist`, …) are not entered: they are other people's code or a
 * copy of this code, not where an estate defines its agents. A root itself is
 * always read, whatever its name.
 *
 * Read-only by construction: the only operations are `lstat`, `readdir` and
 * `readFile`, through `CodeFs`, which the tests replace.
 */
import type { IncompleteReason } from '../../source';
import type { CodeLocation } from './ir';

export interface CodeFs {
    lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size: number }>;
    readdir(path: string): Promise<string[]>;
    readFile(path: string): Promise<Buffer>;
}

export interface CodeRoot {
    /** Reported in every locator in place of the path, which may name a person (`/home/<user>/…`). */
    readonly label: string;
    readonly path: string;
}

export const MAX_FILE_BYTES = 1024 * 1024;
/** The largest file that is read to look for a framework's or a provider SDK's name. It is never parsed. */
export const MAX_MARKER_SCAN_BYTES = 16 * 1024 * 1024;
export const MAX_FILES = 20_000;
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_DIR_DEPTH = 32;

export const SOURCE_EXTENSIONS: readonly string[] = ['.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];
export const SKIPPED_DIRECTORIES: readonly string[] = [
    'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'site-packages', '.tox', '.mypy_cache',
    '.pytest_cache', '.ruff_cache', '.next', 'dist', 'build', 'coverage',
];

/**
 * The text a file must contain to be parsed at all: a framework's module name,
 * which every import of it spells out. `claude-agent-sdk` and
 * `claude_agent_sdk` are the Claude Agent SDK's, in TypeScript and Python
 * (#4156).
 */
export const FRAMEWORK_MARKERS: readonly string[] = ['langchain', 'langgraph', 'claude-agent-sdk', 'claude_agent_sdk'];

/**
 * The same, for agents built directly on a model provider's SDK
 * (`provider-sdk.ts`): text every import of Anthropic's, OpenAI's, Google's
 * Gemini or AWS Bedrock's package contains. `boto3` and `botocore` are here
 * because a Python file may be handed a Bedrock client and never spell
 * `bedrock` itself. Looked for only while that recognition is on.
 */
export const PROVIDER_SDK_MARKERS: readonly string[] = ['anthropic', 'openai', 'genai', 'generativeai', 'generative-ai', 'bedrock', 'boto3', 'botocore'];

/** The text a file must contain to be parsed: a framework's name, and a provider SDK's unless that is turned off. */
export function markersFor(providerSdks: boolean): readonly string[] {
    return providerSdks ? [...FRAMEWORK_MARKERS, ...PROVIDER_SDK_MARKERS] : FRAMEWORK_MARKERS;
}

export interface ReadableFile {
    readonly label: string;
    /** Below the root, `/`-separated. */
    readonly path: string;
    readonly text: string;
}

export interface FileProblem {
    readonly reason: IncompleteReason;
    readonly at: CodeLocation | null;
}

function isSourceFile(name: string): boolean {
    if (/\.d\.[cm]?ts$/i.test(name)) return false;
    return SOURCE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

function reasonOf(err: unknown): IncompleteReason {
    const code = (err as { code?: unknown } | null)?.code;
    return code === 'EACCES' || code === 'EPERM' ? 'AUTH_FAILED' : 'UNREACHABLE';
}

/** A UTF-16 (or UTF-32 little-endian) byte-order mark: `FF FE` or `FE FF`. */
function startsWithWideByteOrderMark(buf: Buffer): boolean {
    return buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
}

const join = (a: string, b: string) => (a.endsWith('/') ? `${a}${b}` : `${a}/${b}`);

/**
 * Walk the roots, yielding each source file that names a framework or a
 * provider's SDK (`opts.markers`; every one, unless the caller narrows it),
 * and recording why anything was not read. `onFile` is called once per file
 * read; `rows` counts every source file examined.
 */
export async function readCodeFiles(
    roots: readonly CodeRoot[],
    fs: CodeFs,
    opts: { readonly deadline: number; readonly now: () => number; readonly markers?: readonly string[] },
    onFile: (file: ReadableFile) => void,
): Promise<{ rows: number; problems: FileProblem[] }> {
    const markers = opts.markers ?? markersFor(true);
    const problems: FileProblem[] = [];
    let rows = 0;
    let bytes = 0;
    let stopped = false;
    const problem = (reason: IncompleteReason, at: CodeLocation | null) => problems.push({ reason, at });

    const walk = async (root: CodeRoot, abs: string, rel: string, depth: number): Promise<void> => {
        if (stopped) return;
        if (opts.now() > opts.deadline) {
            problem('TIME_BOX', null);
            stopped = true;
            return;
        }
        if (depth > MAX_DIR_DEPTH) {
            problem('BYTE_CAP', { label: root.label, path: rel, line: 0 });
            return;
        }
        let entries: string[];
        try {
            entries = [...(await fs.readdir(abs))].sort();
        } catch (err) {
            problem(reasonOf(err), { label: root.label, path: rel, line: 0 });
            return;
        }
        for (const name of entries) {
            if (stopped) return;
            if (opts.now() > opts.deadline) {
                problem('TIME_BOX', null);
                stopped = true;
                return;
            }
            const childAbs = join(abs, name);
            const childRel = rel === '' ? name : `${rel}/${name}`;
            const at: CodeLocation = { label: root.label, path: childRel, line: 0 };
            let st: Awaited<ReturnType<CodeFs['lstat']>>;
            try {
                st = await fs.lstat(childAbs);
            } catch (err) {
                problem(reasonOf(err), at);
                continue;
            }
            if (st.isSymbolicLink()) {
                problem('UNREACHABLE', at);
                continue;
            }
            if (st.isDirectory()) {
                if (SKIPPED_DIRECTORIES.includes(name)) continue;
                await walk(root, childAbs, childRel, depth + 1);
                continue;
            }
            if (!st.isFile() || !isSourceFile(name)) continue;
            rows += 1;
            if (rows > MAX_FILES) {
                problem('BYTE_CAP', at);
                stopped = true;
                return;
            }
            if (st.size > MAX_MARKER_SCAN_BYTES) {
                problem('BYTE_CAP', at);
                continue;
            }
            if (bytes + st.size > MAX_TOTAL_BYTES) {
                problem('BYTE_CAP', at);
                stopped = true;
                return;
            }
            let buf: Buffer;
            try {
                buf = await fs.readFile(childAbs);
            } catch (err) {
                problem(reasonOf(err), at);
                continue;
            }
            // It grew after it was measured: more than is ever read of one file.
            if (buf.length > MAX_MARKER_SCAN_BYTES) {
                problem('BYTE_CAP', at);
                continue;
            }
            bytes += buf.length;
            if (bytes > MAX_TOTAL_BYTES) {
                problem('BYTE_CAP', at);
                stopped = true;
                return;
            }
            // Too large to parse. Searched as bytes, so the answer does not depend on how it decodes:
            // a name spelt in UTF-16 is not found by this search or by the one below.
            if (buf.length > MAX_FILE_BYTES) {
                if (startsWithWideByteOrderMark(buf)) problem('UNPARSEABLE', at);
                else if (markers.some((m) => buf.includes(m))) problem('BYTE_CAP', at);
                continue;
            }
            // A UTF-16 or UTF-32 file decodes as UTF-8 into text that names no
            // framework, so it would be passed over as if it held no agent.
            // TypeScript's own compiler reads such a file; this reader does
            // not, and says so rather than report a tree it read less of.
            if (startsWithWideByteOrderMark(buf)) {
                problem('UNPARSEABLE', at);
                continue;
            }
            const text = buf.toString('utf8');
            // Only a file that names a framework's module can define one of its agents.
            if (markers.some((m) => text.includes(m))) onFile({ label: root.label, path: childRel, text });
        }
    };

    for (const root of roots) {
        if (stopped) break;
        let st: Awaited<ReturnType<CodeFs['lstat']>>;
        try {
            st = await fs.lstat(root.path);
        } catch (err) {
            problem(reasonOf(err), { label: root.label, path: '', line: 0 });
            continue;
        }
        if (!st.isDirectory()) {
            problem('UNREACHABLE', { label: root.label, path: '', line: 0 });
            continue;
        }
        await walk(root, root.path, '', 0);
    }
    return { rows, problems };
}
