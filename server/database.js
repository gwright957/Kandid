const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DB_PATH = path.join(__dirname, '..', 'data', 'kandid.sqlite');

function createId() {
  return crypto.randomUUID();
}

async function initializeDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  await db.exec('PRAGMA foreign_keys = ON;');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      bio TEXT,
      home_city TEXT,
      avatar TEXT,
      location_lat REAL,
      location_lng REAL,
      location_updated_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (follower_id, following_id),
      FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      recipient_id TEXT,
      image TEXT NOT NULL,
      caption TEXT,
      created_at INTEGER NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public',
      original_post_id TEXT,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (original_post_id) REFERENCES posts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS likes (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (post_id, user_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inbox_messages (
      id TEXT PRIMARY KEY,
      recipient_id TEXT NOT NULL,
      post_id TEXT,
      sender_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'drop',
      message TEXT,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await migrateInboxTableIfNeeded(db);
  await seedIfNeeded(db);

  return db;
}

async function migrateInboxTableIfNeeded(db) {
  const columns = await db.all('PRAGMA table_info(inbox_messages)');
  const hasTypeColumn = columns.some((column) => column.name === 'type');
  const postColumn = columns.find((column) => column.name === 'post_id');
  const postAllowsNull = postColumn ? postColumn.notnull === 0 : false;
  if (hasTypeColumn && postAllowsNull) {
    return;
  }

  await db.exec('BEGIN TRANSACTION;');
  try {
    await db.exec(`
      CREATE TABLE inbox_messages_new (
        id TEXT PRIMARY KEY,
        recipient_id TEXT NOT NULL,
        post_id TEXT,
        sender_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL DEFAULT 'drop',
        message TEXT,
        FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await db.exec(`
      INSERT INTO inbox_messages_new (id, recipient_id, post_id, sender_id, created_at, read, type, message)
      SELECT id, recipient_id, post_id, sender_id, created_at, read, 'drop', NULL
      FROM inbox_messages;
    `);

    await db.exec('DROP TABLE inbox_messages;');
    await db.exec('ALTER TABLE inbox_messages_new RENAME TO inbox_messages;');
    await db.exec('COMMIT;');
  } catch (error) {
    await db.exec('ROLLBACK;');
    throw error;
  }
}

async function seedIfNeeded(db) {
  const row = await db.get('SELECT COUNT(*) AS count FROM users');
  if (row.count > 0) return;

  const now = Date.now();

  const demoUsers = [
    {
      id: createId(),
      email: 'ari@kandid.com',
      displayName: 'Ari Castillo',
      bio: 'Street photographer & design nerd capturing city moments.',
      homeCity: 'Brooklyn, NY',
      location: { lat: 40.7129, lng: -74.0059, lastUpdated: now - 2000 },
      createdAt: now - 1000 * 60 * 60 * 24 * 12,
    },
    {
      id: createId(),
      email: 'mina@kandid.com',
      displayName: 'Mina Patel',
      bio: 'Coffee shop hopper. Catch me sketching candid smiles.',
      homeCity: 'Queens, NY',
      location: { lat: 40.7282, lng: -73.7949, lastUpdated: now - 60000 },
      createdAt: now - 1000 * 60 * 60 * 24 * 32,
    },
    {
      id: createId(),
      email: 'devon@kandid.com',
      displayName: 'Devon Blake',
      bio: 'Product designer chasing that perfect candid energy.',
      homeCity: 'Jersey City, NJ',
      location: { lat: 40.7178, lng: -74.0431, lastUpdated: now - 120000 },
      createdAt: now - 1000 * 60 * 60 * 24 * 58,
    },
  ];

  const passwordHash = await bcrypt.hash('password123', 10);

  for (const user of demoUsers) {
    await db.run(
      `INSERT INTO users (
        id, email, password_hash, display_name, bio, home_city, avatar,
        location_lat, location_lng, location_updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ,
      [
        user.id,
        user.email,
        passwordHash,
        user.displayName,
        user.bio,
        user.homeCity,
        null,
        user.location.lat,
        user.location.lng,
        user.location.lastUpdated,
        user.createdAt,
      ]
    );
  }

  const demoPosts = [
    {
      id: createId(),
      authorId: demoUsers[0].id,
      recipientId: demoUsers[1].id,
      image: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80',
      caption: 'Mina sketching strangers at the Bryant Park fountain. 🔥',
      createdAt: now - 1000 * 60 * 45,
      likes: [demoUsers[2].id],
      comments: [
        {
          id: createId(),
          authorId: demoUsers[1].id,
          text: 'Still thinking about this shot. Unreal!',
          createdAt: now - 1000 * 60 * 30,
        },
        {
          id: createId(),
          authorId: demoUsers[2].id,
          text: 'Colors are popping. Teach me your ways.',
          createdAt: now - 1000 * 60 * 15,
        },
      ],
    },
    {
      id: createId(),
      authorId: demoUsers[1].id,
      recipientId: demoUsers[2].id,
      image: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=900&q=80',
      caption: 'Devon mid flow at the product lab meetup.',
      createdAt: now - 1000 * 60 * 120,
      likes: [demoUsers[0].id],
      comments: [
        {
          id: createId(),
          authorId: demoUsers[0].id,
          text: 'The focus on the prototype is perfect 🔥',
          createdAt: now - 1000 * 60 * 80,
        },
      ],
    },
    {
      id: createId(),
      authorId: demoUsers[2].id,
      recipientId: demoUsers[0].id,
      image: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=900&q=80',
      caption: 'Ari spotting color palettes in SoHo storefronts.',
      createdAt: now - 1000 * 60 * 220,
      likes: [demoUsers[1].id],
      comments: [],
    },
  ];

  for (const post of demoPosts) {
    await db.run(
      `INSERT INTO posts (id, author_id, recipient_id, image, caption, created_at, visibility, original_post_id)
       VALUES (?, ?, ?, ?, ?, ?, 'public', NULL)`,
      [post.id, post.authorId, post.recipientId, post.image, post.caption, post.createdAt]
    );

    for (const like of post.likes) {
      await db.run(
        `INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)`,
        [post.id, like, post.createdAt]
      );
    }

    for (const comment of post.comments) {
      await db.run(
        `INSERT INTO comments (id, post_id, author_id, text, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [comment.id, post.id, comment.authorId, comment.text, comment.createdAt]
      );
    }

    await db.run(
      `INSERT INTO inbox_messages (id, recipient_id, post_id, sender_id, created_at, read)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [createId(), post.recipientId, post.id, post.authorId, post.createdAt]
    );
  }
}

function mapUserRow(row) {
  if (!row) return null;
  const hasLocation = row.location_lat !== null && row.location_lat !== undefined;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    bio: row.bio,
    homeCity: row.home_city,
    avatar: row.avatar,
    location: hasLocation
      ? {
          lat: row.location_lat,
          lng: row.location_lng,
          lastUpdated: row.location_updated_at || null,
        }
      : null,
    createdAt: row.created_at,
  };
}

module.exports = {
  initializeDatabase,
  mapUserRow,
  createId,
};
