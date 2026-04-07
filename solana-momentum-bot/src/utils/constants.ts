// Why: SOL mint 주소가 4+ 파일에서 중복 선언되어 있었음 (executor, quoteGate, spreadMeasurer, index)
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;

// Why: 2026-04-07 Phase E — Jupiter Ultra saturated slippage (fake-fill) 임계값이
// tradeExecution, edgeInputSanitizer, trade-report, realized-replay-ratio 4곳에 복제되어
// 있어 drift 위험. 9000bps(90%) 이상은 `outputAmountResult=0` fake-fill로 간주한다.
export const FAKE_FILL_SLIPPAGE_BPS_THRESHOLD = 9000;
