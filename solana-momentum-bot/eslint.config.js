const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Why: logger 경유 강제, reporter.ts는 eslint-disable로 예외 처리
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Why: ARCHITECTURE.md 의존성 방향 규칙 기계적 강제
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['../orchestration/*', '../../orchestration/*', '../orchestration'],
            message: 'orchestration/은 최상위 조율 레이어입니다. 하위 모듈에서 import 금지.'
          },
          {
            group: ['../executor/*', '../../executor/*', '../executor'],
            message: 'executor/는 orchestration/을 통해서만 호출하세요. (strategy, gate, event에서 금지)'
          }
        ]
      }],
    },
  },
  // Why: orchestration/은 모든 모듈을 참조할 수 있으므로 executor import 허용
  {
    files: ['src/orchestration/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  // Why: backtest는 런타임과 격리된 모듈이므로 모든 import 허용
  {
    files: ['src/backtest/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  // Why: index.ts (진입점)은 orchestration 역할이므로 모든 import 허용
  {
    files: ['src/index.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/'],
  },
];
