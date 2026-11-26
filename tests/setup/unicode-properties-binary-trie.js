/**
 * CommonJS stand-in for `unicode-properties`' `#binary-trie` import (its
 * `node` condition, `binaryTrie.node.js`).
 *
 * pdfkit 0.21 → fontkit 3 → unicode-properties 2, which is ESM-only and reads
 * its data file with `new URL('./data.trie', import.meta.url)`. The node Jest
 * project runs CommonJS, and `import.meta` has no CommonJS form, so the file
 * cannot be transformed into something Jest can load. This returns the same
 * bytes from the same file, located through the package instead of
 * `import.meta.url`. Mapped in jest.config.js (`^#binary-trie$`); production
 * never sees it, because Node 24 loads the real module natively.
 */
const { readFileSync } = require('node:fs');
const path = require('node:path');

const packageDir = path.dirname(require.resolve('unicode-properties'));

exports.getBinaryTrie = function getBinaryTrie() {
    return readFileSync(path.join(packageDir, 'data.trie'));
};
