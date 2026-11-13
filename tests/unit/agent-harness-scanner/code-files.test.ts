/**
 * Which files the `code` source reads when a file is too large to parse — over
 * an in-memory file system, so every bound is reached without a disk.
 *
 *   • A file over `MAX_FILE_BYTES` and up to `MAX_MARKER_SCAN_BYTES` is read
 *     only to look for a framework's or a provider SDK's name, and is never
 *     handed to a reader. No such name: nothing is reported. A name: BYTE_CAP.
 *   • A wide byte-order mark is not text this reader decodes: UNPARSEABLE, at
 *     any size.
 *   • A file over `MAX_MARKER_SCAN_BYTES` is not opened: BYTE_CAP.
 *   • What is read to be searched counts towards the total that may be read.
 */
import {
    markersFor,
    MAX_FILE_BYTES,
    MAX_MARKER_SCAN_BYTES,
    MAX_TOTAL_BYTES,
    readCodeFiles,
    type CodeFs,
    type CodeRoot,
    type ReadableFile,
} from '../../../packages/agent-harness-scanner/src/sources/code/files';

type Node =
    | { readonly t: 'dir'; readonly entries: Record<string, Node> }
    | { readonly t: 'file'; readonly data: Buffer; readonly statedSize?: number };

const dir = (entries: Record<string, Node>): Node => ({ t: 'dir', entries });
const file = (text: string | Buffer, extra: { statedSize?: number } = {}): Node => ({
    t: 'file',
    data: typeof text === 'string' ? Buffer.from(text) : text,
    ...extra,
});
const AGENT = 'from langchain.agents import AgentExecutor\n';
const failure = (code: string) => Object.assign(new Error(code), { code });

/** A `CodeFs` over a tree, recording every operation it was asked for. */
function fakeFs(tree: Record<string, Node>) {
    const ops: string[] = [];
    const find = (path: string): Node | undefined => {
        let node: Node | undefined = dir(tree);
        for (const part of path.split('/').filter((p) => p !== '')) {
            if (node?.t !== 'dir') return undefined;
            node = node.entries[part];
        }
        return node;
    };
    const fs: CodeFs = {
        async lstat(path) {
            ops.push(`lstat ${path}`);
            const node = find(path);
            if (node === undefined) throw failure('ENOENT');
            return {
                isDirectory: () => node.t === 'dir',
                isFile: () => node.t === 'file',
                isSymbolicLink: () => false,
                size: node.t === 'file' ? (node.statedSize ?? node.data.length) : 0,
            };
        },
        async readdir(path) {
            ops.push(`readdir ${path}`);
            const node = find(path);
            if (node?.t !== 'dir') throw failure('ENOTDIR');
            // Deliberately unsorted: the walk must not depend on the order it is given.
            return Object.keys(node.entries).reverse();
        },
        async readFile(path) {
            ops.push(`readFile ${path}`);
            const node = find(path);
            if (node?.t !== 'file') throw failure('EISDIR');
            return node.data;
        },
    };
    return { fs, ops };
}

const ROOT: CodeRoot = { label: 'acme', path: '/src' };
const NEVER = { deadline: Number.MAX_SAFE_INTEGER, now: () => 0 };

async function walk(tree: Record<string, Node>, markers?: readonly string[]) {
    const { fs, ops } = fakeFs(tree);
    const files: ReadableFile[] = [];
    const result = await readCodeFiles([ROOT], fs, markers ? { ...NEVER, markers } : NEVER, (f) => files.push(f));
    return { ...result, ops, paths: files.map((f) => f.path) };
}
const at = (path: string) => ({ label: 'acme', path, line: 0 });
const padding = () => Buffer.alloc(MAX_FILE_BYTES + 1, 0x20);

describe('a file too large to parse', () => {
    it('over the most that is ever read of one file: not opened, BYTE_CAP, and the walk carries on', async () => {
        const { paths, rows, problems, ops } = await walk({
            src: dir({
                'big.py': file(AGENT, { statedSize: MAX_MARKER_SCAN_BYTES + 1 }),
                'exact.py': file(AGENT, { statedSize: MAX_FILE_BYTES }),
                'small.py': file(AGENT),
            }),
        });
        expect(paths).toEqual(['exact.py', 'small.py']);
        expect(rows).toBe(3);
        expect(problems).toEqual([{ reason: 'BYTE_CAP', at: at('big.py') }]);
        expect(ops).not.toContain('readFile /src/big.py');
    });

    it('is searched for a framework name: without one nothing is reported, with one it is BYTE_CAP, and neither is parsed', async () => {
        const { paths, rows, problems, ops } = await walk({
            src: dir({
                // A vendored bundle: a megabyte and more of somebody else's code that names no framework.
                'bundle.js': file(Buffer.concat([Buffer.from('var a = 1;\n'), padding()])),
                // The same size, and it names one: an agent may be in it, and it is not parsed.
                'generated.py': file(Buffer.concat([padding(), Buffer.from(AGENT)])),
                'small.py': file(AGENT),
            }),
        });
        expect(ops).toContain('readFile /src/bundle.js');
        expect(ops).toContain('readFile /src/generated.py');
        expect(paths).toEqual(['small.py']);
        expect(rows).toBe(3);
        expect(problems).toEqual([{ reason: 'BYTE_CAP', at: at('generated.py') }]);
    });

    it('that names a provider\'s SDK is reported, and only while that is looked for', async () => {
        const tree = { src: dir({ 'generated.py': file(Buffer.concat([padding(), Buffer.from('import anthropic\n')])) }) };
        expect((await walk(tree)).problems).toEqual([{ reason: 'BYTE_CAP', at: at('generated.py') }]);
        expect(await walk(tree, markersFor(false))).toMatchObject({ rows: 1, problems: [], paths: [] });
    });

    it('exactly at the larger limit is still searched', async () => {
        const most = Buffer.concat([Buffer.from(AGENT), Buffer.alloc(MAX_MARKER_SCAN_BYTES - AGENT.length, 0x20)]);
        const { problems, ops } = await walk({ src: dir({ 'most.py': file(most) }) });
        expect(ops).toContain('readFile /src/most.py');
        expect(problems).toEqual([{ reason: 'BYTE_CAP', at: at('most.py') }]);
    });

    it('with a wide byte-order mark is not searched as if it were text: UNPARSEABLE', async () => {
        const wide = Buffer.concat([Buffer.from([0xff, 0xfe]), padding()]);
        const { paths, problems } = await walk({ src: dir({ 'wide.py': file(wide), 'small.py': file(AGENT) }) });
        expect(paths).toEqual(['small.py']);
        expect(problems).toEqual([{ reason: 'UNPARSEABLE', at: at('wide.py') }]);
    });

    it('counts towards the total that may be read', async () => {
        const each = Buffer.alloc(MAX_MARKER_SCAN_BYTES, 0x20);
        const names = Array.from({ length: Math.floor(MAX_TOTAL_BYTES / MAX_MARKER_SCAN_BYTES) + 1 }, (_, i) => `f${String(i).padStart(2, '0')}.js`);
        const { problems, ops } = await walk({ src: dir(Object.fromEntries(names.map((n) => [n, file(each)]))) });
        const last = names[names.length - 1];
        expect(problems).toEqual([{ reason: 'BYTE_CAP', at: at(last) }]);
        expect(ops).not.toContain(`readFile /src/${last}`);
    });

    it('that grew between the stat and the read still counts: the walk stops where the total was passed', async () => {
        const each = Buffer.alloc(MAX_MARKER_SCAN_BYTES, 0x20);
        const entries: Record<string, Node> = {};
        for (let i = 0; i < MAX_TOTAL_BYTES / MAX_MARKER_SCAN_BYTES - 1; i += 1) entries[`f${i}.js`] = file(each);
        entries['g-small.py'] = file(AGENT);
        // Measured at ten bytes, so it is opened; what arrives takes the read past the total.
        entries['h-grew.js'] = file(each, { statedSize: 10 });
        entries['i-never.py'] = file(AGENT);
        const { paths, problems, ops } = await walk({ src: dir(entries) });
        expect(paths).toEqual(['g-small.py']);
        expect(problems).toEqual([{ reason: 'BYTE_CAP', at: at('h-grew.js') }]);
        expect(ops).not.toContain('lstat /src/i-never.py');
    });

    it('because it grew between the stat and the read is not parsed either', async () => {
        const grown = Buffer.concat([Buffer.from(AGENT), Buffer.alloc(MAX_FILE_BYTES, 0x20)]);
        const past = Buffer.alloc(MAX_MARKER_SCAN_BYTES + 1, 0x20);
        const { paths, problems } = await walk({
            src: dir({ 'grew.py': file(grown, { statedSize: 10 }), 'huge.js': file(past, { statedSize: 10 }), 'next.py': file(AGENT) }),
        });
        expect(paths).toEqual(['next.py']);
        // `huge.js` names no framework: it is reported because more arrived than is ever read of one file.
        expect(problems).toEqual([
            { reason: 'BYTE_CAP', at: at('grew.py') },
            { reason: 'BYTE_CAP', at: at('huge.js') },
        ]);
    });
});

describe('a file that is not UTF-8 text', () => {
    it.each([
        ['little-endian', (b: Buffer) => b, [0xff, 0xfe]],
        ['big-endian', (b: Buffer) => b.swap16(), [0xfe, 0xff]],
    ])('UTF-16 %s with a byte-order mark is UNPARSEABLE, never passed over as holding no agent', async (_name, order, mark) => {
        const wide = Buffer.concat([Buffer.from(mark), order(Buffer.from(AGENT, 'utf16le'))]);
        const { paths, rows, problems } = await walk({ src: dir({ 'wide.py': file(wide), 'small.py': file(AGENT) }) });
        expect(paths).toEqual(['small.py']);
        expect(rows).toBe(2);
        expect(problems).toEqual([{ reason: 'UNPARSEABLE', at: at('wide.py') }]);
    });

    it('a UTF-8 byte-order mark is ordinary text', async () => {
        const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(AGENT)]);
        const { paths, problems } = await walk({ src: dir({ 'marked.py': file(marked) }) });
        expect(paths).toEqual(['marked.py']);
        expect(problems).toEqual([]);
    });
});
