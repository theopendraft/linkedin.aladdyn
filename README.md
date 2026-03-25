# linkedin.aladdyn

LinkedIn automation engine — V1 (Publishing + Auto-Reply + Analytics).

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browsers (required for inbox/DM features)
npx playwright install chromium

# 3. Create the linkedin schema in PostgreSQL (required before db push)
psql $DATABASE_URL -f create_schema.sql

# 4. Push the Prisma schema to the DB
npm run db:push

# 5. Start Redis (if not already running)
docker run -d -p 6379:6379 redis:7-alpine

# 6. Start in development mode
npm run dev
```

## Environment Variables

Copy `.env` and fill in real values:
- `LINKEDIN_ENCRYPTION_KEY` — generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` — from LinkedIn Developer portal
- `JWT_SECRET` — must match `server.aladdyn`

## Bull Board (queue monitor)

```bash
npm run queue:ui
# Open http://localhost:4003/ui
```

## Important: Schema Setup

**You must run `create_schema.sql` before `prisma db push`.**

```bash
psql postgresql://aladdyn:aladdyn_dev@localhost:5432/aladdyn_dev -f create_schema.sql
npm run db:push
```

This creates the `linkedin` schema namespace in the shared PostgreSQL database.

## Architecture

```
POST /api/posts/:id/approve
  → enqueues to linkedin:publish queue
  → publishWorker processes the job
  → calls linkedinApi.publishPost()
  → marks post POSTED or FAILED

GET /api/inbox (manual sync)
POST /internal/inbox/process-replies (scheduled)
  → inboxReader.syncInbox() via Playwright
  → autoReply.processAutoReplies()
  → GPT-4o-mini generates reply
  → inboxReader.sendDM()
```

## Hard Constraints

- Max 30 browser actions/day/account (default limit: 25)
- Random delays 1.5–4s between all automated browser actions
- Never log or expose tokens or session cookies
- Failures never cascade to server.aladdyn or genie.aladdyn
