# Security Rules — 타협 불가

## 지갑 키 보호

- `WALLET_PRIVATE_KEY`는 `.env`에서만 관리. 코드/로그/커밋에 절대 노출 금지.
- `SANDBOX_WALLET_KEY` 동일 적용.
- `.gitignore`에 `.env`, `*.key` 포함 필수.
- 로그 출력 시 키/서명 값은 truncate 처리.

## API 키 보호

- `BIRDEYE_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN` — 모두 .env
- Rate limit 준수: Birdeye (30/min), Jupiter (600/min)
- API 키 에러 시 로그에 키 값 출력 금지

## RPC 보안

- `SOLANA_RPC_URL`은 Helius 전용 엔드포인트 (API key 포함)
- RPC URL을 로그에 출력하지 않음
- 타임아웃/재시도 설정으로 RPC 장애 대응

## 환경변수 중앙화

- 모든 민감 값은 `src/utils/config.ts`에서 파싱
- `process.env` 직접 접근 금지 (config.ts, logger.ts 제외)
- config.ts에서 누락된 필수 변수는 시작 시 즉시 실패

## 온체인 보안

- SecurityGate: honeypot, freeze authority, 전송 수수료 체크
- Exit liquidity 검증 (Birdeye API)
- Token holder 집중도 검증 (top 10 holders > 50% → 거부)

## CI 보안

- `npm audit` 주기적 실행
- 의존성 업데이트 시 lock file diff 확인
- `.env.example`에는 값 없이 키 이름만 기록
