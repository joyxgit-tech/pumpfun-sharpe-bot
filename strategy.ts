// Autonomous Pump.fun Bonding Curve Sharpe Sniper
// Original algorithmic implementation for make.fun Sharpe Sprint

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface SniperConfig {
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
  pacingFillsTarget: number;
  targetWindowSeconds: number;
  defaultPositionLamports: bigint;
  minOrderSizeLamports: bigint;
}

export const DEFAULT_CONFIG: SniperConfig = {
  targetProfitBps: 2800,
  stopLossBps: 500,
  maxHoldingSlots: 12,
  minCreatorSolLamports: 500_000_000n,
  maxCreatorSolLamports: 30_000_000_000n,
  devBuyThresholdLamports: 300_000_000n,
  maxDevBuyLamports: 2_500_000_000n,
  minUniqueBuyers: 1,
  maxUniqueBuyers: 3,
  maxBuyAgeSlots: 3,
  perOrderSlippageBps: 10_000,
  pacingFillsTarget: 120,
  targetWindowSeconds: 21_600,
  defaultPositionLamports: 200_000_000n,
  minOrderSizeLamports: 5_000_000n,
};

interface TrackedCoin {
  mint: Pubkey;
  creator: Pubkey;
  spawnSlot: number;
  creatorBuyLamports: bigint;
  uniqueBuyers: Set<Pubkey>;
  nonCreatorVolumeBought: bigint;
  nonCreatorVolumeSold: bigint;
  creatorHasDumped: boolean;
  totalExecutions: number;
  sentBuyCount: number;
  totalLamportsDeployed: bigint;
  isBlacklisted: boolean;
  isCurveCompleted: boolean;
}

interface OpenPositionTrack {
  entrySlot: number;
  accumulatedFeesLamports: bigint;
  peakValuationLamports: bigint;
  initialDevDumpState: boolean;
}

const PROTOCOL_FEE_BPS = 125n;

function calculateSellProceeds(tokenUnits: bigint, virtualQuote: bigint, virtualToken: bigint): bigint {
  if (tokenUnits <= 0n || virtualToken <= 0n) return 0n;
  const grossSol = (tokenUnits * virtualQuote) / (virtualToken + tokenUnits);
  const feeCut = (grossSol * PROTOCOL_FEE_BPS + BPS - 1n) / BPS;
  return grossSol - feeCut;
}

export class SniperEngine {
  private readonly cfg: SniperConfig;
  private readonly monitoredCoins = new Map<Pubkey, TrackedCoin>();
  private readonly activePositions = new Map<Pubkey, OpenPositionTrack>();
  private readonly executingSells = new Set<Pubkey>();
  private firstEventTimestamp: number | null = null;
  private currentEventTimestamp = 0;
  private totalFillsRecorded = 0;

  constructor(customConfig: Partial<SniperConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...customConfig };
  }

  public evaluateBatch(state: BotState, batch: Batch): OrderInput[] {
    this.ingestEvents(batch);

    for (const ev of batch.events) {
      if (ev.block_time !== null) {
        if (this.firstEventTimestamp === null) this.firstEventTimestamp = ev.block_time;
        if (ev.block_time > this.currentEventTimestamp) this.currentEventTimestamp = ev.block_time;
      }
    }

    const outputOrders: OrderInput[] = [];
    const maxBatchOrders = state.hello.caps.max_orders_per_batch;
    const standardTxFee = state.txFeeLamports();

    // Process fill confirmations
    for (const fill of batch.fills) {
      if (fill.client_id.startsWith('_')) {
        this.activePositions.delete(fill.mint);
        this.executingSells.delete(fill.mint);
        continue;
      }
      if (fill.status === 'filled') {
        this.totalFillsRecorded += 1;
      }
      const posTrack = this.activePositions.get(fill.mint);
      if (fill.status !== 'rejected' && posTrack !== undefined) {
        posTrack.accumulatedFeesLamports += BigInt(fill.tx_fee_lamports);
      }
      if (fill.side === 'buy' && fill.status === 'filled' && posTrack === undefined) {
        const coin = this.monitoredCoins.get(fill.mint);
        this.activePositions.set(fill.mint, {
          entrySlot: fill.slot,
          accumulatedFeesLamports: BigInt(fill.tx_fee_lamports),
          peakValuationLamports: 0n,
          initialDevDumpState: coin?.creatorHasDumped ?? false,
        });
      }
    }

    // Clean resolved selling state
    for (const m of [...this.executingSells]) {
      let isStillPending = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === m && p.order.side === 'sell') {
          isStillPending = true;
          break;
        }
      }
      if (!isStillPending) this.executingSells.delete(m);
    }

    // 1. Evaluate Exits
    for (const [mintKey, holding] of state.positions) {
      if (outputOrders.length >= maxBatchOrders) break;
      if (this.executingSells.has(mintKey)) continue;

      const coinMeta = this.monitoredCoins.get(mintKey);
      let track = this.activePositions.get(mintKey);
      if (track === undefined) {
        track = {
          entrySlot: state.slot,
          accumulatedFeesLamports: standardTxFee,
          peakValuationLamports: 0n,
          initialDevDumpState: coinMeta?.creatorHasDumped ?? false,
        };
        this.activePositions.set(mintKey, track);
      }

      let currentCurve = state.curves.get(mintKey);
      if (currentCurve === undefined) continue;

      const estimatedProceeds = calculateSellProceeds(
        holding.token_amount,
        currentCurve.virtual_quote_reserves,
        currentCurve.virtual_token_reserves
      ) - standardTxFee;

      const totalCostBasis = holding.cost_lamports + track.accumulatedFeesLamports;
      if (estimatedProceeds > track.peakValuationLamports) {
        track.peakValuationLamports = estimatedProceeds;
      }

      let shouldLiquidate = false;
      if (totalCostBasis > 0n) {
        const profitTargetLamports = (totalCostBasis * (BPS + BigInt(this.cfg.targetProfitBps))) / BPS;
        const stopLossFloorLamports = (totalCostBasis * (BPS - BigInt(this.cfg.stopLossBps))) / BPS;

        if (estimatedProceeds >= profitTargetLamports) shouldLiquidate = true;
        if (estimatedProceeds <= stopLossFloorLamports) shouldLiquidate = true;
      }

      if (state.slot - track.entrySlot >= this.cfg.maxHoldingSlots) {
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
        this.executingSells.add(mintKey);
        if (coinMeta !== undefined) coinMeta.isBlacklisted = true;
      }
    }

    // 2. Evaluate Entries
    let deployableSol = state.freeCashLamports() - standardTxFee * BigInt(outputOrders.length);
    let openSlots = state.committedPositionCount();

    for (const coin of this.monitoredCoins.values()) {
      if (outputOrders.length >= maxBatchOrders) break;
      if (coin.isBlacklisted || coin.isCurveCompleted) continue;

      const ageSlots = state.slot - coin.spawnSlot;
      if (ageSlots > this.cfg.maxBuyAgeSlots) {
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
      if (realReserveSol < this.cfg.minCreatorSolLamports || realReserveSol > this.cfg.maxCreatorSolLamports) {
        continue;
      }

      if (coin.creatorBuyLamports < this.cfg.devBuyThresholdLamports || coin.creatorBuyLamports > this.cfg.maxDevBuyLamports) {
        continue;
      }

      const buyerCount = coin.uniqueBuyers.size;
      if (buyerCount < this.cfg.minUniqueBuyers || buyerCount > this.cfg.maxUniqueBuyers) {
        continue;
      }

      const maxPermittedBuy = state.maxBuyLamports(coin.mint);
      const targetAllocation = this.cfg.defaultPositionLamports;
      const orderLamports = targetAllocation < maxPermittedBuy ? targetAllocation : maxPermittedBuy;

      if (orderLamports < this.cfg.minOrderSizeLamports) continue;
      if (deployableSol < orderLamports + standardTxFee * 4n) continue;

      outputOrders.push({
        side: 'buy',
        mint: coin.mint,
        quote_lamports: orderLamports,
        max_slippage_bps: this.cfg.perOrderSlippageBps,
      });

      deployableSol -= (orderLamports + standardTxFee);
      coin.sentBuyCount += 1;
      coin.totalLamportsDeployed += orderLamports;
      coin.isBlacklisted = true; // One clean snipe entry per coin
      openSlots += 1;
    }

    return outputOrders;
  }

  private ingestEvents(batch: Batch): void {
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        this.monitoredCoins.set(ev.mint, {
          mint: ev.mint,
          creator: ev.creator,
          spawnSlot: ev.slot,
          creatorBuyLamports: 0n,
          uniqueBuyers: new Set<Pubkey>(),
          nonCreatorVolumeBought: 0n,
          nonCreatorVolumeSold: 0n,
          creatorHasDumped: false,
          totalExecutions: 0,
          sentBuyCount: 0,
          totalLamportsDeployed: 0n,
          isBlacklisted: false,
          isCurveCompleted: false,
        });
      } else if (ev.event === 'TradeEvent') {
        const tracked = this.monitoredCoins.get(ev.mint);
        if (tracked === undefined) continue;

        tracked.totalExecutions += 1;
        const tradeSol = BigInt(ev.sol_amount);
        const isCreator = ev.user === tracked.creator;

        if (ev.is_buy) {
          tracked.nonCreatorVolumeBought += tradeSol;
          if (isCreator && ev.slot === tracked.spawnSlot) {
            tracked.creatorBuyLamports += tradeSol;
          } else if (!isCreator) {
            tracked.uniqueBuyers.add(ev.user);
          }
        } else {
          if (isCreator) {
            tracked.creatorHasDumped = true;
          } else {
            tracked.nonCreatorVolumeSold += tradeSol;
          }
        }
      } else {
        const tracked = this.monitoredCoins.get(ev.mint);
        if (tracked !== undefined) {
          tracked.isCurveCompleted = true;
          tracked.isBlacklisted = true;
        }
      }
    }
  }
}
