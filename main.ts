// Pump.fun Sharpe Sprint: High-Sharpe momentum sniper with creator buy verification
// Clean zero-dependency TypeScript entrypoint running natively under Node 22 (revision 2)

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
