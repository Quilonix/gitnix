/**
 * Gitnix Notes — Frontend Application
 */
(() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────
  let notes = [];
  let editingId = null;
  let selectedColor = '#ffffff';

  // ─── DOM ────────────────────────────────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const loadingScreen = $('#loadingScreen');
  const mainContent = $('#mainContent');
  const emptyState = $('#emptyState');
  const notesGrid = $('#notesGrid');
  const searchInput = $('#searchInput');
  const errorBanner = $('#errorBanner');
  const errorText = $('#errorText');
  const editorModal = $('#editorModal');
  const statusModal = $('#statusModal');
  const noteForm = $('#noteForm');
  const inputTitle = $('#inputTitle');
  const inputContent = $('#inputContent');
  const inputTags = $('#inputTags');
  const inputPinned = $('#inputPinned');
  const saveBtn = $('#saveBtn');
  const editorTitle = $('#editorTitle');

  // ─── API ────────────────────────────────────────────────────────────────
  async function api(method, path, body = null) {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/api${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ─── Load Notes ─────────────────────────────────────────────────────────
  async function loadNotes() {
    try {
      const query = searchInput.value.trim();
      const params = query ? `?search=${encodeURIComponent(query)}` : '';
      notes = await api('GET', `/notes${params}`);
      render();
      showMain();
    } catch (err) {
      showError(err.message);
      showMain();
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  function render() {
    if (notes.length === 0) {
      notesGrid.hidden = true;
      emptyState.hidden = false;
      return;
    }

    notesGrid.hidden = false;
    emptyState.hidden = true;
    notesGrid.innerHTML = notes.map(note => `
      <article class="note-card ${note.pinned ? 'pinned' : ''}" style="background:${note.color || '#fff'}" data-id="${note._id}">
        ${note.pinned ? '<span class="pin-icon" title="Pinned">📌</span>' : ''}
        <div class="note-actions">
          <button class="btn btn-danger btn-sm btn-delete" data-id="${note._id}" title="Delete">✕</button>
        </div>
        <div class="note-title">${esc(note.title)}</div>
        <div class="note-body">${esc(note.content)}</div>
        <div class="note-footer">
          <span class="note-date">${timeAgo(note._updated || note._created)}</span>
          <div class="note-tags">${(note.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        </div>
      </article>
    `).join('');
  }

  // ─── Editor ─────────────────────────────────────────────────────────────
  function openEditor(note = null) {
    editingId = note ? note._id : null;
    editorTitle.textContent = note ? 'Edit Note' : 'New Note';
    inputTitle.value = note?.title || '';
    inputContent.value = note?.content || '';
    inputTags.value = (note?.tags || []).join(', ');
    inputPinned.checked = note?.pinned || false;
    setColor(note?.color || '#ffffff');
    editorModal.showModal();
    inputTitle.focus();
  }

  function closeEditor() {
    editorModal.close();
    editingId = null;
  }

  async function saveNote(e) {
    e.preventDefault();
    const btnText = saveBtn.querySelector('.save-text');
    const btnLoad = saveBtn.querySelector('.save-loading');
    btnText.hidden = true;
    btnLoad.hidden = false;
    saveBtn.disabled = true;

    const data = {
      title: inputTitle.value.trim(),
      content: inputContent.value,
      color: selectedColor,
      tags: inputTags.value.split(',').map(t => t.trim()).filter(Boolean),
      pinned: inputPinned.checked,
    };

    try {
      if (editingId) {
        await api('PUT', `/notes/${editingId}`, data);
        toast('Note updated & encrypted ✓');
      } else {
        await api('POST', '/notes', data);
        toast('Note created & encrypted ✓');
      }
      closeEditor();
      await loadNotes();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btnText.hidden = false;
      btnLoad.hidden = true;
      saveBtn.disabled = false;
    }
  }

  // ─── Delete ─────────────────────────────────────────────────────────────
  async function deleteNote(id) {
    if (!confirm('Delete this note permanently?')) return;
    try {
      await api('DELETE', `/notes/${id}`);
      toast('Note deleted');
      await loadNotes();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ─── Status ─────────────────────────────────────────────────────────────
  async function showStatus() {
    try {
      const s = await api('GET', '/status');
      $('#statusBody').innerHTML = `
        <div class="status-grid">
          <div class="status-item"><div class="status-val">${s.noteCount}</div><div class="status-label">Notes</div></div>
          <div class="status-item"><div class="status-val">${s.apiRequests}</div><div class="status-label">API Calls</div></div>
          <div class="status-item"><div class="status-val">256-bit</div><div class="status-label">Encryption</div></div>
          <div class="status-item"><div class="status-val">${s.lastSync ? timeAgo(s.lastSync) : 'Never'}</div><div class="status-label">Last Sync</div></div>
          <div class="status-item status-full"><div class="status-val">${s.repo || 'N/A'}</div><div class="status-label">Repository</div></div>
        </div>
      `;
      statusModal.showModal();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ─── Color Picker ───────────────────────────────────────────────────────
  function setColor(color) {
    selectedColor = color;
    $$('.swatch').forEach(s => s.classList.toggle('active', s.dataset.color === color));
  }

  // ─── Helpers ────────────────────────────────────────────────────────────
  function showMain() {
    loadingScreen.hidden = true;
    mainContent.hidden = false;
  }

  function showError(msg) {
    errorText.textContent = msg;
    errorBanner.hidden = false;
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  function toast(msg, isError = false) {
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ─── Event Listeners ────────────────────────────────────────────────────
  $('#btnNew').addEventListener('click', () => openEditor());
  $('#btnNewEmpty')?.addEventListener('click', () => openEditor());
  $('#btnStatus').addEventListener('click', showStatus);
  $('#closeEditor').addEventListener('click', closeEditor);
  $('#cancelEditor').addEventListener('click', closeEditor);
  $('#closeStatus').addEventListener('click', () => statusModal.close());
  $('#dismissError').addEventListener('click', () => { errorBanner.hidden = true; });
  noteForm.addEventListener('submit', saveNote);

  // Color swatches
  $$('.swatch').forEach(s => s.addEventListener('click', () => setColor(s.dataset.color)));

  // Search (debounced)
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadNotes, 300);
  });

  // Click note to edit, delete button
  notesGrid.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.btn-delete');
    if (delBtn) { e.stopPropagation(); deleteNote(delBtn.dataset.id); return; }

    const card = e.target.closest('.note-card');
    if (card) {
      const note = notes.find(n => n._id === card.dataset.id);
      if (note) openEditor(note);
    }
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeEditor(); statusModal.close(); }
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); openEditor(); }
  });

  // Close modal on backdrop click
  editorModal.addEventListener('click', (e) => { if (e.target === editorModal) closeEditor(); });
  statusModal.addEventListener('click', (e) => { if (e.target === statusModal) statusModal.close(); });

  // ─── Init ───────────────────────────────────────────────────────────────
  loadNotes();
})();
