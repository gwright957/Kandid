# Kandid Prototype

Realtime-ready Kandid now ships with a small Express API and SQLite database so multiple people can sign up, share candid drops, and see the same data across devices.

## Features
- Email-based sign up and login backed by JWTs (stored in local storage) with bcrypt password hashing.
- Shared SQLite persistence for users, posts, comments, likes, reposts, and inbox drops.
- Inbox, feed, profile, and nearby views mirror the original prototype but are now hydrated from the API.
- Capture flow supports file upload or camera capture and pushes the drop to the recipient's inbox plus (optionally) the public feed.
- Location updates POST back to the API so "nearby" lists stay consistent across clients.
- Demo data (Ari, Mina, Devon) is seeded automatically on first run.
- Weekly "Hunters vs. Ghosts" contest mode with automatic role assignment, hunt-specific challenges, proximity alerts, capture tracking, and BeKandid opt-out mode.

## Stack
- **Server:** Node.js, Express, SQLite, JWT, bcrypt
- **Client:** Vanilla JS, HTML, CSS (served statically by Express)

## Getting Started
1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Configure environment**
   ```bash
   cp .env.example .env
   # edit JWT_SECRET before deploying anywhere public
   ```
   The defaults run the API on `http://localhost:4000` and allow same-origin requests.
3. **Run the API + static client**
   ```bash
   # hot reload
   npm run dev
   # or production-style
   npm start
   ```
4. Open [http://localhost:4000](http://localhost:4000) and sign up or log in with a demo account:
   - `ari@kandid.com`
   - `mina@kandid.com`
   - `devon@kandid.com`

## API Overview
| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `POST` | `/api/auth/signup` | Create an account and receive a JWT + initial state |
| `POST` | `/api/auth/login` | Log in and receive a JWT + state snapshot |
| `GET`  | `/api/state` | Fetch users, posts, and inbox data |
| `POST` | `/api/posts` | Create a new drop (optionally public) |
| `POST` | `/api/posts/:id/like` | Toggle like for the current user |
| `POST` | `/api/posts/:id/comments` | Add a comment |
| `POST` | `/api/posts/:id/repost` | Toggle repost |
| `POST` | `/api/follows/:id/toggle` | Follow/unfollow a creator |
| `POST` | `/api/inbox/mark-read` | Mark one or more inbox messages as read |
| `POST` | `/api/users/me/location` | Update the signed-in user's location |
| `POST` | `/api/users/me/bekandid` | Toggle BeKandid mode (opt out of contests) |

All mutating routes return a fresh state payload so the client can stay in sync with minimal bookkeeping.

## Hosting Notes
- The SPA expects the API to live on the same origin. If you host the frontend elsewhere, set `window.__KANDID_API_BASE__ = 'https://your-api.example.com';` in `index.html` before loading `app.js`.
- SQLite data persists to `data/kandid.sqlite` locally. In production the server automatically uses `/data/kandid.sqlite` when that directory is available (Render disk), so attach a persistent disk at `/data` to keep accounts between restarts.
- For a quick deploy, push this folder to GitHub and use a service such as Render/Fly/Heroku for the API (build command `npm install`, start command `npm start`). Static hosts like Netlify can proxy to the API if you separate them.

## Security & Next Steps
- Passwords are hashed, but JWT secret rotation, refresh tokens, rate limiting, and CSRF protections are still TODO for production.
- Media is stored as base64 strings; swap to object storage (S3, GCS, Supabase Storage) before real usage.
- Consider moving location and inbox events to real-time channels (WebSockets, Pusher, Supabase Realtime) for instant updates.

## Contest Mode Overview
- The contest resets every Sunday at 8 PM UTC. Eligible users are randomly assigned to either **Hunters** or **Ghosts** (BeKandid users sit out).
- Hunters receive proximity alerts when ghosts are nearby and can submit challenge-themed captures via the Capture form to climb the leaderboard.
- Ghosts gain rewards by avoiding capture and keeping on the move—staying in one location for too long triggers a camping warning that can lead to disqualification.
- BeKandid Mode lets users volunteer for candid shots without entering the contest; their drops still arrive privately and can generate upvotes and rewards for both photographer and subject.

Enjoy capturing candid moments together! 🎞️
