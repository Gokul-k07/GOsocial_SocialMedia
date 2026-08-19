/**
 * ragService.js
 *
 * Orchestrates the full RAG pipeline for GOSocial AI:
 *   1. Embed the user's question (Gemini text-embedding-004)
 *   2. Vector search against public posts (MongoDB Atlas $vectorSearch)
 *   3. Build a safe, size-limited context string
 *   4. Generate a grounded answer (Gemini 1.5-flash)
 *   5. Return { answer, sources }
 *
 * Only posts with visibility === 'anyone' are ever retrieved.
 * No private messages, JWTs, passwords, or admin data are accessed.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import mongoose from 'mongoose';
import Post from '../models/Post.js';
import { generateEmbedding } from './embeddingService.js';

const LLM_MODEL = process.env.LLM_MODEL || 'gemini-1.5-flash';
const VECTOR_INDEX = process.env.MONGODB_VECTOR_INDEX || 'post_embedding_index';
const TOP_K = 6;          // number of posts to retrieve
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
 * @param {Array} posts - Lean post documents with populated author.
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
 * @param {string} question - User's natural-language question.
 * @returns {Promise<{ answer: string, sources: Array }>}
 */
export async function askQuestion(question) {
  // 1. Embed the question
  let queryVector;
  try {
    queryVector = await generateEmbedding(question);
  } catch (err) {
    console.error('[RAG] Embedding error:', err.message);
    throw new Error('Failed to process your question. Please try again.');
  }

  // 2. MongoDB Atlas Vector Search — public posts only
  let retrievedPosts = [];
  try {
    const collection = mongoose.connection.collection('posts');

    const pipeline = [
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: 'embedding',
          queryVector,
          numCandidates: TOP_K * 10, // search broader, then filter
          limit: TOP_K,
          filter: { visibility: 'anyone' }, // SECURITY: only public posts
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
      { $unwind: { path: '$author', preserveNullAndEmpty: true } },
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

    retrievedPosts = await collection.aggregate(pipeline).toArray();
  } catch (err) {
    console.error('[RAG] Vector search error:', err.message);
    throw new Error('Search is temporarily unavailable. Please try again.');
  }

  // 3. Handle no results
  if (retrievedPosts.length === 0) {
    return {
      answer: "I couldn't find enough relevant public GOSocial posts to answer that question.",
      sources: [],
    };
  }

  // 4. Build context
  const context = buildContext(retrievedPosts);

  // 5. Call LLM
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

  // 6. Build safe source attribution — only public fields
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
