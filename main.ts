// Pump.fun Sharpe Sprint: High-Sharpe momentum sniper with creator buy verification
// Clean zero-dependency TypeScript entrypoint running natively under Node 22 (engine v1.1)

import { runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';
import { SniperEngine, DEFAULT_CONFIG } from './strategy.ts';

const engine = new SniperEngine(DEFAULT_CONFIG);

await runBot({
  onBatch: (state: BotState, batch: Batch): OrderInput[] => engine.evaluateBatch(state, batch),
});
