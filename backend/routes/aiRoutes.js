/**
 * aiRoutes.js
 *
 * POST /api/ai/ask
 *
 * Protected endpoint for the GOSocial AI RAG feature.
 * Requires JWT authentication (existing `protect` middleware).
 * Applies its own strict rate limiter to control AI API costs.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { protect } from '../middleware/auth.js';
import { askQuestion } from '../services/ragService.js';

const router = express.Router();

// Strict rate limit: 10 questions per 15 minutes per IP
// Kept separate from the global API limiter so it doesn't affect other routes.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'You have asked too many questions. Please wait 15 minutes before trying again.',
  },
  skip: (req) => {
    // Only apply AFTER the protect middleware sets req.user
    // (rate limiting by IP is fine here; per-user would need a store)
    return false;
  },
});

/**
 * @route   POST /api/ai/ask
 * @access  Private (JWT required)
 * @body    { question: string }  max 500 chars
 * @returns { success, answer, sources[] }
 */
router.post('/ask', protect, aiLimiter, async (req, res) => {
  try {
    const { question } = req.body;

    // --- Input validation ---
    if (!question || typeof question !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Please provide a question.',
      });
    }

    const trimmed = question.trim();
    if (trimmed.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Question cannot be empty.',
      });
    }
    if (trimmed.length > 500) {
      return res.status(400).json({
        success: false,
        message: 'Question is too long. Please keep it under 500 characters.',
      });
    }

    // --- RAG pipeline ---
    const { answer, sources } = await askQuestion(trimmed);

    return res.json({ success: true, answer, sources });
  } catch (err) {
    // Log the real error server-side, return a safe generic message
    console.error('[AI ROUTE] Error:', err.message);

    // Surface user-friendly messages from ragService (already sanitized)
    const isUserFacing =
      err.message.includes('temporarily unavailable') ||
      err.message.includes('process your question') ||
      err.message.includes('Search is temporarily');

    return res.status(500).json({
      success: false,
      message: isUserFacing
        ? err.message
        : 'Something went wrong. Please try again.',
    });
  }
});

export default router;
