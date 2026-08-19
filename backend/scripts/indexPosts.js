/**
 * indexPosts.js
 *
 * One-time (re-runnable) script to generate Gemini embeddings for all
 * public GOSocial posts that have not been embedded yet.
 *
 * Usage:
 *   node --env-file=backend/.env backend/scripts/indexPosts.js
 *
 * Safe to run multiple times — already-embedded posts are skipped.
 * Errors on individual posts are logged but do not stop the batch.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Post from '../models/Post.js';
import { generateAndStoreEmbedding } from '../services/embeddingService.js';

const BATCH_SIZE = 10;      // posts per batch
const BATCH_DELAY_MS = 300; // ms between batches (avoid API rate limits)

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('[INDEX] ERROR: MONGODB_URI is not set in environment.');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('[INDEX] ERROR: GEMINI_API_KEY is not set in environment.');
    process.exit(1);
  }

  console.log('[INDEX] Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('[INDEX] Connected.');

  // Find all public posts without a valid embedding
  // Using .select('+embedding') because embedding field has select:false
  const posts = await Post.find({
    visibility: 'anyone',
    $or: [
      { embedding: { $exists: false } },
      { embedding: { $size: 0 } },
      { embeddingError: true },
    ],
  })
    .select('+embedding caption hashtags')
    .lean();

  const total = posts.length;
  console.log(`[INDEX] Found ${total} post(s) to index.`);

  if (total === 0) {
    console.log('[INDEX] Nothing to do. All public posts are already embedded.');
    await mongoose.disconnect();
    return;
  }

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(posts.length / BATCH_SIZE);

    console.log(`[INDEX] Batch ${batchNum}/${totalBatches} — processing ${batch.length} post(s)...`);

    await Promise.all(
      batch.map(async (post) => {
        try {
          await generateAndStoreEmbedding(post._id.toString(), post.caption || '', post.hashtags || []);
          succeeded++;
        } catch {
          // generateAndStoreEmbedding never throws; this is a safety net
          failed++;
        }
      })
    );

    if (i + BATCH_SIZE < posts.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`\n[INDEX] Done. Succeeded: ${succeeded} | Failed: ${failed} | Total: ${total}`);
  if (failed > 0) {
    console.log('[INDEX] Re-run this script to retry failed posts (embeddingError: true).');
  }

  await mongoose.disconnect();
  console.log('[INDEX] Disconnected.');
}

main().catch((err) => {
  console.error('[INDEX] Fatal error:', err.message);
  process.exit(1);
});
