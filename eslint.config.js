import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'src/generated/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Milestone 4: money math (sizing, fees, P/L) must use Decimal, never JS numbers.
    files: ['src/risk/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator=/^[*\\/%]$/]",
          message: 'Gunakan Decimal (times/div/mod) untuk perhitungan uang di src/risk.',
        },
      ],
    },
  },
);
