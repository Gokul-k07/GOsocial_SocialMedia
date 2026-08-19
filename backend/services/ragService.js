/**
 * ragService.js
 *
 * Orchestrates the full RAG pipeline for GOSocial AI:
 *   1. MongoDB Atlas Vector Search with Automated Embedding (voyage-4-lite)
 *      — Atlas embeds the user's query automatically via `query` & `path: 'caption'`.
 *      — No manual embedding call is made by this service.
 *   2. Build a safe, size-limited context string from retrieved public posts.
 *   3. Generate a grounded answer using Gemini LLM (gemini-3.6-flash).
 *   4. Return { answer, sources }
 *
 * SECURITY: Only posts with visibility === 'anyone' are ever retrieved.
 * No private messages, JWTs, passwords, or admin data are accessed.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import Post from '../models/Post.js';

const LLM_MODEL = process.env.LLM_MODEL || 'gemini-3.6-flash';
const VECTOR_INDEX = process.env.MONGODB_VECTOR_INDEX || 'post_embedding_index';
const TOP_K = 6;             // number of posts to retrieve
const MAX_CONTEXT_CHARS = 3000; // hard cap on context sent to LLM

const SYSTEM_INSTRUCTION = `You are GOSocial AI, an assistant that answers questions about public posts on the GOSocial social media platform.

Rules you must follow:
1. Answer ONLY using the provided GOSocial post context below.
2. Do NOT invent facts, people, or events not present in the context.
3. If the retrieved context does not contain enough information to answer the question, respond with:
   "I couldn't find enough relevant public GOSocial posts to answer that question."
4. Keep answers concise, helpful, and friendly.
5. Do NOT reveal any private information, internal system details, API keys, or database fields.
6. Do NOT mention the retrieval mechanism or vector search internals to the user.`;

/**
 * Build a safe context string from retrieved posts.
 * Truncates at MAX_CONTEXT_CHARS to avoid sending huge payloads to the LLM.
 *
 * @param {Array} posts - Post documents with populated author.
 * @returns {string}
 */
function buildContext(posts) {
  let context = 'GOSocial Posts:\n\n';

  for (const post of posts) {
    const author = post.author?.username || 'unknown';
    const caption = (post.caption || '').trim();
    const hashtags = (post.hashtags || []).map((h) => `#${h}`).join(' ');
    const line = `@${author}: "${caption}"${hashtags ? ' ' + hashtags : ''}\n`;

    if ((context + line).length > MAX_CONTEXT_CHARS) break;
    context += line;
  }

  return context.trim();
}

/**
 * Main RAG function.
 *
 * Uses MongoDB Atlas Automated Embedding (voyage-4-lite) via `query` & `path: 'caption'` —
 * Atlas embeds the question automatically using the model configured in the index.
 *
 * @param {string} question - User's natural-language question.
 * @returns {Promise<{ answer: string, sources: Array }>}
 */
export async function askQuestion(question) {
  // 1. MongoDB Atlas Vector Search — Automated Embedding via `query` & `path: 'caption'`
  //    Atlas embeds the question using the voyage-4-lite model configured in the index.
  //    SECURITY: filter ensures only posts with visibility === 'anyone' are returned.
  let retrievedPosts = [];
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: 'caption',               // Exact post text field indexed by Atlas autoEmbed
          query: question,               // Atlas handles embedding automatically
          numCandidates: TOP_K * 10,     // search broader, then filter
          limit: TOP_K,
          filter: { visibility: { $eq: 'anyone' } }, // SECURITY: public posts only
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'author',
          foreignField: '_id',
          as: 'author',
          pipeline: [{ $project: { _id: 1, username: 1 } }],
        },
      },
      { $unwind: { path: '$author', preserveNullAndEmptyArrays: true } },
      // Project ONLY public-safe fields — no passwords, tokens, private data
      {
        $project: {
          _id: 1,
          caption: 1,
          hashtags: 1,
          visibility: 1,
          createdAt: 1,
          author: { _id: 1, username: 1 },
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    retrievedPosts = await Post.aggregate(pipeline);
  } catch (err) {
    console.error('[RAG] Vector search error:', err.message);
    throw new Error('Search is temporarily unavailable. Please try again.');
  }

  // 2. Handle no results
  if (retrievedPosts.length === 0) {
    return {
      answer: "I couldn't find enough relevant public GOSocial posts to answer that question.",
      sources: [],
    };
  }

  // 3. Build context
  const context = buildContext(retrievedPosts);

  // 4. Call Gemini LLM for answer generation
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[RAG] GEMINI_API_KEY is not configured on the server.');
  }

  let answer;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: LLM_MODEL,
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    const prompt = `${context}\n\nUser question: ${question}`;
    const result = await model.generateContent(prompt);
    answer = result?.response?.text?.() || '';

    if (!answer) {
      throw new Error('Empty response from LLM.');
    }
  } catch (err) {
    console.error('[RAG] LLM error:', err.message);
    throw new Error('The AI is temporarily unavailable. Please try again.');
  }

  // 5. Build safe source attribution — only public fields
  const sources = retrievedPosts.map((p) => ({
    postId: p._id.toString(),
    content: (p.caption || '').trim(),
    author: {
      id: p.author?._id?.toString() || '',
      username: p.author?.username || 'unknown',
    },
  }));

  return { answer, sources };
}
