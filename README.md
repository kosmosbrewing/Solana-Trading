# Solana Memecoin Sniper Bot 🚀

Solana 네트워크에서 신규 유동성 풀(LP) 생성을 실시간 감지하고 자동 매매하는 스나이퍼 봇

## 개요

Solana Trading은 텔레그램 채널에서 신규 토큰 정보를 스크래핑하여 필터링 조건에 맞는 토큰을 자동으로 매수하는 Python 기반 트레이딩 봇입니다. GMGN DEX Aggregator를 통해 스왑 주문을 실행합니다.

## 주요 기능

### 📡 실시간 토큰 감지
- 텔레그램 채널 메시지 실시간 스크래핑 (Telethon)
- Raydium LP 생성 이벤트 WebSocket 모니터링
- DexScreener API를 통한 토큰 가격/유동성 조회

### 🔍 스캠 필터링
- **Market Cap 필터**: 초기 시가총액 검증
- **Holder 필터**: 홀더 수 제한 (50명 이하)
- **Renounced 검증**: 컨트랙트 소유권 포기 여부
- **Top 10 홀더 비율**: 집중도 85% 이하
- **LP Burn 검증**: 100% 소각 여부
- **Rug 확률**: 10% 이하만 진입
- **Twitter 중복 검증**: 동일 트위터 계정 재사용 필터링

### 💹 자동 매매
- GMGN Router API를 통한 스왑 실행
- Anti-MEV 보호 옵션
- Slippage 설정
- 포지션 자동 관리

### 📊 백테스트
- 과거 텔레그램 메시지 기반 전략 검증
- 수익률 분석

## 프로젝트 구조

```
Solana-Trading/
├── omain.py              # 메인 실행 파일
├── util.py               # 유틸리티 함수 (텔레그램, 로깅, 데이터 저장)
├── consts.py             # 설정 상수 (API 키, 지갑 주소 등)
├── getNewLPScraper.py    # 텔레그램 스크래핑 & 자동 매매
├── getNewLP.py           # Raydium LP WebSocket 모니터링
├── getOrderGmGn.py       # GMGN 스왑 주문 실행
├── getBacktestScraper.py # 백테스트용 스크래퍼
└── checkPosition.py      # 포지션 모니터링
```

## 기술 스택

| 구분 | 기술 |
|------|------|
| Language | Python 3.x |
| Async | asyncio, aiohttp |
| Telegram | Telethon |
| Blockchain | solana-py, solders |
| DEX | GMGN Router API |
| Data | DexScreener API |
| Notification | python-telegram-bot |

## 환경 설정

### 1. 필수 패키지 설치

```bash
pip install telethon aiohttp solana solders base58 pandas tabulate python-telegram-bot websockets
```

### 2. 설정 파일 (`consts.py`)

```python
# consts.py
ENV = 'real'  # 'real' 또는 'local'

# Telegram API (my.telegram.org에서 발급)
API_ID = '<YOUR_TELEGRAM_API_ID>'
API_HASH = '<YOUR_TELEGRAM_API_HASH>'

# Solana Wallet
WALLET_KEY = '<YOUR_WALLET_PRIVATE_KEY>'
FROM_ADDRESS = '<YOUR_WALLET_PUBLIC_ADDRESS>'
SOL_ADDRESS = 'So11111111111111111111111111111111111111112'

# Trading Settings
INPUT_SOL = 0.01           # 1회 매수 금액 (SOL)
INPUT_SOL_AMOUNT = 10000000  # lamports (0.01 SOL)
REMAINING_SOL = 1.0        # 최대 투자 SOL
SLIPPAGE = 15              # 슬리피지 (%)
ORDER_FEE = 0.0009         # 주문 수수료

# Telegram Notification
TELEGRAM_BOT_TOKEN = '<YOUR_TELEGRAM_BOT_TOKEN>'
TELEGRAM_MESSAGE_MAX_SIZE = 4096
```

## 사용법

### 메인 봇 실행

```bash
python omain.py
```

### 백테스트 실행

```bash
python getBacktestScraper.py
```

### LP 모니터링 (WebSocket)

```bash
python getNewLP.py
```

## 필터링 조건

봇은 다음 조건을 모두 만족하는 토큰만 매수합니다:

| 조건 | 값 |
|------|-----|
| Market Cap | K/M 단위 미만 (초기 단계) |
| Holder 수 | 50명 이하 |
| Renounced | ✅ (소유권 포기됨) |
| Top 10 홀더 | 85% 이하 |
| LP Burn | 100% |
| Rug 확률 | 10% 이하 |
| 메시지 지연 | 3초 이내 |
| Twitter 중복 | 동일 계정 1회만 |

## 데이터 저장

- `position_data.json`: 현재 보유 포지션
- `twitter_data.json`: 트위터 계정 중복 체크 데이터

## API 연동

### GMGN Router
- **스왑 라우트 조회**: `GET /sol/tx/get_swap_route`
- **트랜잭션 제출**: `POST /sol/tx/submit_signed_transaction`

### DexScreener
- **토큰 정보 조회**: `GET /tokens/v1/solana/{CA}`

## 로그 파일

- `premium.log`: 실시간 트레이딩 로그
- `backtest.log`: 백테스트 결과 로그

로그는 날짜별로 자동 rotation되며 30일간 보관됩니다.
