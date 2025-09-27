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
const CONTEST_START_DAY_UTC = 0; // Sunday
const CONTEST_START_HOUR_UTC = 20; // 8 PM UTC
const CONTEST_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const CONTEST_PROXIMITY_KM = 0.3;
const CONTEST_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const CONTEST_CAMPING_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
const CONTEST_CAMPING_DISTANCE_KM = 0.1;
const CONTEST_CHALLENGES = [
  'Capture them eating',
  'Catch them laughing',
  'Spot them with a colorful outfit',
  'Find them using their phone',
  'Capture them in motion',
  'Catch them with a group of friends',
];

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

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

function distanceKm(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lat2 === null || lon1 === null || lon2 === null) return Infinity;
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getContestWindow(now = Date.now()) {
  const current = new Date(now);
  const start = new Date(current.getTime());
  start.setUTCMilliseconds(0);
  start.setUTCSeconds(0);
  start.setUTCMinutes(0);
  start.setUTCHours(CONTEST_START_HOUR_UTC);
  // adjust to contest start day
  const dayDiff = (current.getUTCDay() - CONTEST_START_DAY_UTC + 7) % 7;
  start.setUTCDate(current.getUTCDate() - dayDiff);
  if (start.getTime() > now) {
    start.setUTCDate(start.getUTCDate() - 7);
  }
  const end = new Date(start.getTime() + CONTEST_DURATION_MS);
  return { startsAt: start.getTime(), endsAt: end.getTime() };
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function ensureActiveContest() {
  if (!db) return null;
  const now = Date.now();
  const window = getContestWindow(now);
  let contest = await db.get('SELECT * FROM contest_weeks WHERE starts_at = ?', window.startsAt);
  if (!contest) {
    const id = createId();
    const challenge = CONTEST_CHALLENGES[Math.floor(Math.random() * CONTEST_CHALLENGES.length)];
    await db.run(
      `INSERT INTO contest_weeks (id, starts_at, ends_at, challenge) VALUES (?, ?, ?, ?)`,
      [id, window.startsAt, window.endsAt, challenge]
    );
    contest = { id, starts_at: window.startsAt, ends_at: window.endsAt, challenge };
  }
  await syncContestAssignments(contest.id);
  return contest;
}

async function syncContestAssignments(contestId) {
  const participants = await db.all('SELECT id FROM users WHERE bekandid_enabled = 0');
  const bekandid = await db.all('SELECT id FROM users WHERE bekandid_enabled = 1');
  if (bekandid.length) {
    const placeholders = bekandid.map(() => '?').join(',');
    await db.run(
      `DELETE FROM contest_assignments WHERE contest_id = ? AND user_id IN (${placeholders})`,
      [contestId, ...bekandid.map((row) => row.id)]
    );
  }

  const existing = await db.all('SELECT * FROM contest_assignments WHERE contest_id = ?', contestId);
  const assignedSet = new Set(existing.map((row) => row.user_id));
  const toAssign = participants.filter((row) => !assignedSet.has(row.id));

  if (!existing.length) {
    const shuffled = shuffle(participants);
    const midpoint = Math.ceil(shuffled.length / 2);
    const hunters = shuffled.slice(0, midpoint);
    const ghosts = shuffled.slice(midpoint);
    const now = Date.now();
    for (const participant of hunters) {
      await db.run(
        `INSERT INTO contest_assignments (contest_id, user_id, role, captures, survival_flag, last_move_at)
         VALUES (?, ?, 'hunter', 0, 1, ?)` ,
        [contestId, participant.id, now]
      );
    }
    for (const participant of ghosts) {
      await db.run(
        `INSERT INTO contest_assignments (contest_id, user_id, role, captures, survival_flag, last_move_at)
         VALUES (?, ?, 'ghost', 0, 1, ?)` ,
        [contestId, participant.id, now]
      );
    }
    return;
  }

  let hunterCount = existing.filter((row) => row.role === 'hunter').length;
  let ghostCount = existing.filter((row) => row.role === 'ghost').length;
  const now = Date.now();
  for (const participant of toAssign) {
    const role = hunterCount <= ghostCount ? 'hunter' : 'ghost';
    await db.run(
      `INSERT INTO contest_assignments (contest_id, user_id, role, captures, survival_flag, last_move_at)
       VALUES (?, ?, ?, 0, 1, ?)`,
      [contestId, participant.id, role, now]
    );
    if (role === 'hunter') hunterCount += 1;
    else ghostCount += 1;
  }
}

async function createInboxEntry({ recipientId, senderId, postId = null, type = 'drop', message = null, createdAt = Date.now() }) {
  await db.run(
    `INSERT INTO inbox_messages (id, recipient_id, post_id, sender_id, created_at, read, type, message)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [createId(), recipientId, postId, senderId, createdAt, type, message]
  );
}

async function handleContestLocationUpdate(userId, lat, lng) {
  const contest = await ensureActiveContest();
  if (!contest) return;
  const assignment = await db.get(
    'SELECT * FROM contest_assignments WHERE contest_id = ? AND user_id = ?',
    contest.id,
    userId
  );
  if (!assignment) return;

  const now = Date.now();
  await db.run(
    `UPDATE contest_assignments
       SET last_location_lat = ?, last_location_lng = ?, last_move_at = COALESCE(last_move_at, ?)
     WHERE contest_id = ? AND user_id = ?`,
    lat,
    lng,
    now,
    contest.id,
    userId
  );

  if (assignment.role === 'ghost') {
    const previousLat = assignment.last_location_lat;
    const previousLng = assignment.last_location_lng;
    const previousMove = assignment.last_move_at || now;
    const movedDistance = distanceKm(previousLat, previousLng, lat, lng);
    if (movedDistance > CONTEST_CAMPING_DISTANCE_KM) {
      await db.run(
        `UPDATE contest_assignments
           SET camping_violation = 0, last_move_at = ?
         WHERE contest_id = ? AND user_id = ?`,
        now,
        contest.id,
        userId
      );
    } else if (now - previousMove > CONTEST_CAMPING_THRESHOLD_MS) {
      await db.run(
        `UPDATE contest_assignments SET camping_violation = 1 WHERE contest_id = ? AND user_id = ?`,
        contest.id,
        userId
      );
      await createInboxEntry({
        recipientId: userId,
        senderId: userId,
        type: 'contest_warning',
        message: 'Ghost alert: move around! Staying put will get you disqualified.',
        createdAt: now,
      });
    }
    return;
  }

  if (assignment.role !== 'hunter') return;

  const ghosts = await db.all(
    `SELECT ca.user_id, u.display_name, u.location_lat, u.location_lng
     FROM contest_assignments ca
     JOIN users u ON ca.user_id = u.id
     WHERE ca.contest_id = ? AND ca.role = 'ghost' AND ca.survival_flag = 1`,
    contest.id
  );

  for (const ghost of ghosts) {
    const distance = distanceKm(lat, lng, ghost.location_lat, ghost.location_lng);
    if (distance <= CONTEST_PROXIMITY_KM) {
      const recentAlert = await db.get(
        `SELECT id, created_at FROM inbox_messages
         WHERE recipient_id = ? AND sender_id = ? AND type = 'contest_alert'
         ORDER BY created_at DESC LIMIT 1`,
        userId,
        ghost.user_id
      );
      if (!recentAlert || now - recentAlert.created_at > CONTEST_ALERT_COOLDOWN_MS) {
        await createInboxEntry({
          recipientId: userId,
          senderId: ghost.user_id,
          type: 'contest_alert',
          message: `${ghost.display_name} is within ${Math.round(distance * 1000)} meters!`,
          createdAt: now,
        });
      }
    }
  }
}

async function handleContestCapture({ hunterId, ghostId, postId, challenge }) {
  const contest = await ensureActiveContest();
  if (!contest) return;
  if (contest.challenge !== challenge) {
    const err = new Error('This capture does not match the weekly contest challenge.');
    err.statusCode = 400;
    throw err;
  }
  const [hunterAssignment, ghostAssignment] = await Promise.all([
    db.get('SELECT * FROM contest_assignments WHERE contest_id = ? AND user_id = ?', contest.id, hunterId),
    db.get('SELECT * FROM contest_assignments WHERE contest_id = ? AND user_id = ?', contest.id, ghostId),
  ]);
  if (!hunterAssignment || hunterAssignment.role !== 'hunter') {
    const err = new Error('Only hunters can submit contest captures.');
    err.statusCode = 400;
    throw err;
  }
  if (!ghostAssignment || ghostAssignment.role !== 'ghost') {
    const err = new Error('Target is not an active ghost.');
    err.statusCode = 400;
    throw err;
  }
  const now = Date.now();
  await db.run(
    `INSERT INTO contest_captures (id, contest_id, hunter_id, ghost_id, post_id, challenge, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [createId(), contest.id, hunterId, ghostId, postId, challenge, now]
  );
  await db.run(
    `UPDATE contest_assignments SET captures = captures + 1 WHERE contest_id = ? AND user_id = ?`,
    contest.id,
    hunterId
  );
  await db.run(
    `UPDATE contest_assignments SET survival_flag = 0 WHERE contest_id = ? AND user_id = ?`,
    contest.id,
    ghostId
  );
  await createInboxEntry({
    recipientId: hunterId,
    senderId: ghostId,
    postId,
    type: 'contest_capture',
    message: 'Capture logged! Score updated.',
    createdAt: now,
  });
  await createInboxEntry({
    recipientId: ghostId,
    senderId: hunterId,
    postId,
    type: 'contest_captured',
    message: 'You were captured! Better luck next week.',
    createdAt: now,
  });
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
  const contest = await ensureActiveContest();
  const [userRows, followRows, postRows, likeRows, commentRows, inboxRows, assignmentRows, captureRows] = await Promise.all([
    db.all('SELECT * FROM users'),
    db.all('SELECT * FROM follows'),
    db.all('SELECT * FROM posts'),
    db.all('SELECT * FROM likes'),
    db.all('SELECT * FROM comments'),
    db.all('SELECT * FROM inbox_messages'),
    db.all('SELECT * FROM contest_assignments WHERE contest_id = ?', contest?.id || ''),
    db.all('SELECT * FROM contest_captures WHERE contest_id = ?', contest?.id || ''),
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
      postId: row.post_id || null,
      senderId: row.sender_id,
      createdAt: row.created_at,
      read: Boolean(row.read),
      type: row.type || 'drop',
      message: row.message || null,
    });
  });

  Object.values(inbox).forEach((messages) => {
    messages.sort((a, b) => b.createdAt - a.createdAt);
  });

  const assignmentsByUser = new Map();
  assignmentRows.forEach((row) => {
    assignmentsByUser.set(row.user_id, {
      contestId: row.contest_id,
      role: row.role,
      captures: row.captures,
      survivalFlag: Boolean(row.survival_flag),
      campingViolation: Boolean(row.camping_violation),
      lastMoveAt: row.last_move_at,
    });
  });

  users.forEach((user) => {
    const assignment = assignmentsByUser.get(user.id);
    user.contestRole = assignment ? assignment.role : null;
    user.contestStats = assignment
      ? {
          captures: assignment.captures,
          survivor: assignment.survivalFlag,
          campingViolation: assignment.campingViolation,
        }
      : null;
  });

  let contestState = null;
  if (contest) {
    const hunterLeaderboard = assignmentRows
      .filter((row) => row.role === 'hunter')
      .sort((a, b) => b.captures - a.captures)
      .map((row) => ({ userId: row.user_id, captures: row.captures }));
    const survivingGhosts = assignmentRows
      .filter((row) => row.role === 'ghost' && row.survival_flag && !row.camping_violation)
      .map((row) => row.user_id);

    contestState = {
      id: contest.id,
      challenge: contest.challenge,
      startsAt: contest.starts_at,
      endsAt: contest.ends_at,
      hunterLeaderboard,
      survivingGhosts,
      captures: captureRows.map((row) => ({
        id: row.id,
        hunterId: row.hunter_id,
        ghostId: row.ghost_id,
        postId: row.post_id,
        createdAt: row.created_at,
        challenge: row.challenge,
      })),
    };
  }

  return { users, posts, inbox, contest: contestState };
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
      const now = Date.now();
      await db.run(
        'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)',
        [currentId, targetId, now]
      );
      await db.run(
        `INSERT INTO inbox_messages (id, recipient_id, post_id, sender_id, created_at, read, type, message)
         VALUES (?, ?, NULL, ?, ?, 0, 'follow', NULL)`,
        [createId(), targetId, currentId, now]
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
    const { recipientId, image, caption = '', visibility = 'public', contestCapture = false } = req.body;
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

    const recipientRow = await db.get('SELECT bekandid_enabled FROM users WHERE id = ?', recipientId);
    await createInboxEntry({
      recipientId,
      senderId: req.userId,
      postId,
      type: recipientRow?.bekandid_enabled ? 'bekandid_drop' : 'drop',
      createdAt: now,
    });

    if (contestCapture) {
      await handleContestCapture({
        hunterId: req.userId,
        ghostId: recipientId,
        postId,
        challenge: req.body.contestChallenge || '',
      });
    }

    const state = await buildState();
    res.status(201).json(state);
  } catch (error) {
    console.error('Failed to create post', error);
    if (error.statusCode) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create post.' });
    }
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
    await handleContestLocationUpdate(req.userId, lat, lng);
    const state = await buildState();
    res.json(state);
  } catch (error) {
    console.error('Failed to update location', error);
    res.status(500).json({ error: 'Failed to update location.' });
  }
});


app.post('/api/users/me/bekandid', requireAuth, async (req, res) => {
  try {
    const enabled = Boolean(req.body.enabled);
    await db.run('UPDATE users SET bekandid_enabled = ? WHERE id = ?', enabled ? 1 : 0, req.userId);
    await ensureActiveContest();
    const state = await buildState();
    res.json(state);
  } catch (error) {
    console.error('Failed to toggle BeKandid mode', error);
    res.status(500).json({ error: 'Failed to toggle BeKandid mode.' });
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
