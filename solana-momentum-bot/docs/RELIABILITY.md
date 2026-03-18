# Reliability — 안정성 규칙

## 헬스체크

- `src/utils/healthMonitor.ts`의 `HealthMonitor.getStatus()` 사용
- 상태: uptime, lastCandleAt, lastTradeAt, dbConnected, wsConnected, openPositions, dailyPnl
- 향후 HTTP endpoint (`GET /health`) 노출 예정 (P2)

## 로깅

- Winston 기반 구조화된 JSON 로깅
- 포맷: `{ timestamp, level, message, module, context }`
- `createModuleLogger(moduleName)` 팩토리 사용
- 로그 레벨: `LOG_LEVEL` 환경변수 (default: info)

## 에러 핸들링

- 개별 try-catch 남발 금지
- 모듈별 에러는 상위(orchestration)로 전파
- orchestration에서 일괄 처리: 로깅 + Notifier(Critical) + 필요 시 tradingHalt

## 크래시 복구

- `src/state/recovery.ts` — 재시작 시 열린 포지션 복구
- `PositionStore`에서 OPEN 상태 트레이드 조회 → 모니터링 재등록
- pm2 자동 재시작 (ecosystem.config.cjs, max_memory_restart: 512M)

## Graceful Shutdown

- SIGINT/SIGTERM 핸들러 등록 (src/index.ts)
- 열린 WebSocket 연결 종료
- 진행 중인 트레이드 상태 저장
- DB 풀 종료
- pm2 graceful_shutdown_timeout: 30초
