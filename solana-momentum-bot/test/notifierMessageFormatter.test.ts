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
    expect(message).toContain('- 품질 점수: 74점 (A등급)');
    expect(message).toContain('- MC / TVL: $2.35M / $120K');
    expect(message).toContain('- 24H 거래대금 / 시총: $12.3M / 42.0%');
    expect(message).toContain('- 스프레드 / AMM 수수료: 1.2% / 0.3%');
    expect(message).toContain('세부 지표');
    expect(message).toContain('- 메인 봉 / 확인 봉: 1m / 15s');
    expect(message).toContain('- 캔들: 2026-03-22 09:00:05.00 → 2026-03-22 09:01:05.00');
    expect(message).toContain('- 평균 / 현재 거래량: $123K / $9.88M');
    expect(message).toContain('- 매수 비중: 0.6200');
    expect(message).toContain('- 고래 점수: 12');
    expect(message).not.toContain('시가총액(USD)');
  });

  it('formats trade open and close messages with readable summaries', () => {
    const order: Order = {
      pairAddress: 'PAIR1234567890',
      strategy: 'fib_pullback',
      side: 'BUY',
      tokenSymbol: 'PAIR',
      price: 0.00123456,
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

    expect(openMessage).toContain('🟢 <b>포지션 진입 완료</b>');
    expect(openMessage).toContain('- 종목: <b>PAIR</b>');
    expect(openMessage).toContain('- 전략: Fib Pullback');
    expect(openMessage).toContain('- 진입 금액: 0.002469 SOL');
    expect(openMessage).toContain('- 수량: 2.000000 PAIR');
    expect(openMessage).toContain('- 손절: 0.00110000 (-0.000269 SOL / -10.9%)');
    expect(openMessage).toContain('- 1차 익절: 0.00140000 (+0.000331 SOL / +13.4%)');
    expect(openMessage).toContain('- 2차 익절: 0.00160000 (+0.000731 SOL / +29.6%)');
    expect(openMessage).toContain('- 포지션 제한: 리스크 한도 기준');
    expect(openMessage).toContain('- 시그널 품질: 58점 (B등급)');

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
      stopLoss: 0.0011,
      takeProfit1: 0.0014,
      takeProfit2: 0.0016,
      timeStopAt: new Date('2026-03-22T03:00:00Z'),
      exitReason: 'TAKE_PROFIT_1',
    };

    const closeMessage = buildTradeCloseMessage(trade);

    expect(closeMessage).toContain('✅ <b>포지션 종료</b>');
    expect(closeMessage).toContain('- 종료 사유: 1차 익절');
    expect(closeMessage).toContain('- 결과: 이익 실현');
    expect(closeMessage).toContain('- 보유 시간: 2h 30m');
    expect(closeMessage).toContain('+0.0003 SOL');
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
    expect(openMessage).toContain('- 종목: <b>PAIR1234...DEFG</b> (ticker 미확인)');
    expect(openMessage).toContain('- 손절: 미설정 (유효한 손절가 없음 / 재검토 필요)');
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
    expect(closeMessage).toContain('- 종목: <b>PAIR1234...DEFG</b> (ticker 미확인)');
    expect(closeMessage).toContain('- 종료 사유: 손절');
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
        ],
        preWatchlistRejectDetailCounts: [
          { label: 'unsupported_dex source=dex_boost dex=meteora', count: 4 },
        ],
        admissionSkipCounts: [
          { reason: 'unsupported_pool_program', count: 5 },
        ],
        admissionSkipDetailCounts: [
          { label: 'unsupported_pool_program source=gecko_new_pool dex=raydium', count: 5 },
        ],
        aliasMissCounts: [],
        capacityCounts: [
          { label: 'helius_pool_discovery reason=queue_overflow detail=limit=250 inFlight=2 queued=250', count: 3 },
        ],
        triggerStatsCounts: [],
        rateLimitCounts: [
          { source: 'gecko_terminal', count: 4 },
          { source: 'helius_seed_backfill', count: 2 },
        ],
        pollFailureCounts: [
          { source: 'gecko_ingester', count: 1 },
        ],
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

    expect(message).toContain('📊 <b>Daily Report — 2026-03-22</b>');
    expect(message).toContain('- 체결 거래: 5건 (승 3 / 패 2)');
    expect(message).toContain('- 실현 손익: +0.1200 SOL (+6.0%)');
    expect(message).toContain('- 일일 손실 사용률: 2.0% / 5.0% (여유 있음)');
    expect(message).toContain('실시간 Admission');
    expect(message).toContain('- 추적 풀: 4개 | 허용 3개 | 차단 1개');
    expect(message).toContain('parse 0.0% / skip 96.6% / obs 88');
    expect(message).toContain('Cadence');
    expect(message).toContain('- 최근 시그널: 1h 0m 전 (2026-03-22T08:00:00.000Z)');
    expect(message).toContain('- 최근 6h: signal 4 / 실행 1 / 제외 3 / 진입 0 / 종료 0');
    expect(message).toContain('cadence 경고: 12h no entry, 24h no closed trade');
    expect(message).toContain('Data Plane (24h)');
    expect(message).toContain('- 최근 캔들: 0h 15m 전 (2026-03-22T08:45:00.000Z)');
    expect(message).toContain('- realtime-ready ratio: 6/10 (60.0%)');
    expect(message).toContain('gate reject (unique token): quote_rejected: Quote error=7, security_rejected: Token is freezable=3');
    expect(message).toContain('pre-watchlist reject: unsupported_dex source=dex_boost dex=meteora=4');
    expect(message).toContain('realtime skip: unsupported_pool_program=5');
    expect(message).toContain('realtime skip detail: unsupported_pool_program source=gecko_new_pool dex=raydium=5');
    expect(message).toContain('429: gecko_terminal=4, helius_seed_backfill=2');
    expect(message).toContain('poll failure: gecko_ingester=1');
    expect(message).toContain('data-plane 경고: no candle >= 10m, 429 observed, low realtime-ready ratio');
    expect(message).toContain('전략 상태');
    expect(message).toContain('Momentum Cascade: 검증 통과');
    expect(message).toContain('Kelly 8.0%');
    expect(message).toContain('소스 성과');
    expect(message).toContain('scanner_dex_boost: 3건 | 승률 66.7% | 손익 +0.0800 SOL');
    expect(message).toContain('unknown: 2건 | 승률 50.0% | 손익 +0.0400 SOL');
  });
});
