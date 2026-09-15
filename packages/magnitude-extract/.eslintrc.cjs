module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: ['dist/'],
  rules: {
    // The existing extractor intentionally uses dynamic Cheerio values at its
    // DOM boundary. Tightening those types is a separate source refactor.
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
