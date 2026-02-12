# Distributed Task Queue System — Setup Guide

A complete, step-by-step guide to get the system running on your Windows machine. **No prior knowledge needed.**

---

## Table of Contents

1. [Option A: Run with Docker (Recommended)](#option-a-run-with-docker-recommended)
2. [Option B: Run without Docker (Manual Setup)](#option-b-run-without-docker-manual-setup)
3. [Testing the System](#3-testing-the-system)
4. [Troubleshooting](#4-troubleshooting)

---

## Option A: Run with Docker (Recommended)

Docker lets you run the entire system (PostgreSQL, Redis, API, Workers) with a single command.

### Step 1: Install Docker Desktop

1. Go to: **https://www.docker.com/products/docker-desktop/**
2. Click **"Download for Windows"**
3. Run the installer (`Docker Desktop Installer.exe`)
4. During installation:
   - ✅ Check **"Use WSL 2"** (recommended)
   - Follow the prompts, click Next/Install
5. **Restart your computer** when prompted
6. After restart, open **Docker Desktop** from your Start Menu
7. Wait until it says **"Docker Desktop is running"** (green icon in system tray)

### Step 2: Verify Docker is Working

Open **PowerShell** (or Windows Terminal) and run:

```powershell
docker --version
docker compose version
```

You should see version numbers. If you get errors, make sure Docker Desktop is running.

### Step 3: Start the Full System

Open PowerShell, navigate to the project folder, and run:

```powershell
cd C:\Users\ayush\OneDrive\Desktop\Queue
docker compose up --build -d
```

**What this does:**
- Downloads PostgreSQL 16 and Redis 7 images
- Builds the API server and Worker images
- Runs database migrations automatically
- Starts everything in the background

⏳ **First time takes 2-5 minutes** (downloading images). Subsequent starts are fast.

### Step 4: Check Everything is Running

```powershell
docker compose ps
```

You should see 4 services: `postgres`, `redis`, `api`, `worker` — all with status "running" or "Up".

### Step 5: Test the Health Endpoint

```powershell
curl http://localhost:3000/health
```

You should see:
```json
{"status":"ok","checks":{"postgresql":{"status":"ok"},"redis":{"status":"ok"}}}
```

🎉 **You're done! Skip to [Testing the System](#3-testing-the-system).**

### Useful Docker Commands

```powershell
# See live logs
docker compose logs -f

# See only API logs
docker compose logs -f api

# See only Worker logs
docker compose logs -f worker

# Stop everything
docker compose down

# Stop and delete all data (fresh start)
docker compose down -v

# Scale workers (run 5 workers instead of 2)
docker compose up --scale worker=5 -d

# Rebuild after code changes
docker compose up --build -d
```

---

## Option B: Run without Docker (Manual Setup)

If you don't want to install Docker, you need to install PostgreSQL and Redis manually.

### Step 1: Install PostgreSQL

1. Go to: **https://www.postgresql.org/download/windows/**
2. Click **"Download the installer"** (EnterpriseDB)
3. Download the latest **PostgreSQL 16** installer
4. Run the installer:
   - Set password to: `taskqueue_pass` (or anything you remember)
   - Keep the default port: `5432`
   - Click Next through the rest
5. After install, open **pgAdmin 4** (installed with PostgreSQL) or **SQL Shell (psql)** from Start Menu

### Step 2: Create the Database

Open **SQL Shell (psql)** from Start Menu:
- Server: `localhost`
- Database: `postgres`
- Port: `5432`
- Username: `postgres`
- Password: *(the password you set during install)*

Then run these SQL commands:

```sql
CREATE USER taskqueue WITH PASSWORD 'taskqueue_pass';
CREATE DATABASE taskqueue OWNER taskqueue;
GRANT ALL PRIVILEGES ON DATABASE taskqueue TO taskqueue;
\q
```

### Step 3: Install Redis

**Option 1: Using Memurai (Recommended for Windows)**
1. Go to: **https://www.memurai.com/get-memurai**
2. Download and install Memurai (Redis-compatible for Windows)
3. It starts automatically as a Windows service

**Option 2: Using WSL (Windows Subsystem for Linux)**
1. Open PowerShell as Administrator:
   ```powershell
   wsl --install
   ```
2. Restart your computer
3. Open **Ubuntu** from Start Menu
4. Run:
   ```bash
   sudo apt update
   sudo apt install redis-server -y
   sudo service redis-server start
   ```

### Step 4: Verify Services are Running

Open PowerShell:

```powershell
# Test PostgreSQL (should say "accepting connections")
pg_isready -h localhost -p 5432

# Test Redis (should say "PONG")
redis-cli ping
```

### Step 5: Configure Environment Variables

Open the file `C:\Users\ayush\OneDrive\Desktop\Queue\.env` and make sure these match your setup:

```env
DATABASE_URL=postgresql://taskqueue:taskqueue_pass@localhost:5432/taskqueue?schema=public
REDIS_URL=redis://localhost:6379
```

If you used a different PostgreSQL password, update it here.

### Step 6: Run Database Migration

```powershell
cd C:\Users\ayush\OneDrive\Desktop\Queue
npx prisma migrate dev --name init
```

This creates all the tables in your database. You should see:
```
Your database is now in sync with your schema.
✔ Generated Prisma Client
```

### Step 7: Start the API Server

```powershell
cd C:\Users\ayush\OneDrive\Desktop\Queue
npm run dev:api
```

You should see: `🚀 API server started` in the output.

**Keep this terminal open!** Open a **new terminal** for the next step.

### Step 8: Start the Worker

Open a **new PowerShell window**:

```powershell
cd C:\Users\ayush\OneDrive\Desktop\Queue
npm run dev:worker
```

You should see: `🚀 Worker starting` in the output.

**Keep this terminal open too!**

### Step 9: Test It

Open a **third PowerShell window** and test:

```powershell
curl http://localhost:3000/health
```

🎉 **You're done! Continue to [Testing the System](#3-testing-the-system).**

---

## 3. Testing the System

Now that everything is running, let's create and process a job.

### Step 1: Get a JWT Token

```powershell
$response = Invoke-RestMethod -Uri "http://localhost:3000/auth/token" -Method POST -ContentType "application/json" -Body '{"sub":"admin","role":"admin"}'
$token = $response.token
Write-Host "Your token: $token"
```

### Step 2: Create a Job

```powershell
$headers = @{ Authorization = "Bearer $token" }

Invoke-RestMethod -Uri "http://localhost:3000/jobs" -Method POST -ContentType "application/json" -Headers $headers -Body '{
  "type": "send-email",
  "queue": "emails",
  "priority": "HIGH",
  "payload": {
    "to": "user@example.com",
    "subject": "Hello World"
  }
}'
```

You'll get back a response with a job ID. **Copy the `id` value.**

### Step 3: Check Job Status

Replace `<JOB_ID>` with the actual ID from Step 2:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/jobs/<JOB_ID>" -Headers $headers
```

If the worker is running, the status should be `COMPLETED`.

### Step 4: Try More Things

```powershell
# List all jobs
Invoke-RestMethod -Uri "http://localhost:3000/jobs" -Headers $headers

# Create a job that always fails (test DLQ)
Invoke-RestMethod -Uri "http://localhost:3000/jobs" -Method POST -ContentType "application/json" -Headers $headers -Body '{
  "type": "always-fail",
  "queue": "default",
  "payload": {},
  "maxRetries": 2
}'

# Check Prometheus metrics
Invoke-RestMethod -Uri "http://localhost:3000/metrics"

# Cancel a pending job
Invoke-RestMethod -Uri "http://localhost:3000/jobs/<JOB_ID>" -Method DELETE -Headers $headers
```

### Step 5: Create a Scheduled Job (runs in the future)

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/jobs" -Method POST -ContentType "application/json" -Headers $headers -Body '{
  "type": "echo",
  "queue": "default",
  "payload": {"message": "I was scheduled!"},
  "scheduledAt": "2026-02-12T16:30:00Z"
}'
```

### Step 6: Test Idempotency

Run the same request twice with the same `idempotencyKey` — the second call returns the existing job instead of creating a duplicate:

```powershell
$body = '{"type":"echo","queue":"default","payload":{"test":true},"idempotencyKey":"unique-key-123"}'

# First call - creates the job
Invoke-RestMethod -Uri "http://localhost:3000/jobs" -Method POST -ContentType "application/json" -Headers $headers -Body $body

# Second call - returns the same job (idempotent = true)
Invoke-RestMethod -Uri "http://localhost:3000/jobs" -Method POST -ContentType "application/json" -Headers $headers -Body $body
```

---

## 4. Troubleshooting

| Problem | Solution |
|---------|----------|
| `docker` not recognized | Install Docker Desktop and restart your computer |
| `docker compose` not recognized | Use `docker-compose` (with hyphen) for older Docker versions |
| Port 3000 already in use | Change `API_PORT` in `.env` to another port (e.g., 3001) |
| Port 5432 already in use | Stop any other PostgreSQL instances or change the port |
| Database connection refused | Make sure PostgreSQL is running and `.env` credentials are correct |
| Redis connection refused | Make sure Redis/Memurai is running on port 6379 |
| `prisma migrate` fails | Make sure the database `taskqueue` exists and the user has permissions |
| Worker not processing jobs | Make sure both API and Worker are running, and `WORKER_QUEUES` in `.env` matches the queue name you're posting to |
