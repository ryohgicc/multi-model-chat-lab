import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.{ts,tsx}'], languageOptions: { globals: globals.browser } },
  { files: ['server/**/*.js', 'cloud/**/*.js', 'scripts/**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.serviceworker } } },
)
