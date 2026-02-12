// ============================================================
// TaskQueue Dashboard — App Logic
// ============================================================

const API = window.location.origin;
let TOKEN = null;
let currentPage = 'overview';
let refreshTimer = null;
let currentUser = { name: '', role: 'admin' };
let jobsOffset = 0;
const JOBS_LIMIT = 20;
let lastErrorToast = 0; // debounce error toasts on auto-refresh

// ─── Init ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initClock();
    initNavigation();
    initModalHandlers();
    initMobileMenu();
    initTheme();
    initLoginForm();
    initLogout();

    // Check existing session
    const session = localStorage.getItem('tq_session');
    if (session) {
        try {
            currentUser = JSON.parse(session);
            TOKEN = localStorage.getItem('tq_token');
            if (TOKEN) {
                showDashboard();
                return;
            }
        } catch (e) { /* fall through to login */ }
    }
    showLogin();
});

// ─── Login ───────────────────────────────────────────────────

function showLogin() {
    document.getElementById('loginOverlay').classList.remove('hidden');
    document.getElementById('sidebar').style.visibility = 'hidden';
    document.getElementById('mainContent').style.visibility = 'hidden';
}

function showDashboard() {
    document.getElementById('loginOverlay').classList.add('hidden');
    document.getElementById('sidebar').style.visibility = 'visible';
    document.getElementById('mainContent').style.visibility = 'visible';
    applyRole();
    updateUserUI();
    startAutoRefresh();
    loadPage(currentPage);
    updateSystemStatus(true);
}

function initLoginForm() {
    // Role card selection
    document.querySelectorAll('.role-card').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.role-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            card.querySelector('input[type="radio"]').checked = true;
        });
    });

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('loginBtn');
        btn.disabled = true;
        btn.textContent = 'Signing in...';

        const name = document.getElementById('loginName').value.trim() || 'User';
        const password = document.getElementById('loginPassword').value;
        const role = document.querySelector('input[name="role"]:checked').value;

        try {
            const res = await fetch(`${API}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: name, password, role })
            });
            if (!res.ok) {
                let msg = 'Invalid credentials';
                try { const err = await res.json(); msg = err.message || msg; } catch (e) { }
                throw new Error(msg);
            }
            const data = await res.json();
            TOKEN = data.token;
            currentUser = data.user || { name, role };
            localStorage.setItem('tq_session', JSON.stringify(currentUser));
            localStorage.setItem('tq_token', TOKEN);
            showDashboard();
            showToast(`Welcome, ${currentUser.name}!`, 'success');
        } catch (err) {
            showToast(err.message || 'Unable to sign in.', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = 'Sign In <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
        }
    });
}

function initLogout() {
    const doLogout = () => {
        localStorage.removeItem('tq_session');
        localStorage.removeItem('tq_token');
        TOKEN = null;
        stopAutoRefresh();
        // Reset to overview
        currentPage = 'overview';
        navigateTo('overview');
        showLogin();
        showToast('Signed out', 'info');
    };
    document.getElementById('logoutBtn').addEventListener('click', doLogout);
    document.getElementById('settingsLogout').addEventListener('click', doLogout);
}

function applyRole() {
    const isAdmin = currentUser.role === 'admin';
    document.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdmin);
    });
    // If employee is on create page, redirect
    if (!isAdmin && currentPage === 'create') {
        navigateTo('overview');
    }
}

function updateUserUI() {
    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('userRole').textContent = currentUser.role;
    document.getElementById('userAvatar').textContent = (currentUser.name[0] || 'U').toUpperCase();
    document.getElementById('settingsUser').textContent = currentUser.name;
    document.getElementById('settingsRole').textContent = currentUser.role;
}

// ─── Theme ───────────────────────────────────────────────────

function initTheme() {
    const saved = localStorage.getItem('tq_theme') || 'dark';
    applyTheme(saved);

    document.querySelectorAll('.theme-card').forEach(card => {
        card.addEventListener('click', () => {
            const val = card.dataset.themeValue;
            applyTheme(val);
            localStorage.setItem('tq_theme', val);
        });
    });
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-card').forEach(card => {
        card.classList.toggle('active', card.dataset.themeValue === theme);
        const radio = card.querySelector('input[type="radio"]');
        if (radio) radio.checked = card.dataset.themeValue === theme;
    });
}

// ─── Navigation ──────────────────────────────────────────────

function initNavigation() {
    document.querySelectorAll('.nav-link[data-page]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(link.dataset.page);
        });
    });

    // "View all" link on overview
    document.querySelectorAll('.link-btn[data-page]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(link.dataset.page);
        });
    });
}

function navigateTo(page) {
    // Prevent employees from accessing admin pages
    if (page === 'create' && currentUser.role !== 'admin') {
        showToast('Access denied — admin only.', 'error');
        return;
    }

    currentPage = page;
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    const navLink = document.querySelector(`.nav-link[data-page="${page}"]`);
    if (navLink) navLink.classList.add('active');

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const pageEl = document.getElementById(`page-${page}`);
    if (pageEl) pageEl.classList.add('active');

    const titles = { overview: 'Overview', jobs: 'Jobs', create: 'Create Job', settings: 'Settings' };
    document.getElementById('pageTitle').textContent = titles[page] || page;

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');

    loadPage(page);
}

function loadPage(page) {
    if (page === 'overview') loadOverview();
    if (page === 'jobs') loadJobs();
    if (page === 'create') initCreateForm();
    if (page === 'settings') updateSettingsUI();
}

// ─── Clock ───────────────────────────────────────────────────

function initClock() {
    const el = document.getElementById('clock');
    const tick = () => {
        el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
    };
    tick();
    setInterval(tick, 1000);
}

// ─── Mobile Menu ─────────────────────────────────────────────

function initMobileMenu() {
    const btn = document.getElementById('mobileMenuBtn');
    const sidebar = document.getElementById('sidebar');
    btn.addEventListener('click', () => sidebar.classList.toggle('open'));
    document.addEventListener('click', (e) => {
        if (!sidebar.contains(e.target) && !btn.contains(e.target)) {
            sidebar.classList.remove('open');
        }
    });
}

// ─── Auto Refresh ────────────────────────────────────────────

function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
        if (currentPage === 'overview' || currentPage === 'jobs') {
            loadPage(currentPage);
        }
    }, 5000);
}

function stopAutoRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

// ─── API Helper ──────────────────────────────────────────────

async function apiFetch(path, options = {}) {
    const headers = { ...options.headers };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${API}${path}`, { ...options, headers });

    if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try {
            const err = await res.json();
            msg = err.message || msg;
        } catch (e) { /* ignore */ }
        throw new Error(msg);
    }

    return res.json();
}

// ─── Overview ────────────────────────────────────────────────

async function loadOverview() {
    try {
        const health = await apiFetch('/health');
        updateHealthCards(health);
    } catch (err) {
        silentError('Failed to load health data');
    }

    try {
        const [pending, processing, completed, failed, dead, scheduled, cancelled] = await Promise.all([
            apiFetch('/jobs?status=PENDING&limit=1'),
            apiFetch('/jobs?status=PROCESSING&limit=1'),
            apiFetch('/jobs?status=COMPLETED&limit=1'),
            apiFetch('/jobs?status=FAILED&limit=1'),
            apiFetch('/jobs?status=DEAD&limit=1'),
            apiFetch('/jobs?status=SCHEDULED&limit=1'),
            apiFetch('/jobs?status=CANCELLED&limit=1'),
        ]);

        const statsGrid = document.getElementById('statsGrid');
        statsGrid.innerHTML = [
            statCard('pending', 'Pending', pending.pagination.total),
            statCard('processing', 'Processing', processing.pagination.total),
            statCard('completed', 'Completed', completed.pagination.total),
            statCard('failed', 'Failed', failed.pagination.total),
            statCard('dead', 'Dead', dead.pagination.total),
            statCard('scheduled', 'Scheduled', scheduled.pagination.total),
            statCard('cancelled', 'Cancelled', cancelled.pagination.total),
        ].join('');
    } catch (err) {
        silentError('Failed to load job stats');
    }

    try {
        loadQueueCards();
    } catch (err) { /* silent */ }

    try {
        const recent = await apiFetch('/jobs?limit=10');
        renderRecentJobs(recent.jobs);
    } catch (err) {
        silentError('Failed to load recent jobs');
    }
}

function updateHealthCards(health) {
    const pgUp = health.dependencies?.postgres?.status === 'up';
    const redisUp = health.dependencies?.redis?.status === 'up';
    const pgLatency = health.dependencies?.postgres?.latencyMs;
    const redisLatency = health.dependencies?.redis?.latencyMs;

    document.getElementById('pgStatus').textContent = pgUp ? 'Connected' : 'Down';
    document.getElementById('pgStatus').style.color = pgUp ? 'var(--success)' : 'var(--danger)';
    document.getElementById('pgLatency').textContent = pgLatency !== undefined ? `${pgLatency}ms` : '';

    document.getElementById('redisStatus').textContent = redisUp ? 'Connected' : 'Down';
    document.getElementById('redisStatus').style.color = redisUp ? 'var(--success)' : 'var(--danger)';
    document.getElementById('redisLatency').textContent = redisLatency !== undefined ? `${redisLatency}ms` : '';

    document.getElementById('uptimeValue').textContent = formatUptime(health.uptime || 0);

    updateSystemStatus(pgUp && redisUp);
}

function updateSystemStatus(online) {
    const dot = document.querySelector('.pulse-dot');
    const text = document.querySelector('.status-text');
    if (online) {
        dot.className = 'pulse-dot online';
        text.textContent = 'System Online';
    } else {
        dot.className = 'pulse-dot offline';
        text.textContent = 'System Offline';
    }
}

function statCard(cls, label, value) {
    return `<div class="stat-card ${cls}"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
}

async function loadQueueCards() {
    try {
        const metricsText = await fetch(`${API}/metrics`).then(r => r.text());
        const queues = {};
        const regex = /task_queue_(\w+)_size\{queue="([^"]+)"\}\s+(\d+)/g;
        let match;
        while ((match = regex.exec(metricsText)) !== null) {
            const [, type, queue, val] = match;
            if (!queues[queue]) queues[queue] = {};
            queues[queue][type] = parseInt(val);
        }

        const container = document.getElementById('queueCards');
        if (Object.keys(queues).length === 0) {
            container.innerHTML = '<div class="empty-state"><p>No queue data available yet</p></div>';
            return;
        }
        container.innerHTML = Object.entries(queues).map(([name, stats]) => `
            <div class="queue-card">
                <div class="queue-card-header">
                    <span class="queue-name">${esc(name)}</span>
                </div>
                <div class="queue-stats">
                    <div class="queue-stat"><span class="queue-stat-value" style="color:var(--warning)">${stats.waiting || 0}</span><span class="queue-stat-label">Waiting</span></div>
                    <div class="queue-stat"><span class="queue-stat-value" style="color:var(--processing)">${stats.processing || 0}</span><span class="queue-stat-label">Active</span></div>
                    <div class="queue-stat"><span class="queue-stat-value" style="color:var(--danger)">${stats.dlq || 0}</span><span class="queue-stat-label">DLQ</span></div>
                    <div class="queue-stat"><span class="queue-stat-value" style="color:var(--info)">${stats.delayed || 0}</span><span class="queue-stat-label">Delayed</span></div>
                </div>
            </div>
        `).join('');
    } catch (err) {
        silentError('Failed to load queue data');
    }
}

function renderRecentJobs(jobs) {
    const tbody = document.getElementById('recentJobsBody');
    if (!jobs || jobs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><p>No jobs yet</p></td></tr>';
        return;
    }
    tbody.innerHTML = jobs.map(job => `
        <tr>
            <td><span class="job-id" onclick="openJobDetail('${job.id}')">${job.id.slice(0, 8)}…</span></td>
            <td>${esc(job.type)}</td>
            <td><span style="font-family:'JetBrains Mono',monospace;font-size:12px">${esc(job.queue)}</span></td>
            <td><span class="priority-badge ${job.priority}">${job.priority}</span></td>
            <td><span class="status-badge ${job.status}">${job.status}</span></td>
            <td>${timeAgo(job.createdAt)}</td>
        </tr>
    `).join('');
}

// ─── Jobs Page ───────────────────────────────────────────────

async function loadJobs() {
    const status = document.getElementById('filterStatus').value;
    const queue = document.getElementById('filterQueue').value;

    let url = `/jobs?limit=${JOBS_LIMIT}&offset=${jobsOffset}`;
    if (status) url += `&status=${status}`;
    if (queue) url += `&queue=${queue}`;

    try {
        const data = await apiFetch(url);
        renderJobsTable(data.jobs);
        updatePagination(data.pagination);
    } catch (err) {
        silentError('Failed to load jobs');
    }

    // Wire up filter buttons
    document.getElementById('applyFilters').onclick = () => { jobsOffset = 0; loadJobs(); };
    document.getElementById('clearFilters').onclick = () => {
        document.getElementById('filterStatus').value = '';
        document.getElementById('filterQueue').value = '';
        jobsOffset = 0;
        loadJobs();
    };
}

function renderJobsTable(jobs) {
    const tbody = document.getElementById('jobsBody');
    const isAdmin = currentUser.role === 'admin';

    if (!jobs || jobs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${isAdmin ? 8 : 7}" class="empty-state"><p>No jobs found</p></td></tr>`;
        return;
    }

    tbody.innerHTML = jobs.map(job => {
        const canRetry = ['FAILED', 'DEAD', 'CANCELLED'].includes(job.status);
        const canCancel = ['PENDING', 'SCHEDULED'].includes(job.status);
        const actions = isAdmin ? `
            <td>
                <div style="display:flex;gap:6px">
                    ${canRetry ? `<button class="btn btn-success btn-sm" onclick="retryJob('${job.id}')">Retry</button>` : ''}
                    ${canCancel ? `<button class="btn btn-danger btn-sm" onclick="cancelJob('${job.id}')">Cancel</button>` : ''}
                </div>
            </td>
        ` : '';

        return `
            <tr>
                <td><span class="job-id" onclick="openJobDetail('${job.id}')">${job.id.slice(0, 8)}…</span></td>
                <td>${esc(job.type)}</td>
                <td><span style="font-family:'JetBrains Mono',monospace;font-size:12px">${esc(job.queue)}</span></td>
                <td><span class="priority-badge ${job.priority}">${job.priority}</span></td>
                <td><span class="status-badge ${job.status}">${job.status}</span></td>
                <td>${job.attempts || 0}</td>
                <td>${timeAgo(job.createdAt)}</td>
                ${actions}
            </tr>
        `;
    }).join('');
}

function updatePagination(pag) {
    if (!pag) return;
    const prev = document.getElementById('prevPage');
    const next = document.getElementById('nextPage');
    const info = document.getElementById('pageInfo');
    const page = Math.floor(jobsOffset / JOBS_LIMIT) + 1;
    const totalPages = Math.ceil(pag.total / JOBS_LIMIT) || 1;
    info.textContent = `Page ${page} of ${totalPages}`;
    prev.disabled = jobsOffset <= 0;
    next.disabled = jobsOffset + JOBS_LIMIT >= pag.total;
    prev.onclick = () => { jobsOffset = Math.max(0, jobsOffset - JOBS_LIMIT); loadJobs(); };
    next.onclick = () => { jobsOffset += JOBS_LIMIT; loadJobs(); };
}

// ─── Job Actions ─────────────────────────────────────────────

async function retryJob(id) {
    try {
        await apiFetch(`/jobs/${id}/retry`, { method: 'POST' });
        showToast('Job queued for retry', 'success');
        loadPage(currentPage);
    } catch (err) {
        showToast(err.message || 'Retry failed', 'error');
    }
}

async function cancelJob(id) {
    try {
        await apiFetch(`/jobs/${id}`, { method: 'DELETE' });
        showToast('Job cancelled', 'success');
        loadPage(currentPage);
    } catch (err) {
        showToast(err.message || 'Cancel failed', 'error');
    }
}

// ─── Create Job Form ─────────────────────────────────────────

let formInit = false;
function initCreateForm() {
    if (formInit) return;
    formInit = true;

    document.getElementById('createJobForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('submitJobBtn');
        btn.disabled = true;

        const type = document.getElementById('jobType').value.trim();
        const queue = document.getElementById('jobQueue').value;
        const priority = document.querySelector('input[name="priority"]:checked').value;
        const maxRetries = parseInt(document.getElementById('jobMaxRetries').value);
        const scheduledAt = document.getElementById('jobScheduledAt').value;
        const idempotencyKey = document.getElementById('jobIdempotencyKey').value.trim();

        let payload;
        try {
            payload = JSON.parse(document.getElementById('jobPayload').value);
        } catch (err) {
            showToast('Invalid JSON payload', 'error');
            btn.disabled = false;
            return;
        }

        const body = { type, queue, priority, payload };
        if (!isNaN(maxRetries)) body.maxRetries = maxRetries;
        if (scheduledAt) body.scheduledAt = new Date(scheduledAt).toISOString();
        if (idempotencyKey) body.idempotencyKey = idempotencyKey;

        try {
            const data = await apiFetch('/jobs', { method: 'POST', body: JSON.stringify(body) });
            showToast(`Job ${data.job.id.slice(0, 8)}… created!`, 'success');
            document.getElementById('createJobForm').reset();
            document.getElementById('jobPayload').value = '{}';
            navigateTo('jobs');
        } catch (err) {
            showToast(err.message || 'Failed to create job', 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

// ─── Job Detail Modal ────────────────────────────────────────

function initModalHandlers() {
    const overlay = document.getElementById('modalOverlay');
    document.getElementById('modalClose').addEventListener('click', () => overlay.classList.remove('active'));
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('active');
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') overlay.classList.remove('active');
    });
}

async function openJobDetail(id) {
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    body.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    overlay.classList.add('active');

    try {
        const data = await apiFetch(`/jobs/${id}`);
        const job = data.job || data;
        const isAdmin = currentUser.role === 'admin';
        const canRetry = isAdmin && ['FAILED', 'DEAD', 'CANCELLED'].includes(job.status);
        const canCancel = isAdmin && ['PENDING', 'SCHEDULED'].includes(job.status);

        body.innerHTML = `
            <div class="detail-grid">
                <div class="detail-item"><span class="detail-label">Job ID</span><span class="detail-value mono">${job.id}</span></div>
                <div class="detail-item"><span class="detail-label">Status</span><span class="detail-value"><span class="status-badge ${job.status}">${job.status}</span></span></div>
                <div class="detail-item"><span class="detail-label">Type</span><span class="detail-value">${esc(job.type)}</span></div>
                <div class="detail-item"><span class="detail-label">Queue</span><span class="detail-value mono">${esc(job.queue)}</span></div>
                <div class="detail-item"><span class="detail-label">Priority</span><span class="detail-value"><span class="priority-badge ${job.priority}">${job.priority}</span></span></div>
                <div class="detail-item"><span class="detail-label">Attempts</span><span class="detail-value">${job.attempts || 0}${job.maxRetries !== undefined ? ` / ${job.maxRetries}` : ''}</span></div>
                <div class="detail-item"><span class="detail-label">Created</span><span class="detail-value">${formatDate(job.createdAt)}</span></div>
                <div class="detail-item"><span class="detail-label">Completed</span><span class="detail-value">${job.completedAt ? formatDate(job.completedAt) : '—'}</span></div>
            </div>

            ${job.payload ? `<div class="detail-item"><span class="detail-label">Payload</span><div class="payload-block">${esc(JSON.stringify(job.payload, null, 2))}</div></div>` : ''}
            ${job.result ? `<div class="detail-item" style="margin-top:12px"><span class="detail-label">Result</span><div class="payload-block">${esc(JSON.stringify(job.result, null, 2))}</div></div>` : ''}
            ${job.error ? `<div class="detail-item" style="margin-top:12px"><span class="detail-label">Error</span><div class="payload-block" style="border-color:rgba(239,68,68,0.3);color:var(--danger)">${esc(job.error)}</div></div>` : ''}

            ${job.history && job.history.length > 0 ? `
                <div class="timeline">
                    <h4>History</h4>
                    ${job.history.map(h => `
                        <div class="timeline-item">
                            <div class="timeline-dot"></div>
                            <div class="timeline-content">
                                <span class="timeline-status">${esc(h.status)}</span>
                                ${h.message ? `<span class="timeline-message">${esc(h.message)}</span>` : ''}
                                <span class="timeline-time">${formatDate(h.createdAt)}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            ` : ''}

            ${canRetry || canCancel ? `
                <div class="modal-actions">
                    ${canRetry ? `<button class="btn btn-success" onclick="retryJob('${job.id}');document.getElementById('modalOverlay').classList.remove('active')">Retry Job</button>` : ''}
                    ${canCancel ? `<button class="btn btn-danger" onclick="cancelJob('${job.id}');document.getElementById('modalOverlay').classList.remove('active')">Cancel Job</button>` : ''}
                </div>
            ` : ''}
        `;
    } catch (err) {
        body.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">${esc(err.message || 'Failed to load job details')}</p></div>`;
    }
}

// ─── Settings ────────────────────────────────────────────────

function updateSettingsUI() {
    document.getElementById('settingsUser').textContent = currentUser.name;
    document.getElementById('settingsRole').textContent = currentUser.role;
}

// ─── Utilities ───────────────────────────────────────────────

function esc(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function timeAgo(date) {
    if (!date) return '—';
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function formatDate(date) {
    if (!date) return '—';
    return new Date(date).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
}

function formatUptime(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

function showToast(message, type = 'info') {
    const icon = { success: '✓', error: '✕', info: 'ℹ' }[type] || 'ℹ';
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span style="font-size:16px;font-weight:700">${icon}</span> ${esc(message)}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function silentError(msg) {
    // Debounce: only show one error toast per 10 seconds during auto-refresh
    const now = Date.now();
    if (now - lastErrorToast > 10000) {
        lastErrorToast = now;
        showToast(msg, 'error');
    }
}

// Make functions available globally for onclick handlers
window.openJobDetail = openJobDetail;
window.retryJob = retryJob;
window.cancelJob = cancelJob;
