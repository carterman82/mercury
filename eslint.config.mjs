import tseslint from 'typescript-eslint';

// Gate the new Project runtime without imposing unrelated legacy style changes.
export default tseslint.config({
  files: ['src/main/project-*.ts', 'src/renderer/ProjectMaps.tsx', 'src/renderer/project-maps.test.ts'],
  extends: [...tseslint.configs.recommended],
  rules: {
    // JSON/provider/SDK boundaries are runtime-validated; adopting stricter
    // domain types is independent of this syntax/correctness gate.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
  },
});
