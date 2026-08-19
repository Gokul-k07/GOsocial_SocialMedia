/**
 * embeddingService.js
 *
 * Generates text embeddings using Google Gemini text-embedding-004 (768-dim).
 * API key is read from GEMINI_API_KEY environment variable — never exposed
 * to the frontend.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import Post from '../models/Post.js';

const MODEL_NAME = process.env.EMBEDDING_MODEL || 'text-embedding-004';

/**
 * Build a safe text representation of a post for embedding.
 * Only uses the public caption field — no private data.
 */
function buildPostText(caption = '', hashtags = []) {
  const parts = [caption.trim()];
  if (hashtags.length > 0) {
    parts.push(hashtags.map((h) => `#${h}`).join(' '));
  }
  return parts.filter(Boolean).join(' ').slice(0, 2000); // cap at 2000 chars
}

/**
 * Generate a single embedding vector for the given text.
 *
 * @param {string} text - Plain text to embed.
 * @returns {Promise<number[]>}  768-dimensional float array.
 */
export async function generateEmbedding(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[EMBEDDING] GEMINI_API_KEY is not set in environment.');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  const result = await model.embedContent(text);
  const values = result?.embedding?.values;

  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('[EMBEDDING] Received empty embedding from Gemini API.');
  }

  return values; // 768-dim float array
}

/**
 * Generate an embedding for a saved Post document and store it.
 * Safe to call fire-and-forget — errors are logged, never re-thrown,
 * and the original post is never modified except for the embedding fields.
 *
 * @param {string} postId  - MongoDB ObjectId string of the post.
 * @param {string} caption - Post caption text.
 * @param {string[]} [hashtags=[]] - Post hashtags array.
 */
export async function generateAndStoreEmbedding(postId, caption, hashtags = []) {
  try {
    const text = buildPostText(caption, hashtags);
    if (!text) {
      console.warn('[EMBEDDING] Post', postId, 'has no text to embed — skipping.');
      return;
    }

    const vector = await generateEmbedding(text);

    await Post.findByIdAndUpdate(postId, {
      $set: { embedding: vector, embeddingError: false },
    });

    console.log('[EMBEDDING] Stored embedding for post', postId);
  } catch (err) {
    // Log safely — no secrets in message
    console.error('[EMBEDDING] Failed for post', postId, '—', err.message);

    // Mark the post so the indexing script can retry it later
    try {
      await Post.findByIdAndUpdate(postId, {
        $set: { embeddingError: true },
      });
    } catch {
      // Best-effort — do not throw
    }
  }
}
