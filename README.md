# Omoide

**Omoide** (思い出, “memories”) — a chat agent with one tool — web search — and a memory that is indexed by the day you said things, so “what did I ask you on 3 November?” and “has that price changed?” are answerable rather than improvised.

```
npm install
cp .env.example .env      # add OPENROUTER_API_KEY + one search key
npm run dev               # http://localhost:3000
```

**You do not need a database, a Neon account, or any cloud signup for the local app.** The default storage is *embedded Postgres* (PGlite) — a real Postgres that lives inside the Node process and writes to `./.data/pglite`. Zero installs, zero accounts, and the full schema is created automatically on first start. A hosted database (Neon) is **optional**, for the deployed version.

---

## Table of contents

1. [Local setup (the only setup most people need)](#local-setup)
2. [Optional: run against a hosted database (Neon)](#hosted-database)
3. [Optional: deploy it (Vercel + Neon, ~$2 total spend cap)](#deploying)
4. [Why this is not just “LLM + search”](#why-this-is-not-just-llm--search)
5. [Architecture — including the full diagram walkthrough](#architecture)
6. [What you can try](#what-you-can-try)
7. [Commands](#commands)
8. [Configuration reference](#configuration-reference)
9. [Troubleshooting](#troubleshooting)
10. [Design decisions worth reading the code for](#design-decisions-worth-reading-the-code-for)

---

## Local setup

### Prerequisites

- **Node.js ≥ 20.9** (`node -v` to check). That’s all — no Postgres, no Docker, no accounts.

### Steps

**1. Install and configure**

```bash
git clone <this repo>
cd <repo>
npm install
cp .env.example .env
```

**2. Add two keys to `.env`** (both have free tiers):

| Key | Where to get it | Why it’s needed |
|---|---|---|
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | All models: the main answer model, the cheap planner, embeddings, and the eval judges. One key, one bill. |
| `TINYFISH_API_KEY` *or* `EXA_API_KEY` | [agent.tinyfish.ai](https://agent.tinyfish.ai) / [dashboard.exa.ai](https://dashboard.exa.ai) | The agent’s only tool: web search. TinyFish is the primary (search + page fetching with ETag support, which the re-check engine uses); Exa is the semantic second index and fallback. At least one is required. |

Leave `DATABASE_URL=` **empty** — that is the “local mode” setting.

**3. Start**

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The sidebar shows the database as **embedded PGlite**; `http://localhost:3000/api/config` reports every provider and what is missing. If a key is absent the app says exactly which one instead of answering badly.

**4. See the memory features immediately**

The empty state has a **Load demo history** button. It runs three *real* research turns through the real pipeline (Postgres pricing comparison, a CRM shortlist, a Next.js question) and backdates them to last Tuesday / Friday / Monday, so date recall and re-checks have something true to work on. Seeding is idempotent — clicking it twice gives one clean copy, not duplicates. **Reset demo history** removes it.

That’s the whole local setup: `npm install`, two keys, `npm run dev`.

### Where your data lives

Everything (threads, messages, claims, sources, traces) is inside `./.data/pglite` on your disk. Delete that folder and you have a factory-fresh app. `.env` and `.data/` are git-ignored; no secrets or history can be committed.

---

## Optional: hosted database

<a id="hosted-database"></a>

**Skip this entirely if you only run locally.** PGlite already gives you the real thing — same SQL, same indexes, same features. A hosted database matters in exactly two cases:

1. You want history to persist on a machine that is not yours (or survive a fresh clone),
2. You deploy the app (serverless functions have no persistent disk, so **deployments require** `DATABASE_URL`).

To switch:

1. Create a free database at [neon.tech](https://neon.tech) (or use any Postgres 16+) and copy its connection string.
2. Put it in `.env`:
   ```
   DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
   ```
3. **Restart the dev server.** The running process holds its old connection; only a restart switches over.
4. Verify at `http://localhost:3000/api/config` — Postgres should now say `external`.
5. Click **Load demo history** once — the hosted database starts empty; nothing is copied from `./.data/pglite`.

The identical schema DDL (`src/server/db/schema.ts`) runs on both modes automatically. Nothing about the app changes except where the bytes live.

---

## Optional: deploying

<a id="deploying"></a>

**The project is complete without deploying.** This section exists because the reviewer may want a public URL. It assumes the hosted-database step above, because serverless functions have no persistent disk — PGlite data would vanish between invocations.

### Steps

1. Push the repo to GitHub.
2. Create the hosted database (Neon free tier is enough) and keep its connection string.
3. Import the repo at [vercel.com/new](https://vercel.com/new), then set the environment variables in the Vercel dashboard (Project → Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `OPENROUTER_API_KEY` | your key (see the spend-cap advice below) |
   | `TINYFISH_API_KEY` and/or `EXA_API_KEY` | your search key(s) |
   | `DATABASE_URL` | the Neon connection string (**required**) |
   | `MAIN_MODEL` / `UTILITY_MODEL` / `EMBEDDING_MODEL` | optional; the defaults are already cheap |

4. Deploy. First boot creates the schema on Neon automatically — no migration command.

### The $2 spend cap, honestly

- **Enforce it at OpenRouter, not in the app.** Create a *separate* API key just for the deployment and set its credit/spend limit to **$2** when you create it at [openrouter.ai/keys](https://openrouter.ai/keys) (per-key limits are a first-class feature there). When the cap is hit, OpenRouter refuses requests — the app’s answer degrades gracefully to “I couldn’t reach the model,” it never spends a cent more.
- **What a turn actually costs:** the planner and extractor are tiny flash-tier models; the main model is a cheap tier by default; searches are cached (`search_cache`, TTL) and unchanged-page re-checks cost **zero** model tokens (ETag `304`). A typical research turn lands around **$0.003–0.02** — so $2 is realistically *hundreds* of research turns, far beyond a review session.
- **What NOT to do with the deployment key:** don’t run `EVAL_LIVE=1 npm run eval` against it. A full live eval makes ~40 model calls + 12 web research turns (~$0.20–0.30) — cheap, but it should bill to your local key, and it must never run against the deployed database anyway (evals force their own throwaway embedded DB by design).
- You can also lower the ceiling further by pointing `MAIN_MODEL` at a cheaper tier — model choice is one env var, no code changes.

---

## Why this is not just “LLM + search”

Two of the three example questions are not search problems. They are **memory + time** problems:

| The question | What has to be true to answer it well |
|---|---|
| “What did I ask you on 3 November? Is your answer still correct today?” | The date must resolve to the right local day; the old turn must be found; the *facts in it* must be re-checkable, not just re-readable. |
| “Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?” | Weekday arithmetic in the user’s timezone; recall by date **and** topic; a diff of prices, with sources. |
| “On Monday we shortlisted 5 CRM tools… has any changed since?” | Recall of a team conversation; per-item price checks; news bounded by the date. Plus honesty when the conversation was never in this app. |

So the design centres on four things:

1. **Dates are computed in code, never by the model.** The planner returns phrases (“last tuesday”); `src/server/time/resolve.ts` turns them into local dates with unit tests. Every message stores `local_date` in the user’s timezone, so “3 November” is an indexed equality lookup.
2. **Memory is injected context, not a second tool.** The brief says one tool; giving the model `recall_memory` would also add a round trip and a failure mode. The orchestrator decides what the model needs to know before it speaks.
3. **A claim ledger.** After each cited answer, atomic facts (entity, attribute, value, source URL, observed time) are extracted and stored. “Is that still correct?” becomes: conditional-fetch the source (ETag / Last-Modified / content hash); if unchanged, the answer is unchanged with **zero model tokens**; if changed, ask a small model which claims moved.
4. **Honest misses.** Empty memory produces one plain sentence (“I don’t have a record of that”) plus something useful — never an invented past conversation. You can load opt-in demo history to see recall working.

## Architecture

```
user message
   │
   ├─ planner (small model, JSON)  ──► intent, queries, raw temporal phrases
   │        └─ fallback: deterministic heuristics (and the offline planner)
   ├─ time resolver (code)         ──► concrete local date ranges
   ├─ recall (Postgres)            ──► exact date → ±1 day → FTS + embeddings
   ├─ recheck (code)               ──► conditional fetch → hash → per-claim verdicts
   ├─ webSearch (the one tool)     ──► TinyFish ⨯ Exa ⨯ queries → RRF → fetch → passages
   └─ synthesizer (main model, streams, may call web_search twice more)
            └─ answer + citations + sources + a trace of how it was produced
```

Everything before the final stream is deterministic and inspectable, which is what makes cheap models reliable here. The model still holds the real `web_search` tool for gaps and follow-ups — a pipeline where the next step is predictable, an agent where it is not.

### Reading the full diagram

The ASCII sketch above is the map; **[`docs/architecture-detailed.png`](docs/architecture-detailed.png)** is the territory — every table, every field, real sample rows (editable source: [`docs/architecture-detailed.excalidraw`](docs/architecture-detailed.excalidraw)). It reads in three bands, top to bottom:

1. **“One turn, end to end” (top row).** The eight steps of a single message, left to right. Each box names the tables it writes (`▸ writes …`) or reads, and the green loop under steps 8 → 5 is the product’s core cycle: *the claims learned today are exactly what gets re-checked next turn.* Note that most steps are **conditional gates**, not a conveyor belt — a chit-chat message only fires save → plan → synthesize.
2. **“The schema” (middle).** The 8 tables drawn ER-style, with **every actual field** from `src/server/db/schema.ts`: types, primary keys (green), foreign keys (blue, drawn field-to-field), and yellow-highlighted rows marking the fields the design hangs on — `messages.local_date`, `claims.value`, `sources.etag` / `content_hash`, `claim_checks.status`. The dashed orange arrow is the one reference that is a value, not a constraint: a claim remembers its `source_url` but the `sources` table owns the page.
3. **“What a row really looks like” (right column).** Realistic values: the user/assistant message pair joined by `turn_id`, a claim row (`entity` + `attribute` is the lookup key; `value` is what goes stale), a `claim_checks` receipt (`status ∈ unchanged | changed | not_found`, `method: etag`), and the recall ladder — dates before vectors, with reasons.

The bottom strip holds the legend, the indexes recall leans on, and the one design choice worth asking about: why a separate `local_date` column beats timestamps and embeddings for date questions.

Full reasoning, rejected alternatives and next steps: **[DESIGN.md](./DESIGN.md)**.

## What you can try

- **“How much does the Neon Launch plan cost?”** → searches, cites the vendor page, dates the observation.
- **“Compare Neon, Supabase and AWS RDS for a small app.”** → multi-query research, table, per-row citations.
- **“What did I ask you on 3 November?”** → exact-date recall from any thread, with the user’s own words.
- **“Last Tuesday I asked you about Postgres hosting. Has any pricing changed?”** → recall + per-claim re-check + a change report.
- **“On Monday we shortlisted 5 CRMs…”** with no history → says so, then checks the usual suspects instead of pretending.

The empty state has a **Load demo history** button. It runs three real turns through the pipeline (Postgres pricing, a CRM shortlist, a Next.js question) and backdates them, marking the rows `is_demo`. Seeding deliberately runs **inside the app process**: PGlite allows one process per data directory, so a separate seed script would lock the database the dev server is using. “Reset demo history” removes it.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | App on :3000 (embedded Postgres, auto-migrated) |
| `npm test` | 45 unit tests: date resolution, ranking, canonical URLs, citations, claim extraction, re-check heuristics |
| `npm run eval` | 12 scripted conversations, fresh DB each, deterministic assertions; writes `evals/report.json` |
| `EVAL_LIVE=1 npm run eval` | Same scenarios against real models and search, plus a two-decision-model judge panel that fails only on unanimous low scores and flags dissents (costs tokens; never touches a hosted DB) |
| `npm run search:smoke -- "neon pricing"` | Prints exactly what a search returns: providers, sources, passages, hashes |
| `npm run typecheck` / `npm run build` | TypeScript / production build |

Current offline eval: **12/12 scenarios pass** (chitchat, stable facts, fresh prices, comparison, exact-date memory, relative-weekday memory, empty-memory honesty, team-past honesty, unchanged/changed/unconfirmable re-checks, pronoun follow-up). The live run grades every answer with both decision-model judges.

Offline mode is for tests, not for pretending: `MOCK=1` swaps in fixture search and a template writer. With keys present the real pipeline is used. If the app has no model key it says exactly what is missing instead of answering badly.

## Configuration reference

All keys live in [`.env.example`](./.env.example) with comments. Copy it to `.env` and fill in what you have.

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | all models (chat, planner, embeddings, judge) |
| `TINYFISH_API_KEY` | one search key | primary search + page fetch with ETag support |
| `EXA_API_KEY` | one search key | semantic second index + fallback reader |
| `TAVILY_API_KEY` | no | third-tier fallback, skipped when empty |
| `DATABASE_URL` | no | **empty = embedded PGlite (local, zero setup)**; set = Neon/Postgres (required for deployments) |
| `MAIN_MODEL` | no | answer model; default `deepseek/deepseek-chat-v3.1` (cheap) |
| `UTILITY_MODEL` | no | planner + claim extraction + re-check classifier |
| `EMBEDDING_MODEL` | no | topic-recall vectors |
| `JUDGE_MODELS` | no | eval-only judge panel (comma-separated decision models); any model the decisions endpoint rejects falls back to the text judge |
| `AGENT_NOW` | no | freezes the clock (demo/eval reproducibility) |
| `MOCK` | no | `1` = deterministic offline mode |

The only *code* difference between local and deployed is `DATABASE_URL`. Same app, same schema, same behaviour.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/api/config` lists a provider as not configured | Its key is missing from `.env` (or the server wasn’t restarted after editing). |
| Set `DATABASE_URL` but the sidebar still says PGlite | The dev server holds its old connection — restart it. |
| `EHOSTUNREACH` / DB lock errors | Another process is using the same PGlite data dir (PGlite is single-process). Evals and smoke tests force their own directories for this reason. |
| Want a factory reset | Stop the server, `rm -rf .data/pglite`, restart. |
| Search returns nothing | Run `npm run search:smoke -- "test query"` — it prints exactly what each provider returned, so a broken adapter is obvious before blaming the agent. |
| Deployed app returns model errors | Check the OpenRouter key’s spend limit wasn’t reached, and that `DATABASE_URL` is set (serverless has no disk for PGlite). |

## Design decisions worth reading the code for

- `src/server/agent/orchestrator.ts` — the only file that knows a whole turn; ordering matters more than any prompt.
- `src/server/time/resolve.ts` + `tests/time.test.ts` — the date contract; “last Tuesday” on Tuesday 10 Nov is 3 Nov, and that is tested.
- `src/server/memory/recheck.ts` — the cheap path: 304/hash short-circuit, then model verification only when the page really changed.
- `src/server/search/index.ts` — the one tool, including the citation registry and why ids are stable per turn.
- `src/server/agent/synthesize.ts` — one model call in the common case, at most two self-chosen follow-up searches.
