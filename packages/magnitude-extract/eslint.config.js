import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import plugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default defineConfig({
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, plugin.configs['flat/recommended']],
    languageOptions: {
        globals: { ...globals.node, ...globals.browser },
    },
    rules: {
        '@typescript-eslint/no-explicit-any': 'off',
    },
});
