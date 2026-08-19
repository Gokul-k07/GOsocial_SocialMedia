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
services/embeddingService.js  →  Gemini text-embedding-004  →  768-dim vector
     ↓
MongoDB Atlas $vectorSearch  (posts collection, visibility: 'anyone' only)
     ↓
Top-6 relevant public posts  +  author.username
     ↓
services/ragService.js  →  Build context (max 3000 chars)  →  Gemini 1.5-flash
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

1. Converts the question to a vector embedding.
2. Searches GOSocial's own post database for semantically similar posts.
3. Feeds those real posts as context to Gemini.
4. Gemini answers using only that context — and says so if there isn't enough.

---

## How Embeddings Work

A text embedding is a list of numbers (a vector) that captures the *meaning* of text.
Similar sentences produce vectors that are close together in high-dimensional space.

GOSocial uses **Google Gemini `text-embedding-004`**, which produces **768-dimensional**
float vectors. Each public post's caption is converted to one of these vectors and stored
in MongoDB. At query time the user's question is also embedded, and MongoDB returns the
posts whose vectors are closest.

---

## How Posts Are Indexed

### New posts (automatic)
When a user creates a public post (`visibility: 'anyone'`), `postRoutes.js` calls
`generateAndStoreEmbedding()` **fire-and-forget** after the post is saved.
Post creation never fails due to embedding errors.

### Existing posts (one-time script)
Run the indexing script once after deployment to embed all historical public posts.

```bash
# From the project root
node --env-file=backend/.env backend/scripts/indexPosts.js
```

The script:
- Connects to MongoDB using `MONGODB_URI`.
- Finds all `visibility: 'anyone'` posts without a valid embedding.
- Processes them in batches of 10 (300 ms delay between batches).
- Is **safe to re-run** — already-embedded posts are skipped.
- Sets `embeddingError: true` on any post that fails, so you can retry.

---

## MongoDB Atlas Vector Search Setup

> [!IMPORTANT]
> This step must be done **manually** in the MongoDB Atlas UI or CLI
> before the AI feature will return results.

### Step 1 — Add GEMINI_API_KEY to backend `.env`

```env
GEMINI_API_KEY=your_actual_key_here
EMBEDDING_MODEL=text-embedding-004
LLM_MODEL=gemini-1.5-flash
MONGODB_VECTOR_INDEX=post_embedding_index
```

Get a free key at: https://aistudio.google.com/app/apikey

### Step 2 — Run the indexing script

```bash
node --env-file=backend/.env backend/scripts/indexPosts.js
```

Wait for it to finish. It will log progress and report failures.

### Step 3 — Create the Atlas Vector Search Index

1. Open **MongoDB Atlas** → your cluster → **Search** tab.
2. Click **Create Search Index** → choose **JSON Editor**.
3. Select the database and the **`posts`** collection.
4. Set the index name to exactly: **`post_embedding_index`**
   (or whatever you set `MONGODB_VECTOR_INDEX` to).
5. Paste this JSON definition:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 768,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "visibility"
    }
  ]
}
```

6. Click **Create Index** and wait for it to build (usually < 2 minutes).

> [!NOTE]
> `numDimensions: 768` matches Gemini `text-embedding-004` exactly.
> If you change the embedding model you must also re-index all posts
> and update the Atlas index dimensions.

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
| `500` | Embedding / vector search / LLM failure (safe generic message) |

---

## Required Environment Variables

Add these to `backend/.env`:

```env
# Required for RAG feature
GEMINI_API_KEY=your_gemini_api_key_here

# Optional — defaults shown
EMBEDDING_MODEL=text-embedding-004
LLM_MODEL=gemini-1.5-flash
MONGODB_VECTOR_INDEX=post_embedding_index
```

**Never** put `GEMINI_API_KEY` in:
- Frontend `.env` files
- Any `VITE_` prefixed variable
- Source code
- `.env.example` (only the placeholder key name goes there)

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

## Security

| Concern | How it's handled |
|---|---|
| API key exposure | `GEMINI_API_KEY` is backend-only; never sent to frontend |
| Private post access | `$vectorSearch` filter `{ visibility: 'anyone' }` — followers-only posts are never retrieved |
| Unauthenticated access | `protect` middleware rejects requests without a valid JWT |
| Rate abuse | Dedicated `aiLimiter`: 10 req / 15 min per IP |
| LLM hallucination | System prompt restricts model to answer only from provided context |
| Error leakage | All errors are caught; only safe user-facing messages are returned |
| Stack trace exposure | No raw `err.stack` or `err.message` from providers is ever sent to the client |

---

## Testing Checklist

### 1. Authentication
```bash
# Should return 401
curl -X POST http://localhost:8000/api/ai/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"test"}'
```

### 2. RAG answer
Log into GOSocial, open the browser console and run:
```js
const res = await fetch('/api/ai/ask', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ question: 'What are people posting about?' })
});
console.log(await res.json());
```

### 3. Grounding — unrelated question
Ask: *"What is the capital of France?"*
Expected: model responds it couldn't find relevant GOSocial posts.

### 4. Source accuracy
Verify returned `sources[].postId` values correspond to real posts in the database.

### 5. Existing features
After deployment, verify: login, register, home feed, create post, like, comment,
bookmark, follow/unfollow, search, profile, notifications, messages, admin.

---

## Known Limitations

1. **Atlas index must be created manually** — no automatic index creation at startup.
2. **Historical posts need one-time indexing** — run `scripts/indexPosts.js` after setup.
3. **Embeddings not regenerated on post edit** — editing a post's caption does not update its embedding. A future enhancement could hook into `PUT /api/posts/:id`.
4. **Rate limit is per-IP** — shared IPs (e.g. NAT) share the quota. A Redis-backed per-user limiter would be needed for production scale.
5. **No streaming** — the answer is returned in one JSON response. Streaming (SSE) could be added later.
6. **Gemini free tier limits** — the free Gemini API tier has per-minute and per-day quotas. For high traffic, a paid key is required.
