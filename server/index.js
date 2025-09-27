const path = require('path');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initializeDatabase, mapUserRow, createId } = require('./database');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'replace-me-with-a-strong-secret';
const TOKEN_TTL = '30d';

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
  : true;

const staticRoot = path.join(__dirname, '..');

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(staticRoot));

let db;

function createToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token.' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

async function buildState() {
  const [userRows, followRows, postRows, likeRows, commentRows, inboxRows] = await Promise.all([
    db.all('SELECT * FROM users'),
    db.all('SELECT * FROM follows'),
    db.all('SELECT * FROM posts'),
    db.all('SELECT * FROM likes'),
    db.all('SELECT * FROM comments'),
    db.all('SELECT * FROM inbox_messages'),
  ]);

  const followersMap = new Map();
  const followingMap = new Map();
  followRows.forEach((row) => {
    if (!followersMap.has(row.following_id)) followersMap.set(row.following_id, []);
    if (!followingMap.has(row.follower_id)) followingMap.set(row.follower_id, []);
    followersMap.get(row.following_id).push(row.follower_id);
    followingMap.get(row.follower_id).push(row.following_id);
  });

  const users = userRows
    .map((row) => {
      const user = mapUserRow(row);
      user.followers = followersMap.get(user.id) || [];
      user.following = followingMap.get(user.id) || [];
      return user;
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const postsById = new Map();
  const posts = postRows.map((row) => {
    const post = {
      id: row.id,
      authorId: row.author_id,
      recipientId: row.recipient_id,
      image: row.image,
      caption: row.caption,
      createdAt: row.created_at,
      visibility: row.visibility,
      originalPostId: row.original_post_id,
      likes: [],
      reposts: [],
      comments: [],
    };
    postsById.set(post.id, post);
    return post;
  });

  likeRows.forEach((row) => {
    const post = postsById.get(row.post_id);
    if (post) {
      post.likes.push(row.user_id);
    }
  });

  commentRows.forEach((row) => {
    const post = postsById.get(row.post_id);
    if (post) {
      post.comments.push({
        id: row.id,
        authorId: row.author_id,
        text: row.text,
        createdAt: row.created_at,
      });
    }
  });

  posts.forEach((post) => {
    post.comments.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  });

  posts
    .filter((post) => post.originalPostId)
    .forEach((post) => {
      const original = postsById.get(post.originalPostId);
      if (original) {
        original.reposts.push(post.authorId);
      }
    });

  const inbox = {};
  inboxRows.forEach((row) => {
    if (!inbox[row.recipient_id]) inbox[row.recipient_id] = [];
    inbox[row.recipient_id].push({
      id: row.id,
      postId: row.post_id,
      senderId: row.sender_id,
      createdAt: row.created_at,
      read: Boolean(row.read),
    });
  });

  Object.values(inbox).forEach((messages) => {
    messages.sort((a, b) => b.createdAt - a.createdAt);
  });

  return { users, posts, inbox };
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, displayName, bio = '', homeCity = '', avatar = null } = req.body;
    if (!email || !password || !displayName) {
      return res.status(400).json({ error: 'Email, password, and display name are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await db.get('SELECT id FROM users WHERE email = ?', normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'Email already in use.' });
    }

    const id = createId();
    const hash = await bcrypt.hash(password, 12);
    const now = Date.now();
    await db.run(
      `INSERT INTO users (
        id, email, password_hash, display_name, bio, home_city, avatar,
        location_lat, location_lng, location_updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`
        ,
      [id, normalizedEmail, hash, displayName.trim(), bio.trim(), homeCity.trim(), avatar, now]
    );

    const token = createToken({ userId: id });
    const state = await buildState();
    res.status(201).json({ token, userId: id, state });
  } catch (error) {
    console.error('Signup failed', error);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const row = await db.get('SELECT * FROM users WHERE email = ?', normalizedEmail);
    if (!row) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const token = createToken({ userId: row.id });
    const state = await buildState();
    res.json({ token, userId: row.id, state });
  } catch (error) {
    console.error('Login failed', error);
    res.status(500).json({ error: 'Failed to log in.' });
  }
});

app.get('/api/state', requireAuth, async (_req, res) => {
  try {
    const state = await buildState();
    res.json(state);
  } catch (error) {
    console.error('Failed to load state', error);
    res.status(500).json({ error: 'Failed to load state.' });
  }
});

app.post('/api/follows/:userId/toggle', requireAuth, async (req, res) => {
  try {
    const currentId = req.userId;
    const targetId = req.params.userId;
    if (currentId === targetId) {
      return res.status(400).json({ error: 'Cannot follow yourself.' });
    }
    const existing = await db.get(
      'SELECT follower_id FROM follows WHERE follower_id = ? AND following_id = ?',
      currentId,
      targetId
    );
    if (existing) {
      await db.run('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [currentId, targetId]);
    } else {
      await db.run(
        'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)',
        [currentId, targetId, Date.now()]
      );
    }
    const state = await buildState();
    res.json(state);
  } catch (error) {
    console.error('Failed to toggle follow', error);
    res.status(500).json({ error: 'Failed to update follow state.' });
  }
});

app.post('/api/posts', requireAuth, async (req, res) => {
  try {
    const { recipientId, image, caption = '', visibility = 'public' } = req.body;
    if (!recipientId || !image) {
      return res.status(400).json({ error: 'Recipient and image are required.' });
    }
    const now = Date.now();
    const postId = createId();
    await db.run(
      `INSERT INTO posts (id, author_id, recipient_id, image, caption, created_at, visibility, original_post_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [postId, req.userId, recipientId, image, caption, now, visibility]
    );

    await db.run(
      `INSERT INTO inbox_messages (id, recipient_id, post_id, sender_id, created_at, read)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [createId(), recipientId, postId, req.userId, now]
    );

    const state = await buildState();
    res.status(201).json(state);
  } catch (error) {
    console.error('Failed to create post', error);
    res.status(500).json({ error: 'Failed to create post.' });
  }
});

app.post('/api/posts/:postId/like', requireAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const existing = await db.get(
      'SELECT post_id FROM likes WHERE post_id = ? AND user_id = ?',
      [postId, req.userId]
    );
    if (existing) {
      await db.run('DELETE FROM likes WHERE post_id = ? AND user_id = ?', [postId, req.userId]);
    } else {
      await db.run('INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)', [
        postId,
        req.userId,
        Date.now(),
      ]);
    }
    const state = await buildState();
    res.json(state);
  } catch (error) {
    console.error('Failed to toggle like', error);
    res.status(500).json({ error: 'Failed to toggle like.' });
  }
});

app.post('/api/posts/:postId/comments', requireAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Comment text is required.' });
    }
    const commentId = createId();
    const now = Date.now();
    await db.run(
      `INSERT INTO comments (id, post_id, author_id, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [commentId, postId, req.userId, text.trim(), now]
    );
    const state = await buildState();
    res.status(201).json(state);
  } catch (error) {
    console.error('Failed to add comment', error);
    res.status(500).json({ error: 'Failed to add comment.' });
  }
});

app.post('/api/posts/:postId/repost', requireAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const original = await db.get('SELECT * FROM posts WHERE id = ?', postId);
    if (!original) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    const canonicalId = original.original_post_id || original.id;
    const existing = await db.get(
      `SELECT id FROM posts WHERE original_post_id = ? AND author_id = ?`,
      [canonicalId, req.userId]
    );

    if (existing) {
      await db.run('DELETE FROM posts WHERE id = ?', [existing.id]);
      const state = await buildState();
      return res.json(state);
    }

    const canonical = await db.get('SELECT * FROM posts WHERE id = ?', canonicalId);
    if (!canonical) {
      return res.status(404).json({ error: 'Original post not found.' });
    }

    const newCaption = canonical.caption
      ? `Repost · ${canonical.caption}`
      : 'Reposted a candid moment';
    await db.run(
      `INSERT INTO posts (id, author_id, recipient_id, image, caption, created_at, visibility, original_post_id)
       VALUES (?, ?, ?, ?, ?, ?, 'public', ?)`,
      [
        createId(),
        req.userId,
        canonical.recipient_id,
        canonical.image,
        newCaption,
        Date.now(),
        canonical.id,
      ]
    );

    const state = await buildState();
    res.status(201).json(state);
  } catch (error) {
    console.error('Failed to toggle repost', error);
    res.status(500).json({ error: 'Failed to toggle repost.' });
  }
});

app.post('/api/inbox/mark-read', requireAuth, async (req, res) => {
  try {
    const { messageIds } = req.body;
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ error: 'messageIds array is required.' });
    }
    const placeholders = messageIds.map(() => '?').join(',');
    await db.run(
      `UPDATE inbox_messages SET read = 1 WHERE id IN (${placeholders}) AND recipient_id = ?`,
      [...messageIds, req.userId]
    );
    const state = await buildState();
    res.json(state);
  } catch (error) {
    console.error('Failed to mark inbox as read', error);
    res.status(500).json({ error: 'Failed to mark inbox messages.' });
  }
});

app.post('/api/users/me/location', requireAuth, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Latitude and longitude are required numbers.' });
    }
    await db.run(
      `UPDATE users SET location_lat = ?, location_lng = ?, location_updated_at = ? WHERE id = ?`,
      [lat, lng, Date.now(), req.userId]
    );
    const state = await buildState();
    res.json(state);
  } catch (error) {
    console.error('Failed to update location', error);
    res.status(500).json({ error: 'Failed to update location.' });
  }
});


app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(staticRoot, 'index.html'));
});

initializeDatabase()
  .then((database) => {
    db = database;
    app.listen(PORT, () => {
      console.log(`Kandid API listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
