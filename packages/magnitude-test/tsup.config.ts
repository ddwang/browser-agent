import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        cli: 'src/cli.ts',
        'worker/readConfig': 'src/worker/readConfig.ts',
        'worker/readTest': 'src/worker/readTest.ts',
    },
    format: ['cjs', 'esm'],
    dts: { entry: ['src/index.ts'] },
    splitting: false,
    noExternal: ['ink-spinner'],
    external: ['ink', 'react'],
    shims: true,
    sourcemap: true,
    clean: true,
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
});
