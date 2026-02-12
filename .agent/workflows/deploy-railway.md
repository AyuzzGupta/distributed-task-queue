---
description: How to deploy the Task Queue system to Railway
---

# Deploy to Railway

// turbo-all

## Prerequisites
- GitHub account
- Railway account (https://railway.app — sign up with GitHub)

## Step 1 — Initialize Git & Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit — Task Queue System"
```

Go to https://github.com/new and create a new repo called `distributed-task-queue` (or whatever you want). Then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/distributed-task-queue.git
git branch -M main
git push -u origin main
```

## Step 2 — Create Railway Project

1. Go to https://railway.app/new
2. Click **"Deploy from GitHub Repo"**
3. Select your `distributed-task-queue` repo
4. Railway will detect the Dockerfile and start deploying — **wait, don't deploy yet!**
5. Cancel the initial deploy if it starts

## Step 3 — Add Postgres Database

1. In your Railway project, click **"+ New"** → **"Database"** → **"PostgreSQL"**
2. Railway will provision a Postgres instance
3. Click the Postgres service → **"Variables"** tab → copy `DATABASE_URL`

## Step 4 — Add Redis

1. Click **"+ New"** → **"Database"** → **"Redis"**
2. Railway will provision a Redis instance
3. Click the Redis service → **"Variables"** tab → copy `REDIS_URL`

## Step 5 — Configure API Service

1. Click the main service (your GitHub repo)
2. Go to **"Settings"** tab:
   - **Root Directory**: leave empty (root)
   - **Dockerfile Path**: `Dockerfile.api`
   - **Watch Paths**: leave empty
3. Go to **"Variables"** tab and add these:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (use Railway reference) |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` (use Railway reference) |
| `JWT_SECRET` | Generate a strong random string (32+ chars) |
| `ADMIN_PASSWORD` | Your admin password |
| `EMPLOYEE_PASSWORD` | Your employee password |
| `NODE_ENV` | `production` |
| `CORS_ORIGIN` | `*` (or your domain later) |

> **TIP:** For `DATABASE_URL` and `REDIS_URL`, click "Add Reference" and select the Postgres/Redis service. Railway auto-fills the connection string.

4. Go to **"Networking"** tab → Click **"Generate Domain"** to get a public URL

## Step 6 — Add Worker Service

1. Click **"+ New"** → **"GitHub Repo"** → select the same repo
2. Go to **"Settings"** tab:
   - **Dockerfile Path**: `Dockerfile.worker`
3. Go to **"Variables"** tab — add the SAME variables as API:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `JWT_SECRET` | Same as API |
| `ADMIN_PASSWORD` | Same as API |
| `EMPLOYEE_PASSWORD` | Same as API |
| `NODE_ENV` | `production` |
| `WORKER_CONCURRENCY` | `5` |
| `WORKER_QUEUES` | `default,emails,notifications` |

4. Do NOT generate a domain for the worker (it doesn't need one)

## Step 7 — Deploy

1. Both services should auto-deploy
2. Watch the build logs in Railway dashboard
3. Wait for both services to show **"Active"** status
4. Visit your API's generated domain — you should see the dashboard!

## Step 8 — Verify

1. Open your Railway domain (e.g. `https://your-app.up.railway.app`)
2. Login with your admin credentials
3. Check health page — Postgres and Redis should show "Connected"
4. Try creating a job — it should get processed by the worker

## Updating

Just push to `main` branch — Railway auto-deploys:

```bash
git add .
git commit -m "your changes"
git push
```
