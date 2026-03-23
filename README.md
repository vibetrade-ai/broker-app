# broker-app

AI-powered broker interface built on the vibe-trade harness. Lets you express trading intent in natural language, review AI-generated plan proposals, and execute orders with human-in-the-loop approval.

## What it does

- **Intent system** — describe a trade idea; the AI breaks it into a structured plan
- **Broker chat** — conversational interface with full market data, indicators, and order tools
- **Approval flow** — every order requires explicit user confirmation before execution
- **Strategy tracking** — P&L, win rate, and trade history per strategy

## Prerequisites

- Node.js 20+
- Dhan trading account (for live market data and order execution)
- Anthropic API key

## Environment variables

Create `backend/.env`:

```
DHAN_ACCESS_TOKEN=your_token
DHAN_CLIENT_ID=your_client_id
ANTHROPIC_API_KEY=your_key
```

## Running locally

**Backend** (port 3001):
```bash
cd backend
npm install
npm run dev
```

**Frontend** (port 3002):
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3002.

## Runtime data

Stored in `~/.vibetrade-broker/` by default. Override with `VIBETRADE_DATA_DIR` env var.
