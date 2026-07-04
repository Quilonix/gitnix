/**
 * ═══════════════════════════════════════════════════════════════
 * Gitnix Events — Frontend Application
 * ═══════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let currentUser = null;
let currentPage = 'home';

// ═══════════════════════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function api(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };

  const token = localStorage.getItem('token');
  if (token) {
    opts.headers['Authorization'] = `Bearer ${token}`;
  }

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, opts);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong');
  }

  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════

function navigate(page, data = null) {
  // Auth guards — redirect if not allowed
  if (page === 'my-registrations' && !currentUser) {
    toast('Please login first', 'error');
    page = 'login';
  }
  if (page === 'admin' && (!currentUser || currentUser.role !== 'admin')) {
    toast('Admin access required', 'error');
    page = currentUser ? 'home' : 'login';
  }

  // If logged in, don't show login/signup
  if ((page === 'login' || page === 'signup') && currentUser) {
    page = 'home';
  }

  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  // Show target page
  const target = document.getElementById(`page-${page}`);
  if (target) {
    target.classList.add('active');
    currentPage = page;
  }

  // Load page data
  switch (page) {
    case 'home': loadEvents(); break;
    case 'event': loadEventDetail(data); break;
    case 'my-registrations': loadMyRegistrations(); break;
    case 'admin': loadAdminPanel(); break;
    case 'login': break;
    case 'signup': break;
  }

  // Close mobile menu
  document.querySelector('.nav-links')?.classList.remove('open');
}

function toggleMobileMenu() {
  document.querySelector('.nav-links')?.classList.toggle('open');
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

async function handleLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  try {
    const data = await api('POST', '/auth/login', {
      email: document.getElementById('login-email').value,
      password: document.getElementById('login-password').value,
    });

    localStorage.setItem('token', data.token);
    currentUser = data.user;
    updateUI();
    navigate('home');
    toast('Welcome back, ' + data.user.name + '!', 'success');
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function handleSignup(e) {
  e.preventDefault();
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';

  try {
    const data = await api('POST', '/auth/signup', {
      name: document.getElementById('signup-name').value,
      email: document.getElementById('signup-email').value,
      password: document.getElementById('signup-password').value,
    });

    localStorage.setItem('token', data.token);
    currentUser = data.user;
    updateUI();
    navigate('home');
    toast('Account created! Welcome, ' + data.user.name, 'success');
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch {}
  localStorage.removeItem('token');
  currentUser = null;
  updateUI();
  navigate('home');
  toast('Logged out');
}

async function checkAuth() {
  const token = localStorage.getItem('token');
  if (!token) return;

  try {
    const data = await api('GET', '/auth/me');
    currentUser = data.user;
  } catch {
    localStorage.removeItem('token');
    currentUser = null;
  }
  updateUI();
}

function updateUI() {
  const isLoggedIn = !!currentUser;
  const isAdmin = currentUser?.role === 'admin';

  // Show/hide nav links based on auth state
  document.querySelectorAll('.auth-only').forEach(el => {
    el.style.display = isLoggedIn ? '' : 'none';
  });
  document.querySelectorAll('.guest-only').forEach(el => {
    el.style.display = isLoggedIn ? 'none' : '';
  });
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });

  // Update user name
  const nameEl = document.querySelector('.user-name');
  if (nameEl && currentUser) {
    nameEl.textContent = currentUser.name;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVENTS (PUBLIC)
// ═══════════════════════════════════════════════════════════════════════════════

async function loadEvents() {
  const grid = document.getElementById('events-grid');
  grid.innerHTML = '<div class="loading">Loading events...</div>';

  try {
    const data = await api('GET', '/events');
    if (data.events.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📅</div>
          <p>No events yet. Check back soon!</p>
        </div>`;
      return;
    }

    grid.innerHTML = data.events.map(event => {
      const dateStr = formatDate(event.date);
      const spotsClass = event.spotsLeft <= 0 ? 'spots-full' :
                         event.spotsLeft <= 5 ? 'spots-limited' : 'spots-available';
      const spotsText = event.spotsLeft <= 0 ? 'Full' :
                        `${event.spotsLeft} spots left`;

      return `
        <div class="event-card" onclick="navigate('event', '${event._id}')">
          <div class="event-card-date">${dateStr}</div>
          <div class="event-card-title">${esc(event.title)}</div>
          <div class="event-card-location">📍 ${esc(event.location)}</div>
          <div class="event-card-footer">
            <span class="event-card-spots ${spotsClass}">${spotsText}</span>
            <span class="btn btn-sm btn-outline">View →</span>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

async function loadEventDetail(eventId) {
  const container = document.getElementById('event-detail');
  container.innerHTML = '<div class="loading">Loading event...</div>';

  try {
    const data = await api('GET', `/events/${eventId}`);
    const event = data.event;
    const dateStr = formatDate(event.date);
    const spotsClass = event.spotsLeft <= 0 ? 'spots-full' :
                       event.spotsLeft <= 5 ? 'spots-limited' : 'spots-available';

    let actionBtn = '';
    if (!currentUser) {
      actionBtn = `<button class="btn btn-primary" onclick="navigate('login')">Login to Register</button>`;
    } else if (event.spotsLeft <= 0) {
      actionBtn = `<button class="btn btn-outline" disabled>Event Full</button>`;
    } else {
      actionBtn = `<button class="btn btn-primary" onclick="registerForEvent('${event._id}')">Register Now</button>`;
    }

    container.innerHTML = `
      <button class="btn btn-outline btn-sm" onclick="navigate('home')" style="margin-bottom:1rem">← Back to Events</button>
      <div class="event-detail-header">
        <h1 class="event-detail-title">${esc(event.title)}</h1>
        <div class="event-meta">
          <span class="event-meta-item">📅 ${dateStr}</span>
          <span class="event-meta-item">📍 ${esc(event.location)}</span>
          <span class="event-meta-item ${spotsClass}">👥 ${event.registeredCount}/${event.capacity} registered</span>
        </div>
      </div>
      ${event.description ? `<div class="event-description">${esc(event.description)}</div>` : ''}
      <div class="event-actions">
        ${actionBtn}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

async function registerForEvent(eventId) {
  if (!currentUser) {
    toast('Please login first', 'error');
    navigate('login');
    return;
  }
  try {
    await api('POST', `/events/${eventId}/register`);
    toast('Successfully registered! 🎉', 'success');
    loadEventDetail(eventId);
  } catch (err) {
    if (err.message.includes('Authentication')) {
      toast('Session expired — please login again', 'error');
      logout();
    } else {
      toast(err.message, 'error');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MY REGISTRATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function loadMyRegistrations() {
  const container = document.getElementById('my-registrations-list');
  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const data = await api('GET', '/my/registrations');
    if (data.registrations.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎟️</div>
          <p>You haven't registered for any events yet.</p>
          <button class="btn btn-primary" onclick="navigate('home')" style="margin-top:1rem">Browse Events</button>
        </div>`;
      return;
    }

    container.innerHTML = data.registrations.map(reg => `
      <div class="registration-card">
        <div class="registration-info">
          <h4>${esc(reg.eventTitle)}</h4>
          <p>Registered ${formatDate(reg._createdAt)}</p>
        </div>
        <div>
          <span class="badge badge-confirmed">${reg.status}</span>
          <button class="btn btn-sm btn-outline" onclick="cancelRegistration('${reg.eventId}')" style="margin-left:0.5rem">Cancel</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

async function cancelRegistration(eventId) {
  if (!confirm('Cancel this registration?')) return;
  try {
    await api('DELETE', `/events/${eventId}/register`);
    toast('Registration cancelled');
    loadMyRegistrations();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ═══════════════════════════════════════════════════════════════════════════════

async function loadAdminPanel() {
  if (!currentUser || currentUser.role !== 'admin') {
    navigate('home');
    return;
  }

  // Double-check with server that token is still valid + admin
  try {
    const check = await api('GET', '/admin/stats');
    loadAdminStats();
    loadAdminEvents();
  } catch (err) {
    toast('Admin access denied', 'error');
    navigate('home');
  }
}

async function loadAdminStats() {
  try {
    const data = await api('GET', '/admin/stats');
    const s = data.stats;
    document.getElementById('admin-stats').innerHTML = `
      <div class="stat-card"><div class="stat-value">${s.totalEvents}</div><div class="stat-label">Events</div></div>
      <div class="stat-card"><div class="stat-value">${s.totalUsers}</div><div class="stat-label">Users</div></div>
      <div class="stat-card"><div class="stat-value">${s.totalRegistrations}</div><div class="stat-label">Registrations</div></div>
      <div class="stat-card"><div class="stat-value">${s.upcomingEvents}</div><div class="stat-label">Upcoming</div></div>
    `;
  } catch {}
}

async function loadAdminEvents() {
  const container = document.getElementById('admin-events-list');
  try {
    const data = await api('GET', '/events');
    if (data.events.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No events created yet.</p></div>';
      return;
    }
    container.innerHTML = data.events.map(event => `
      <div class="admin-list-item">
        <div class="admin-list-item-info">
          <h4>${esc(event.title)}</h4>
          <p>${formatDate(event.date)} · ${esc(event.location)} · ${event.registeredCount}/${event.capacity} registered</p>
        </div>
        <div class="admin-list-item-actions">
          <button class="btn btn-sm btn-outline" onclick="viewEventRegistrations('${event._id}', '${esc(event.title)}')">Registrations</button>
          <button class="btn btn-sm btn-danger" onclick="deleteEvent('${event._id}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

async function loadAdminUsers() {
  const container = document.getElementById('admin-users-list');
  try {
    const data = await api('GET', '/admin/users');
    container.innerHTML = data.users.map(user => `
      <div class="admin-list-item">
        <div class="admin-list-item-info">
          <h4>${esc(user.name)} <span class="badge badge-${user.role}">${user.role}</span></h4>
          <p>${esc(user.email)} · Joined ${formatDate(user.createdAt)}</p>
        </div>
        <div class="admin-list-item-actions">
          ${user.role === 'attendee'
            ? `<button class="btn btn-sm btn-outline" onclick="changeRole('${user.id}', 'admin')">Make Admin</button>`
            : `<button class="btn btn-sm btn-outline" onclick="changeRole('${user.id}', 'attendee')">Remove Admin</button>`}
          <button class="btn btn-sm btn-danger" onclick="deleteUser('${user.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

async function viewEventRegistrations(eventId, title) {
  const container = document.getElementById('admin-registrations-list');
  switchAdminTab('registrations');
  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const data = await api('GET', `/admin/events/${eventId}/registrations`);
    if (data.registrations.length === 0) {
      container.innerHTML = `<div class="empty-state"><p>No registrations for "${title}" yet.</p></div>`;
      return;
    }
    container.innerHTML = `<h4 style="margin-bottom:1rem">Registrations for: ${title}</h4>` +
      data.registrations.map(reg => `
        <div class="admin-list-item">
          <div class="admin-list-item-info">
            <h4>${esc(reg.userName)}</h4>
            <p>${esc(reg.userEmail)} · ${formatDate(reg._createdAt)}</p>
          </div>
          <span class="badge badge-confirmed">${reg.status}</span>
        </div>
      `).join('');
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

  document.getElementById(`admin-tab-${tab}`).classList.add('active');
  event?.target?.classList?.add('active');

  // Lazy load tab data
  if (tab === 'users') loadAdminUsers();
  if (tab === 'events') loadAdminEvents();
}

function showCreateEvent() {
  document.getElementById('create-event-form').style.display = 'block';
}

function hideCreateEvent() {
  document.getElementById('create-event-form').style.display = 'none';
}

async function handleCreateEvent(e) {
  e.preventDefault();
  const errEl = document.getElementById('create-event-error');
  errEl.textContent = '';

  try {
    await api('POST', '/admin/events', {
      title: document.getElementById('event-title').value,
      date: document.getElementById('event-date').value,
      location: document.getElementById('event-location').value,
      capacity: document.getElementById('event-capacity').value,
      description: document.getElementById('event-description').value,
    });

    toast('Event created! 🎉', 'success');
    hideCreateEvent();
    loadAdminEvents();
    loadAdminStats();

    // Clear form
    document.getElementById('event-title').value = '';
    document.getElementById('event-date').value = '';
    document.getElementById('event-location').value = '';
    document.getElementById('event-capacity').value = '50';
    document.getElementById('event-description').value = '';
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function deleteEvent(id) {
  if (!confirm('Delete this event? This also removes all registrations.')) return;
  try {
    await api('DELETE', `/admin/events/${id}`);
    toast('Event deleted');
    loadAdminEvents();
    loadAdminStats();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function changeRole(userId, role) {
  try {
    await api('PUT', `/admin/users/${userId}/role`, { role });
    toast(`User role updated to ${role}`, 'success');
    loadAdminUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteUser(userId) {
  if (!confirm('Delete this user? This removes their registrations too.')) return;
  try {
    await api('DELETE', `/admin/users/${userId}`);
    toast('User deleted');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function toast(message, type = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast show ' + type;
  setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  checkAuth().then(() => {
    navigate('home');
  });
});
