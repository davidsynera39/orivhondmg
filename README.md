# Orivon — Full-Stack HTML/CSS/JS Prototype

The connected personal-guidance platform from the build brief, built as a
plain HTML/CSS/JS frontend backed by a real Node/Express server, a real
SQLite database, and real AI (Anthropic Claude) — no build step, no
framework, no localStorage. This is the "main app" version: what you see
in the browser talks to an actual backend over HTTP.

## Architecture

```
orivon-static/
  public/            # frontend — plain HTML/CSS/JS, served statically
    index.html
    style.css
    app.js           # router, API client, all views
  server/             # backend — Express
    index.js          # entrypoint: mounts routes, serves public/
    db/
      schema.js        # Drizzle ORM schema (23 tables)
      index.js          # DB client (SQLite via better-sqlite3)
      migrate.js         # migration runner
    ai/
      index.js           # provider factory (Anthropic or Mock)
      providers/
    lib/
      auth.js             # bcrypt + JWT cookie sessions
      context.js           # task-scoped AI context builder
      storage.js            # per-user file storage
      extract-text.js        # PDF/DOCX text extraction
      activity.js
    routes/
      auth.js, onboarding.js, career.js, roadmap.js, chat.js,
      cv.js, settings.js, profile.js, misc.js (goals/activity)
  drizzle/            # generated SQL migrations
  orivon.db           # SQLite database file (created by migrate)
```

The frontend talks to the backend exclusively through `fetch()` calls to
`/api/*` routes, with session state in an httpOnly cookie (JWT). Nothing
sensitive — passwords, AI API keys — ever reaches the browser.

## Running it

**Quickest way:** run the setup script, which installs, migrates, and starts the server in one step.

- Mac/Linux: `./setup.sh`
- Windows: `setup.bat`

**Manual steps** (same thing, spelled out):

```bash
npm install
npm run migrate   # creates orivon.db and applies the schema
npm start         # starts the server at http://localhost:3000
```

Visit `http://localhost:3000` — the frontend is served by the same server
that handles the API.

### Enabling real AI responses

By default the app runs on a **Mock AI provider** — every AI feature works
end-to-end and returns clearly-labeled placeholder content, so the whole
product is testable without a key.

1. Open `.env`
2. Set `ANTHROPIC_API_KEY` to a real key
3. Restart the server

No frontend changes needed — the AI provider abstraction in `server/ai/`
is the only place that decides which provider to use.

### Database

SQLite file at `./orivon.db`. To reset:

```bash
rm orivon.db*
npm run migrate
```

To change the schema: edit `server/db/schema.js`, run
`npx drizzle-kit generate` to create a new migration, then `npm run migrate`.

### File storage

Uploaded CVs are stored under `./storage/cvs/<userId>/`, namespaced per
user. Local disk storage suitable for a prototype — swap for S3/blob
storage before any real deployment.

## What's implemented

- **Auth**: register, login, logout, JWT cookie sessions, bcrypt password hashing
- **Onboarding**: 4-step dynamic wizard, persisted to the database
- **Dashboard**: goal, roadmap progress, next actions, goals, activity — all from real DB queries
- **AI Chat**: persisted conversation history, real (or mock) AI replies
- **Career Guidance**: AI-generated recommendation with skills/gaps, hands off directly into roadmap creation
- **Learning Roadmaps**: AI-generated staged plan, checkable items with live, server-persisted progress
- **CV Review**: real file upload (PDF/DOCX), real text extraction, general or job-specific AI analysis
- **Settings**: email/password change, preferences, account deletion that cascades through every table via foreign keys and deletes on-disk files
- **Security**: every resource-owning route checks `resource.userId === req.user.id` before returning or mutating data — verified live that a second user gets a 404, not another user's data

## Not yet built

Interview Prep, Scholarships, Research Assistant, and dedicated Goals/Activity
pages (they're currently summarized on the Dashboard only). These follow the
exact same pattern as Career/Roadmap/CV — a new route file in `server/routes/`,
a new `Api.*` method, and a new `Views.*` function.

## Testing notes

This was built and verified with two levels of testing:

1. **Direct API testing** (curl) — every endpoint tested against the real
   server and real SQLite database: registration, onboarding, career
   assessment, roadmap generation and item completion, CV upload (PDF and
   DOCX) with real text extraction, CV review, settings, and account
   deletion — including confirming the deletion actually cascades through
   the database and removes on-disk files, and that cross-user access is
   correctly blocked (404, not another user's data).

2. **Frontend-against-real-server testing** (headless jsdom + real fetch,
   with a manual cookie jar since Node's fetch doesn't carry a browser's
   cookie jar automatically) — the actual frontend code, unmodified,
   driving the real running server through the full connected journey:
   register → onboarding → dashboard → career assessment → roadmap
   generation → item completion (verified persisted after navigating away
   and back) → chat → settings → logout/login. All checks passed.

One real concurrency bug was found and fixed during this process: the
client-side session cache could be corrupted by a slow, stale `/api/auth/me`
check resolving after a newer login had already updated it. Fixed with a
generation counter so late-resolving requests can't clobber fresher state.
Async views were also hardened so a slow-loading page (e.g. a heavy
dashboard fetch) can't render itself on top of whatever page the user has
since navigated to.

## macOS desktop app (.dmg)

`desktop/` is a small Electron app that opens the hosted site (https://orivonmentor.onrender.com) in a native window, with a 3-second logo splash. It contains no server code or keys. Change `APP_URL` in `desktop/main.js` if the host changes.

- Run locally: `cd desktop && npm install && npm start`
- Build DMGs on a Mac: `cd desktop && npm run dist:mac` (Intel + Apple silicon, macOS 11+)
- Or run the **Build macOS DMG** GitHub workflow and download the DMGs from its artifacts.
