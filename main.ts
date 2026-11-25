// Pump.fun Sharpe Sprint: High-Sharpe momentum sniper with dev buy filtering
import { BPS, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

interface SniperConfig {
  targetProfitBps: number;
  stopLossBps: number;
  maxHoldingSlots: number;
  minCreatorSolLamports: bigint;
  maxCreatorSolLamports: bigint;
  devBuyThresholdLamports: bigint;
  maxDevBuyLamports: bigint;
  minUniqueBuyers: number;
  maxUniqueBuyers: number;
  maxBuyAgeSlots: number;
  perOrderSlippageBps: number;
  defaultPositionLamports: bigint;
  minOrderSizeLamports: bigint;
}

const CONFIG: SniperConfig = {
  targetProfitBps: 2750,
  stopLossBps: 480,
  maxHoldingSlots: 14,
  minCreatorSolLamports: 500_000_000n,
  maxCreatorSolLamports: 30_000_000_000n,
  devBuyThresholdLamports: 300_000_000n,
  maxDevBuyLamports: 2_500_000_000n,
  minUniqueBuyers: 1,
  maxUniqueBuyers: 3,
  maxBuyAgeSlots: 3,
  perOrderSlippageBps: 10_000,
  defaultPositionLamports: 200_000_000n,
  minOrderSizeLamports: 5_000_000n,
};

interface TrackedCoin {
  mint: Pubkey;
  creator: Pubkey;
  spawnSlot: number;
  creatorBuyLamports: bigint;
  uniqueBuyers: Set<Pubkey>;
  creatorHasDumped: boolean;
  isBlacklisted: boolean;
  isCurveCompleted: boolean;
}

interface OpenPositionTrack {
  entrySlot: number;
  accumulatedFeesLamports: bigint;
  initialDevDumpState: boolean;
}

const PROTOCOL_FEE_BPS = 125n;

function calculateSellProceeds(tokenUnits: bigint, virtualQuote: bigint, virtualToken: bigint): bigint {
  if (tokenUnits <= 0n || virtualToken <= 0n) return 0n;
  const grossSol = (tokenUnits * virtualQuote) / (virtualToken + tokenUnits);
  const feeCut = (grossSol * PROTOCOL_FEE_BPS + BPS - 1n) / BPS;
  return grossSol - feeCut;
}

const monitoredCoins = new Map<Pubkey, TrackedCoin>();
const activePositions = new Map<Pubkey, OpenPositionTrack>();
const executingSells = new Set<Pubkey>();

function ingestBatchEvents(batch: Batch): void {
  for (const ev of batch.events) {
    if (ev.event === 'CreateEvent') {
      monitoredCoins.set(ev.mint, {
        mint: ev.mint,
        creator: ev.creator,
        spawnSlot: ev.slot,
        creatorBuyLamports: 0n,
        uniqueBuyers: new Set<Pubkey>(),
        creatorHasDumped: false,
        isBlacklisted: false,
        isCurveCompleted: false,
      });
    } else if (ev.event === 'TradeEvent') {
      const tracked = monitoredCoins.get(ev.mint);
      if (tracked === undefined) continue;
      const tradeSol = BigInt(ev.sol_amount);
      const isCreator = ev.user === tracked.creator;
      if (ev.is_buy) {
        if (isCreator && ev.slot === tracked.spawnSlot) {
          tracked.creatorBuyLamports += tradeSol;
        } else if (!isCreator) {
          tracked.uniqueBuyers.add(ev.user);
        }
      } else {
        if (isCreator) {
          tracked.creatorHasDumped = true;
        }
      }
    } else {
      const tracked = monitoredCoins.get(ev.mint);
      if (tracked !== undefined) {
        tracked.isCurveCompleted = true;
        tracked.isBlacklisted = true;
      }
    }
  }
}

function evaluateBatch(state: BotState, batch: Batch): OrderInput[] {
  ingestBatchEvents(batch);

  const outputOrders: OrderInput[] = [];
  const maxBatchOrders = state.hello.caps.max_orders_per_batch;
  const standardTxFee = state.txFeeLamports();

  for (const fill of batch.fills) {
    if (fill.client_id.startsWith('_')) {
      activePositions.delete(fill.mint);
      executingSells.delete(fill.mint);
      continue;
    }
    const posTrack = activePositions.get(fill.mint);
    if (fill.status !== 'rejected' && posTrack !== undefined) {
      posTrack.accumulatedFeesLamports += BigInt(fill.tx_fee_lamports);
    }
    if (fill.side === 'buy' && fill.status === 'filled' && posTrack === undefined) {
      const coin = monitoredCoins.get(fill.mint);
      activePositions.set(fill.mint, {
        entrySlot: fill.slot,
        accumulatedFeesLamports: BigInt(fill.tx_fee_lamports),
        initialDevDumpState: coin?.creatorHasDumped ?? false,
      });
    }
  }

  for (const m of [...executingSells]) {
    let isStillPending = false;
    for (const p of state.pending.values()) {
      if (p.order.mint === m && p.order.side === 'sell') {
        isStillPending = true;
        break;
      }
    }
    if (!isStillPending) executingSells.delete(m);
  }

  // Evaluate exits
  for (const [mintKey, holding] of state.positions) {
    if (outputOrders.length >= maxBatchOrders) break;
    if (executingSells.has(mintKey)) continue;

    const coinMeta = monitoredCoins.get(mintKey);
    let track = activePositions.get(mintKey);
    if (track === undefined) {
      track = {
        entrySlot: state.slot,
        accumulatedFeesLamports: standardTxFee,
        initialDevDumpState: coinMeta?.creatorHasDumped ?? false,
      };
      activePositions.set(mintKey, track);
    }

    const currentCurve = state.curves.get(mintKey);
    if (currentCurve === undefined) continue;

    const estimatedProceeds = calculateSellProceeds(
      holding.token_amount,
      currentCurve.virtual_quote_reserves,
      currentCurve.virtual_token_reserves
    ) - standardTxFee;

    const totalCostBasis = holding.cost_lamports + track.accumulatedFeesLamports;
    let shouldLiquidate = false;

    if (totalCostBasis > 0n) {
      const profitTargetLamports = (totalCostBasis * (BPS + BigInt(CONFIG.targetProfitBps))) / BPS;
      const stopLossFloorLamports = (totalCostBasis * (BPS - BigInt(CONFIG.stopLossBps))) / BPS;
      if (estimatedProceeds >= profitTargetLamports || estimatedProceeds <= stopLossFloorLamports) {
        shouldLiquidate = true;
      }
    }

    if (state.slot - track.entrySlot >= CONFIG.maxHoldingSlots) {
      shouldLiquidate = true;
    }

    if (coinMeta !== undefined && coinMeta.creatorHasDumped && !track.initialDevDumpState) {
      shouldLiquidate = true;
    }

    if (shouldLiquidate) {
      outputOrders.push({
        side: 'sell',
        mint: mintKey,
        token_amount: holding.token_amount,
        max_slippage_bps: 10_000,
      });
      executingSells.add(mintKey);
      if (coinMeta !== undefined) coinMeta.isBlacklisted = true;
    }
  }

  // Evaluate entries
  let deployableSol = state.freeCashLamports() - standardTxFee * BigInt(outputOrders.length);
  let openSlots = state.committedPositionCount();

  for (const coin of monitoredCoins.values()) {
    if (outputOrders.length >= maxBatchOrders) break;
    if (coin.isBlacklisted || coin.isCurveCompleted) continue;

    const ageSlots = state.slot - coin.spawnSlot;
    if (ageSlots > CONFIG.maxBuyAgeSlots) {
      coin.isBlacklisted = true;
      continue;
    }

    if (openSlots >= state.hello.caps.max_open_positions) continue;

    const curve = state.curves.get(coin.mint);
    if (curve === undefined || curve.complete) continue;
    if (coin.creatorHasDumped) {
      coin.isBlacklisted = true;
      continue;
    }

    const realReserveSol = curve.real_quote_reserves;
    if (realReserveSol < CONFIG.minCreatorSolLamports || realReserveSol > CONFIG.maxCreatorSolLamports) {
      continue;
    }

    if (coin.creatorBuyLamports < CONFIG.devBuyThresholdLamports || coin.creatorBuyLamports > CONFIG.maxDevBuyLamports) {
      continue;
    }

    const buyerCount = coin.uniqueBuyers.size;
    if (buyerCount < CONFIG.minUniqueBuyers || buyerCount > CONFIG.maxUniqueBuyers) {
      continue;
    }

    const maxPermittedBuy = state.maxBuyLamports(coin.mint);
    const targetAllocation = CONFIG.defaultPositionLamports;
    const orderLamports = targetAllocation < maxPermittedBuy ? targetAllocation : maxPermittedBuy;

    if (orderLamports < CONFIG.minOrderSizeLamports) continue;
    if (deployableSol < orderLamports + standardTxFee * 4n) continue;

    outputOrders.push({
      side: 'buy',
      mint: coin.mint,
      quote_lamports: orderLamports,
      max_slippage_bps: CONFIG.perOrderSlippageBps,
    });

    deployableSol -= (orderLamports + standardTxFee);
    coin.isBlacklisted = true;
    openSlots += 1;
  }

  return outputOrders;
}

await runBot({
  onBatch: evaluateBatch,
});
