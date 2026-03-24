import type { FastifyInstance } from "fastify";
import type { IntentStore, TriggerStore, TradeStore } from "../lib/storage/index.js";
import { getBrokerAdapter } from "../lib/credentials.js";

export interface HaltRouteOpts {
  intents: IntentStore;
  triggers: TriggerStore;
  trades: TradeStore;
}

export async function haltRoute(fastify: FastifyInstance, opts: HaltRouteOpts) {
  fastify.post("/api/halt", async (_req, _reply) => {
    const { intents, triggers, trades } = opts;

    // 1. Pause all active intents and their triggers
    let pausedIntents = 0;
    const activeIntents = await intents.list({
      status: ["processing", "clarifying", "planning", "active"],
    });
    for (const intent of activeIntents) {
      const triggerPrimitives = intent.primitives.filter(p => p.type === "trigger");
      for (const p of triggerPrimitives) {
        try {
          const trigger = await triggers.get(p.id);
          if (trigger?.status === "active") await triggers.setStatus(p.id, "paused");
        } catch {}
      }
      try {
        await intents.update(intent.id, { status: "paused" });
        pausedIntents++;
      } catch {}
    }

    // 2. Cancel pending broker orders
    let cancelledOrders = 0;
    const pendingTrades = await trades.list({ status: "pending" });
    let broker: ReturnType<typeof getBrokerAdapter> | null = null;
    try { broker = getBrokerAdapter(); } catch {}

    for (const tr of pendingTrades) {
      if (broker) { try { await broker.cancelOrder(tr.orderId); } catch {} }
      try { await trades.update(tr.id, { status: "cancelled" }); cancelledOrders++; } catch {}
    }

    return { ok: true, halted: { intents: pausedIntents, orders: cancelledOrders } };
  });
}
