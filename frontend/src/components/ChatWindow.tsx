"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, getWsUrl, type Intent, type ClarificationQuestion } from "@/lib/api";
import { IntentCard } from "@/components/IntentCard";
import { ClarificationWidget } from "@/components/ClarificationWidget";
import { PlanProposalWidget } from "@/components/PlanProposalWidget";
import { BrokerPill } from "@/components/TopBar";

type ChatMsg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "thinking" }
  | { id: string; role: "agent_text"; text: string }
  | { id: string; role: "clarification"; questions: ClarificationQuestion[]; answered?: boolean }
  | { id: string; role: "plan_proposal"; plan: string; summary: string; submitted?: boolean }
  | { id: string; role: "intent_card"; intent: Intent }
  | { id: string; role: "error"; text: string };

let msgCounter = 0;
function nextId() {
  return `msg-${++msgCounter}`;
}

const INITIAL_GREETING: ChatMsg = {
  id: "greeting",
  role: "agent_text",
  text: "Hi! I can answer questions about your portfolio, market data, and positions. When you're ready to trade or set up an automation, just tell me what you want to do.",
};

export function ChatWindow({ initialConversationId }: { initialConversationId?: string }) {
  const [sessionId, setSessionId] = useState(() => {
    if (initialConversationId) {
      if (typeof window !== "undefined") localStorage.setItem("chat:conversationId", initialConversationId);
      return initialConversationId;
    }
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("chat:conversationId");
      if (stored) return stored;
    }
    const id = `chat-${Date.now()}`;
    if (typeof window !== "undefined") localStorage.setItem("chat:conversationId", id);
    return id;
  });

  const [messages, setMessages] = useState<ChatMsg[]>([INITIAL_GREETING]);
  const [inputText, setInputText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isAwaitingResponse, setIsAwaitingResponse] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const streamingMsgIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Reset to a new chat when sidebar clears the stored conversation ID
  useEffect(() => {
    const onStorage = () => {
      const stored = localStorage.getItem("chat:conversationId");
      if (!stored) handleNewChat();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load conversation history when sessionId changes
  useEffect(() => {
    api.conversations.getMessages(sessionId)
      .then(history => {
        const chatMsgs: ChatMsg[] = history
          .filter(m => m.role !== "tool")
          .map(m => ({
            id: nextId(),
            role: m.role === "user" ? "user" as const : "agent_text" as const,
            text: m.text,
          }));
        setMessages(chatMsgs.length > 0 ? chatMsgs : [INITIAL_GREETING]);
      })
      .catch(() => {
        setMessages([INITIAL_GREETING]);
      });
  }, [sessionId]);

  // WebSocket connection
  useEffect(() => {
    const wsUrl = `${getWsUrl()}/ws/broker-chat?conversationId=${sessionId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          content?: string;
          message?: string;
          questions?: ClarificationQuestion[];
          plan?: string;
          summary?: string;
          intent?: Intent;
        };

        if (msg.type === "text_delta") {
          const content = msg.content ?? "";
          if (!streamingMsgIdRef.current) {
            const id = nextId();
            streamingMsgIdRef.current = id;
            setMessages(prev => [
              ...prev.filter(m => m.role !== "thinking"),
              { id, role: "agent_text", text: content },
            ]);
          } else {
            const id = streamingMsgIdRef.current;
            setMessages(prev => prev.map(m =>
              m.id === id ? { ...m, text: (m as { text: string }).text + content } : m
            ));
          }
        } else if (msg.type === "ask_clarification") {
          streamingMsgIdRef.current = null;
          setIsAwaitingResponse(true);
          setMessages(prev => [
            ...prev.filter(m => m.role !== "thinking"),
            { id: nextId(), role: "clarification", questions: msg.questions ?? [] },
          ]);
        } else if (msg.type === "propose_plan") {
          streamingMsgIdRef.current = null;
          setIsAwaitingResponse(true);
          setMessages(prev => [
            ...prev.filter(m => m.role !== "thinking"),
            { id: nextId(), role: "plan_proposal", plan: msg.plan ?? "", summary: msg.summary ?? "" },
          ]);
        } else if (msg.type === "intent_complete") {
          streamingMsgIdRef.current = null;
          if (msg.intent) {
            setMessages(prev => [
              ...prev.filter(m => m.role !== "thinking"),
              { id: nextId(), role: "intent_card", intent: msg.intent! },
            ]);
          }
        } else if (msg.type === "done") {
          streamingMsgIdRef.current = null;
          setIsStreaming(false);
          setIsAwaitingResponse(false);
          setMessages(prev => prev.filter(m => m.role !== "thinking"));
        } else if (msg.type === "error") {
          streamingMsgIdRef.current = null;
          setIsStreaming(false);
          setIsAwaitingResponse(false);
          setMessages(prev => [
            ...prev.filter(m => m.role !== "thinking"),
            { id: nextId(), role: "error", text: msg.message ?? "An error occurred" },
          ]);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      setIsStreaming(false);
      setIsAwaitingResponse(false);
      streamingMsgIdRef.current = null;
    };

    return () => {
      ws.close();
    };
  }, [sessionId]);

  const addMessage = useCallback((msg: ChatMsg) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  const handleSubmit = () => {
    const isInFlight = isStreaming || isAwaitingResponse;
    if (!inputText.trim() || isInFlight) return;
    const text = inputText.trim();
    setInputText("");
    addMessage({ id: nextId(), role: "user", text });
    addMessage({ id: nextId(), role: "thinking" });
    setIsStreaming(true);

    wsRef.current?.send(JSON.stringify({
      type: "message",
      messages: [{ role: "user", content: text }],
    }));
  };

  const handleApprovePlan = useCallback((approved: boolean, feedback?: string) => {
    wsRef.current?.send(JSON.stringify({ type: "plan_response", approved, feedback }));
    setMessages(prev => [
      ...prev.map(m => m.role === "plan_proposal" ? { ...m, submitted: true } : m),
      { id: nextId(), role: "thinking" } as ChatMsg,
    ]);
  }, []);

  const handleClarify = useCallback((answers: Record<string, string>) => {
    wsRef.current?.send(JSON.stringify({ type: "clarification_response", answers }));
    setMessages(prev => [
      ...prev.map(m => m.role === "clarification" ? { ...m, answered: true } : m),
      { id: nextId(), role: "thinking" } as ChatMsg,
    ]);
  }, []);

  const handleNewChat = () => {
    const newId = `chat-${Date.now()}`;
    localStorage.setItem("chat:conversationId", newId);
    window.dispatchEvent(new Event("storage"));
    streamingMsgIdRef.current = null;
    setIsStreaming(false);
    setIsAwaitingResponse(false);
    setInputText("");
    setSessionId(newId);
  };

  const sessionTitle = (messages.find(m => m.role === "user") as { text: string } | undefined)?.text?.slice(0, 50) ?? "New Chat";
  const isInFlight = isStreaming || isAwaitingResponse;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* TopBar */}
      <div style={{
        background: "rgba(255,255,255,0.82)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom: "1px solid var(--gray-200)",
        minHeight: "64px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 32px",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <h1 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "var(--gray-900)", letterSpacing: "-0.02em" }}>
            {sessionTitle}
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <BrokerPill />
          <button
            onClick={handleNewChat}
            style={{
              padding: "6px 14px",
              borderRadius: "var(--radius-xs)",
              border: "1.5px solid var(--gray-200)",
              background: "white",
              color: "var(--gray-700)",
              fontSize: "13px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            New Chat
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "22px",
        padding: "28px 32px",
        background: "var(--gray-50)",
      }}>
        {messages.map(msg => {
          if (msg.role === "user") {
            return (
              <div key={msg.id} style={{ display: "flex", justifyContent: "flex-end", gap: "10px", alignItems: "flex-end" }}>
                <div style={{
                  background: "var(--gray-900)",
                  color: "white",
                  padding: "11px 16px",
                  borderRadius: "var(--radius-lg)",
                  borderBottomRightRadius: "4px",
                  fontSize: "15px",
                  maxWidth: "65%",
                  lineHeight: "1.5",
                }}>
                  {msg.text}
                </div>
                <div style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, #f97316, #ec4899)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}>
                  <span style={{ color: "white", fontSize: "11px", fontWeight: "700" }}>SK</span>
                </div>
              </div>
            );
          }

          if (msg.role === "thinking") {
            return (
              <div key={msg.id} style={{ display: "flex", alignItems: "flex-end", gap: "10px" }}>
                <div style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "var(--gray-900)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}>
                  <span style={{ color: "white", fontSize: "12px", fontFamily: "var(--font-serif)", fontStyle: "italic" }}>Vt</span>
                </div>
                <div style={{
                  background: "white",
                  padding: "13px 16px",
                  borderRadius: "var(--radius-lg)",
                  borderBottomLeftRadius: "4px",
                  border: "1px solid var(--gray-200)",
                  boxShadow: "var(--shadow-xs)",
                  display: "flex",
                  gap: "4px",
                  alignItems: "center",
                }}>
                  {[0, 1, 2].map(i => (
                    <div key={i} style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      background: "var(--gray-400)",
                      animation: `chatPulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                    }} />
                  ))}
                </div>
              </div>
            );
          }

          if (msg.role === "agent_text") {
            return (
              <div key={msg.id} style={{ display: "flex", alignItems: "flex-end", gap: "10px" }}>
                <div style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "var(--gray-900)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}>
                  <span style={{ color: "white", fontSize: "12px", fontFamily: "var(--font-serif)", fontStyle: "italic" }}>Vt</span>
                </div>
                <div style={{
                  background: "white",
                  color: "var(--gray-700)",
                  padding: "11px 16px",
                  borderRadius: "var(--radius-lg)",
                  borderBottomLeftRadius: "4px",
                  border: "1px solid var(--gray-200)",
                  boxShadow: "var(--shadow-xs)",
                  fontSize: "15px",
                  maxWidth: "65%",
                  lineHeight: "1.5",
                }} className="chat-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
                </div>
              </div>
            );
          }

          if (msg.role === "clarification") {
            return (
              <div key={msg.id} style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                <div style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "var(--gray-900)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  marginTop: "4px",
                }}>
                  <span style={{ color: "white", fontSize: "12px", fontFamily: "var(--font-serif)", fontStyle: "italic" }}>Vt</span>
                </div>
                <div style={{
                  background: "white",
                  padding: "16px 20px",
                  borderRadius: "var(--radius-lg)",
                  borderBottomLeftRadius: "4px",
                  border: "1px solid var(--gray-200)",
                  boxShadow: "var(--shadow-xs)",
                  maxWidth: "500px",
                  width: "100%",
                }}>
                  <ClarificationWidget
                    questions={msg.questions}
                    onConfirm={async (answers) => handleClarify(answers)}
                    answered={msg.answered}
                    variant="chat"
                  />
                </div>
              </div>
            );
          }

          if (msg.role === "plan_proposal") {
            return (
              <div key={msg.id} style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                <div style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "var(--gray-900)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  marginTop: "4px",
                }}>
                  <span style={{ color: "white", fontSize: "12px", fontFamily: "var(--font-serif)", fontStyle: "italic" }}>Vt</span>
                </div>
                <div style={{
                  background: "white",
                  padding: "16px 20px",
                  borderRadius: "var(--radius-lg)",
                  borderBottomLeftRadius: "4px",
                  border: "1px solid var(--gray-200)",
                  boxShadow: "var(--shadow-xs)",
                  maxWidth: "560px",
                  width: "100%",
                }}>
                  <PlanProposalWidget
                    plan={msg.plan}
                    summary={msg.summary}
                    submitted={msg.submitted}
                    onApprove={async () => handleApprovePlan(true)}
                    onRequestChanges={async (feedback) => handleApprovePlan(false, feedback)}
                  />
                </div>
              </div>
            );
          }

          if (msg.role === "intent_card") {
            return (
              <div key={msg.id} style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                <div style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "var(--gray-900)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  marginTop: "4px",
                }}>
                  <span style={{ color: "white", fontSize: "12px", fontFamily: "var(--font-serif)", fontStyle: "italic" }}>Vt</span>
                </div>
                <div style={{ maxWidth: "440px", width: "100%" }}>
                  <IntentCard intent={msg.intent} />
                </div>
              </div>
            );
          }

          if (msg.role === "error") {
            return (
              <div key={msg.id} style={{ display: "flex", alignItems: "flex-end", gap: "10px" }}>
                <div style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "var(--gray-900)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}>
                  <span style={{ color: "white", fontSize: "12px", fontFamily: "var(--font-serif)", fontStyle: "italic" }}>Vt</span>
                </div>
                <div style={{
                  background: "var(--red-light)",
                  color: "var(--red)",
                  padding: "11px 16px",
                  borderRadius: "var(--radius-lg)",
                  borderBottomLeftRadius: "4px",
                  fontSize: "14px",
                  maxWidth: "65%",
                  lineHeight: "1.5",
                }}>
                  {msg.text}
                </div>
              </div>
            );
          }

          return null;
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div style={{
        borderTop: "1px solid var(--gray-200)",
        padding: "16px 32px",
        display: "flex",
        gap: "10px",
        background: "var(--gray-50)",
        alignItems: "center",
        flexShrink: 0,
      }}>
        <input
          type="text"
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="Ask about your portfolio or describe a trade..."
          disabled={isInFlight}
          style={{
            flex: 1,
            padding: "12px 16px",
            borderRadius: "var(--radius)",
            border: "1.5px solid var(--gray-200)",
            fontSize: "15px",
            outline: "none",
            background: isInFlight ? "var(--gray-100)" : "white",
            color: "var(--gray-900)",
            cursor: isInFlight ? "not-allowed" : "text",
            transition: "border-color 0.15s",
            fontFamily: "var(--font-sans)",
          }}
          onFocus={e => !isInFlight && (e.target.style.borderColor = "var(--blue)")}
          onBlur={e => e.target.style.borderColor = "var(--gray-200)"}
        />
        <button
          onClick={handleSubmit}
          disabled={!inputText.trim() || isInFlight}
          style={{
            width: "42px",
            height: "42px",
            borderRadius: "var(--radius-xs)",
            border: "none",
            background: inputText.trim() && !isInFlight ? "var(--gray-900)" : "var(--gray-200)",
            color: inputText.trim() && !isInFlight ? "white" : "var(--gray-400)",
            fontSize: "18px",
            fontWeight: "600",
            cursor: inputText.trim() && !isInFlight ? "pointer" : "default",
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            transition: "background 0.15s",
          }}
        >
          ↑
        </button>
      </div>

      <style>{`
        @keyframes chatPulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        .chat-markdown > *:first-child { margin-top: 0; }
        .chat-markdown > *:last-child { margin-bottom: 0; }
        .chat-markdown p { margin: 0 0 8px 0; }
        .chat-markdown ul, .chat-markdown ol { margin: 0 0 8px 0; padding-left: 20px; }
        .chat-markdown li { margin-bottom: 2px; }
        .chat-markdown strong { font-weight: 600; }
        .chat-markdown code { background: var(--gray-100); padding: 1px 5px; border-radius: 4px; font-size: 13px; font-family: monospace; }
        .chat-markdown pre { background: var(--gray-100); padding: 10px 14px; border-radius: 6px; overflow-x: auto; margin: 0 0 8px 0; }
        .chat-markdown pre code { background: none; padding: 0; }
        .chat-markdown table { border-collapse: collapse; width: 100%; margin-bottom: 8px; font-size: 13px; }
        .chat-markdown th, .chat-markdown td { border: 1px solid var(--gray-200); padding: 5px 10px; text-align: left; }
        .chat-markdown th { background: var(--gray-50); font-weight: 600; }
        .chat-markdown h1, .chat-markdown h2, .chat-markdown h3 { margin: 8px 0 4px 0; font-weight: 700; }
        .chat-markdown h1 { font-size: 17px; }
        .chat-markdown h2 { font-size: 15px; }
        .chat-markdown h3 { font-size: 14px; }
        .chat-markdown blockquote { border-left: 3px solid var(--gray-300); margin: 0 0 8px 0; padding-left: 12px; color: var(--gray-500); }
        .chat-markdown hr { border: none; border-top: 1px solid var(--gray-200); margin: 8px 0; }
      `}</style>
    </div>
  );
}
