import type { FastifyInstance } from "fastify";
import type {
  IntentStore,
  TriggerStore,
  PortfolioStore,
  StrategyStore,
  TradeStore,
  ApprovalStore,
} from "../lib/storage/index.js";
import { getBrokerAdapter } from "../lib/credentials.js";
import { syncOrders } from "../lib/brokers/dhan/order-sync.js";
import { computeOpenPositions } from "../lib/trade-utils.js";

export interface IntentsRouteOpts {
  intents: IntentStore;
  triggers: TriggerStore;
  portfolios: PortfolioStore;
  strategies: StrategyStore;
  trades: TradeStore;
  approvals: ApprovalStore;
}

export async function intentsRoute(
  fastify: FastifyInstance,
  opts: IntentsRouteOpts,
) {
  // GET /api/intents — list with optional status filter
  fastify.get("/api/intents", async (request) => {
    const query = request.query as { status?: string };
    if (!query.status) return opts.intents.list();
    const statuses = query.status.split(",").map(s => s.trim()) as import("../lib/storage/types.js").IntentStatus[];
    return opts.intents.list({ status: statuses });
  });

  // GET /api/intents/:id — get with expanded primitive summaries
  fastify.get("/api/intents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const intent = await opts.intents.get(id);
    if (!intent) {
      reply.code(404);
      return { error: "Not found" };
    }

    // Expand primitives
    const expanded = await Promise.all(
      intent.primitives.map(async (p) => {
        try {
          if (p.type === "trigger") {
            const trigger = await opts.triggers.get(p.id);
            const scheduledAt = trigger?.nextFireAt
              ?? (trigger?.condition.mode === "time" ? ((trigger.condition as { mode: "time"; fireAt?: string; at?: string }).fireAt ?? (trigger.condition as { mode: "time"; at?: string }).at) : undefined);
            return { ...p, trigger: trigger ? { name: trigger.name, status: trigger.status, nextFireAt: trigger.nextFireAt, scheduledAt, lastFiredAt: trigger.lastFiredAt } : null };
          }
          if (p.type === "portfolio") {
            const portfolio = await opts.portfolios.get(p.id);
            return { ...p, portfolio: portfolio ? { name: portfolio.name, allocation: portfolio.allocation, status: portfolio.status } : null };
          }
          if (p.type === "strategy") {
            const strategy = await opts.strategies.get(p.id);
            return { ...p, strategy: strategy ? { name: strategy.name } : null };
          }
          if (p.type === "order") {
            const trade = await opts.trades.get(p.id);
            return { ...p, trade: trade ? { symbol: trade.symbol, status: trade.status, quantity: trade.quantity, transactionType: trade.transactionType, executedPrice: trade.executedPrice } : null };
          }
        } catch {
          // ignore expansion errors
        }
        return p;
      })
    );

    return { ...intent, primitives: expanded };
  });

  // DELETE /api/intents/:id — cancel intent and linked triggers
  fastify.delete("/api/intents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const intent = await opts.intents.get(id);
    if (!intent) {
      reply.code(404);
      return { error: "Not found" };
    }
    if (intent.status === "cancelled") {
      return { ok: true, message: "Already cancelled" };
    }

    // Cancel linked triggers
    const triggerPrimitives = intent.primitives.filter(p => p.type === "trigger");
    let cancelledTriggers = 0;
    for (const p of triggerPrimitives) {
      try {
        const trigger = await opts.triggers.get(p.id);
        if (trigger && (trigger.status === "active" || trigger.status === "paused")) {
          await opts.triggers.setStatus(p.id, "cancelled");
          cancelledTriggers++;
        }
      } catch {
        // ignore
      }
    }

    await opts.intents.update(id, {
      status: "cancelled",
      resolvedAt: new Date().toISOString(),
    });

    return { ok: true, cancelledTriggers };
  });

  // POST /api/intents/:id/pause
  fastify.post("/api/intents/:id/pause", async (request, reply) => {
    const { id } = request.params as { id: string };
    const intent = await opts.intents.get(id);
    if (!intent) { reply.code(404); return { error: "Not found" }; }
    if (intent.status !== "active") return { ok: true, message: "Not active" };

    const triggerPrimitives = intent.primitives.filter(p => p.type === "trigger");
    for (const p of triggerPrimitives) {
      try {
        const trigger = await opts.triggers.get(p.id);
        if (trigger?.status === "active") await opts.triggers.setStatus(p.id, "paused");
      } catch {}
    }
    await opts.intents.update(id, { status: "paused" });
    return { ok: true };
  });

  // POST /api/intents/:id/resume
  fastify.post("/api/intents/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const intent = await opts.intents.get(id);
    if (!intent) { reply.code(404); return { error: "Not found" }; }
    if (intent.status !== "paused") return { ok: true, message: "Not paused" };

    const triggerPrimitives = intent.primitives.filter(p => p.type === "trigger");
    for (const p of triggerPrimitives) {
      try {
        const trigger = await opts.triggers.get(p.id);
        if (trigger?.status === "paused") await opts.triggers.setStatus(p.id, "active");
      } catch {}
    }
    await opts.intents.update(id, { status: "active" });
    return { ok: true };
  });

  // GET /api/intents/:id/performance — realized P&L and open positions for an intent
  fastify.get("/api/intents/:id/performance", async (request, reply) => {
    const { id } = request.params as { id: string };
    const intent = await opts.intents.get(id);
    if (!intent) {
      reply.code(404);
      return { error: "Not found" };
    }

    try {
      const broker = getBrokerAdapter();
      await syncOrders(broker, opts.trades);
    } catch { /* non-fatal */ }

    const trades = await opts.trades.list({ intentId: id });
    const openPositions = computeOpenPositions(trades.filter(t => t.status === "filled"));

    // Compute realized P&L: for each filled SELL, compute P&L against prior filled BUYs of the same symbol
    let realizedPnl = 0;
    const filledTrades = trades.filter(t => t.status === "filled");
    for (const sell of filledTrades.filter(t => t.transactionType === "SELL")) {
      const priorBuys = filledTrades.filter(
        t => t.transactionType === "BUY" && t.symbol === sell.symbol && t.createdAt <= sell.createdAt
      );
      if (priorBuys.length > 0 && sell.executedPrice != null) {
        const totalQty = priorBuys.reduce((s, t) => s + t.quantity, 0);
        const totalCost = priorBuys.reduce((s, t) => s + (t.executedPrice! * t.quantity), 0);
        if (totalQty > 0) {
          const avgCost = totalCost / totalQty;
          realizedPnl += +((sell.executedPrice - avgCost) * sell.quantity).toFixed(2);
        }
      }
    }

    type EnrichedPosition = (typeof openPositions)[number] & { ltp?: number; unrealizedPnl?: number };
    const enriched: EnrichedPosition[] = openPositions.map(p => ({ ...p }));
    let unrealizedPnl = 0;

    if (openPositions.length > 0) {
      try {
        const broker = getBrokerAdapter();
        const quotes = await broker.getQuote(openPositions.map(p => p.symbol));
        const ltpMap = Object.fromEntries(quotes.map(q => [q.symbol.toUpperCase(), q.lastPrice]));
        for (const pos of enriched) {
          const ltp = ltpMap[pos.symbol.toUpperCase()];
          if (ltp != null && ltp > 0) {
            pos.ltp = ltp;
            pos.unrealizedPnl = +((ltp - pos.avgBuyPrice) * pos.quantity).toFixed(2);
            unrealizedPnl += pos.unrealizedPnl;
          }
        }
        unrealizedPnl = +unrealizedPnl.toFixed(2);
      } catch (err) {
        console.warn("[intents/performance] LTP fetch failed:", err instanceof Error ? err.message : err);
      }
    }

    const deployedCapital = +enriched.reduce((s, p) => s + p.deployedCapital, 0).toFixed(2);

    let allocation: number | undefined;
    if (intent.portfolioId) {
      try {
        const portfolio = await opts.portfolios.get(intent.portfolioId);
        if (portfolio) allocation = portfolio.allocation;
      } catch { /* non-fatal */ }
    }

    return {
      intentId: id,
      ...(intent.portfolioId && { portfolioId: intent.portfolioId }),
      ...(allocation !== undefined && { allocation }),
      deployedCapital,
      ...(allocation !== undefined && { availableCapital: +(allocation - deployedCapital).toFixed(2) }),
      trades,
      openPositions: enriched,
      realizedPnl: +realizedPnl.toFixed(2),
      unrealizedPnl,
      tradeCount: trades.length,
    };
  });
}
