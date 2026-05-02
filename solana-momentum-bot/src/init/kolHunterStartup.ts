import type { Notifier } from '../notifier';
import type { KolTx } from '../kol/types';
import type { BotContext } from '../orchestration/types';

export interface KolTrackerStartupLike {
  on(event: 'kol_swap', listener: (tx: KolTx) => void): unknown;
  start(): Promise<void>;
}

export interface KolStartupLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface LiveExecutionQualityHydrationSummary {
  loaded: number;
  hydrated: number;
  skippedExpired: number;
}

interface TradeMarkoutHydrationSummary {
  scheduled: number;
}

interface KolHunterStartupRuntime {
  initKolHunter(options: {
    securityClient?: BotContext['onchainSecurityClient'];
    gateCache?: BotContext['gateCache'];
    ctx?: BotContext;
  }): void;
  hydrateLiveExecutionQualityCooldownsFromLedger(): Promise<LiveExecutionQualityHydrationSummary>;
  hydrateTradeMarkoutsFromLedger?(): Promise<TradeMarkoutHydrationSummary>;
  handleKolSwap(tx: KolTx): Promise<void>;
  initKolPaperNotifier(notifier: Notifier): void;
}

export interface StartKolTrackerWithPreparedHunterOptions {
  tracker: KolTrackerStartupLike;
  ctx: BotContext;
  notifier: Notifier;
  log: KolStartupLogger;
  activeKols: number;
  kolHunterEnabled: boolean;
  kolHunterLiveCanaryEnabled: boolean;
  kolHunterPaperOnly: boolean;
  runtime: KolHunterStartupRuntime;
}

export async function startKolTrackerWithPreparedHunter(
  options: StartKolTrackerWithPreparedHunterOptions
): Promise<void> {
  const {
    initKolHunter,
    hydrateLiveExecutionQualityCooldownsFromLedger,
    hydrateTradeMarkoutsFromLedger,
    handleKolSwap,
    initKolPaperNotifier,
  } = options.runtime;

  if (options.kolHunterEnabled) {
    initKolHunter({
      securityClient: options.ctx.onchainSecurityClient,
      gateCache: options.ctx.gateCache,
      ctx: options.ctx,
    });
    if (
      options.kolHunterLiveCanaryEnabled
      && !options.kolHunterPaperOnly
      && options.ctx.tradingMode === 'live'
    ) {
      const qualityCooldownHydration = await hydrateLiveExecutionQualityCooldownsFromLedger();
      options.log.info(
        `[KOL_HUNTER] live quality cooldown hydration completed before tracker start: ` +
        `loaded=${qualityCooldownHydration.loaded} ` +
        `hydrated=${qualityCooldownHydration.hydrated} ` +
        `expired=${qualityCooldownHydration.skippedExpired}`
      );
      if (hydrateTradeMarkoutsFromLedger) {
        const tradeMarkoutHydration = await hydrateTradeMarkoutsFromLedger();
        if (tradeMarkoutHydration.scheduled > 0) {
          options.log.info(
            `[KOL_HUNTER] trade markout hydration scheduled=${tradeMarkoutHydration.scheduled}`
          );
        }
      }
    }
    // RPC subscription 전 handler/listener 를 먼저 붙여 startup 직후 signal drop/live cooldown race 를 막는다.
    options.tracker.on('kol_swap', (tx: KolTx) => {
      handleKolSwap(tx).catch((err) => {
        options.log.warn(`[KOL_HUNTER] handleKolSwap error: ${String(err)}`);
      });
    });
    initKolPaperNotifier(options.notifier);
  }

  await options.tracker.start();
  options.log.info(`[KOL_DISCOVERY] Option 5 Phase 1 — tracker started (${options.activeKols} active KOLs)`);
  if (options.kolHunterEnabled) {
    options.log.info(
      `[KOL_HUNTER] Option 5 Phase 3 — paper lane started (paperOnly=${options.kolHunterPaperOnly}, ` +
      `survival=${options.ctx.onchainSecurityClient ? 'wired' : 'no-client'})`
    );
  }
}
