// Backward-compat shim. 실제 구현은 src/orchestration/pureWs/* 도메인 파일에 분할 보관됨.
// 새 함수/state 추가 시 src/orchestration/pureWs/ 안의 적절한 파일을 직접 수정한다.
// Why: src/index.ts + 4 개의 test 가 본 path 를 import 중 → 호출부 변경 0건 유지.

export * from './pureWs';
