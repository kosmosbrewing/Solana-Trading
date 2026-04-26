// Backward-compat shim. 실제 config 정의는 src/config/* 도메인 파일에 분할 보관됨.
// 새 env 추가 시 src/config 안의 적절한 section 파일을 직접 수정한다 (helpers + index 만 손대면 됨).
// Why: 200+ import 사이트가 `from '../utils/config'` 를 사용 중 → 호출부 변경 0건 유지.

export { config, type TradingMode } from '../config';
