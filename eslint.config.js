import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['src/**/*.ts', 'examples/**/*.ts'],
    rules: {
      // Complexity budgets. These are the gate, not a suggestion: a function
      // past them is a function nobody will safely change later.
      complexity: ['error', 10],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-nested-callbacks': ['error', 3],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-nested-callbacks': 'off',
    },
  },
  { ignores: ['node_modules/**', 'dist/**'] },
);
