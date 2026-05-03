KOL Hunter가 아직 놓치고 있는 엣지
핵심 판단
주신 운영자료를 기준으로 보면, 지금 시스템의 가장 큰 부족점은 신호 탐지 자체보다 보이는 알파를 우리 지갑 기준의 실수익으로 바꾸는 과정입니다. 이 점은 외부 연구와도 맞아떨어집니다. 6,000개 이상의 밈코인 데이터를 사용한 최근 copy-trading 연구에서는, 선별된 “smart money” 지갑은 평균 14% 수익을 냈지만 현실적 마찰을 반영한 copier 수익은 거래당 3% 수준으로 줄었고, 심지어 동일 수량을 복제해도 bonding curve 구조 때문에 copier 쪽에 체계적인 execution disadvantage가 생긴다고 설명합니다. 즉, 관찰된 지갑 알파와 우리가 실제로 먹을 수 있는 알파는 다른 것입니다. 지금 smart-v3가 paper에선 일부 가능성을 보이는데 live wallet truth로는 약한 이유를 가장 잘 설명하는 축도 바로 여기입니다.

따라서 지금 전략의 진짜 공백은 “KOL을 더 찾는 것” 하나가 아니라, 크게 다섯 가지입니다. 상류 정보 부족(dev/deployer/funder/launchpad sale), copyable alpha와 observed alpha의 분리 부족, 실행 인프라 부족, 조작·군집화·crowding 필터 부족, 시장 폭과 follow-through를 반영한 상태 조건부 정책 부족입니다. 다시 말해 지금 구조는 “무엇을 볼 것인가”는 상당히 정리되어 있는데, “무엇을 실제로 거래할 가치가 있는가”와 “그걸 지갑 기준으로 어떻게 먹을 것인가”가 아직 약합니다.

실제로 엣지를 취하는 지갑들과의 차이
실제로 시장에서 돈을 버는 지갑들은 대체로 당신보다 더 이른 계층에서 정보를 잡거나, 같은 정보라도 더 잘 체결하거나, 또는 둘 다 합니다. 특히 Pump.fun 같은 launchpad 구간의 데이터는 굉장히 정보량이 큽니다. 최근 Solana 밈코인 연구는 4만 개가 넘는 launch를 분석해, 고위험 launch가 보통 짧은 sale duration, 적은 buyer 수, 더 큰 초기 매집, 더 높은 bundled-account 기반 집중도를 보인다고 보고했고, 이 리스크 스코어를 trading decision에 통합하면 손실을 최대 56.1% 줄일 수 있다고 제시했습니다. 같은 연구는 표본 내에서 1분 미만 sale 또는 100 holders 미만 launch의 94.9%가 고위험으로 분류되어, 간단한 초기 스크리닝만으로도 상당한 하방 제거 효과가 있음을 보여줍니다. 당신의 현재 3개 레인은 대부분 이보다 한 단계 뒤인 KOL/WS/pair 반응 이후를 보고 있어서, 구조적으로 늦을 가능성이 큽니다.

또 다른 차이는 creator·bundle·bot 인식 능력입니다. copy-trading 조작 연구는 Solana의 짧은 블록 간격과 public mempool 부재를 감안할 때, launch block에서 creator 직후 비-creator 매수들이 거의 동시에 붙는 패턴은 독립적 추격보다 사전 조율된 통제일 가능성이 높다고 설명합니다. 같은 연구는 bundle bot, sniper bot, bump bot, comment bot 같은 조작 패턴이 copy-trading을 정면으로 겨냥한다고 정리합니다. 즉, 실제 엣지 지갑과 같은 민트를 건드린다고 해서 같은 정보를 쓰는 것이 아니라, 그 지갑은 조작자인지, 초기 누적자인지, 진짜 smart money인지를 먼저 구분해야 합니다. 지금 전략은 Token-2022 위험 확장, concentration, sell-route probe까지는 이미 좋지만, creator/funder/bundled buyer graph에서 아직 한 박자 느립니다.

또 하나 중요한 차이는 지갑 수를 늘리는 것 자체가 엣지가 아니라는 점입니다. 기관 거래 연구는 정보 경쟁이 커지고 신호 상관관계가 높아질수록 trading이 더 공격적으로 변하고 alpha는 낮아진다고 보고합니다. 같은 연구는 alpha가 남아 있는 동안 작은 increments로 같은 종목을 계속 산다는 사실도 보여줍니다. 이 두 결과를 합치면, KOL을 많이 넣고 consensus bonus를 키우는 것만으로는 edge가 아니라 오히려 crowding tax가 될 수 있습니다. 지금 시스템은 이미 “fresh KOL consensus”를 잘 보고 있지만, 실제로 필요한 것은 단순 count가 아니라 effective independent count와 crowding penalty입니다. 이게 없으면 “3명 합의”가 실제론 같은 무리의 1.2명일 수 있습니다.

마지막으로, 실제 수익 지갑들은 off-chain 맥락도 더 많이 사용합니다. 최근 multimodal memecoin 연구는 텍스트 설명, 로고, 커뮤니티 코멘트, 타임스탬프, likes 같은 데이터를 합친 CoinVibe/CoinCLIP 계열 접근이 “viable vs low-quality/bot-driven” 프로젝트를 가르는 데 유의미하다고 봅니다. pure_ws가 지금 pair context, pair age, entry price, markout coverage가 비어 있는 상태라면, 이 레인은 단순히 아직 약한 것이 아니라 판별에 필요한 입력 자체가 부족한 상태에 가깝습니다.

현재 세 레인에서 특히 부족한 부분
smart-v3는 철학적으로는 맞습니다. 주신 자료상 이 레인은 여전히 “5x+ convexity를 노리는 본선”이고, 실제로 외부 문헌도 거래비용이 있는 환경에서는 무조건 자주 트레이드하는 것보다 state-conditional policy와 no-trade zone이 더 합리적이라고 말합니다. 문제는 지금 smart-v3가 관측된 wallet alpha를 copyable alpha로 바꾸는 모형이 없다는 점입니다. 이 때문에 KOL 점수는 높아도, 실제로는 너무 늦었거나, 조작자 군집이거나, landing이 나빠서, 또는 post-cost 기대값이 음수인 거래를 live로 건드릴 수 있습니다. 현재 부족한 것은 “조금 더 좋은 pullback 값”이 아니라, 이 민트를 이 시점에 이 티켓으로 우리가 따라가도 되는가를 묻는 monetizability gate입니다.

rotation-v1은 아이디어 자체가 나쁘지 않지만, 가장 비용 민감한 영역을 건드리고 있다는 점을 과소평가하면 안 됩니다. DEX 시장 품질 연구는 고정적인 gas/transaction 비용 때문에 DEX가 작고 중간 크기 주문에서는 비싸고, 상대적으로 큰 주문에서야 비용 경쟁력이 생긴다고 봅니다. solver-based DEX 연구도 execution improvement가 대체로 더 큰 사이즈나 유동성 파편화가 큰 경우에 더 뚜렷하고, 소형 거래에서는 오프체인 기준가 대비 markout이 계속 음수인 경우가 많다고 보고합니다. 주신 자료에서 underfill 표본이 token-only로는 흥미로워 보여도 rent-adjusted stress에서 약한 이유가 바로 이 구간의 본질입니다. rotation은 TP/SL 미세조정보다 먼저, 모든 비용 이후에도 남는 monetizable continuation이 실제로 있는지를 증명해야 합니다.

pure_ws는 아직 전략이라기보다 증거 수집 인프라에 더 가깝습니다. 이건 부정적인 평가가 아니라 정확한 분류입니다. 멀티모달/launch-context 연구들은 공통적으로 context, holdings, community, time-series를 함께 넣어야 분류력이 생긴다고 말하는데, pure_ws는 주신 자료상 현재 entry price·pair age·context known·prewarm success가 비어 있거나 낮습니다. 이 상태에서 pure_ws를 alpha engine으로 보기는 어렵고, 우선은 context pipeline 복구와 markout coverage 회복이 먼저입니다.

가장 큰 보강 포인트
가장 ROI가 큰 보강은 새로운 KOL 10명을 더 넣는 것보다, origin/dev 계층을 별도 lane으로 만드는 것입니다. 구체적으로는 creator, deployer, first funder, launchpad 단계의 first buyers, bundled buyers를 한 그래프로 묶고, 여기에 “과거 non-rug history”, “migration 전 buyer/holder structure”, “creator-linked same-block coordination”를 넣어 KOL보다 한 단계 상류의 gate를 만들어야 합니다. 지금 전략은 KOL 반응 이후를 보는 downstream lane이 강한데, 실제 시장의 큰 수익 지갑 중 일부는 그보다 먼저 움직입니다. 따라서 smart-v3를 더 잘 만들기만 해서는 한계가 있고, origin layer를 하나 추가해야 구조적으로 늦지 않습니다.

두 번째는 KOL score를 copyability score로 바꾸는 것입니다. 지금처럼 weighted KOL score와 consensus bonus만으로는 “이 지갑이 벌었는가”는 보지만 “내가 복제해서 벌 수 있는가”는 못 봅니다. 외부 연구를 종합하면 여기에 반드시 들어가야 할 항은 다섯 개입니다: posterior alpha, expected execution drag, fixed costs, manipulation risk, crowding tax입니다. 실무적으로는 다음과 같은 형태가 되어야 합니다.

text
복사
CopyableEdge
= PosteriorAlpha

- ExpectedExecutionDrag
- FixedCosts
- ManipulationRisk
- CrowdingTax
  이 점수는 지갑 과거 PnL만 보지 말고, copier return gap, bonding-curve disadvantage, trade size 대비 friction, same-block/creator bundle risk, effective independent KOL count를 함께 반영해야 합니다. Kelly나 sizing은 이 점수가 양수라는 것이 먼저 증명된 다음에 붙는 두 번째 문제입니다.

세 번째는 execution stack을 전략의 일부로 승격하는 것입니다. 공식 네트워크 문서와 Helius, Jito Labs, Jupiter 문서를 합치면 결론은 매우 명확합니다. Solana에서 우선순위 수수료는 현재 leader가 당신의 트랜잭션을 더 앞에 배치하게 만들고, priority fee는 compute unit price × compute unit limit로 계산되므로 CU limit를 과도하게 잡으면 불필요하게 많이 냅니다. Helius는 latency-sensitive trader에게 dynamic priority fees, optimized CU, maxRetries=0, robust retry, 지역 co-location, cache warming, 그리고 ultra-low-latency가 필요하면 Sender 사용을 권합니다. Sender는 validator와 Jito에 dual routing하고, Jito ShredStream은 hundreds of milliseconds를 절약할 수 있다고 설명합니다. Jito의 dontfront는 bundle에서 당신의 트랜잭션을 인덱스 0으로 강제해 sandwich 위험을 줄이며, 공식 가이드는 tight slippage와 적절한 tips/priority fees를 함께 권합니다. Jupiter도 fast mode가 routing latency를 줄이지만 route optimality와 fee estimation 정확도를 일부 희생한다고 분명히 적습니다. 이건 단순 최적화가 아니라, live와 paper 차이를 줄이는 핵심 엣지입니다.

네 번째는 전역 hardcut/trail 최적화보다 state-conditional no-trade / hold policy입니다. alpha decay와 transaction-cost 논문은 최적 정책이 no-trade zone 형태를 띠며, 신호가 그 경계를 넘을 때만 거래해야 한다고 설명합니다. lagged predictive power가 더 오래 남는 환경일수록 multi-period 정책의 이점이 커지고, NBER 거래비용 연구도 turnover를 줄이는 buy/hold spread가 비용 완화에 매우 효과적이라고 말합니다. 이걸 지금 전략에 번역하면, “hardcut을 -10%에서 -20%로 바꿀까?”가 첫 질문이 아니라, 어떤 민트/어떤 스타일/어떤 day quality에서만 hold를 늘릴 것인가가 첫 질문이어야 합니다. 조건 없는 글로벌 완화는 right tail과 rug tail을 동시에 키웁니다.

다섯 번째는 장의 질을 ‘뱅어 한 개’가 아니라 breadth와 follow-through로 측정하는 것입니다. 최근 memecoin fragility 연구는 memecoins를 volatility spillovers, whale dominance, sentiment amplification의 결합으로 보며, 반대로 solver execution 연구는 realized volatility 자체와 execution welfare 사이에 뚜렷한 상관이 약하다고 보고합니다. 이 둘을 합치면 “오늘 20x 하나 나왔다”는 사실만으로 risk-on을 판단하는 것은 너무 거칩니다. 더 유효한 day quality는 tracked mint 중 +50/+100/+400 도달 비율, first major sell 이후 continuation, 30분·2시간 생존율, creator-linked concentration, sell-route stability 같은 breadth/follow-through 지표를 함께 본 값이어야 합니다. 이 부분은 문헌과 주신 아키텍처를 합친 제 해석이지만, 현재 시장 구조에는 그 해석이 더 타당합니다.

여섯 번째는 검증 체계를 엣지의 일부로 보는 태도입니다. Bailey와 López de Prado의 PBO/DSR 논문은, 전략 선택과 파라미터 탐색 과정 자체가 성과를 부풀릴 수 있으므로 CSCV와 DSR로 통제해야 한다고 설명합니다. 지금처럼 smart-v3, rotation, underfill, pure_ws, 각종 trail/hardcut 조합이 많아지는 구조에서는 이 검증 계층이 없으면 “좋아 보이는 arm”을 계속 채택하다가 selection bias로 미끄러지기 쉽습니다. 다시 말해, 지금 부족한 것은 더 많은 아이디어가 아니라 아이디어를 죽이는 규율이기도 합니다.

지금 당장 가장 실질적인 바뀜
제가 보기에 가장 실질적인 변화는 세 가지입니다.

첫째, smart-v3 앞단에 origin/dev/funder lane을 shadow로 추가해야 합니다. KOL consensus는 유지하되, 진입 전에 launchpad-sale 위험도와 creator-linked bundle 징후를 먼저 평가하는 구조가 필요합니다. 이게 있어야 hold 완화도 안전하게 할 수 있습니다.

둘째, rotation-v1과 smart-v3 모두에 monetizable-edge gate를 넣어야 합니다. 이 gate는 최소한 ATA rent + network fee + priority fee/tip + expected landing drag + sell-route risk를 entry 전에 차감한 기대 로그성장이 양수일 때만 열려야 합니다. robust Kelly나 fractional Kelly는 그 다음 단계입니다. Kelly는 sizing 도구이지, 음수 edge를 양수로 바꿔주지 않습니다.

셋째, 실행 인프라를 “옵션”이 아니라 전략 본체로 올려야 합니다. 주신 전략의 next bottleneck은 언어보다 먼저 landing quality일 가능성이 큽니다. transaction-specific priority fee, CU limit simulation, Jito path, dual routing, regional placement, dontfront, post-trade landing attribution이 먼저 들어가야 합니다. live가 paper를 따라가지 못할 때 가장 먼저 의심해야 할 것도 exit 파라미터보다 이 계층입니다.

하지 말아야 할 변경
반대로, 지금 당장 하지 않는 편이 나은 것도 분명합니다. 첫째, KOL 수를 크게 늘리는 것만으로 smart-v3를 강화하려는 시도는 보류하는 편이 낫습니다. crowding과 상관 신호는 alpha를 낮출 수 있기 때문입니다. effective independent count와 crowding penalty가 먼저 들어가야 합니다.

둘째, global hardcut 완화는 아직 이르다고 봅니다. no-trade zone과 multi-period 논문은 state conditional 완화를 시사하지, 전 민트 공통 완화를 지지하지 않습니다. 지금처럼 dev/creator/bundle risk가 충분히 걸러지지 않은 상태에서 전역 hold를 늘리면, right tail을 더 먹기 전에 먼저 left tail이 커질 확률이 높습니다.

셋째, rotation과 pure_ws의 live 승격도 아직 빠릅니다. small-ticket 회전은 마찰 비용의 역풍을 가장 많이 받고, pure_ws는 아직 입력 데이터 품질 자체가 전략 평가를 버틸 수준이 아닙니다. 외부 문헌도 소형 거래와 저품질 memecoin 판별의 어려움을 반복해서 보여줍니다.

최종 권고
요약하면, 지금 전략은 방향이 틀린 것이 아니라 엣지가 생기는 위치보다 한두 단계 아래에서 너무 열심히 잘하고 있는 구조에 가깝습니다. 실제 시장에서 엣지를 취하는 지갑들과 비교했을 때 가장 큰 부족점은 상류 정보 부족, copyability 평가 부족, 실행 품질 부족입니다. 그 다음 단계의 부족점이 effective independence / crowding, multimodal context, breadth-based regime, 엄격한 검증 체계입니다.

그래서 우선순위는 이렇게 잡는 것이 맞습니다. origin/dev/funder shadow lane 구축 → copyable-edge gate 구축 → execution stack 강화 → effective KOL count와 crowding penalty 도입 → state-conditional hold/no-trade 정책 → 그 다음에야 sizing/Kelly입니다. 이 순서가 바뀌면, 지금처럼 “paper에는 있어 보이는 엣지”가 계속 “live wallet truth에서는 희미한 엣지”로 남을 가능성이 큽니다. 반대로 이 순서대로 가면, smart-v3는 본선으로 남고, rotation-v1은 보조 수확 레인으로 분리되며, pure_ws는 증거 수집 장치에서 실제 전략 후보로 올라올 수 있습니다. 지금 부족한 것은 더 많은 규칙이 아니라, 더 이른 정보와 더 엄격한 monetization discipline입니다.
