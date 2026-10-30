/**
 * DIAGNOSTIC ONLY (#4613) — never merged. At the end of the run, force ten full
 * collections one after another, yielding to the event loop between them so weak
 * callbacks and finalizers can run, and print heapUsed after each. Answers: is the
 * heap that survives ONE gc() garbage that needs several collections, or live?
 */
const v8 = require('v8');

const MB = 1024 * 1024;
const ctx = () => {
    const h = v8.getHeapStatistics();
    return `native_contexts=${h.number_of_native_contexts} detached_contexts=${h.number_of_detached_contexts}`;
};

class HeapMultiGcReporter {
    constructor() {
        this.i = 0;
    }

    // Every 25 files, WITHOUT forcing a collection: how many contexts are alive.
    onTestResult(test, result) {
        if (this.i % 25 === 0) {
            const rel = String(result.testFilePath || test.path).replace(`${process.cwd()}/`, '');
            process.stderr.write(
                `heap-multigc file ${this.i} ${Math.round(process.uptime())}s ${rel}` +
                    ` heapUsed=${Math.round(process.memoryUsage().heapUsed / MB)} ${ctx()}\n`,
            );
        }
        this.i += 1;
    }

    async onRunComplete() {
        if (typeof globalThis.gc !== 'function') {
            process.stderr.write('heap-multigc: no gc exposed\n');
            return;
        }
        const out = [`heap-multigc start heapUsed=${Math.round(process.memoryUsage().heapUsed / MB)} ${ctx()}`];
        for (let i = 1; i <= 10; i += 1) {
            const t0 = Date.now();
            globalThis.gc();
            const sync = process.memoryUsage().heapUsed;
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setTimeout(r, 50));
            const after = process.memoryUsage();
            out.push(
                `heap-multigc gc#${i} heapUsed=${Math.round(sync / MB)}` +
                    ` after-yield=${Math.round(after.heapUsed / MB)} rss=${Math.round(after.rss / MB)}` +
                    ` ms=${Date.now() - t0} ${ctx()}`,
            );
        }
        process.stderr.write(`${out.join('\n')}\n`);
    }
}

module.exports = HeapMultiGcReporter;
