# ☑️ 2000 Checkboxes

A real-time collaborative app — toggle any checkbox and every connected user sees it instantly.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | HTML + Vanilla CSS + Vanilla JS |
| Backend | Node.js + Express + WebSocket |
| State / Pub-Sub | Redis 7 |
| Auth | Custom OIDC Server (TypeScript) |
| Database | PostgreSQL 17 (user accounts) |

---

## Run Locally

### Prerequisites
- Node.js ≥ 18
- Docker Desktop

### 1. Install dependencies

```bash
# Main app
npm install

# OIDC auth server
cd oidc-auth-main && npm install && cd ..
```

### 2. Start backing services

```bash
docker compose up -d
```

This starts **Redis** + **PostgreSQL** in Docker.

### 3. Run DB migrations

```bash
cd oidc-auth-main
npm run db:migrate
cd ..
```

### 4. Start the Auth Server
Open **Terminal 1** and run:
```bash
cd oidc-auth-main
npm run dev
```
*(Leave this terminal running)*

### 5. Start the Main App
Open **Terminal 2** and run:
```bash
npm run dev
```
*(Leave this terminal running)*

### 6. View the App
Open **http://localhost:8080** in your browser.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `PORT` | App port (default `8080`) |
| `REDIS_URL` | Redis connection string |
| `SESSION_SECRET` | Secret for session cookies |
| `APP_URL` | Public URL of the app |
| `OIDC_ISSUER` | URL of the OIDC auth server |
| `CLIENT_ID` | OIDC client ID |
| `CLIENT_SECRET` | OIDC client secret |
| `POSTGRES_USER` | PostgreSQL username |
| `POSTGRES_PASSWORD` | PostgreSQL password |

---

## Deploy to Railway

```bash
git add .
git commit -m "deploy"
git push origin main
```

1. Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub**
2. Select this repo — Railway detects `docker-compose.yml` automatically
3. Add environment variables in the Railway dashboard
4. Click **Deploy** — live in ~3 minutes at `*.up.railway.app`

---

## Project Structure

```
├── server.js            ← Express + WebSocket server
├── index.html           ← Frontend SPA
├── script.js            ← Frontend logic
├── style.css            ← Styles
├── docker-compose.yml   ← All 4 services (Redis, Postgres, OIDC, App)
├── Dockerfile           ← Main app container
├── railway.toml         ← Railway deploy config
├── src/
│   ├── auth.js          ← OIDC client + auth routes
│   ├── wsHandler.js     ← WebSocket events
│   ├── rateLimiter.js   ← Redis sliding-window rate limiter
│   ├── checkboxStore.js ← Redis bitmap helpers
│   └── redisClient.js   ← Redis connections
└── oidc-auth-main/      ← OIDC auth server (TypeScript)
    ├── src/index.ts     ← Auth server entry point
    ├── drizzle/         ← DB migrations
    └── Dockerfile       ← Auth server container
```

---

## Auth

Sign up with any email and password at the login screen.  
Anonymous users can **view** checkboxes. Only signed-in users can **toggle** them.

---

## License

ISC
