import js from '@eslint/js';
import globals from 'globals';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

export default [
	{
		ignores: ['**/dist/**', '**/node_modules/**', '.yarn/**', '.omx/**'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	prettierRecommended,
	{
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.node,
				...globals.jest,
			},
		},
		rules: {
			'no-undef': 'off',
			'no-unused-vars': 'off',
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
		},
	},
];
