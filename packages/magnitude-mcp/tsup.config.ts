import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    splitting: false,
    shims: true,
    clean: true,
    outExtension: ({ format }) => ({
        js: format === 'esm' ? '.mjs' : '.cjs',
    }),
});
