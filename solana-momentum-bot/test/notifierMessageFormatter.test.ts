import {
  buildAlertMessage,
  buildSignalMessage,
  buildTradeCloseMessage,
  buildTradeOpenMessage,
} from '../src/notifier/messageFormatter';
import { buildDailySummaryMessage } from '../src/notifier/dailySummaryFormatter';
import { Order, Signal, Trade } from '../src/utils/types';

describe('messageFormatter', () => {
  it('escapes alert content for HTML parse mode', () => {
    const message = buildAlertMessage('CRITICAL', 'Pool <Event>', 'bad & broken <tag>');

    expect(message).toContain('🔴 <b>Critical Alert</b>');
    expect(message).toContain('- 영역: Pool &lt;Event&gt;');
    expect(message).toContain('- 내용: bad &amp; broken &lt;tag&gt;');
  });

  it('formats signal messages with friendly labels', () => {
    const signal: Signal = {
      action: 'BUY',
      strategy: 'volume_spike',
      pairAddress: 'PAIR1234567890',
      tokenSymbol: 'PAIR',
      price: 0.00001234,
      timestamp: new Date('2026-03-22T00:00:00Z'),
      meta: {
        primaryIntervalSec: 60,
        confirmIntervalSec: 15,
        primaryCandleStartSec: Date.parse('2026-03-22T00:00:05Z') / 1000,
        primaryCandleCloseSec: Date.parse('2026-03-22T00:01:05Z') / 1000,
        avgVolume: 123456,
        currentVolume: 9876543,
        currentVolume24hUsd: 12345678,
        ammFeePct: 0.003,
        buyRatio: 0.62,
        whaleScore: 12,
        marketCapUsd: 2345678,
        volumeMcapRatio: 0.42,
      },
      breakoutScore: {
        volumeScore: 20,
        buyRatioScore: 18,
        multiTfScore: 10,
        whaleScore: 12,
        lpScore: 8,
        mcapVolumeScore: 6,
        totalScore: 74,
        grade: 'A',
      },
      poolTvl: 120000,
      spreadPct: 0.012,
    };

    const message = buildSignalMessage(signal);

    expect(message).toContain('🟢 <b>BUY 시그널</b>');
    expect(message).toContain('- 종목: <b>PAIR</b>');
    expect(message).toContain('- 전략: Volume Spike');
    expect(message).toContain('- 컨트랙트: <code>PAIR1234567890</code>');
    expect(message).toContain('- 시그널 시각(UTC): <code>2026-03-22T00:00:00.000Z</code>');
    expect(message).toContain('- 시그널 품질: 74점 (A등급)');
    expect(message).toContain('- MC / TVL: $2.35M / $120K');
    expect(message).toContain('- 24H 거래대금 / 시총: $12.3M / 42.0%');
    expect(message).toContain('- 스프레드 / AMM 수수료: 1.2% / 0.3%');
    expect(message).toContain('진입 근거');
    expect(message).toContain('- 메인 봉 / 확인 봉: 1m / 15s');
    expect(message).toContain('- 캔들: 2026-03-22 09:00:05.00 → 2026-03-22 09:01:05.00');
    expect(message).toContain('- 평균 / 현재 거래량: $123K / $9.88M');
    expect(message).toContain('- 매수 비중: 0.6200');
    expect(message).toContain('- 고래 점수: 12');
    expect(message).not.toContain('시가총액(USD)');
  });

  it('formats trade open and close messages with readable summaries', () => {
    const order: Order = {
      tradeId: 'trade-open-1',
      pairAddress: 'PAIR1234567890',
      strategy: 'fib_pullback',
      side: 'BUY',
      tokenSymbol: 'PAIR',
      price: 0.00123456,
      plannedEntryPrice: 0.0012,
      quantity: 2,
      stopLoss: 0.0011,
      takeProfit1: 0.0014,
      takeProfit2: 0.0016,
      timeStopMinutes: 30,
      breakoutScore: 58,
      breakoutGrade: 'B',
      sizeConstraint: 'RISK',
    };

    const openMessage = buildTradeOpenMessage(order, 'TX123');

    expect(openMessage).toContain('🟢 <b>포지션 진입</b> <b>PAIR</b> <code>trade-op</code>');
    expect(openMessage).toContain('- 전략: Fib Pullback');
    expect(openMessage).toContain('- 진입: 0.002469 SOL @ 0.00123456 (수량 2.000000 PAIR)');
    expect(openMessage).toContain('- 손절: -10.9% · -0.000269 SOL @ 0.00110000');
    expect(openMessage).toContain('- TP1: +13.4% · +0.000331 SOL @ 0.00140000');
    expect(openMessage).toContain('- TP2: +29.6% · +0.000731 SOL @ 0.00160000');
    // pnl 0.0003 / notional (0.00123456*2=0.00246912) = 12.15% → "+12.1%"
    expect(openMessage).toContain('- 포지션 제한: 리스크 한도 기준');
    expect(openMessage).toContain('- 시그널 품질: 58점 (B등급)');
    expect(openMessage).toContain('- Entry gap: +2.88% (planned=0.00120000 → fill=0.00123456)');
    expect(openMessage).toContain('- 컨트랙트: <code>PAIR1234567890</code>');
    expect(openMessage).toContain('- tx: <code>TX123</code>');
    // 한눈에 보기 / 진입 가격 / 진입 금액 중복 제거 검증
    expect(openMessage).not.toContain('한눈에 보기');
    expect(openMessage).not.toContain('진입 가격');
    expect(openMessage).not.toContain('진입 금액');

    const trade: Trade = {
      id: 'trade-1',
      pairAddress: 'PAIR1234567890',
      strategy: 'fib_pullback',
      side: 'SELL',
      entryPrice: 0.00123456,
      exitPrice: 0.0014,
      quantity: 2,
      pnl: 0.0003,
      slippage: 0.011,
      txSignature: 'TX456',
      status: 'CLOSED',
      createdAt: new Date('2026-03-22T00:00:00Z'),
      closedAt: new Date('2026-03-22T02:30:00Z'),
      decisionPrice: 0.00142,
      entrySlippageBps: 25,
      exitSlippageBps: 40,
      roundTripCostPct: 0.9,
      stopLoss: 0.0011,
      takeProfit1: 0.0014,
      takeProfit2: 0.0016,
      timeStopAt: new Date('2026-03-22T03:00:00Z'),
      exitReason: 'TAKE_PROFIT_1',
      tokenSymbol: 'PAIR',
    };

    const closeMessage = buildTradeCloseMessage(trade);

    expect(closeMessage).toContain('✅ <b>포지션 종료</b> <b>PAIR</b> <code>trade-1</code> · 이익 실현');
    expect(closeMessage).toContain('- 전략: Fib Pullback');
    // 1차 익절 → ㄹ받침 → "로"
    expect(closeMessage).toContain('- 사유: 1차 익절로 종료 · 보유 2h 30m');
    expect(closeMessage).toContain('- 실현 손익: +0.0003 SOL (+12.2%) · 슬리피지 1.1%');
    expect(closeMessage).toContain('- 가격: 0.00123456 → 0.00140000');
    expect(closeMessage).toContain('- 비용: entry 25bps · exit 40bps · rtCost 0.90%');
    expect(closeMessage).toContain('- Exit gap: -1.41% (decision=0.00142000 → fill=0.00140000)');
    expect(closeMessage).toContain('- 컨트랙트: <code>PAIR1234567890</code>');
    expect(closeMessage).toContain('- tx: <code>TX456</code>');
    // 중복 제거 검증
    expect(closeMessage).not.toContain('한눈에 보기');
    expect(closeMessage).not.toContain('종료 사유:');
    expect(closeMessage).not.toContain('결과:');
  });

  it('uses "으로" particle for close reasons without 받침-ㄹ', () => {
    const trade: Trade = {
      id: 'trade-hc',
      pairAddress: 'PAIR1234567890ABCDEFG',
      strategy: 'cupsey_flip_10s',
      side: 'SELL',
      entryPrice: 0.23872236,
      exitPrice: 0.23740977,
      quantity: 0.041504,
      pnl: -0.0001,
      status: 'CLOSED',
      createdAt: new Date('2026-03-22T00:00:00Z'),
      closedAt: new Date('2026-03-22T00:00:30Z'),
      stopLoss: 0.236,
      takeProfit1: 0.24,
      takeProfit2: 0.25,
      timeStopAt: new Date('2026-03-22T00:30:00Z'),
      exitReason: 'REJECT_HARD_CUT',
      tokenSymbol: 'ASTR',
    };

    const message = buildTradeCloseMessage(trade);
    // 초기 하드컷 → ㅅ받침 → "으로"
    expect(message).toContain('- 사유: 초기 하드컷으로 종료 · 보유 1분 미만');
    expect(message).toContain('❌ <b>포지션 종료</b> <b>ASTR</b>');
    expect(message).not.toContain('하드컷로');
    // HTML 이스케이프 후에도 꼬이지 않아야 함
    expect(message).not.toContain('&lt;');
  });

  it('hides entry gap line when price noise is sub-basis-point', () => {
    const order: Order = {
      tradeId: 'trade-noise',
      pairAddress: 'PAIR1234567890',
      strategy: 'cupsey_flip_10s',
      side: 'BUY',
      tokenSymbol: 'PAIR',
      price: 0.23872236,
      plannedEntryPrice: 0.23872236001, // 1e-11 level noise
      quantity: 0.04,
      stopLoss: 0.235,
      takeProfit1: 0.24,
      takeProfit2: 0.25,
      timeStopMinutes: 30,
    };

    const message = buildTradeOpenMessage(order);
    expect(message).not.toContain('Entry gap');
    expect(message).not.toContain('-0.00%');
  });

  it('hides cost line when all cost fields are missing', () => {
    const trade: Trade = {
      id: 'trade-nocost',
      pairAddress: 'PAIR1234567890',
      strategy: 'cupsey_flip_10s',
      side: 'SELL',
      entryPrice: 0.1,
      exitPrice: 0.11,
      quantity: 1,
      pnl: 0.01,
      status: 'CLOSED',
      createdAt: new Date('2026-03-22T00:00:00Z'),
      closedAt: new Date('2026-03-22T01:00:00Z'),
      stopLoss: 0.09,
      takeProfit1: 0.11,
      takeProfit2: 0.12,
      timeStopAt: new Date('2026-03-22T01:30:00Z'),
      exitReason: 'TAKE_PROFIT_1',
      tokenSymbol: 'PAIR',
    };

    const message = buildTradeCloseMessage(trade);
    expect(message).not.toContain('- 비용:');
    expect(message).not.toContain('Exit gap');
  });

  it('falls back to contract label and hides invalid stop-loss math in alerts', () => {
    const order: Order = {
      pairAddress: 'PAIR1234567890ABCDEFG',
      strategy: 'volume_spike',
      side: 'BUY',
      price: 0.006947,
      quantity: 1,
      stopLoss: 0,
      takeProfit1: 0.0075,
      takeProfit2: 0.0081,
      timeStopMinutes: 30,
    };

    const openMessage = buildTradeOpenMessage(order);
    expect(openMessage).toContain('<b>PAIR1234...DEFG</b> (ticker 미확인)');
    expect(openMessage).toContain('- 손절: 미설정 (유효한 손절가 없음 / 재검토 필요)');
    expect(openMessage).toContain('- TP1: +8.0% · +0.000553 SOL @ 0.00750000');
    expect(openMessage).toContain('- TP2: +16.6% · +0.001153 SOL @ 0.00810000');
    expect(openMessage).not.toContain('-100.0%');

    const trade: Trade = {
      id: 'trade-fallback',
      pairAddress: 'PAIR1234567890ABCDEFG',
      strategy: 'volume_spike',
      side: 'SELL',
      entryPrice: 0.006947,
      exitPrice: 0.0065,
      quantity: 1,
      pnl: -0.000447,
      status: 'CLOSED',
      createdAt: new Date('2026-03-22T00:00:00Z'),
      closedAt: new Date('2026-03-22T00:05:00Z'),
      stopLoss: 0.0067,
      takeProfit1: 0.0075,
      takeProfit2: 0.0081,
      timeStopAt: new Date('2026-03-22T00:30:00Z'),
      exitReason: 'STOP_LOSS',
    };

    const closeMessage = buildTradeCloseMessage(trade);
    expect(closeMessage).toContain('<b>PAIR1234...DEFG</b> (ticker 미확인)');
    // 손절 → ㄹ받침 → "로"
    expect(closeMessage).toContain('- 사유: 손절로 종료 · 보유 5분');
  });

  it('formats daily summary with risk and strategy sections', () => {
    const message = buildDailySummaryMessage({
      totalTrades: 5,
      wins: 3,
      losses: 2,
      pnl: 0.12,
      portfolioValue: 2,
      bestTrade: { pair: 'ABCDEFGH12345678', pnl: 0.09, score: 71, grade: 'A' },
      worstTrade: { pair: 'WXYZ9876543210', pnl: -0.02, score: 43, grade: 'C' },
      signalsDetected: 12,
      signalsExecuted: 5,
      signalsFiltered: 7,
      dailyLossUsed: 0.02,
      dailyLossLimit: 0.05,
      consecutiveLosses: 1,
      uptime: 9 * 3_600_000 + 15 * 60_000,
      restarts: 0,
      realtimeAdmission: {
        trackedPools: 4,
        allowedPools: 3,
        blockedPools: 1,
        blockedDetails: [
          {
            pool: 'BLOCKEDPOOL123456789',
            observedNotifications: 88,
            parseRatePct: 0,
            skippedRatePct: 96.59,
          },
        ],
      },
      cadence: {
        lastSignalAt: '2026-03-22T08:00:00.000Z',
        lastTradeAt: '2026-03-21T18:00:00.000Z',
        lastClosedTradeAt: undefined,
        timeSinceLastSignalMs: 60 * 60 * 1000,
        timeSinceLastTradeMs: 15 * 60 * 60 * 1000,
        timeSinceLastClosedTradeMs: undefined,
        windows: [
          {
            hours: 6,
            detectedSignals: 4,
            executedSignals: 1,
            filteredSignals: 3,
            trades: 0,
            closedTrades: 0,
          },
          {
            hours: 12,
            detectedSignals: 9,
            executedSignals: 2,
            filteredSignals: 7,
            trades: 0,
            closedTrades: 0,
          },
        ],
      },
      todayUtcOps: {
        capSuppressedPairs: 2,
        capSuppressedCandles: 1177,
      },
      rejectionMix: {
        hours: 24,
        lastCandleAt: '2026-03-22T08:45:00.000Z',
        timeSinceLastCandleMs: 15 * 60 * 1000,
        gateFilterReasonCounts: [
          { reason: 'quote_rejected: Quote error', count: 7 },
          { reason: 'security_rejected: Token is freezable', count: 3 },
        ],
        preWatchlistRejectCounts: [
          { reason: 'unsupported_dex', count: 4 },
          { reason: 'operator_blacklist', count: 2 },
        ],
        preWatchlistRejectDetailCounts: [
          { label: 'unsupported_dex source=dex_boost dex=meteora', count: 4 },
          { label: 'operator_blacklist detail=token_mint source=gecko_trending', count: 2 },
        ],
        admissionSkipCounts: [
          { reason: 'unsupported_pool_program', count: 5 },
        ],
        admissionSkipDetailCounts: [
          { label: 'unsupported_pool_program source=gecko_new_pool dex=raydium', count: 5 },
          { label: 'no_pairs detail=all_pairs_blocked source=gecko_trending dex=raydium', count: 1 },
        ],
        aliasMissCounts: [],
        candidateEvictedCount: 3,

        candidateReaddedWithinGraceCount: 1,
        signalNotInWatchlistCount: 8,
        signalNotInWatchlistRecentlyEvictedCount: 2,
        missedTokens: [
          {
            tokenMint: 'CGEDT9QZDvvH5GmVkWJH2BXiMJqMJySC9ihWyr7Spump',
            evicted: 1,
            readded: 0,
            notInWatchlist: 13,
            recentlyEvicted: 1,
            admissionBlocked: 0,
          },
          {
            tokenMint: 'BURNIE1234567890ABCDEFG',
            evicted: 1,
            readded: 1,
            notInWatchlist: 5,
            recentlyEvicted: 2,
            admissionBlocked: 0,
          },
          {
            tokenMint: 'PIPPIN1234567890ABCDEFG',
            evicted: 0,
            readded: 0,
            notInWatchlist: 3,
            recentlyEvicted: 0,
            admissionBlocked: 0,
          },
          {
            tokenMint: 'HIDDEN1234567890ABCDEFG',
            evicted: 0,
            readded: 0,
            notInWatchlist: 1,
            recentlyEvicted: 0,
            admissionBlocked: 0,
          },
        ],
        capacityCounts: [
          { label: 'helius_pool_discovery reason=queue_overflow detail=limit=250 inFlight=2 queued=250', count: 3 },
        ],
        triggerStatsCounts: [],
        latestTriggerStats: {
          source: 'bootstrap_trigger',
          detail: 'evals=200 signals=5(boosted=2) insuffCandles=60 volInsuf=100 lowBuyRatio=10 cooldown=5',
        },
        bootstrapBoostedSignalCount: 2,
        rateLimitCounts: [
          { source: 'gecko_terminal', count: 4 },
          { source: 'helius_seed_backfill', count: 2 },
        ],
        pollFailureCounts: [
          { source: 'gecko_ingester', count: 1 },
        ],
        riskRejectionCounts: [],
        realtimeCandidateReadiness: {
          totalCandidates: 10,
          prefiltered: 4,
          admissionSkipped: 2,
          ready: 6,
          readinessRate: 0.6,
        },
      },
      edgeStats: [
        {
          strategy: 'momentum_cascade',
          totalTrades: 5,
          wins: 3,
          losses: 2,
          winRate: 0.6,
          avgWinR: 1.5,
          avgLossR: -1,
          rewardRisk: 1.8,
          sharpeRatio: 0.9,
          maxConsecutiveLosses: 2,
          edgeState: 'Confirmed',
          kellyFraction: 0.08,
          kellyEligible: true,
        },
      ],
      sourceOutcomes: [
        {
          sourceLabel: 'scanner_dex_boost',
          totalTrades: 3,
          wins: 2,
          losses: 1,
          winRate: 2 / 3,
          pnl: 0.08,
        },
        {
          sourceLabel: 'unknown',
          totalTrades: 2,
          wins: 1,
          losses: 1,
          winRate: 0.5,
          pnl: 0.04,
        },
      ],
    }, '2026-03-22');

    expect(message).toContain('📊 <b>일간 요약 — 2026-03-22 KST</b>');
    expect(message).toContain('- 체결 거래: 5건 (승 3 / 패 2)');
    expect(message).toContain('- 실현 손익: +0.1200 SOL (+6.0%)');
    expect(message).toContain('- 일일 손실 사용률: 2.0% / 5.0% (여유 있음)');
    expect(message).toContain('실시간 수집 상태');
    expect(message).toContain('- 추적 풀: 4개 | 허용 3개 | 차단 1개');
    expect(message).toContain('파싱 0.0% / skip 96.6% / 알림 88');
    expect(message).toContain('최근 흐름');
    expect(message).toContain('- 최근 시그널: 1h 0m 전 (2026-03-22 17:00:00 KST)');
    expect(message).toContain('- 최근 6h: 신호 4 / 실행 1 / 제외 3 / 진입 0 / 종료 0');
    expect(message).toContain('흐름 경고: 12h 진입 없음, 24h 종료 없음');
    expect(message).toContain('데이터 상태 (24h)');
    expect(message).toContain('워치리스트 전 제외: 미지원 DEX 4건, 운영자 블랙리스트 2건');
    expect(message).toContain('운영자 블랙리스트 적중');
    expect(message).toContain('- 최근 캔들: 0h 15m 전 (2026-03-22 17:45:00 KST)');
    expect(message).toContain('- 실시간 준비율: 6/10 (60.0%)');
    expect(message).toContain('게이트 제외(토큰 기준): 호가 품질 부족 7건, 보안 게이트 차단 3건');
    expect(message).toContain('실시간 스킵: 미지원 풀 프로그램 5건');
    expect(message).toContain('워치리스트 변동: 축출 3건 | 재편입 1건 | 목록 밖 신호 8건 (최근 축출 2건)');
    expect(message).toContain('놓친 토큰 (상위 3개):');
    expect(message).toContain('CGEDT9QZ...pump');
    expect(message).toContain('BURNIE12...DEFG');
    expect(message).toContain('PIPPIN12...DEFG');
    expect(message).not.toContain('HIDDEN12...DEFG');
    expect(message).toContain('부스트 신호: 2건 (누적)');
    expect(message).toContain('운영 보정(UTC)');
    expect(message).toContain('eval 억제: 2 pairs / 1177 candles skipped');
    expect(message).toContain('429 제한: gecko_terminal=4, helius_seed_backfill=2');
    expect(message).toContain('폴링 실패: gecko_ingester=1');
    expect(message).toContain('데이터 경고: 캔들 업데이트 10분 이상 없음, 429 발생, 실시간 준비율 낮음, 운영자 블랙리스트 적중, 최근 축출 신호 2건, all_pairs_blocked 발생');
    expect(message).toContain('엔지니어링 상세');
    expect(message).toContain('워치리스트 전 제외(raw): unsupported_dex source=dex_boost dex=meteora=4');
    expect(message).toContain('실시간 스킵 상세(raw): unsupported_pool_program source=gecko_new_pool dex=raydium=5');
    expect(message).toContain('용량 제한(raw): helius_pool_discovery reason=queue_overflow detail=limit=250 inFlight=2 queued=250=3');
    expect(message).toContain('트리거 통계 (bootstrap_trigger): evals=200 signals=5(boosted=2) insuffCandles=60 volInsuf=100 lowBuyRatio=10 cooldown=5');
    expect(message).toContain('전략 상태');
    expect(message).toContain('Momentum Cascade: 검증 통과');
    expect(message).toContain('Kelly 8.0%');
    expect(message).toContain('소스 성과');
    expect(message).toContain('scanner_dex_boost: 3건 | 승률 66.7% | 손익 +0.0800 SOL');
    expect(message).toContain('unknown: 2건 | 승률 50.0% | 손익 +0.0400 SOL');
  });

  it('omits missed token section when there are no missed tokens', () => {
    const message = buildDailySummaryMessage({
      totalTrades: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
      portfolioValue: 1,
      signalsDetected: 0,
      signalsExecuted: 0,
      signalsFiltered: 0,
      dailyLossUsed: 0,
      dailyLossLimit: 0.05,
      consecutiveLosses: 0,
      uptime: 60_000,
      restarts: 0,
      todayUtcOps: {
        capSuppressedPairs: 0,
        capSuppressedCandles: 0,
      },
      rejectionMix: {
        hours: 24,
        gateFilterReasonCounts: [],
        admissionSkipCounts: [],
        admissionSkipDetailCounts: [],
        aliasMissCounts: [],
        candidateEvictedCount: 0,

        candidateReaddedWithinGraceCount: 0,
        signalNotInWatchlistCount: 0,
        signalNotInWatchlistRecentlyEvictedCount: 0,
        missedTokens: [],
        capacityCounts: [],
        triggerStatsCounts: [],
        bootstrapBoostedSignalCount: 0,
        preWatchlistRejectCounts: [],
        preWatchlistRejectDetailCounts: [],
        rateLimitCounts: [],
        pollFailureCounts: [],
        riskRejectionCounts: [],
        realtimeCandidateReadiness: {
          totalCandidates: 0,
          prefiltered: 0,
          admissionSkipped: 0,
          ready: 0,
          readinessRate: 0,
        },
      },
    }, '2026-03-23');

    expect(message).not.toContain('놓친 토큰 (상위 3개):');
    expect(message).toContain('부스트 신호: 0건 (누적)');
  });
});
