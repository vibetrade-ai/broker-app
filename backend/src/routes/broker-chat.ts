import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type {
  ConversationStore,
  IntentStore,
  TriggerStore,
  PortfolioStore,
  StrategyStore,
  TradeStore,
  ApprovalStore,
  IntentPrimitive,
  IntentType,
  ClarificationQuestion,
} from "../lib/storage/index.js";
import { getBrokerAdapter, getAnthropicClient } from "../lib/credentials.js";
import { TOOLS, type ToolDefinition, createRegisterTriggerTool, createPortfolioTools, createStrategyTools } from "../lib/tools.js";
import type { ClientMessage, ServerMessage } from "../types.js";
import { BrokerAuthError } from "../lib/brokers/errors.js";
import { getSecurityId } from "../lib/brokers/dhan/instruments.js";

interface BrokerChatOpts {
  store: ConversationStore;
  intents: IntentStore;
  triggers: TriggerStore;
  portfolios: PortfolioStore;
  strategies: StrategyStore;
  trades: TradeStore;
  approvals: ApprovalStore;
}

const ASK_CLARIFICATION_TOOL: Anthropic.Tool = {
  name: "ask_clarification",
  description: "Call this BEFORE creating any primitives when the intent leaves critical decisions ambiguous (e.g. exact amount, quantity, which exchange, order type, schedule time, stop-loss level). Ask specific questions with explicit options. Always mark one option as recommended.",
  input_schema: {
    type: "object" as const,
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Short unique id, e.g. 'q1'" },
            question: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  value: { type: "string" },
                  label: { type: "string" },
                  recommended: { type: "boolean" },
                },
                required: ["value", "label"],
              },
            },
          },
          required: ["id", "question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

const PROPOSE_PLAN_TOOL: Anthropic.Tool = {
  name: "propose_plan",
  description: "Propose an implementation plan to the user before executing. Call this after gathering clarifications and before creating any orders, triggers, portfolios, or strategies. The user must approve before you proceed. Only describe what the user explicitly asked for. If you believe something is a valuable addition (e.g. a stop-loss), you must have asked about it in clarifications first with a recommended option. If you didn't ask about it, do not add it.",
  input_schema: {
    type: "object" as const,
    properties: {
      plan: { type: "string", description: "Structured markdown description of what you will implement: instruments, conditions, order types, quantities. Only include what the user asked for or confirmed in clarifications." },
      summary: { type: "string", description: "One-sentence summary, e.g. 'Buy 50 RELIANCE if RSI < 30, sell when RSI > 70'" },
    },
    required: ["plan", "summary"],
  },
};

const INTENT_COMPLETE_TOOL: Anthropic.Tool = {
  name: "intent_complete",
  description: "Call this when you have finished creating all necessary primitives to fulfill the intent. Pass the classified type, a one-sentence summary, and plain-English entry/exit conditions whenever they are known.",
  input_schema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        enum: ["atomic", "conditional", "scheduled", "agentic", "composite"],
        description: "Classification of the intent type",
      },
      title: {
        type: "string",
        description: "3–6 word noun-phrase label for the intent. No verbs. Examples: 'Weekly NIFTYBEES SIP', 'RELIANCE RSI Entry', 'HDFC Stop-Loss Guard', 'Nifty50 Momentum Watch'.",
      },
      summary: {
        type: "string",
        description: "One sentence describing what was created, e.g. 'Set a recurring trigger to buy ₹5000 of NIFTYBEES every Monday at 9:15 AM'",
      },
      entry_condition: {
        type: "string",
        description: "One short sentence (max ~100 chars) describing only how/when the position is entered. Never include exit info.",
      },
      exit_condition: {
        type: "string",
        description: "One short sentence (max ~100 chars) describing ONLY when/how to exit. Never repeat entry conditions here. If no automatic exit, write 'No automatic exit'.",
      },
    },
    required: ["type", "title", "summary", "entry_condition", "exit_condition"],
  },
};

const SYSTEM_PROMPT = `You are a trading assistant connected to the user's brokerage account. You can answer questions about the market, portfolio, and positions using the available tools. When the user wants to place a trade, set up an automation, or create a strategy, use the intent workflow below.

IMPORTANT — tool usage rules:
- Always call the relevant tool FIRST before writing any response. Never start writing an answer and then call a tool mid-sentence.
- After receiving tool results, write your full response based on the data.
- Do not narrate what you are about to do. Just call the tool silently and then present the result.
- Only call tools that the user explicitly asked for. Do not make unsolicited tool calls.
- Do not offer unsolicited opinions or proactively suggest trades.

IMPORTANT — framing rules:
- You are the one doing the work. Never say things like "a specialist will handle this", "you'll be notified", "I'll pass this along", or anything that implies a human intermediary will take over. You handle everything yourself.
- After completing an intent, give a brief, factual confirmation of what you've done. Do not promise future notifications.

Formatting:
- Format monetary values in Indian Rupees (₹) with Indian number formatting (e.g. ₹1,23,456.78)
- Use markdown tables for structured data (positions, orders)
- Be concise — lead with the numbers, add brief commentary after

Error handling:
- If a tool returns an error starting with "TOOL_ERROR:", explain what went wrong in plain, friendly language — no technical jargon, no HTTP status codes, no internal error codes
- If the error is "TOOL_ERROR: TOKEN_EXPIRED", tell the user their session has expired and they need to reconnect — do not call any more tools

## Intent Workflow

Use this workflow when the user wants to place a trade, set up an automation, or create a strategy. Skip it for pure information queries.

### Turn budget
Minimise turns at every step:
- Call ask_clarification ONCE with ALL questions in a single call — never split into multiple asks.
- Call propose_plan ONCE with the complete plan.
- After plan approval, call ALL creation tools simultaneously in a single response — do not create primitives one at a time. For example, if you need to place 10 orders and register 2 triggers, emit all 12 tool calls in the same response.
- Call intent_complete in the SAME response as your last creation tool — do not use a separate turn for it.
- Never call a market data tool unless strictly required to determine a symbol or price needed for a creation call.

### Workflow

**Step 1 — Clarify (skip if intent is fully unambiguous)**
Call ask_clarification once with ALL questions.

**Step 2 — Plan**
Call propose_plan once with a complete, structured plan. Wait for approval.

**Step 3 — Create (one turn)**
After approval, emit ALL of the following in a single response:
- create_portfolio (if needed)
- create_strategy (if needed)
- ALL place_order calls (batch every order together)
- ALL register_trigger calls (batch every trigger together)
- intent_complete

Do NOT interleave creation with analysis. Do NOT wait for one creation to finish before starting another.

### Guidelines
- Immediate execution (buy/sell now): call place_order
- Conditional (when X, do Y): call register_trigger with a condition
- Scheduled/recurring: call register_trigger with recurring=true
- Agentic monitoring (watch X and decide): call register_trigger with action.type="reasoning_job"
- Portfolio/fund management: call create_portfolio first in the same response as register_trigger/place_order. Do NOT specify portfolioId in those downstream calls — the server will automatically inject the portfolioId from the create_portfolio result before executing them.
- Use product_type: "CNC" for equity delivery (long-term holds). Use "INTRADAY" only when the user explicitly asks for same-day trades.

### intent_complete fields
- type: atomic | conditional | scheduled | agentic | composite
- summary: one sentence describing what you created
- entry_condition: ONE sentence (≤100 chars), entry only — what triggers the entry
- exit_condition: ONE sentence (≤100 chars), exit only — what closes the position. Never include entry info here.

### Plan constraints
- Your plan must only contain what the user asked for or what they confirmed in clarifications.
- If you think something is a valuable addition (stop-loss, position sizing, extra instruments), raise it as a clarification question with a recommended option — then include it only if confirmed.
- Never silently add features, conditions, or parameters that were not discussed.`;

function extractPrimitives(toolName: string, result: string): IntentPrimitive[] {
  const primitives: IntentPrimitive[] = [];
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (parsed.triggerId && typeof parsed.triggerId === "string") {
      primitives.push({ type: "trigger", id: parsed.triggerId });
    }
    if (parsed.portfolioId && typeof parsed.portfolioId === "string") {
      primitives.push({ type: "portfolio", id: parsed.portfolioId });
    }
    if (parsed.strategyId && typeof parsed.strategyId === "string") {
      primitives.push({ type: "strategy", id: parsed.strategyId });
    }
    if (parsed.orderId && typeof parsed.orderId === "string") {
      primitives.push({ type: "order", id: parsed.orderId });
    }
  } catch {
    // non-JSON result; ignore
  }
  return primitives;
}

export async function brokerChatRoute(fastify: FastifyInstance, opts: BrokerChatOpts) {
  fastify.get("/ws/broker-chat", { websocket: true }, async (socket, request) => {
    const conversationId =
      (request.query as { conversationId?: string }).conversationId ?? randomUUID();
    const conversationHistory: Anthropic.MessageParam[] = await opts.store.load(conversationId);

    // Create factory tools per-connection
    const registerTriggerTool = createRegisterTriggerTool(opts.triggers);
    const portfolioToolList = createPortfolioTools(opts.portfolios, opts.triggers, opts.trades);
    const strategyToolList = createStrategyTools(opts.strategies, opts.triggers);

    // Build combined tool map for handler dispatch
    const intentToolMap: Record<string, ToolDefinition> = {};
    const INTENT_TOOL_NAMES = [
      "get_quote", "get_index_quote", "get_historical_data", "compute_indicators",
      "fetch_news", "get_market_status", "search_instruments", "place_order",
    ];
    for (const name of INTENT_TOOL_NAMES) {
      if (TOOLS[name]) intentToolMap[name] = TOOLS[name];
    }
    intentToolMap["register_trigger"] = registerTriggerTool;
    for (const t of portfolioToolList) {
      if (t.definition.name === "create_portfolio") intentToolMap["create_portfolio"] = t;
    }
    for (const t of strategyToolList) {
      if (t.definition.name === "create_strategy") intentToolMap["create_strategy"] = t;
    }

    // Build tool definitions list (intent tools first, then read-only, deduplicated)
    const readOnlyToolDefs: Anthropic.Tool[] = Object.values(TOOLS)
      .filter(t => !t.requiresApproval)
      .map(t => t.definition);
    const intentExecDefs: Anthropic.Tool[] = Object.values(intentToolMap).map(t => t.definition as Anthropic.Tool);
    const allToolDefs: Anthropic.Tool[] = [
      ...intentExecDefs,
      ...readOnlyToolDefs,
      ASK_CLARIFICATION_TOOL,
      PROPOSE_PLAN_TOOL,
      INTENT_COMPLETE_TOOL,
    ].filter((t, i, arr) => arr.findIndex(x => x.name === t.name) === i);

    function send(msg: ServerMessage) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    }

    // Per-connection pause/resume state
    let pendingUserResponse: {
      kind: "clarification" | "plan";
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
    } | null = null;
    let isProcessing = false;

    socket.on("message", async (raw: Buffer | string) => {
      let clientMsg: ClientMessage;
      try {
        clientMsg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send({ type: "error", message: "Invalid JSON message" });
        return;
      }

      // Routing guard: resolve pending clarification/plan responses first
      if (pendingUserResponse !== null) {
        if (clientMsg.type === "clarification_response" || clientMsg.type === "plan_response") {
          pendingUserResponse.resolve(clientMsg);
          pendingUserResponse = null;
          return;
        } else {
          send({ type: "error", message: "Awaiting your response to the current prompt" });
          return;
        }
      }

      if (clientMsg.type !== "message") return;

      if (isProcessing) {
        send({ type: "error", message: "Already processing a request" });
        return;
      }

      isProcessing = true;
      const saveFrom = conversationHistory.length;

      try {
        for (const msg of clientMsg.messages) {
          if (msg.role !== "user" && msg.role !== "assistant") continue;
          conversationHistory.push({ role: msg.role, content: msg.content });
        }

        const intentText = [...clientMsg.messages].reverse().find(m => m.role === "user")?.content ?? "";

        let broker = null;
        try { broker = getBrokerAdapter(); } catch { /* not configured */ }

        const systemPrompt = SYSTEM_PROMPT + (broker
          ? `\n\n<broker>\nName: ${broker.capabilities.name}\nMarkets: ${broker.capabilities.markets.join(", ")}\nAsset classes: ${broker.capabilities.assetClasses.join(", ")}\n</broker>`
          : "");

        const anthropic = getAnthropicClient();
        let tokenExpired = false;

        // Per-request intent state
        const intentId = randomUUID();
        const collectedPrimitives: IntentPrimitive[] = [];
        let portfolioIdFromPrimitives: string | undefined;
        let intentCompleted = false;

        while (true) {
          const stream = anthropic.messages.stream({
            model: "claude-sonnet-4-6",
            max_tokens: 8096,
            system: systemPrompt,
            tools: allToolDefs,
            messages: conversationHistory,
          });

          stream.on("text", (text) => {
            send({ type: "text_delta", content: text });
          });

          const finalMessage = await stream.finalMessage();

          const toolUses: Anthropic.ToolUseBlock[] = [];
          for (const block of finalMessage.content) {
            if (block.type === "tool_use") toolUses.push(block);
          }

          conversationHistory.push({ role: "assistant", content: finalMessage.content });

          if (finalMessage.stop_reason === "end_turn" || toolUses.length === 0) {
            send({ type: "done" });
            if (tokenExpired) send({ type: "token_expired" });
            break;
          }

          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const toolUse of toolUses) {
            const args = toolUse.input as Record<string, unknown>;

            if (toolUse.name === "ask_clarification") {
              const typedArgs = args as { questions: ClarificationQuestion[] };
              send({ type: "ask_clarification", questions: typedArgs.questions });

              const response = await new Promise<unknown>((resolve, reject) => {
                pendingUserResponse = { kind: "clarification", resolve, reject };
                setTimeout(() => {
                  if (pendingUserResponse?.kind === "clarification") {
                    pendingUserResponse = null;
                    reject(new Error("Clarification timed out after 10 minutes"));
                  }
                }, 10 * 60 * 1000);
              });

              const answers = (response as { answers: Record<string, string> }).answers;
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: JSON.stringify({ answers }),
              });
              continue;
            }

            if (toolUse.name === "propose_plan") {
              const typedArgs = args as { plan: string; summary: string };
              send({ type: "propose_plan", plan: typedArgs.plan, summary: typedArgs.summary });

              const response = await new Promise<unknown>((resolve, reject) => {
                pendingUserResponse = { kind: "plan", resolve, reject };
                setTimeout(() => {
                  if (pendingUserResponse?.kind === "plan") {
                    pendingUserResponse = null;
                    reject(new Error("Plan approval timed out after 10 minutes"));
                  }
                }, 10 * 60 * 1000);
              });

              const planResponse = response as { approved: boolean; feedback?: string };
              if (planResponse.approved) {
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: JSON.stringify({ approved: true, message: "User approved the plan. Proceed with implementation." }),
                });
              } else {
                const feedback = planResponse.feedback ?? "User requested changes but provided no specific feedback.";
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: JSON.stringify({ approved: false, feedback, message: "User rejected the plan. Review their feedback and propose a revised plan or ask for clarification." }),
                });
              }
              continue;
            }

            if (toolUse.name === "intent_complete") {
              const typedArgs = args as { type: IntentType; title?: string; summary: string; entry_condition?: string; exit_condition?: string };
              const now = new Date().toISOString();
              const intent = {
                id: intentId,
                text: intentText,
                type: typedArgs.type,
                status: "active" as const,
                title: typedArgs.title,
                summary: typedArgs.summary,
                entryCondition: typedArgs.entry_condition,
                exitCondition: typedArgs.exit_condition,
                primitives: collectedPrimitives,
                createdAt: now,
                resolvedAt: now,
              };

              await opts.intents.append(intent);
              send({ type: "intent_complete", intent });
              intentCompleted = true;

              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: JSON.stringify({ ok: true }),
              });
              continue;
            }

            // Dispatch to intent tool map, then fall back to TOOLS
            const toolDef = intentToolMap[toolUse.name] ?? TOOLS[toolUse.name];
            if (!toolDef) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: `TOOL_ERROR: Unknown tool "${toolUse.name}"`,
              });
              continue;
            }

            // Inject intentId and portfolioId for creation tools
            if (toolUse.name === "register_trigger") {
              args.intentId = intentId;
              if (portfolioIdFromPrimitives && !args.portfolioId) {
                args.portfolioId = portfolioIdFromPrimitives;
              }
            }
            if (toolUse.name === "create_strategy") {
              args.intentId = intentId;
            }
            if (toolUse.name === "place_order") {
              args.intentId = intentId;
              if (portfolioIdFromPrimitives && !args.portfolioId) {
                args.portfolioId = portfolioIdFromPrimitives;
              }
            }

            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const result = await toolDef.handler(args, broker as any);
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });

              // Auto-record every successful place_order
              if (toolUse.name === "place_order") {
                try {
                  const parsed = JSON.parse(result) as Record<string, unknown>;
                  if (!parsed["error"]) {
                    const orderId = String(parsed["orderId"] ?? randomUUID());
                    const symbol = (args.symbol as string).toUpperCase();
                    const securityId = await getSecurityId(symbol).catch(() => "unknown");
                    const currentStatus = String(parsed["currentStatus"] ?? "").toUpperCase();
                    const initialStatus: import("../lib/storage/types.js").TradeStatus =
                      currentStatus === "FILLED" || currentStatus === "TRADED" || currentStatus === "PART_TRADED" ? "filled"
                      : currentStatus === "REJECTED" ? "rejected"
                      : currentStatus === "CANCELLED" || currentStatus === "EXPIRED" ? "cancelled"
                      : "pending";
                    await opts.trades.append({
                      id: randomUUID(),
                      orderId,
                      symbol,
                      securityId,
                      transactionType: args.transaction_type as "BUY" | "SELL",
                      quantity: args.quantity as number,
                      orderType: args.order_type as "MARKET" | "LIMIT",
                      requestedPrice: args.price as number | undefined,
                      status: initialStatus,
                      executedPrice: initialStatus === "filled"
                        ? (parsed["executedPrice"] as number | undefined) : undefined,
                      filledAt: initialStatus === "filled"
                        ? (parsed["filledAt"] as string | undefined) : undefined,
                      rejectionReason: initialStatus === "rejected"
                        ? (parsed["rejectionReason"] as string | undefined) : undefined,
                      strategyId: args.strategy_id as string | undefined,
                      portfolioId: args.portfolioId as string | undefined,
                      intentId,
                      note: args.note as string | undefined,
                      createdAt: new Date().toISOString(),
                    });
                  }
                } catch (err) {
                  console.error("[broker-chat] failed to record trade:", err);
                }
              }

              // Collect primitives from results
              const newPrimitives = extractPrimitives(toolUse.name, result);
              for (const p of newPrimitives) {
                if (!collectedPrimitives.some(e => e.id === p.id && e.type === p.type)) {
                  collectedPrimitives.push(p);
                }
                if (p.type === "portfolio" && !portfolioIdFromPrimitives) {
                  portfolioIdFromPrimitives = p.id;
                }
              }
            } catch (err) {
              if (err instanceof BrokerAuthError) {
                tokenExpired = true;
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: "TOOL_ERROR: TOKEN_EXPIRED — Your broker session has expired.",
                });
              } else {
                const msg = err instanceof Error ? err.message : String(err);
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: `TOOL_ERROR: ${msg}`,
                });
              }
            }
          }

          conversationHistory.push({ role: "user", content: toolResults });

          if (intentCompleted) {
            send({ type: "done" });
            break;
          }
        }
      } catch (err) {
        console.error("[broker-chat] Claude loop error:", err);
        send({
          type: "error",
          message: err instanceof Error ? err.message : "An unexpected error occurred",
        });
      } finally {
        isProcessing = false;
      }

      await opts.store.append(conversationId, conversationHistory.slice(saveFrom));
    });

    socket.on("close", () => {
      if (pendingUserResponse) {
        pendingUserResponse.reject(new Error("WebSocket closed"));
        pendingUserResponse = null;
      }
    });

    socket.on("error", (err: Error) => {
      console.error("[broker-chat] WebSocket error:", err);
    });
  });
}
