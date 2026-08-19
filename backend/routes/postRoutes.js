import jwt from 'jsonwebtoken';
import express from 'express';
import Post from '../models/Post.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';
import { protect } from '../middleware/auth.js';
import { buildUserLookupQuery } from '../utils/userLookup.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 8;
    const author = String(req.query.author || '').trim();
    const filter = {};

    if (author) {
      const authorUser = await User.findOne(buildUserLookupQuery(author)).select('_id');
      if (!authorUser) {
        return res.json({ posts: [], total: 0, page, pages: 0 });
      }
      filter.author = authorUser._id;
    }

    // Optional user authentication for visibility check
    let requestingUserId = null;
    let followingIds = [];
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      try {
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        requestingUserId = decoded.id;
        const currentUser = await User.findById(requestingUserId).select('following');
        if (currentUser) {
          followingIds = currentUser.following || [];
        }
      } catch {
        // Unauthenticated request fallback
      }
    }

    if (requestingUserId) {
      filter.$or = [
        { visibility: { $ne: 'followers' } },
        { author: requestingUserId },
        { author: { $in: followingIds }, visibility: 'followers' },
      ];
    } else {
      filter.visibility = { $ne: 'followers' };
    }

    const posts = await Post.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('author', 'username fullname avatar bio')
      .populate('comments.author', 'username fullname avatar');

    const total = await Post.countDocuments(filter);
    res.json({ posts, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
});

// @desc    Get user's bookmarked posts
// @route   GET /api/posts/bookmarks
// @access  Private
router.get('/bookmarks', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).populate({
      path: 'bookmarks',
      populate: [
        { path: 'author', select: 'username fullname avatar bio' },
        { path: 'comments.author', select: 'username fullname avatar' },
      ],
    });

    const posts = (user.bookmarks || [])
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ posts });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('author', 'username fullname avatar bio')
      .populate('comments.author', 'username fullname avatar');

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    res.json({ post });
  } catch (error) {
    next(error);
  }
});

const DANGEROUS_EXTENSIONS = [
  'exe', 'msi', 'bat', 'cmd', 'sh', 'vbs', 'ps1', 'apk', 'jar', 'js', 'scr', 'dll', 'sys', 'com', 'py', 'iso', 'zip', 'rar', '7z', 'php', 'html', 'htm'
];

function isSafeAttachment(att) {
  if (!att || !att.name) return false;
  const ext = att.name.split('.').pop().toLowerCase();
  if (DANGEROUS_EXTENSIONS.includes(ext)) return false;
  if (att.fileSize && att.fileSize > 5 * 1024 * 1024) return false;
  return true;
}

router.post('/', protect, async (req, res, next) => {
  try {
    const { caption = '', image = '', images = [], attachments = [], visibility = 'anyone' } = req.body;
    
    // Sanitize document attachments against dangerous extensions & size limits (>5MB)
    const safeAttachments = (attachments || []).filter(isSafeAttachment);

    // Validate empty post
    const hasCaption = caption && caption.trim().length > 0;
    const hasImage = image || (images && images.length > 0);
    const hasAttachment = safeAttachments.length > 0;

    if (!hasCaption && !hasImage && !hasAttachment) {
      return res.status(400).json({ message: 'Post content cannot be completely empty.' });
    }

    // Extract hashtags
    const hashtagsMatch = caption.match(/#([a-zA-Z0-9_]+)/g);
    const hashtags = hashtagsMatch ? Array.from(new Set(hashtagsMatch.map(h => h.slice(1).toLowerCase()))) : [];

    // Extract mentions
    const mentionsMatch = caption.match(/@([a-zA-Z0-9_.]+)/g);
    const mentionUsernames = mentionsMatch ? Array.from(new Set(mentionsMatch.map(m => m.slice(1).toLowerCase()))) : [];

    let mentionUserIds = [];
    if (mentionUsernames.length > 0) {
      const mentionedUsers = await User.find({ username: { $in: mentionUsernames } }).select('_id');
      mentionUserIds = mentionedUsers.map(u => u._id);
    }

    const allImages = images.length > 0 ? images : (image ? [image] : []);
    const postData = {
      author: req.user.id,
      caption,
      image: allImages[0] || '',
      images: allImages,
      attachments: safeAttachments,
      hashtags,
      mentions: mentionUserIds,
      visibility,
    };

    const post = await Post.create(postData);

    // Trigger notifications for mentioned users
    for (const recipientId of mentionUserIds) {
      if (recipientId.toString() !== req.user.id) {
        await Notification.create({
          recipient: recipientId,
          sender: req.user.id,
          type: 'mention',
          post: post._id,
        });
      }
    }

    const populated = await Post.findById(post._id)
      .populate('author', 'username fullname avatar bio')
      .populate('comments.author', 'username fullname avatar');

    res.status(201).json({ post: populated });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', protect, async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (post.author.toString() !== req.user.id) return res.status(403).json({ message: 'Not allowed' });

    // Strict 3-hour edit window check (3 * 60 * 60 * 1000 ms)
    const postAgeMs = Date.now() - new Date(post.createdAt).getTime();
    const maxAgeMs = 3 * 60 * 60 * 1000;
    if (postAgeMs > maxAgeMs) {
      return res.status(403).json({ message: 'Posts can only be edited within 3 hours of creation.' });
    }

    if (req.body.caption !== undefined) post.caption = req.body.caption;
    if (req.body.visibility !== undefined) post.visibility = req.body.visibility;

    await post.save();
    const populated = await Post.findById(post._id)
      .populate('author', 'username fullname avatar bio')
      .populate('comments.author', 'username fullname avatar');

    res.json({ post: populated });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', protect, async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (post.author.toString() !== req.user.id) return res.status(403).json({ message: 'Not allowed' });
    await post.deleteOne();
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/like', protect, async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    const hasLiked = post.likes.includes(req.user.id);
    if (hasLiked) {
      post.likes = post.likes.filter((id) => id.toString() !== req.user.id);
    } else {
      post.likes.push(req.user.id);
      if (post.author.toString() !== req.user.id) {
        const existing = await Notification.findOne({
          type: 'like',
          sender: req.user.id,
          recipient: post.author,
          post: post._id,
        });
        if (!existing) {
          await Notification.create({
            type: 'like',
            sender: req.user.id,
            recipient: post.author,
            post: post._id,
          });
        }
      }
    }

    await post.save();
    // Return only the fields needed for a local update (no full populate to keep it fast)
    res.json({ post: { _id: post._id, likes: post.likes } });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/comment', protect, async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    post.comments.push({ author: req.user.id, text: req.body.text });
    if (post.author.toString() !== req.user.id) {
      await Notification.create({
        type: 'comment',
        sender: req.user.id,
        recipient: post.author,
        post: post._id,
      });
    }

    await post.save();
    const populated = await Post.findById(post._id).populate('comments.author', 'username fullname avatar');
    res.status(201).json({ post: populated });
  } catch (error) {
    next(error);
  }
});

router.delete('/:postId/comments/:commentId', protect, async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: 'Post not found' });
    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ message: 'Comment not found' });
    if (comment.author.toString() !== req.user.id) return res.status(403).json({ message: 'Not allowed' });
    comment.deleteOne();
    await post.save();
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/bookmark', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    const bookmarked = user.bookmarks.some((id) => id.toString() === req.params.id);
    if (bookmarked) {
      user.bookmarks = user.bookmarks.filter((id) => id.toString() !== req.params.id);
    } else {
      user.bookmarks.push(req.params.id);
    }
    await user.save();
    res.json({ bookmarked: !bookmarked, postId: req.params.id, bookmarks: user.bookmarks });
  } catch (error) {
    next(error);
  }
});

export default router;
