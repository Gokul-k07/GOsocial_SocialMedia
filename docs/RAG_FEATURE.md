# GOSocial AI — RAG Feature Documentation

## Architecture

```
GOSocial User
     ↓
React /ai page  (AIPage.jsx)
     ↓
POST /api/ai/ask  (JWT cookie auth — existing `protect` middleware)
     ↓
Rate limit: 10 req / 15 min per IP  (express-rate-limit)
     ↓
Input validation (non-empty, max 500 chars)
     ↓
MongoDB Atlas $vectorSearch  (queryText — Atlas auto-embeds via voyage-4-lite)
     ↓
Top-6 relevant public posts  (visibility: 'anyone' only)  +  author.username
     ↓
services/ragService.js  →  Build context (max 3000 chars)  →  Gemini LLM
     ↓
JSON: { success, answer, sources[] }
     ↓
React UI  (answer card + clickable source cards → /post/:id)
```

---

## What is RAG?

**Retrieval-Augmented Generation (RAG)** is a technique that improves LLM responses by
grounding them in real, retrieved data rather than relying on the model's pre-trained
knowledge alone.

Instead of asking Gemini "what are GOSocial users saying about React?" (which it cannot
know), the system:

1. Sends the question as plain text to MongoDB Atlas Vector Search.
2. Atlas automatically embeds the query using **voyage-4-lite** (Automated Embedding).
3. MongoDB returns the most semantically similar **public** posts.
4. Those real posts are fed as context to Gemini.
5. Gemini answers using only that context — and says so if there isn't enough.

---

## Embedding Architecture

### Old architecture (removed)

```
Application → Gemini text-embedding-004 → 768-dim vector → stored in Post.embedding
                         ↓
              $vectorSearch { queryVector: [...] }
```

### New architecture (current)

```
Application → $vectorSearch { queryText: "..." }
                         ↓
              MongoDB Atlas Automated Embedding (voyage-4-lite)
                         ↓
              Semantically similar posts returned automatically
```

**Gemini is now used exclusively for final answer generation.**  
MongoDB Atlas handles all embedding — both for indexed post text and for user queries.  
No embedding vectors are stored in application documents.  
No embedding API calls are made by the application code.

---

## How Posts Are Indexed

### New posts (automatic)

When a user creates a post, `postRoutes.js` saves it normally.  
The Atlas Automated Embedding pipeline detects the new document and generates its
embedding based on the `caption` field automatically, without any application-side call.

### Existing posts (automatic via Atlas)

MongoDB Atlas Automated Embedding performs the initial synchronization of all documents
in the indexed collection when the index is first created.  
**No manual indexing script is required.**

> [!NOTE]
> The old `backend/scripts/indexPosts.js` script has been removed.
> Atlas handles historical post embedding automatically during index build.

---

## MongoDB Atlas Setup

> [!IMPORTANT]
> The Vector Search index must be created **manually** in the MongoDB Atlas UI
> before the AI feature will return results. Atlas then manages all embeddings.

### Step 1 — Add required variables to `backend/.env`

```env
GEMINI_API_KEY=your_actual_key_here
LLM_MODEL=gemini-3.6-flash
MONGODB_VECTOR_INDEX=post_embedding_index
```

Get a free Gemini key at: https://aistudio.google.com/app/apikey

> [!CAUTION]
> `GEMINI_API_KEY` is backend-only. Never put it in frontend `.env` files,
> `VITE_` prefixed variables, or source code.

### Step 2 — Enable Atlas Automated Embedding on your cluster

In the MongoDB Atlas UI:
1. Navigate to your cluster → **Search** tab.
2. Ensure your cluster tier supports Atlas Vector Search (M10 or higher recommended
   for production; M0 free tier supports Vector Search with limitations).

### Step 3 — Create the Atlas Vector Search Index

1. Open **MongoDB Atlas** → your cluster → **Atlas Search** tab.
2. Click **Create Search Index** → choose **JSON Editor**.
3. Select the database and the **`posts`** collection.
4. Set the index name to exactly: **`post_embedding_index`**  
   (or whatever value you set `MONGODB_VECTOR_INDEX` to in `.env`).
5. Paste this JSON definition:

```json
{
  "fields": [
    {
      "type": "autoEmbed",
      "modality": "text",
      "path": "caption",
      "model": "voyage-4-lite"
    },
    {
      "type": "filter",
      "path": "visibility"
    }
  ]
}
```

6. Click **Create Index** and wait for it to build (typically 1–5 minutes for small collections).

> [!NOTE]
> - `"path": "caption"` must match the actual text field on the `Post` model — confirmed as `caption`.
> - `"model": "voyage-4-lite"` is the Atlas-managed embedding model; no API key is required in your app.
> - The `"filter"` field on `visibility` enables efficient pre-filtering so only public posts are returned.
> - Atlas will automatically embed all existing documents in the collection when the index is first built.

### Step 4 — Start the backend

```bash
cd backend
npm run dev
```

No additional scripts need to be run.

---

## Automated Embedding Model

| Property | Value |
|---|---|
| **Model** | `voyage-4-lite` |
| **Provider** | Voyage AI (managed by MongoDB Atlas) |
| **Managed by** | MongoDB Atlas — no application API key needed |
| **Indexed field** | `caption` (the post's text content) |
| **Query embedding** | Handled automatically via `queryText` in `$vectorSearch` |

---

## Vector Search Index Configuration

The application is compatible with the following Atlas Vector Search index definition
on the **`posts`** collection:

```json
{
  "fields": [
    {
      "type": "autoEmbed",
      "modality": "text",
      "path": "caption",
      "model": "voyage-4-lite"
    },
    {
      "type": "filter",
      "path": "visibility"
    }
  ]
}
```

The `$vectorSearch` aggregation stage in `ragService.js` uses:

```js
{
  $vectorSearch: {
    index: "post_embedding_index",
    queryText: question,              // Atlas embeds this automatically
    numCandidates: 60,
    limit: 6,
    filter: { visibility: { $eq: "anyone" } }  // SECURITY: public only
  }
}
```

---

## Public Visibility Filtering

This is a critical security boundary.

The RAG system enforces `visibility === "anyone"` at the database query level using the
`$vectorSearch` `filter` operator. This means:

| Post type | Retrieved by RAG? |
|---|---|
| `visibility: "anyone"` (public) | ✅ Yes |
| `visibility: "followers"` (private) | ❌ Never |

No follower-only or private posts can appear in AI context or sources under any circumstance.
The filter is applied inside MongoDB — not in application code after retrieval.

---

## API Reference

### `POST /api/ai/ask`

| Property | Value |
|---|---|
| **Auth** | Required — JWT cookie (same as all other protected routes) |
| **Rate limit** | 10 requests per 15 minutes per IP |
| **Content-Type** | `application/json` |

#### Request body

```json
{
  "question": "What are users discussing about React?"
}
```

| Field | Type | Constraints |
|---|---|---|
| `question` | string | Required, 1–500 characters |

#### Success response `200`

```json
{
  "success": true,
  "answer": "Based on the available GOSocial posts, several users are discussing React in the context of...",
  "sources": [
    {
      "postId": "64abc...",
      "content": "Just shipped my first React app!",
      "author": {
        "id": "64def...",
        "username": "gokul_k"
      }
    }
  ]
}
```

#### Error responses

| Status | Condition |
|---|---|
| `400` | Missing question, empty question, or question > 500 chars |
| `401` | Not authenticated |
| `429` | Rate limit exceeded |
| `500` | Vector search / LLM failure (safe generic message returned) |

---

## Required Environment Variables

Add these to `backend/.env`:

```env
# Required for RAG feature — LLM answer generation only
GEMINI_API_KEY=your_gemini_api_key_here

# Optional — defaults shown
LLM_MODEL=gemini-1.5-flash
MONGODB_VECTOR_INDEX=post_embedding_index
```

**`EMBEDDING_MODEL` is no longer used and should be removed from any existing `.env` files.**

**Never** put `GEMINI_API_KEY` in:
- Frontend `.env` files
- Any `VITE_` prefixed variable
- Source code
- `.env.example` (only the placeholder key name goes there)

---

## Rate Limiting

| Limiter | Scope | Limit |
|---|---|---|
| `aiLimiter` (AI-specific) | Per IP | 10 requests / 15 minutes |
| `apiLimiter` (global) | Per IP | 10 000 requests / 15 minutes |

The AI limiter is applied only to `POST /api/ai/ask` to control Gemini API costs.

---

## Security

| Concern | How it's handled |
|---|---|
| API key exposure | `GEMINI_API_KEY` is backend-only; never sent to frontend |
| Embedding key exposure | None — Atlas manages voyage-4-lite; no key in the app |
| Private post access | `$vectorSearch` filter `{ visibility: { $eq: 'anyone' } }` — followers-only posts are never retrieved |
| Unauthenticated access | `protect` middleware rejects requests without a valid JWT |
| Rate abuse | Dedicated `aiLimiter`: 10 req / 15 min per IP |
| LLM hallucination | System prompt restricts model to answer only from provided context |
| Error leakage | All errors are caught; only safe user-facing messages are returned |
| Stack trace exposure | No raw `err.stack` or `err.message` from providers is ever sent to the client |

---

## Testing

### Test 1 — Unauthenticated request → 401

```bash
curl -X POST http://localhost:8000/api/ai/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"test"}'
# Expected: 401 Unauthorized
```

### Test 2 — Valid authenticated RAG response

Log into GOSocial, open the browser console and run:

```js
const res = await fetch('/api/ai/ask', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ question: 'What are people posting about?' })
});
console.log(await res.json());
// Expected: { success: true, answer: "...", sources: [...] }
```

### Test 3 — Rate limit → 429

Send more than 10 requests within 15 minutes from the same IP.  
Expected: `429 Too Many Requests`

### Test 4 — Grounding (no relevant posts)

Ask: *"What is the capital of France?"*  
Expected: model responds it couldn't find relevant GOSocial posts — not a fabricated answer.

### Test 5 — Private post isolation (security)

Create a post with `visibility: "followers"` containing a distinctive keyword.  
Ask a question using that keyword.  
Expected: the followers-only post **must not** appear in `sources[]`.

### Test 6 — Public post retrieval

Create a post with `visibility: "anyone"` containing a distinctive keyword.  
Ask a question using that keyword.  
Expected: that post **can** appear in `sources[]`.

---

## Source Attribution

The API always returns `sources[]` — the actual post documents used to generate the
answer. The frontend renders each source as a clickable card that routes to `/post/:id`.

Only these public-safe fields are exposed per source:
- `postId` — MongoDB ObjectId string
- `content` — post caption text
- `author.id` — MongoDB ObjectId string
- `author.username` — public username

No images, likes, comments, passwords, tokens, or private fields are included.

---

## Known Limitations

1. **Atlas index must be created manually** — no automatic index creation at startup.
2. **Atlas Automated Embedding availability** — `autoEmbed` with `voyage-4-lite` requires
   a MongoDB Atlas cluster that supports this feature. Verify availability for your cluster
   tier in the [Atlas documentation](https://www.mongodb.com/docs/atlas/atlas-vector-search/ai-integrations/automated-embedding/).
3. **Caption edits reflected automatically** — when a post's `caption` is updated, Atlas
   Automated Embedding will re-embed the document automatically (no application-side action needed).
4. **Rate limit is per-IP** — shared IPs (e.g. NAT) share the quota. A Redis-backed
   per-user limiter would be needed for production scale.
5. **No streaming** — the answer is returned in one JSON response. Streaming (SSE) could be added later.
6. **Gemini free tier limits** — the free Gemini API tier has per-minute and per-day quotas.
   For high traffic, a paid key is required.
7. **RAG is not active until the Atlas index is built and active** — do not claim the
   feature works in production until the index status shows **Active** in the Atlas UI.
