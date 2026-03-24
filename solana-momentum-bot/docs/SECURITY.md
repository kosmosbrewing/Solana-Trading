# Security Rules — 타협 불가

## 지갑 키 보호

- `WALLET_PRIVATE_KEY`는 `.env`에서만 관리. 코드/로그/커밋에 절대 노출 금지.
- `SANDBOX_WALLET_PRIVATE_KEY`도 동일 적용.
- 현재 레포는 `.gitignore`에 `.env`를 포함한다. 별도 키 파일을 도입하면 `*.key`도 함께 무시하도록 추가한다.
- 로그 출력 시 키/서명 값은 truncate 처리.

## API 키 보호

- `BIRDEYE_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN` — 모두 .env
- `BIRDEYE_API_KEY`는 optional. 현재 핵심 runtime은 Birdeye 없이도 기동 가능
- Rate limit 준수: Jupiter (600/min), DexScreener/GeckoTerminal는 각 client backoff 정책 준수
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

- SecurityGate: 온체인 mint authority / freeze authority / Token-2022 transfer fee / top holder concentration 체크
- Exit liquidity 검증: Quote Gate / sell impact / liquidity proxy 기반 soft protection
- Token holder 집중도 검증 (top 10 holders > 50% → 거부)

## CI 보안

- `npm audit` 주기적 실행
- 의존성 업데이트 시 lock file diff 확인
- `.env.example`에는 실제 비밀값을 넣지 않는다. placeholder와 기본 운영값만 기록한다.
