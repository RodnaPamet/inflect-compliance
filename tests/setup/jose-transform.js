/**
 * The Jest transformer for `jose`: TypeScript's `transpileModule`, ES module
 * to CommonJS, at an ES2022 target.
 *
 * jose's build is minified, so each error class's constructor is one comma
 * expression, `super(message, options), this.name = …`. At the repo's ES2017
 * target TypeScript lowers class fields into the constructor and, finding no
 * `super()` STATEMENT to put them after, puts them first, so constructing any
 * jose error throws "Must call super constructor in derived class". Every
 * refusal then arrives as a ReferenceError instead of the error that names
 * it, and the key set's re-fetch on an unknown key, which catches
 * `JWKSNoMatchingKey` by class, cannot run. ES2022 keeps class fields native,
 * as Node and Next run them.
 *
 * Not ts-jest with a `tsconfig` option: ts-jest caches one configuration per
 * Jest project, so a second ts-jest entry in the same project transforms with
 * the first entry's target whatever options it is given.
 */
const crypto = require('node:crypto');
const ts = require('typescript');

const COMPILER_OPTIONS = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    allowJs: true,
    sourceMap: true,
    inlineSources: true,
};

module.exports = {
    process(source, filename) {
        const { outputText, sourceMapText } = ts.transpileModule(source, {
            fileName: filename,
            compilerOptions: COMPILER_OPTIONS,
        });
        return { code: outputText, map: sourceMapText };
    },
    getCacheKey(source, filename) {
        return crypto
            .createHash('sha256')
            .update(`jose-transform:es2022-cjs:${ts.version}\0${filename}\0`)
            .update(source)
            .digest('hex');
    },
};
