import { mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { verifyBrowserDependencies } from './verify-browser-dependencies.mjs';

const directory = process.cwd();
verifyBrowserDependencies(directory);
const require = createRequire(join(directory, 'package.json'));
const modules = join(directory, 'node_modules');
mkdirSync(modules, { recursive: true });
// npm pack only includes locally installed bundled dependencies; Bun hoists them.
for (const name of require('./package.json').bundledDependencies) {
    const target = dirname(require.resolve(`${name}/package.json`));
    const local = join(modules, name);
    if (!existsSync(local)) symlinkSync(target, local, 'junction');
}
