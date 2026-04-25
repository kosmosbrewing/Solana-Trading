module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Phase H1.3 (2026-04-25) — 최소 setup. logger quiet + unhandled rejection 강화.
  // 자세한 정책은 test/__helpers__/setup.ts 주석 참고.
  setupFiles: ['<rootDir>/test/__helpers__/setup.ts'],
  // Helper 디렉토리는 테스트 root 가 아님 (.ts 만 있어도 jest 가 test 로 오해 안 함)
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/__helpers__/'],
};
