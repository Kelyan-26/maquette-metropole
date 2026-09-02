// ================================================================
// ACCÉLÉRATEUR M — Portfolio des entreprises accompagnées
// ================================================================

// Filet de sécurité pour l'ouverture en double-clic (protocole file://) :
// Safari, et Chrome selon la configuration, refusent alors l'accès au stockage
// local et lèvent une exception au premier accès. On bascule sur une mémoire
// vive : la consultation fonctionne, seul le thème choisi n'est pas mémorisé
// d'une ouverture à l'autre.
(function ensureSafeStorage() {
  try {
    window.localStorage.setItem('__probe__', '1');
    window.localStorage.removeItem('__probe__');
  } catch (e) {
    const mem = new Map();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
        setItem: (k, v) => { mem.set(String(k), String(v)); },
        removeItem: (k) => { mem.delete(String(k)); },
        clear: () => mem.clear(),
        key: (i) => Array.from(mem.keys())[i] ?? null,
        get length() { return mem.size; },
      },
    });
    console.warn('[storage] stockage local indisponible (file://) — bascule en mémoire vive');
  }
})();

const STORAGE_KEY = 'm-historique-data-v4';

// Chiffres officiels extraits du fichier Excel "Liste Alumnis Accélérateur M"
// Ligne "Total Général" de la feuille "Levée de fonds"
// Ces valeurs sont éditables via l'admin pour rester à jour avec les communications officielles
// ⚠️ Les chiffres figés — 207 entreprises, 230 emplois, 11 promotions, 35 éteintes —
// ont été retirés. Ils étaient saisis à la main, personne ne les recalculait, et
// l'interface affichait deux vérités concurrentes : 207 en haut de page, 181 fiches
// en dessous. La réunion du 01/09/2026 a tranché : on affiche ce que la base sait.
//
// Ce qu'on perd et qu'il faut savoir : 207 sociétés ont probablement été
// accompagnées, le portfolio n'en documente que 181. Les libellés ont donc changé —
// on n'annonce plus « startups accompagnées » mais « entreprises du portfolio ».
//
// Le seul chiffre qui coïncidait déjà exactement est celui des fonds : 73 671 800 €,
// retrouvé au centime après fusion des trois doublons. C'est ce qui valide la fusion.

let state = { entreprises: [], programmes: [], promotions: [], thematiques: [], villes: [] };
let filters = { search: '', promotions: new Set(), programmes: new Set(), thematiques: new Set(), statuts: new Set(), villes: new Set() };
let portfolioState = { tab: 'all', sort: 'default', view: 'grid' };

// Mapping thématique → couleur accent (bande verticale + tag)
const THEME_COLORS = {
  'Tech': '#0095C1',
  'Numérique': '#0095C1',
  'IA': '#5f4bb5',
  'Économie bleue': '#005E78',
  'Économie circulaire': '#2ea55f',
  'Environnement': '#2ea55f',
  'Énergie': '#f5a623',
  'Social': '#e5324b',
  'Santé': '#e56ba1',
  'Éducation': '#7859d1',
  'Culture': '#c07040',
  'Mobilité': '#4EBED6',
  'Alimentation': '#88a02f',
  'Industrie': '#6b7280',
  'Tourisme': '#e28f2b',
};

function themeAccentFor(entreprise) {
  const themes = entreprise.thematiques || [];
  for (const t of themes) {
    if (THEME_COLORS[t]) return { color: THEME_COLORS[t], label: t };
    // Match partiel
    for (const key of Object.keys(THEME_COLORS)) {
      if (t.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(t.toLowerCase())) {
        return { color: THEME_COLORS[key], label: t };
      }
    }
  }
  return { color: 'rgba(0,149,193,0.35)', label: themes[0] || '' };
}

// ----- DATA -----

// ================================================================
// API BACKEND — Postgres persistant via Docker (http://localhost:4000)
// Fallback : IndexedDB → localStorage → seed
// ================================================================
const API_BASE = (() => {
  const host = window.location.hostname;
  // Si on est en localhost, on parle à l'API sur le même host
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return `http://${host}:4000`;
  // Sinon file:// ou autre : essaie 127.0.0.1
  return 'http://127.0.0.1:4000';
})();
const API_AUTH = 'malumni-local-2026';
let API_AVAILABLE = false;

async function apiRequest(path, opts = {}) {
  const r = await fetch(API_BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Auth': API_AUTH, ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`API ${r.status} ${r.statusText}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}

async function apiPing() {
  try {
    await Promise.race([
      apiRequest('/api/ping'),
      new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 1500)),
    ]);
    API_AVAILABLE = true;
    return true;
  } catch { API_AVAILABLE = false; return false; }
}

async function apiGetFullState() { return apiRequest('/api/full'); }
async function apiPutEntreprise(e) { return apiRequest(`/api/entreprises/${encodeURIComponent(e.id)}`, { method: 'PUT', body: JSON.stringify(e) }); }
async function apiDeleteEntreprise(id) { return apiRequest(`/api/entreprises/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
async function apiPutState(state) {
  const clone = { ...state };
  delete clone.entreprises;
  return apiRequest('/api/state', { method: 'PUT', body: JSON.stringify(clone) });
}
async function apiBulkImport(state) { return apiRequest('/api/bulk-import', { method: 'POST', body: JSON.stringify(state) }); }
async function apiSnapshot(label = 'auto') { return apiRequest('/api/snapshots', { method: 'POST', body: JSON.stringify({ label }) }); }

// ================================================================
// STOCKAGE — IndexedDB en priorité (10-500 Mo), localStorage en fallback
// ================================================================
const IDB_NAME = 'm-alumni-db';
const IDB_STORE = 'state';
const IDB_KEY = 'main';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject('IndexedDB indisponible');
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key = IDB_KEY) {
  try {
    const db = await idbOpen();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}
async function idbSet(value, key = IDB_KEY) {
  try {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { return false; }
}

// Normalisation robuste : minuscule + trim + suppression des accents
function normalizeCompanyName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Merge agressif : pour chaque entreprise, si le seed a des données MEILLEURES
// (logo_url data:image valide, description plus longue, champs manquants), on backfill.
function mergeSeedInto(current) {
  if (!window.SEED_DATA || !current || !current.entreprises) return current;
  const seedByName = {};
  const seedById = {};
  window.SEED_DATA.entreprises.forEach(e => {
    seedByName[normalizeCompanyName(e.nom)] = e;
    if (e.id) seedById[e.id] = e;
  });
  const FIELDS = ['logo_url', 'description_longue', 'description_courte', 'site_web', 'linkedin',
                  'forme_juridique', 'date_creation', 'adresse', 'siret', 'pays', 'code_postal',
                  'nationalite', 'historique', 'ville'];
  let backfilled = 0;
  current.entreprises.forEach(e => {
    const seed = seedById[e.id] || seedByName[normalizeCompanyName(e.nom)];
    if (!seed) return;
    FIELDS.forEach(f => {
      const cur = e[f];
      const s = seed[f];
      if (s === undefined || s === null || s === '' || (Array.isArray(s) && !s.length)) return;
      // Cas 1 : champ vide dans current
      if (cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && !cur.length)) {
        e[f] = s; backfilled++; return;
      }
      // Cas 2 : logo_url — le seed gagne toujours s'il a une data:URL
      // (récupération des logos perdus, priorité au seed disque qui a été enrichi)
      if (f === 'logo_url' && typeof s === 'string' && s.startsWith('data:')) {
        if (typeof cur !== 'string' || !cur.startsWith('data:image/') || s.length > cur.length + 100) {
          e[f] = s; backfilled++; return;
        }
      }
      // Cas 3 : descriptions — seed gagne dès que plus long (récupération données)
      if ((f === 'description_longue' || f === 'description_courte')
          && typeof cur === 'string' && typeof s === 'string' && s.length > cur.length + 5) {
        e[f] = s; backfilled++; return;
      }
      // Cas 4 : historique — seed gagne si a plus d'entrées
      if (f === 'historique' && Array.isArray(s) && s.length > (Array.isArray(cur) ? cur.length : 0)) {
        e[f] = s; backfilled++; return;
      }
    });
  });
  // Ajoute les entreprises présentes dans le seed mais absentes du current
  const currentNames = new Set(current.entreprises.map(e => normalizeCompanyName(e.nom)));
  const currentIds = new Set(current.entreprises.map(e => e.id).filter(Boolean));
  let added = 0;
  window.SEED_DATA.entreprises.forEach(s => {
    if (currentIds.has(s.id) || currentNames.has(normalizeCompanyName(s.nom))) return;
    current.entreprises.push(JSON.parse(JSON.stringify(s)));
    added++;
  });
  if (backfilled || added) {
    console.log(`[auto-merge] ${backfilled} champs restaurés, ${added} entreprises ajoutées depuis le seed`);
  }
  return current;
}

/**
 * Chargement des données — le fichier fait foi, et rien d'autre.
 *
 * ⚠️ La version d'origine lisait, dans l'ordre : une API locale, puis
 * IndexedDB, puis localStorage, et le fichier seulement en dernier recours.
 * C'était juste pour un outil d'édition, et dangereux pour une maquette de
 * présentation : le navigateur qui avait consulté une version antérieure
 * continuait de l'afficher. Une correction faite sur le fichier restait
 * invisible, et un poste de démonstration pouvait montrer des chiffres
 * périmés sans que personne ne s'en aperçoive.
 *
 * Ici, on lit `data-seed.js` et on efface toute copie locale. Le contenu
 * n'étant plus modifiable depuis l'interface, il n'y a rien à conserver.
 */
async function loadData() {
  purgeCachesLocaux();

  if (window.SEED_DATA) {
    state = JSON.parse(JSON.stringify(window.SEED_DATA));
    state.meta = calculeMeta(state.entreprises);
    console.log(`[data] ${state.entreprises.length} entreprises chargées depuis le fichier`);
    return;
  }

  console.error('data-seed.js absent ou illisible');
  showToast("Les données n'ont pas pu être chargées", 'error');
  state = { entreprises: [], programmes: [], promotions: [], thematiques: [], villes: [] };
  state.meta = calculeMeta([]);
}

/** Efface les copies laissées par les versions précédentes du portfolio. */
function purgeCachesLocaux() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    Object.keys(localStorage)
      .filter(k => k.startsWith('m-alumni-') || k.startsWith('m-historique-'))
      .forEach(k => localStorage.removeItem(k));
  } catch (e) { /* stockage indisponible : rien à purger */ }
  try {
    if (window.indexedDB && indexedDB.deleteDatabase) indexedDB.deleteDatabase(IDB_NAME);
  } catch (e) { /* idem */ }
}

// ================================================================
// PROTECTIONS DONNÉES — Anti perte de logos/descriptions
// ================================================================

const BACKUP_PREFIX = 'm-alumni-backup-';
const LAST_EXPORT_KEY = 'm-alumni-last-export';
const MAX_LOCAL_BACKUPS = 5;

// Sauvegarde principale avec try/catch, quota-aware et snapshot rolling
/**
 * La maquette ne persiste rien.
 *
 * Le contenu n'est plus modifiable depuis l'interface : il n'y a donc rien à
 * sauvegarder, et écrire une copie locale ne pourrait que recréer le cache
 * périmé qu'on vient de supprimer. On se contente de tenir les totaux à jour.
 */
function saveData() {
  state.meta = calculeMeta(state.entreprises);
  return { ok: true, lsOk: true };
}

function autoBackupSnapshot(payload) {
  const today = new Date().toISOString().slice(0, 10);
  const key = BACKUP_PREFIX + today;
  try {
    localStorage.setItem(key, payload);
  } catch (e) {
    // Si le snapshot échoue par quota, on supprime les vieux backups puis on retente
    pruneBackups(0);
    try { localStorage.setItem(key, payload); } catch (e2) {
      console.warn('Snapshot rolling impossible :', e2);
    }
  }
  pruneBackups();
}

function pruneBackups(keepCount = MAX_LOCAL_BACKUPS) {
  const backups = Object.keys(localStorage)
    .filter(k => k.startsWith(BACKUP_PREFIX))
    .sort();
  while (backups.length > keepCount) {
    localStorage.removeItem(backups.shift());
  }
}

function listBackups() {
  return Object.keys(localStorage)
    .filter(k => k.startsWith(BACKUP_PREFIX))
    .sort()
    .map(k => ({ key: k, date: k.slice(BACKUP_PREFIX.length), size: (localStorage.getItem(k) || '').length }));
}

function restoreBackup(dateKey) {
  const raw = localStorage.getItem(BACKUP_PREFIX + dateKey);
  if (!raw) { showToast('Snapshot introuvable', 'error'); return; }
  try {
    const parsed = JSON.parse(raw);
    if (!confirm(`Restaurer le snapshot du ${dateKey} ? La base actuelle sera écrasée.`)) return;
    // Snapshot d'urgence avant restauration
    localStorage.setItem(BACKUP_PREFIX + 'pre-restore-' + Date.now(), JSON.stringify(state));
    state = parsed;
    saveData({ skipSnapshot: true });
    showToast('Snapshot restauré', 'success');
    router();
  } catch (e) {
    showToast('Snapshot corrompu, restauration impossible', 'error');
  }
}

// Compresse une image en WebP 400px max, 0.85 qualité
async function compressImageFile(file, maxSize = 400, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let w = img.width, h = img.height;
      if (w > maxSize || h > maxSize) {
        const ratio = Math.min(maxSize / w, maxSize / h);
        w = Math.max(1, Math.round(w * ratio));
        h = Math.max(1, Math.round(h * ratio));
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      // Fond blanc pour PNG transparents (évite fond noir sur WebP)
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      // Tente WebP, fallback JPEG si non supporté
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('Compression failed'));
        const reader = new FileReader();
        reader.onload = () => resolve({ dataUrl: reader.result, size: blob.size });
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      }, 'image/webp', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Image invalide')); };
    img.src = objectUrl;
  });
}

// Export JSON — utilisé partout où on veut télécharger la base
function triggerJsonDownload(prefix = 'export') {
  const now = new Date();
  const stamp = now.toISOString().replace(/:/g, '-').slice(0, 19);
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `m-alumni-${prefix}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  localStorage.setItem(LAST_EXPORT_KEY, now.toISOString());
  updateExportReminder();
}
window.triggerJsonDownload = triggerJsonDownload;
window.restoreBackup = restoreBackup;
window.listBackups = listBackups;

function daysSinceLastExport() {
  const last = localStorage.getItem(LAST_EXPORT_KEY);
  if (!last) return Infinity;
  return (Date.now() - new Date(last).getTime()) / (24 * 3600 * 1000);
}

function updateExportReminder() {
  // Ancien indicateur retiré, remplacé par le status auto-save dans le header
  const legacy = document.getElementById('export-fab');
  if (legacy) legacy.remove();
}

function ensureExportFab() {
  // Ne plus créer le FAB — auto-save gère tout en silence
  const legacy = document.getElementById('export-fab');
  if (legacy) legacy.remove();
}

// ================================================================
// AUTO-SAVE SILENCIEUX — Détection changement + download débounce
// ================================================================
// Auto-save silencieux : uniquement IndexedDB + localStorage + snapshots
// Aucun download automatique. Le stockage IndexedDB a de grosse capacité et
// est réputé fiable ; les backups JSON restent accessibles via ⌘K.
let _autosaveDirty = false;
let _autosaveTimer = null;

function markDirtyAutosave() {
  _autosaveDirty = true;
  updateAutosaveIndicator('dirty');
  // Fait juste un flash visuel puis revient à "saved" après 1s
  if (_autosaveTimer) clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => {
    _autosaveDirty = false;
    updateAutosaveIndicator('saved');
  }, 1000);
}
window.markDirtyAutosave = markDirtyAutosave;

// Anciennes fonctions désactivées : pas de download automatique
function scheduleAutosave() {}
function performAutosaveDownload() {}

function updateAutosaveIndicator(status) {
  let el = document.getElementById('autosave-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'autosave-indicator';
    el.className = 'autosave-indicator';
    el.innerHTML = `
      <span class="autosave-dot"></span>
      <span class="autosave-label">Auto-sauvegardé</span>
      <span class="autosave-api"></span>
    `;
    document.body.appendChild(el);
  }
  const label = el.querySelector('.autosave-label');
  const api = el.querySelector('.autosave-api');
  el.classList.remove('is-dirty', 'is-saved', 'is-error');
  const apiTxt = API_AVAILABLE ? '· DB' : '· local';
  if (api) api.textContent = apiTxt;
  if (status === 'dirty') {
    el.classList.add('is-dirty');
    if (label) label.textContent = 'Sauvegarde…';
  } else if (status === 'saved') {
    el.classList.add('is-saved');
    if (label) label.textContent = 'Sauvegardé';
    setTimeout(() => el.classList.remove('is-saved'), 2500);
  } else if (status === 'error') {
    el.classList.add('is-error');
    if (label) label.textContent = 'Erreur sauvegarde';
  }
}

function refreshReferentials() {
  const entr = state.entreprises;
  state.promotions = [...new Set(entr.flatMap(e => e.promotions || []))].sort();
  state.programmes = [...new Set(entr.flatMap(e => e.programmes || []))].sort();
  state.thematiques = [...new Set(entr.flatMap(e => e.thematiques || []))].sort();
  state.villes = [...new Set(entr.map(e => e.ville).filter(Boolean))].sort();
}

// ----- FORMATTING -----

function formatMoney(v) {
  if (!v) return '0 €';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace('.0', '') + ' M€';
  if (v >= 1e3) return Math.round(v / 1e3) + ' K€';
  return v + ' €';
}

function initials(name) {
  if (!name) return '?';
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function personInitials(p) {
  return ((p.prenom?.[0] || '') + (p.nom?.[0] || '')).toUpperCase();
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ----- ROUTING -----

let currentSection = null;

const SECTIONS = {
  alumni: {
    title: 'Accélérateur M',
    subtitle: 'Portfolio des entreprises accompagnées',
  },
};

const NAV_ITEMS = {
  alumni: [
    { route: '', label: 'Portfolio' },
    { route: 'timeline', label: 'Timeline' },
    { route: 'carte', label: 'Carte' },
    { route: 'stats', label: 'Statistiques' },
  ],
};

function parseHash() {
  const hash = (location.hash || '#/').slice(2);
  const parts = hash.split('/').filter(p => p !== undefined);
  const section = parts[0] || '';
  const view = parts[1] || '';
  const param = parts[2] || '';
  return { section, view, param };
}

function startProgressBar() {
  let bar = document.getElementById('nav-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'nav-progress';
    bar.className = 'nav-progress';
    document.body.appendChild(bar);
  }
  bar.classList.remove('done');
  bar.style.width = '0%';
  requestAnimationFrame(() => {
    bar.style.width = '85%';
  });
}
function finishProgressBar() {
  const bar = document.getElementById('nav-progress');
  if (!bar) return;
  bar.style.width = '100%';
  setTimeout(() => {
    bar.classList.add('done');
    bar.style.width = '0%';
  }, 200);
}

function router() {
  startProgressBar();
  const { section, view, param } = parseHash();

  if (!section || section !== 'alumni') {
    location.hash = '#/alumni';
    return;
  }

  currentSection = section;
  applySectionChrome(section);

  routeAlumni(view, param);

  updateNavActive(view);
  window.scrollTo(0, 0);
  finishProgressBar();
}

function routeAlumni(view, param) {
  if (view === 'entreprise' && param) renderDetail(param);
  else if (view === 'timeline') renderTimeline();
  else if (view === 'carte') renderCarte();
  else if (view === 'stats') renderStats();
  else renderHome();
}

function routeStartups(view, param) {
  if (!view) renderStartupsHome();
  else renderStartupsPlaceholder(view, param);
}

function applySectionChrome(section) {
  const header = document.getElementById('app-header');
  const body = document.body;
  const title = document.getElementById('header-title');
  const subtitle = document.getElementById('header-subtitle');
  const navInner = document.getElementById('main-nav-inner');
  const meta = SECTIONS[section];
  if (!meta) return;

  if (header) header.style.display = '';
  body.dataset.section = section;

  if (title) title.textContent = meta.title;
  if (subtitle) subtitle.textContent = meta.subtitle;

  if (navInner) {
    navInner.innerHTML = NAV_ITEMS[section].map(item => `
      <a href="#/${section}${item.route ? '/' + item.route : ''}" data-route="${item.route}"${item.id ? ` id="${item.id}"` : ''}>${escapeHtml(item.label)}</a>
    `).join('');
  }
}

function hideSectionChrome() {
  const header = document.getElementById('app-header');
  if (header) header.style.display = 'none';
  document.body.dataset.section = 'landing';
}

function updateNavActive(view) {
  document.querySelectorAll('.main-nav a').forEach(a => {
    const route = a.dataset.route || '';
    a.classList.toggle('active', route === view || (route === '' && !view));
  });
}

function navigate(hash) {
  Sfx.play('nav');
  if (document.startViewTransition && !window.__reduceMotion) {
    document.startViewTransition(() => { location.hash = hash; });
  } else {
    location.hash = hash;
  }
}

// Navigation contextuelle : préfixe automatiquement avec la section courante
function navigateSection(view, param) {
  const section = currentSection || 'alumni';
  let hash = `#/${section}`;
  if (view) hash += `/${view}`;
  if (param) hash += `/${param}`;
  location.hash = hash;
}

window.navigate = navigate;
window.navigateSection = navigateSection;

// ================================================================
// Sfx — micro sound design ultra léger
// ================================================================
const Sfx = (() => {
  let ctx = null;
  const enabled = () => localStorage.getItem('m-sfx') === '1';
  const ensure = () => { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {} } return ctx; };
  const tone = (freq, dur = 0.06, type = 'sine', gain = 0.04) => {
    if (!enabled()) return;
    const c = ensure(); if (!c) return;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(gain, c.currentTime + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g).connect(c.destination);
    o.start(); o.stop(c.currentTime + dur);
  };
  return {
    play(kind) {
      if (!enabled()) return;
      if (kind === 'nav') tone(880, 0.06, 'sine', 0.03);
      else if (kind === 'tick') tone(1600, 0.02, 'square', 0.015);
      else if (kind === 'whoosh') { tone(400, 0.12, 'triangle', 0.03); setTimeout(() => tone(800, 0.08, 'triangle', 0.02), 40); }
      else if (kind === 'ok') { tone(660, 0.06); setTimeout(() => tone(880, 0.08), 60); }
      else if (kind === 'err') tone(180, 0.15, 'sawtooth', 0.04);
    },
    toggle() {
      const on = !enabled();
      localStorage.setItem('m-sfx', on ? '1' : '0');
      this.play(on ? 'ok' : 'err');
      const btn = document.getElementById('btn-sfx');
      if (btn) btn.classList.toggle('is-on', on);
      showToast(on ? 'Sons activés' : 'Sons désactivés', 'success');
    },
  };
})();
window.Sfx = Sfx;
window.toggleSfx = () => Sfx.toggle();

// ================================================================
// fuzzyMatch — score de similarité multi-champs
// ================================================================
function normalize(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = normalize(query);
  const t = normalize(text);
  if (!t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 85;
  if (t.includes(q)) return 65;
  // caractères de q dans l'ordre dans t
  const inOrder = (needle, haystack) => {
    let i = 0, gaps = 0, last = -1;
    for (let j = 0; j < haystack.length && i < needle.length; j++) {
      if (haystack[j] === needle[i]) {
        if (last >= 0) gaps += j - last - 1;
        last = j; i++;
      }
    }
    return i === needle.length ? gaps : -1;
  };
  const g1 = inOrder(q, t);
  if (g1 >= 0) return Math.max(10, 45 - Math.min(45, g1));
  // tolère 1-2 typos : si presque tous les chars de q sont dans t
  const g2 = inOrder(t, q);
  if (g2 >= 0) return Math.max(10, 35 - Math.min(35, g2));
  // Score trigrammes : combien de trigrammes de q sont dans t
  if (q.length >= 3 && t.length >= 3) {
    let hits = 0, total = q.length - 2;
    for (let i = 0; i <= q.length - 3; i++) if (t.includes(q.slice(i, i+3))) hits++;
    if (hits / total > 0.5) return Math.round(20 + 25 * (hits / total));
  }
  return 0;
}
function fuzzyMatchEntreprise(query, e) {
  if (!query) return 100;
  const fields = [
    { v: e.nom, w: 3 },
    { v: e.ville, w: 2 },
    { v: e.description_courte, w: 1 },
    { v: e.description_longue, w: 0.5 },
    { v: (e.thematiques || []).join(' '), w: 1.5 },
    { v: (e.programmes || []).join(' '), w: 1.2 },
    { v: (e.promotions || []).join(' '), w: 1 },
  ];
  return fields.reduce((sum, f) => sum + fuzzyScore(query, f.v) * f.w, 0);
}
window.fuzzyScore = fuzzyScore;
window.fuzzyMatchEntreprise = fuzzyMatchEntreprise;

// ================================================================
// Comparateur — état + toggle
// ================================================================
const CompareStore = {
  MAX: 4,
  key: 'm-compare-ids',
  get() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch(e) { return []; } },
  set(ids) { localStorage.setItem(this.key, JSON.stringify(ids)); this.updateBar(); },
  has(id) { return this.get().includes(id); },
  toggle(id) {
    let ids = this.get();
    if (ids.includes(id)) ids = ids.filter(x => x !== id);
    else if (ids.length < this.MAX) ids.push(id);
    else { showToast(`Comparateur limité à ${this.MAX} entreprises`, 'error'); return; }
    this.set(ids);
    Sfx.play('tick');
  },
  clear() { this.set([]); },
  updateBar() {
    const ids = this.get();
    let bar = document.getElementById('compare-bar');
    if (!ids.length) { if (bar) bar.remove(); return; }
    const html = `
      <div class="compare-bar-inner">
        <span class="compare-bar-count">${ids.length}</span>
        <span class="compare-bar-label">entreprise${ids.length > 1 ? 's' : ''} sélectionnée${ids.length > 1 ? 's' : ''}</span>
        <div class="compare-bar-logos">
          ${ids.map(id => {
            const e = state.entreprises.find(x => x.id === id);
            const logo = e && (e.logo_url || '').startsWith('data:') ? `<img src="${e.logo_url}" alt="">` : `<span>${escapeHtml(initials(e?.nom || '?'))}</span>`;
            return `<button class="compare-bar-chip" title="Retirer ${escapeHtml(e?.nom||'')}" onclick="CompareStore.toggle('${escapeHtml(id)}')">${logo}<i>×</i></button>`;
          }).join('')}
        </div>
        <button class="compare-bar-cta" onclick="navigate('#/alumni/compare')">Comparer →</button>
        <button class="compare-bar-clear" onclick="CompareStore.clear()" title="Vider">×</button>
      </div>`;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'compare-bar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = html;
  },
};
window.CompareStore = CompareStore;

// ================================================================
// LANDING — Choix entre M alumni et M startups
// ================================================================

function renderLanding() {
  hideSectionChrome();
  const s = state.stats_officielles || {};
  const totalEntr = s.total_entreprises || state.entreprises?.length || 207;
  const totalProms = s.total_promotions || 11;
  const totalFonds = s.total_fonds || 73671800;
  const totalEmplois = s.total_emplois || 230;
  const year = new Date().getFullYear();

  document.getElementById('app').innerHTML = `
    <div class="landing3">
      <div class="landing3-mesh" aria-hidden="true"></div>
      <div class="landing3-video-hero" aria-hidden="true">
        <video autoplay muted loop playsinline poster="logo.png">
          <source src="https://cdn.pixabay.com/video/2023/06/09/166339-834168849_large.mp4" type="video/mp4">
        </video>
      </div>
      <div class="landing3-skyline" aria-hidden="true"></div>
      <canvas id="landing-particles" class="landing3-particles"></canvas>
      <div class="landing3-bg" aria-hidden="true">
        <div class="landing3-cube-pattern"></div>
        <div class="landing3-cube-wireframe"></div>
        <div class="landing3-orb landing3-orb--blue"></div>
        <div class="landing3-orb landing3-orb--green"></div>
      </div>

      <header class="landing3-hero">
        <div class="landing3-hero-inner">
          <div class="landing3-brand">
            <div class="landing3-logo">
              <img src="logo.png" alt="Accélérateur M">
            </div>
            <div>
              <div class="landing3-eyebrow">
                <span class="landing3-dot"></span>
                Marseille · Depuis 2014
              </div>
              <h1 class="landing3-title kinetic-title">Accélérateur M</h1>
            </div>
          </div>
          <div class="landing3-hero-right">
            <button class="landing3-theme-toggle" onclick="toggleTheme()" title="Basculer thème clair / sombre" aria-label="Basculer thème">
              <svg class="theme-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
              <svg class="theme-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            </button>
            <div class="landing3-tricolor" aria-hidden="true">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>
        <p class="landing3-baseline">Accélérer la métamorphose des entreprises. Un accélérateur, deux portails.</p>
      </header>

      <main class="landing3-main">
        <div class="landing3-emblem" aria-hidden="true">
          <div class="landing3-emblem-orbit"></div>
          <div class="landing3-emblem-orbit landing3-emblem-orbit--2"></div>
          <div class="landing3-emblem-mark">
            <img src="logo.png" alt="">
          </div>
        </div>
        <div class="landing3-instruction">
          <span class="landing3-instruction-line"></span>
          <span>Choisis ton portail</span>
          <span class="landing3-instruction-line"></span>
        </div>

        <div class="landing3-cards">
          <a class="l3-card l3-card--alumni" href="#/alumni">
            <div class="l3-card-halo"></div>
            <div class="l3-card-glow"></div>
            <div class="l3-card-head">
              <span class="l3-card-index">01</span>
              <span class="l3-card-tag">Portfolio · Historique</span>
            </div>
            <div class="l3-card-body">
              <h2 class="l3-card-title">M alumni</h2>
              <p class="l3-card-desc">Les start-ups accompagnées depuis 2014. Portfolio, timeline, alumni, carte, récits, statistiques.</p>
            </div>
            <div class="l3-card-stats">
              <div class="l3-stat">
                <b class="l3-count" data-count-to="${totalEntr}">0</b>
                <span>Start-ups</span>
              </div>
              <div class="l3-stat">
                <b class="l3-count" data-count-to="${totalProms}">0</b>
                <span>Promotions</span>
              </div>
              <div class="l3-stat">
                <b class="l3-count" data-count-money="${totalFonds}">0 €</b>
                <span>Levés cumulés</span>
              </div>
            </div>
            <div class="l3-card-cta">
              <span>Entrer</span>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </div>
          </a>

          <a class="l3-card l3-card--startups" href="#/startups">
            <div class="l3-card-halo"></div>
            <div class="l3-card-glow"></div>
            <div class="l3-card-head">
              <span class="l3-card-index">02</span>
              <span class="l3-card-tag">
                <span class="l3-live-dot"></span>
                En accompagnement · ${year}
              </span>
            </div>
            <div class="l3-card-body">
              <h2 class="l3-card-title">M startups</h2>
              <p class="l3-card-desc">Les start-ups actuellement dans les programmes de l'Accélérateur. Suivi live, équipes, événements.</p>
            </div>
            <div class="l3-card-stats l3-card-stats--soon">
              <div class="l3-soon-badge">Bientôt disponible</div>
              <p>Construction en cours · lancement ${year}</p>
            </div>
            <div class="l3-card-cta">
              <span>Découvrir</span>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </div>
          </a>
        </div>
      </main>

      <div class="landing3-partners" aria-label="Partenaires de l'Accélérateur M">
        <div class="landing3-partners-label">
          <span class="landing3-partners-dot"></span>
          Ils nous accompagnent
        </div>
        <div class="landing3-partners-track" role="marquee">
          <div class="landing3-partners-line">
            ${(() => {
              const partners = [
                'RÉGION SUD',
                'VILLE DE MARSEILLE',
                'MÉTROPOLE AIX-MARSEILLE',
                'CCI AIX-MARSEILLE',
                'FRENCH TECH AIX-MARSEILLE',
                'AIX-MARSEILLE UNIVERSITÉ',
                'BPIFRANCE',
                'CRÉDIT AGRICOLE',
                'ADEME',
                'LA COQUE',
                'PROVENCE PROMOTION',
                'CISAM',
                'BANQUE POPULAIRE',
                'FRENCH IMPACT',
                'THECAMP',
                'FONDATION CMA-CGM',
              ];
              const item = p => `<span class="landing3-partner">${escapeHtml(p)}</span><span class="landing3-partners-sep" aria-hidden="true">✦</span>`;
              return partners.concat(partners).concat(partners).map(item).join('');
            })()}
          </div>
        </div>
      </div>

      <footer class="landing3-footer">
        <div class="landing3-footer-inner">
          <div class="landing3-footer-left">© ${year} Accélérateur M · Marseille</div>
          <div class="landing3-footer-mid">
            <a href="https://accelerateur-m.com" target="_blank" rel="noreferrer">accelerateur-m.com</a>
            <span class="dot">·</span>
            <a href="mailto:contact@accelerateur-m.com">contact@accelerateur-m.com</a>
          </div>
          <div class="landing3-footer-right">v4 · prototype</div>
        </div>
      </footer>
    </div>
  `;

  setTimeout(animateLandingCounters, 200);
  setTimeout(initLandingParticles, 300);
}

function animateLandingCounters() {
  document.querySelectorAll('.l2-count, .l3-count').forEach(el => {
    const target = parseInt(el.dataset.countTo, 10);
    const money = el.dataset.countMoney ? parseInt(el.dataset.countMoney, 10) : null;
    const to = money || target;
    if (!to) return;
    const duration = 1400;
    const start = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const val = Math.round(to * ease(t));
      el.textContent = money != null ? formatMoney(val) : val.toLocaleString('fr-FR');
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

// ================================================================
// M STARTUPS — Placeholder "à venir"
// ================================================================

const STARTUPS_PLACEHOLDERS = {
  '': {
    title: 'Portfolio des start-ups actives',
    lead: 'La liste des start-ups actuellement en accompagnement à l\'Accélérateur M.',
  },
  timeline: {
    title: 'Timeline',
    lead: 'Cohortes en cours, jalons d\'accompagnement, échéances clés.',
  },
  personnes: {
    title: 'Équipes',
    lead: 'Les fondateurs et fondatrices actuellement dans les programmes.',
  },
  carte: {
    title: 'Carte',
    lead: 'Répartition géographique des start-ups en accompagnement.',
  },
  stats: {
    title: 'Statistiques',
    lead: 'Chiffres clés et suivi de la promotion en cours.',
  },
  prive: {
    title: 'Espace privé',
    lead: 'Ressources internes, messagerie, événements et offres réservés à l\'écosystème.',
  },
};

function renderStartupsHome() {
  renderStartupsPlaceholder('', '');
}

function renderStartupsPlaceholder(view, param) {
  const meta = STARTUPS_PLACEHOLDERS[view] || {
    title: 'À venir',
    lead: 'Cette section fera partie de M startups.',
  };
  document.getElementById('app').innerHTML = `
    <div class="startups-placeholder">
      <div class="startups-placeholder-inner">
        <div class="startups-badge">Bientôt disponible</div>
        <h2>${escapeHtml(meta.title)}</h2>
        <p class="startups-lead">${escapeHtml(meta.lead)}</p>
        <div class="startups-info">
          <p>M startups est le portail dédié aux start-ups actuellement accompagnées par l'Accélérateur M. Il partagera la même architecture que M alumni pour permettre un suivi live des cohortes en cours.</p>
          <p>Cette page est en cours de construction. En attendant, tu peux explorer les 182 alumni historiques dans <a href="#/alumni">M alumni</a>.</p>
        </div>
        <div class="startups-actions">
          <a class="btn-primary" href="#/">← Revenir au choix des portails</a>
          <a class="btn-secondary" href="#/alumni">Explorer M alumni</a>
        </div>
      </div>
    </div>
  `;
}

// ----- HOME -----

// ================================================================
// WALL OF ALUMNI — Grille dense des logos importés
// ================================================================
function renderAlumniWall() {
  // Toutes les entreprises avec logo, triées par nom (les nouveaux logos apparaissent naturellement en dessous)
  const withLogos = state.entreprises
    .filter(e => (e.logo_url || '').startsWith('data:'))
    .sort((a, b) => (a.nom || '').localeCompare(b.nom || ''));
  if (withLogos.length < 4) return '';
  return `
    <section class="alumni-wall">
      <div class="alumni-wall-inner">
        <div class="alumni-wall-head">
          <span class="alumni-wall-eyebrow"><span class="alumni-wall-dot"></span>Écosystème vivant</span>
          <h3 class="alumni-wall-title">Start-ups qui construisent le territoire.</h3>
        </div>
        <div class="alumni-wall-grid">
          ${withLogos.map(e => `
            <a class="alumni-wall-item tilt-3d" href="#/alumni/entreprise/${escapeHtml(e.id)}" title="${escapeHtml(e.nom)}">
              <img src="${escapeHtml(e.logo_url)}" alt="${escapeHtml(e.nom)}" loading="lazy">
              <span class="alumni-wall-name">${escapeHtml(e.nom)}</span>
            </a>
          `).join('')}
        </div>
      </div>
    </section>
  `;
}

function renderHome() {
  const filtered = filterEntreprises();
  const meta = state.meta || {};
  const allE = state.entreprises;

  // Sélection de la star card : plus grosse levée qui matche aussi les filtres
  const featured = filtered.length > 6
    ? [...filtered].sort((a, b) => (b.fonds_leves || 0) - (a.fonds_leves || 0))[0]
    : null;
  const rest = featured ? filtered.filter(e => e.id !== featured.id) : filtered;

  const counts = tabCounts();
  const tabs = [
    { id: 'all', label: 'Tous', count: counts.all },
    { id: 'active', label: 'Actives', count: counts.active },
    { id: 'raised', label: 'Levée ≥ 1 M€', count: counts.raised },
    { id: 'eteinte', label: 'Éteintes', count: counts.eteinte },
  ];
  const view = portfolioState.view;
  const isList = view === 'list';

  document.getElementById('app').innerHTML = `
    <div class="hero hero--v4">
      <div class="hero-v4-mark" aria-hidden="true">
        <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M20 80 L20 20 L50 60 L80 20 L80 80" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="hero-v4-orbs" aria-hidden="true">
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
        <div class="orb orb-3"></div>
      </div>
      <div class="hero-v4-marquee" aria-hidden="true">
        <div class="marquee-track">
          ${(state.entreprises.slice(0, 30).map(e => e.nom).join(' · ') + ' · ').repeat(3)}
        </div>
      </div>
      <div class="hero-v4-inner">
        <div class="hero-eyebrow">
          <span>M alumni</span>
          <span class="hero-sep"></span>
          <span>Depuis 2014 · Marseille</span>
        </div>
        <h2 class="hero-v4-title hero-v4-title--xl">
          <span class="kinetic-word"><span>Accélérer</span></span>
          <span class="kinetic-word kinetic-word--muted"><span>la</span> <span>métamorphose</span></span>
          <span class="kinetic-word kinetic-word--accent"><span>des</span> <span>entreprises.</span></span>
        </h2>
        <p class="hero-v4-baseline" data-scramble="1">Depuis 2014, l'Accélérateur M accompagne les start-ups qui se créent et se développent sur le territoire. Ce portfolio recense les entreprises passées par ses programmes, les emplois qu'elles ont créés et les fonds qu'elles ont levés.</p>
        <div class="hero-v4-cta">
          <button class="btn-primary" onclick="document.querySelector('.kpi-bento')?.scrollIntoView({behavior:'smooth',block:'start'})">
            Voir l'impact
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:6px;vertical-align:middle;"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
          </button>
          <button class="btn-secondary" onclick="openCmdk()">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:middle;"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            Rechercher (⌘K)
          </button>
        </div>
      </div>
    </div>
    <div class="kpi-bento">
      <div class="kpi-bento-inner">
        <a class="kpi-tile kpi-tile--hero tilt-3d" href="#/alumni/stats" data-kpi="fonds">
          <div class="kpi-tile-header">
            <div class="kpi-tile-datavis kpi-datavis--waveform">
              <svg viewBox="0 0 60 40" preserveAspectRatio="none">
                <path d="M 0 30 Q 10 5, 20 25 T 40 20 T 60 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                <path d="M 0 35 Q 10 15, 20 30 T 40 25 T 60 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.55"/>
                <circle cx="60" cy="15" r="2.5" fill="currentColor"/>
              </svg>
            </div>
            <div class="kpi-tile-badge">
              <span class="kpi-dot"></span>Impact
            </div>
          </div>
          <div class="kpi-tile-value" data-count-target="${state.meta.total_fonds || 0}" data-count-money="1">0</div>
          <div class="kpi-tile-label">Fonds levés cumulés</div>
          <div class="kpi-tile-spark" data-spark="fonds"></div>
          <div class="kpi-tile-caption">Depuis 2014 · toutes promotions confondues</div>
        </a>

        <a class="kpi-tile kpi-tile--accent tilt-3d" href="#/alumni" data-kpi="entreprises">
          <div class="kpi-tile-datavis kpi-datavis--spiral">
            <svg viewBox="0 0 60 60" preserveAspectRatio="xMidYMid">
              <path d="M 30 30 m -20 0 a 20 20 0 1 1 15 19 a 15 15 0 0 1 -10 -15 a 10 10 0 1 1 15 -3 a 5 5 0 0 1 -6 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              <circle cx="30" cy="30" r="2" fill="currentColor"/>
            </svg>
          </div>
          <div class="kpi-tile-value" data-count-target="${state.meta.total_entreprises || 0}">0</div>
          <div class="kpi-tile-label">Entreprises<br>du portefeuille</div>
          <div class="kpi-tile-spark" data-spark="entreprises"></div>
        </a>

        <a class="kpi-tile tilt-3d" href="#/alumni/timeline" data-kpi="promotions">
          <div class="kpi-tile-datavis kpi-datavis--orbits">
            <svg viewBox="0 0 60 60" preserveAspectRatio="xMidYMid">
              <circle cx="30" cy="30" r="26" fill="none" stroke="currentColor" stroke-width="1" opacity="0.35"/>
              <circle cx="30" cy="30" r="18" fill="none" stroke="currentColor" stroke-width="1" opacity="0.55"/>
              <circle cx="30" cy="30" r="10" fill="none" stroke="currentColor" stroke-width="1" opacity="0.85"/>
              <circle cx="56" cy="30" r="2.5" fill="currentColor"/>
              <circle cx="12" cy="30" r="2" fill="currentColor" opacity="0.7"/>
              <circle cx="30" cy="20" r="1.8" fill="currentColor" opacity="0.85"/>
            </svg>
          </div>
          <div class="kpi-tile-value" data-count-target="${state.meta.total_promotions || 0}">0</div>
          <div class="kpi-tile-label">Promotions</div>
          <div class="kpi-tile-spark" data-spark="promotions"></div>
        </a>

        <a class="kpi-tile kpi-tile--green tilt-3d" href="#/alumni/stats" data-kpi="emplois">
          <div class="kpi-tile-datavis kpi-datavis--bars">
            <svg viewBox="0 0 60 60" preserveAspectRatio="xMidYMid">
              <rect x="6"  y="40" width="7" height="14" rx="1.5" fill="currentColor" opacity="0.35"/>
              <rect x="18" y="30" width="7" height="24" rx="1.5" fill="currentColor" opacity="0.55"/>
              <rect x="30" y="22" width="7" height="32" rx="1.5" fill="currentColor" opacity="0.75"/>
              <rect x="42" y="10" width="7" height="44" rx="1.5" fill="currentColor"/>
              <path d="M 3 44 L 15 34 L 27 26 L 39 18 L 51 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.9"/>
            </svg>
          </div>
          <div class="kpi-tile-value" data-count-target="${state.meta.total_emplois || 0}">0</div>
          <div class="kpi-tile-label">Emplois<br>déclarés</div>
          <div class="kpi-tile-spark" data-spark="emplois"></div>
        </a>
      </div>
    </div>

    ${renderAlumniWall()}
    <div class="main">
      <div class="content-area" style="grid-column: 1 / -1;">
        <div class="portfolio-toolbar">
          <div class="portfolio-tabs" role="tablist">
            ${tabs.map(t => `
              <button class="portfolio-tab ${portfolioState.tab === t.id ? 'active' : ''}" onclick="setPortfolioTab('${t.id}')">
                ${escapeHtml(t.label)}
                <span class="portfolio-tab-count">${t.count}</span>
              </button>
            `).join('')}
          </div>
          <div class="portfolio-controls">
            <button class="btn-filter" onclick="openFilterModal()" title="Filtres avancés">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
              Filtrer
              ${countActiveFilters() ? `<span class="filter-count-badge">${countActiveFilters()}</span>` : ''}
            </button>
            <div class="portfolio-sort">
              <label>Trier</label>
              <select onchange="setPortfolioSort(this.value)">
                <option value="default" ${portfolioState.sort === 'default' ? 'selected' : ''}>Par défaut</option>
                <option value="name" ${portfolioState.sort === 'name' ? 'selected' : ''}>Nom (A-Z)</option>
                <option value="year_desc" ${portfolioState.sort === 'year_desc' ? 'selected' : ''}>Plus récentes</option>
                <option value="fonds_desc" ${portfolioState.sort === 'fonds_desc' ? 'selected' : ''}>Fonds levés ↓</option>
                <option value="emplois_desc" ${portfolioState.sort === 'emplois_desc' ? 'selected' : ''}>Emplois ↓</option>
              </select>
            </div>
            <div class="portfolio-view">
              <button class="${view === 'grid' ? 'active' : ''}" onclick="setPortfolioView('grid')" title="Vue grid" aria-label="Vue grid">${iconSvg('grid', 14)}</button>
              <button class="${view === 'list' ? 'active' : ''}" onclick="setPortfolioView('list')" title="Vue liste" aria-label="Vue liste">${iconSvg('list', 14)}</button>
            </div>
            <button class="btn-secondary btn-report" onclick="generatePortfolioReport()" title="Générer le rapport PDF du portfolio">
              ${iconSvg('doc', 14)} <span>Rapport PDF</span>
            </button>
          </div>
        </div>
        ${renderActiveFiltersBar()}
        <h3 class="section-title">
          <span>Entreprises accompagnées</span>
          <span class="count">${filtered.length} résultat${filtered.length > 1 ? 's' : ''}</span>
        </h3>
        ${filtered.length === 0
          ? renderEmptyState('filters')
          : (view === 'kanban'
              ? renderKanbanView(filtered)
              : (isList
              ? `<div class="list-view">
                  <div class="list-head">
                    <div></div><div></div><div>Nom · Ville</div>
                    <div>Thématique</div><div>Promo</div><div>Programme</div>
                    <div>Année</div><div>Emplois</div><div>Fonds</div><div>Statut</div>
                  </div>
                  ${filtered.map(renderListItem).join('')}
                </div>`
              : `<div class="grid" id="entreprises-grid">
                  ${(featured ? renderFeaturedCard(featured) : '') + rest.map(e => renderCard(e, allE)).join('')}
                </div>`))
        }
        ${filtered.length > 0 ? renderImpactSection() : ''}
      </div>
    </div>
  `;
  bindFilterEvents();
  animateHeroStats();
  setTimeout(renderHeroSparklines, 800);
  observeScrollTriggeredCounters();
  initMotionSystems();
}

// ================================================================
// MOTION SYSTEMS — Scroll reveals, magnetic hover, parallax, kinetic text
// ================================================================

function initMotionSystems() {
  initKineticHero();
  initScrollReveals();
  initMagneticCards();
  initHeroParallax();
  initTextScramble();
  initScrollProgress();
  setTimeout(initSparklineReveal, 900);
  setTimeout(initCardLogoColors, 100);
}

// ================================================================
// EXTRACTION COULEUR DOMINANTE — Depuis les logos des entreprises
// Applique la couleur comme --card-accent sur chaque card
// ================================================================
const _cardColorCache = new Map();

function extractDominantColor(imgSrc) {
  if (_cardColorCache.has(imgSrc)) return Promise.resolve(_cardColorCache.get(imgSrc));
  return new Promise(resolve => {
    if (!imgSrc || !imgSrc.startsWith('data:image/')) return resolve(null);
    const img = new Image();
    img.onload = () => {
      try {
        const size = 40;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 120) continue;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          // Ignore blanc quasi-pur (fond)
          if (r > 240 && g > 240 && b > 240) continue;
          // Ignore noir quasi-pur (texte des logos)
          if (r < 20 && g < 20 && b < 20) continue;
          // Ignore gris purs
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          if (max - min < 25) continue;
          // Quantize à 32 valeurs par canal pour buckets
          const key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
          const cur = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
          cur.r += r; cur.g += g; cur.b += b; cur.n++;
          buckets.set(key, cur);
        }
        if (!buckets.size) { _cardColorCache.set(imgSrc, null); return resolve(null); }
        // Trouve le bucket le plus fréquent
        let best = null, bestN = 0;
        buckets.forEach(v => { if (v.n > bestN) { bestN = v.n; best = v; } });
        const color = `rgb(${Math.round(best.r / best.n)},${Math.round(best.g / best.n)},${Math.round(best.b / best.n)})`;
        _cardColorCache.set(imgSrc, color);
        resolve(color);
      } catch (e) { _cardColorCache.set(imgSrc, null); resolve(null); }
    };
    img.onerror = () => { _cardColorCache.set(imgSrc, null); resolve(null); };
    img.src = imgSrc;
  });
}

async function initCardLogoColors() {
  const cards = document.querySelectorAll('.card:not([data-accent-set])');
  for (const card of cards) {
    card.dataset.accentSet = '1';
    const img = card.querySelector('img.card-logo-img, .card-logo-mini img');
    if (img && img.src && img.src.startsWith('data:')) {
      const color = await extractDominantColor(img.src);
      if (color) {
        card.style.setProperty('--card-accent', color);
        card.classList.add('has-logo-accent');
      }
    }
  }
  // Idem sur la vue liste
  const rows = document.querySelectorAll('.list-row:not([data-accent-set])');
  for (const row of rows) {
    row.dataset.accentSet = '1';
    const img = row.querySelector('.list-logo img');
    if (img && img.src && img.src.startsWith('data:')) {
      const color = await extractDominantColor(img.src);
      if (color) row.style.setProperty('--card-accent', color);
    }
  }
}

// Cursor follower : petit dot lumineux qui suit le curseur avec smoothing
let _cursorEl = null;
let _cursorRAF = null;
let _cursorTarget = { x: 0, y: 0 };
let _cursorPos = { x: 0, y: 0 };
function initCursorFollower() {
  if (_cursorEl) return;
  if ('ontouchstart' in window) return; // pas sur mobile
  _cursorEl = document.createElement('div');
  _cursorEl.className = 'cursor-dot';
  document.body.appendChild(_cursorEl);
  document.addEventListener('mousemove', e => {
    _cursorTarget.x = e.clientX;
    _cursorTarget.y = e.clientY;
  });
  document.addEventListener('mouseover', e => {
    const isInteractive = e.target.closest('a, button, .card, .kpi-tile, [role="button"], input, select, textarea, .filter-chip, .portfolio-tab');
    _cursorEl.classList.toggle('is-hover', !!isInteractive);
  });
  function tick() {
    _cursorPos.x += (_cursorTarget.x - _cursorPos.x) * 0.18;
    _cursorPos.y += (_cursorTarget.y - _cursorPos.y) * 0.18;
    _cursorEl.style.transform = `translate3d(${_cursorPos.x}px, ${_cursorPos.y}px, 0) translate(-50%, -50%)`;
    _cursorRAF = requestAnimationFrame(tick);
  }
  tick();
}

// Text scramble : le baseline se décode caractère par caractère au chargement
function initTextScramble() {
  const el = document.querySelector('[data-scramble="1"]');
  if (!el || el.dataset.scrambled === '1') return;
  el.dataset.scrambled = '1';
  const finalText = el.textContent;
  const chars = '!<>-_\\/[]{}—=+*^?#@$%&';
  let frame = 0;
  const startedAt = performance.now();
  const duration = 900;
  function tick(now) {
    const t = Math.min(1, (now - startedAt) / duration);
    const cutoff = Math.floor(finalText.length * t);
    let out = '';
    for (let i = 0; i < finalText.length; i++) {
      if (i < cutoff) out += finalText[i];
      else if (finalText[i] === ' ') out += ' ';
      else out += chars[Math.floor(Math.random() * chars.length)];
    }
    el.textContent = out;
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = finalText;
  }
  el.textContent = '';
  setTimeout(() => requestAnimationFrame(tick), 400);
}

// Floating shapes : petits SVG (plus, dot, croix, cercle) qui flottent en fond du hero
function initFloatingShapes() {
  const hero = document.querySelector('.hero--v4');
  if (!hero || hero.querySelector('.floating-shapes')) return;
  const container = document.createElement('div');
  container.className = 'floating-shapes';
  container.setAttribute('aria-hidden', 'true');
  const shapes = ['plus', 'dot', 'ring', 'cross', 'star', 'arrow'];
  const shapeHTML = {
    plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>',
    dot: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" fill="currentColor"/></svg>',
    ring: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="6"/></svg>',
    cross: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg>',
    star: '<svg viewBox="0 0 20 20" fill="currentColor"><polygon points="10,2 12,8 18,8 13,12 15,18 10,14 5,18 7,12 2,8 8,8"/></svg>',
    arrow: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="10" x2="16" y2="10"/><polyline points="10 4 16 10 10 16"/></svg>',
  };
  const positions = [
    { shape: 'plus',  top: '12%', left: '8%',  size: 22, color: 'primary', dur: 8 },
    { shape: 'dot',   top: '22%', left: '92%', size: 10, color: 'green',   dur: 6 },
    { shape: 'ring',  top: '68%', left: '12%', size: 26, color: 'cyan',    dur: 9 },
    { shape: 'cross', top: '80%', left: '35%', size: 16, color: 'primary', dur: 7 },
    { shape: 'star',  top: '48%', left: '85%', size: 20, color: 'green',   dur: 11 },
    { shape: 'arrow', top: '10%', left: '55%', size: 18, color: 'cyan',    dur: 10 },
    { shape: 'plus',  top: '82%', left: '78%', size: 14, color: 'green',   dur: 8 },
    { shape: 'dot',   top: '45%', left: '20%', size: 8,  color: 'primary', dur: 5 },
  ];
  positions.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = `float-shape float-shape--${p.color}`;
    el.style.top = p.top;
    el.style.left = p.left;
    el.style.width = p.size + 'px';
    el.style.height = p.size + 'px';
    el.style.animationDuration = p.dur + 's';
    el.style.animationDelay = (i * 0.3) + 's';
    el.innerHTML = shapeHTML[p.shape];
    container.appendChild(el);
  });
  hero.appendChild(container);
}

// Kinetic text : chaque mot du hero apparaît avec fade+slide stagger
function initKineticHero() {
  const words = document.querySelectorAll('.hero-v4-title .kinetic-word span');
  words.forEach((w, i) => {
    w.style.opacity = '0';
    w.style.transform = 'translateY(28px) rotateX(-40deg)';
    w.style.display = 'inline-block';
    w.style.transformOrigin = 'bottom center';
    setTimeout(() => {
      w.style.transition = 'opacity 0.9s cubic-bezier(0.22, 1, 0.36, 1), transform 0.9s cubic-bezier(0.22, 1, 0.36, 1)';
      w.style.opacity = '1';
      w.style.transform = 'translateY(0) rotateX(0)';
    }, 80 + i * 65);
  });
}

// Scroll reveals : sections apparaissent avec fade+slide when in viewport
let _revealObserver = null;
function initScrollReveals() {
  if (_revealObserver) _revealObserver.disconnect();
  if (!('IntersectionObserver' in window)) return;
  const selectors = [
    '.impact-section',
    '.portfolio-toolbar',
    '.section-title',
    '.grid > .card',
    '.list-view',
    '.detail-section',
  ];
  const els = document.querySelectorAll(selectors.join(','));
  els.forEach(el => {
    if (el.dataset.revealed === '1') return;
    el.classList.add('reveal-init');
  });
  _revealObserver = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        en.target.classList.add('reveal-in');
        en.target.dataset.revealed = '1';
        _revealObserver.unobserve(en.target);
      }
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -60px 0px' });
  els.forEach(el => _revealObserver.observe(el));
}

// Magnetic cards : tilt 3D quand le curseur bouge dessus
function initMagneticCards() {
  document.querySelectorAll('.card, .kpi-tile, .tilt-3d').forEach(card => {
    if (card.dataset.magnetic === '1') return;
    card.dataset.magnetic = '1';
    let raf = null;
    const maxTilt = card.classList.contains('alumni-wall-item') ? 8 : 4;
    const lift = card.classList.contains('alumni-wall-item') ? 2 : 4;
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const rx = (0.5 - y) * maxTilt;
      const ry = (x - 0.5) * maxTilt;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        card.style.transform = `perspective(1000px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-${lift}px)`;
      });
    });
    card.addEventListener('mouseleave', () => {
      if (raf) cancelAnimationFrame(raf);
      card.style.transform = '';
    });
  });
}

// Scroll progress bar en haut de la page
function initScrollProgress() {
  if (document.getElementById('scroll-progress')) return;
  const bar = document.createElement('div');
  bar.id = 'scroll-progress';
  bar.className = 'scroll-progress';
  document.body.appendChild(bar);
  const update = () => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    const pct = h > 0 ? (window.scrollY / h) * 100 : 0;
    bar.style.width = pct.toFixed(2) + '%';
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  update();
}

// Anime les sparklines quand ils entrent dans le viewport
let _sparkObserver = null;
function initSparklineReveal() {
  if (_sparkObserver) _sparkObserver.disconnect();
  if (!('IntersectionObserver' in window)) return;
  const paths = document.querySelectorAll('.kpi-tile-spark svg .spark-line, .kpi-tile-spark svg .spark-area');
  if (!paths.length) return;
  paths.forEach(p => {
    try {
      const len = p.getTotalLength ? p.getTotalLength() : 300;
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = len;
      p.style.transition = 'stroke-dashoffset 1.6s cubic-bezier(0.22, 1, 0.36, 1)';
    } catch {}
  });
  _sparkObserver = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        en.target.querySelectorAll('svg .spark-line, svg .spark-area').forEach(p => {
          p.style.strokeDashoffset = 0;
        });
        _sparkObserver.unobserve(en.target);
      }
    });
  }, { threshold: 0.3 });
  document.querySelectorAll('.kpi-tile-spark').forEach(el => _sparkObserver.observe(el));
}

// Hero parallax : orbs bougent légèrement selon la souris
function initHeroParallax() {
  const hero = document.querySelector('.hero--v4');
  if (!hero) return;
  const orbs = hero.querySelectorAll('.orb');
  const mark = hero.querySelector('.hero-v4-mark');
  let raf = null;
  hero.addEventListener('mousemove', (e) => {
    const rect = hero.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      orbs.forEach((orb, i) => {
        const factor = (i + 1) * 15;
        orb.style.transform = `translate(${x * factor}px, ${y * factor}px)`;
      });
      if (mark) mark.style.transform = `translate(${x * -20}px, ${y * -20}px) rotate(${x * 4}deg)`;
    });
  });
}

// Scroll-triggered counters : relance l'animation quand le hero réapparaît
let _scrollCounterObserver = null;
function observeScrollTriggeredCounters() {
  if (_scrollCounterObserver) _scrollCounterObserver.disconnect();
  if (!('IntersectionObserver' in window)) return;
  const cards = document.querySelectorAll('.kpi-tile-value, .stats .stat-card .stat-value');
  if (!cards.length) return;
  _scrollCounterObserver = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        const el = en.target;
        const target = parseInt(el.dataset.countTarget || '0');
        const money = el.dataset.countMoney === '1';
        el.textContent = '0';
        animateCounter(el, target, { formatter: money ? formatMoney : v => Math.round(v).toString() });
      }
    });
  }, { threshold: 0.5 });
  cards.forEach(c => _scrollCounterObserver.observe(c));
}

// ================================================================
// SPARKLINES — Mini-courbes SVG dérivées de l'historique
// ================================================================
function computeYearlySeries() {
  const buckets = {};
  state.entreprises.forEach(e => {
    const y = getCompanyYear(e) || e.annee_creation;
    if (!y || y < 2000 || y > 2100) return;
    if (!buckets[y]) buckets[y] = { entreprises: 0, promotions: new Set(), fonds: 0, emplois: 0 };
    buckets[y].entreprises++;
    (e.promotions || []).forEach(p => buckets[y].promotions.add(p));
    buckets[y].fonds += (e.fonds_leves || 0);
    buckets[y].emplois += (e.emplois || 0);
  });
  const years = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  if (!years.length) return null;
  const minY = years[0], maxY = Math.max(years[years.length - 1], new Date().getFullYear());
  const series = { entreprises: [], promotions: [], fonds: [], emplois: [] };
  let cumE = 0, cumF = 0, cumEmp = 0;
  const promsSeen = new Set();
  for (let y = minY; y <= maxY; y++) {
    const b = buckets[y] || { entreprises: 0, promotions: new Set(), fonds: 0, emplois: 0 };
    cumE += b.entreprises;
    cumF += b.fonds;
    cumEmp += b.emplois;
    b.promotions.forEach(p => promsSeen.add(p));
    series.entreprises.push(cumE);
    series.promotions.push(promsSeen.size);
    series.fonds.push(cumF);
    series.emplois.push(cumEmp);
  }
  return series;
}

function sparklinePath(values, w = 100, h = 22) {
  if (!values || values.length < 2) return { line: '', area: '', dot: { x: 0, y: 0 } };
  const max = Math.max(...values), min = Math.min(...values);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - ((v - min) / range) * (h - 4) - 2]);
  const line = pts.map(([x, y], i) => (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
  const area = line + ` L${w.toFixed(1)},${h} L0,${h} Z`;
  const last = pts[pts.length - 1];
  return { line, area, dot: { x: last[0], y: last[1] } };
}

function renderHeroSparklines() {
  const series = computeYearlySeries();
  if (!series) return;
  const map = { entreprises: series.entreprises, promotions: series.promotions, fonds: series.fonds, emplois: series.emplois };
  document.querySelectorAll('.stat-sparkline, .kpi-tile-spark').forEach(el => {
    const key = el.dataset.spark;
    const data = map[key];
    if (!data) return;
    const rect = el.getBoundingClientRect();
    const w = Math.max(60, rect.width || 200);
    const h = Math.max(22, rect.height || 42);
    const { line, area, dot } = sparklinePath(data, w, h);
    const isHero = el.closest('.kpi-tile--hero');
    const isGreen = el.closest('.kpi-tile--green');
    const stopColor = isHero ? '#FFFFFF' : (isGreen ? '#24F121' : '#0099FF');
    el.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="sparkG-${key}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${stopColor}" stop-opacity="${isHero ? 0.4 : 0.28}"/>
            <stop offset="100%" stop-color="${stopColor}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path class="spark-area" d="${area}" fill="url(#sparkG-${key})"/>
        <path class="spark-line" d="${line}"/>
        <circle class="spark-dot" cx="${dot.x.toFixed(1)}" cy="${dot.y.toFixed(1)}" r="${isHero ? 3.5 : 2.5}"/>
      </svg>
    `;
  });
}

const FILTER_ICONS = {
  'zap': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  'calendar': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  'layers': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  'activity': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  'map-pin': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
};

function renderFilterGroup(label, key, options, iconKey) {
  if (!options.length) return '';
  const counts = countByFilter(key, options);
  const iconHtml = iconKey ? `<span class="filter-icon">${FILTER_ICONS[iconKey] || ''}</span>` : '';
  return `
    <div class="filter-group">
      <div class="filter-label">${iconHtml}${label}</div>
      <div class="filter-chips">
        ${options.map(opt => `
          <span class="filter-chip ${filters[key].has(opt) ? 'active' : ''}" data-filter="${key}" data-value="${escapeHtml(opt)}">
            ${escapeHtml(opt.length > 22 ? opt.slice(0, 20) + '…' : opt)}
            <span class="chip-count">${counts[opt] || 0}</span>
          </span>
        `).join('')}
      </div>
    </div>
  `;
}

function renderActiveFiltersBar() {
  const active = [];
  ['programmes', 'promotions', 'thematiques', 'statuts', 'villes'].forEach(k => {
    filters[k].forEach(v => active.push({ key: k, val: v }));
  });
  if (!active.length) return '';
  return `
    <div class="active-filters-bar">
      ${active.map(f => `
        <span class="active-filter-pill" data-filter="${f.key}" data-value="${escapeHtml(f.val)}">
          ${escapeHtml(f.val.length > 18 ? f.val.slice(0, 16) + '…' : f.val)}
          <button data-remove-filter data-filter="${f.key}" data-value="${escapeHtml(f.val)}">×</button>
        </span>
      `).join('')}
    </div>
  `;
}

function toggleFilterChip(key, val) {
  if (filters[key].has(val)) filters[key].delete(val);
  else filters[key].add(val);
  renderHome();
}
window.toggleFilterChip = toggleFilterChip;

function countByFilter(key, options) {
  const counts = {};
  const singleFieldMap = { statuts: 'statut', villes: 'ville' };
  const singleField = singleFieldMap[key];
  for (const opt of options) {
    counts[opt] = state.entreprises.filter(e => {
      if (singleField) return e[singleField] === opt;
      return (e[key] || []).includes(opt);
    }).length;
  }
  return counts;
}

function cardBadge(e, allEntreprises) {
  // Retourne 1 badge max, priorité : star > raised > soon > dormant
  const topFonds = allEntreprises && allEntreprises.length
    ? Math.max(...allEntreprises.map(x => x.fonds_leves || 0))
    : 0;
  const year = e.annee_creation || 0;
  const currentYear = new Date().getFullYear();
  if (topFonds > 0 && e.fonds_leves === topFonds) {
    return `<span class="card-badge card-badge--star" title="Top fonds levés">Top levée</span>`;
  }
  if ((e.fonds_leves || 0) >= 1000000 && year >= currentYear - 3) {
    return `<span class="card-badge card-badge--raised" title="Levée récente">Levée récente</span>`;
  }
  if (e.statut === 'Active' && year >= currentYear - 1) {
    return `<span class="card-badge card-badge--soon" title="Récemment créée">Nouvelle</span>`;
  }
  if (e.statut === 'Éteinte') {
    return `<span class="card-badge card-badge--dormant" title="Start-up éteinte">Éteinte</span>`;
  }
  return '';
}

function cardHoverPreview(e) {
  const persons = e.personnes || [];
  if (!persons.length && !e.annee_creation && !(e.thematiques || []).length) return '';
  const avatars = persons.slice(0, 3).map(p =>
    `<span class="card-preview-avatar">${escapeHtml(personInitials(p))}</span>`
  ).join('');
  const rest = persons.length - 3;
  const restAv = rest > 0 ? `<span class="card-preview-avatar more">+${rest}</span>` : '';
  const meta = [
    e.annee_creation ? `Depuis <b>${e.annee_creation}</b>` : '',
    (e.thematiques || [])[0] ? `<b>${escapeHtml(e.thematiques[0])}</b>` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="card-preview">
      ${persons.length ? `<div class="card-preview-avatars">${avatars}${restAv}</div>` : ''}
      <div class="card-preview-meta">${meta || 'Voir la fiche →'}</div>
    </div>
  `;
}

function renderFeaturedCard(e) {
  return renderCard(e, state.entreprises);
}

function renderCard(e, allEntreprises) {
  const programme = (e.programmes || [])[0] || (e.promotions || [])[0] || '';
  const fonds = e.fonds_leves ? formatMoney(e.fonds_leves) : (e.fonds_confidentiel ? 'Confidentiel' : '');
  const logoHtml = e.logo_url
    ? `<div class="card-logo-mini"><img class="card-logo-img" src="${escapeHtml(e.logo_url)}" alt="" onerror="this.parentElement.remove()"></div>`
    : `<div class="card-logo-mini card-logo-mini--empty"><span>${escapeHtml(initials(e.nom))}</span></div>`;
  return `
    <div class="card editable" data-editable-type="entreprise" data-editable-id="${escapeHtml(e.id)}" style="view-transition-name:card-${escapeHtml(e.id)};" onclick="navigate('#/alumni/entreprise/${escapeHtml(e.id)}')">
      ${editPencil(`openEntrepriseInlineEditor('${escapeHtml(e.id)}')`)}
      <div class="card-mini-body">
        ${logoHtml}
        <h4 class="card-mini-name">${escapeHtml(e.nom)}</h4>
        <div class="card-mini-meta">
          ${programme ? `<span class="card-mini-prog">${escapeHtml(programme)}</span>` : ''}
          ${fonds ? `<span class="card-mini-fonds">${escapeHtml(fonds)}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderListItem(e) {
  const accent = themeAccentFor(e);
  const eid = escapeHtml(e.id);
  const logoHtml = e.logo_url
    ? `<img src="${escapeHtml(e.logo_url)}" alt="">`
    : '';
  const promo = (e.promotions || [])[0] || '';
  const prog = (e.programmes || [])[0] || '';
  const theme = (e.thematiques || [])[0] || '';
  const fonds = e.fonds_leves ? formatMoney(e.fonds_leves) : (e.fonds_confidentiel ? 'Confi.' : '—');
  const statutClass = 'list-statut-' + (e.statut || 'inconnu').toLowerCase().replace('é', 'e');
  return `
    <div class="list-row editable" data-editable-type="entreprise" data-editable-id="${eid}" style="--theme-accent:${accent.color};" onclick="navigate('#/alumni/entreprise/${eid}')">
      <div class="list-stripe"></div>
      <div class="list-logo">${logoHtml}</div>
      <div class="list-name">
        <div class="list-nom">${escapeHtml(e.nom)}</div>
        <div class="list-ville">${escapeHtml(e.ville || '—')}</div>
      </div>
      <div class="list-tag">${escapeHtml(theme)}</div>
      <div class="list-tag list-tag-alt">${escapeHtml(promo)}</div>
      <div class="list-tag list-tag-alt">${escapeHtml(prog)}</div>
      <div class="list-num">${e.annee_creation || '—'}</div>
      <div class="list-num">${e.emplois || 0}</div>
      <div class="list-num list-num-em">${fonds}</div>
      <div class="list-statut ${statutClass}">${escapeHtml(e.statut || '—')}</div>
      ${editPencil(`openEntrepriseInlineEditor('${eid}')`)}
    </div>
  `;
}

function renderImpactSection() {
  const m = state.meta || calculeMeta(state.entreprises);
  const totalEntr = m.total_entreprises;
  const totalEmplois = m.total_emplois;
  const totalFonds = m.total_fonds;
  const totalPromos = m.total_promotions;
  // Marquee entreprises pour bandeau du bas
  const entNames = state.entreprises.map(e => e.nom).filter(Boolean);
  const marqueeItem = (n) => `<span class="alumni-marquee-item">${escapeHtml(n)}</span><span class="alumni-marquee-sep" aria-hidden="true">✦</span>`;
  const marqueeLine = entNames.concat(entNames).concat(entNames).map(marqueeItem).join('');
  return `
    <section class="impact-section impact-section--xl">
      <div class="impact-inner">
        <div class="impact-eyebrow">
          <span class="impact-dot"></span>
          Impact cumulé de la promotion
        </div>
        <h3 class="impact-statement">
          <span class="impact-hl">${totalEntr}</span> entreprises accompagnées et documentées.
          <span class="impact-hl impact-hl--red">${totalEmplois}</span> emplois créés.
        </h3>
        <div class="impact-metrics">
          <div class="impact-metric"><b>${formatMoney(totalFonds)}</b><span>Fonds levés cumulés</span></div>
          <div class="impact-metric"><b>${totalPromos}</b><span>Promotions</span></div>
          <div class="impact-metric"><b>${new Date().getFullYear() - 2014}</b><span>Années d'existence</span></div>
          <div class="impact-metric"><b>${state.programmes.length}</b><span>Programmes d'accompagnement</span></div>
        </div>
      </div>
    </section>
    <div class="alumni-marquee" aria-label="Toutes les start-ups accompagnées">
      <div class="alumni-marquee-label">
        <span class="alumni-marquee-dot"></span>
        ${getOfficialCount()} entreprises documentées depuis 2014
      </div>
      <div class="alumni-marquee-track">
        <div class="alumni-marquee-line">${marqueeLine}</div>
      </div>
    </div>
  `;
}

function renderEmptyState(context = 'filters') {
  const messages = {
    filters: {
      title: 'Aucune correspondance',
      msg: 'Les filtres actifs ne renvoient aucune start-up. Retire une contrainte pour élargir la recherche.',
      cta: `<button class="empty-action" onclick="resetFilters()">Réinitialiser les filtres</button>`,
    },
    empty: {
      title: 'Portfolio vide',
      msg: 'Aucune start-up n\'a encore été ajoutée. Passe en mode édition pour créer la première fiche.',
      cta: '',
    },
  };
  const m = messages[context] || messages.filters;
  return `
    <div class="empty-state">
      <div class="empty-state-illu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          <line x1="8" y1="11" x2="14" y2="11"/>
        </svg>
      </div>
      <h4>${m.title}</h4>
      <p>${m.msg}</p>
      ${m.cta}
    </div>
  `;
}

function filterEntreprises() {
  const s = filters.search.toLowerCase().trim();
  const currentYear = new Date().getFullYear();
  let filtered = state.entreprises.filter(e => {
    if (s && !(e.nom || '').toLowerCase().includes(s) && !(e.description_courte || '').toLowerCase().includes(s)) return false;
    if (filters.promotions.size && !(e.promotions || []).some(p => filters.promotions.has(p))) return false;
    if (filters.programmes.size && !(e.programmes || []).some(p => filters.programmes.has(p))) return false;
    if (filters.thematiques.size && !(e.thematiques || []).some(t => filters.thematiques.has(t))) return false;
    if (filters.statuts.size && !filters.statuts.has(e.statut)) return false;
    if (filters.villes.size && !filters.villes.has(e.ville)) return false;
    // Tab statut portfolio
    if (portfolioState.tab === 'active' && statutEffectif(e) !== 'Active') return false;
    if (portfolioState.tab === 'raised' && !((e.fonds_leves || 0) >= 1000000)) return false;
    if (portfolioState.tab === 'eteinte' && statutEffectif(e) !== 'Éteinte') return false;
    return true;
  });
  // Tri
  if (portfolioState.sort === 'name') filtered.sort((a, b) => (a.nom || '').localeCompare(b.nom || ''));
  else if (portfolioState.sort === 'year_desc') filtered.sort((a, b) => (b.annee_creation || 0) - (a.annee_creation || 0));
  else if (portfolioState.sort === 'fonds_desc') filtered.sort((a, b) => (b.fonds_leves || 0) - (a.fonds_leves || 0));
  else if (portfolioState.sort === 'emplois_desc') filtered.sort((a, b) => (b.emplois || 0) - (a.emplois || 0));
  return filtered;
}

/**
 * Le statut qui fait foi.
 *
 * Le champ `statut` vient d'un import jamais recoupé : 8 sociétés y sont
 * « Active » alors que le registre national les déclare cessées. Quand le
 * registre a répondu, c'est lui qui décide — sinon la fiche affichait
 * « Cessée » tout en étant comptée dans l'onglet « Actives ».
 */
function statutEffectif(e) {
  // La correction ne va que dans un sens, et c'est délibéré.
  //
  // Une date de cessation au registre est un fait : elle dément « Active ».
  // L'inverse est faux — une société peut rester immatriculée des années après
  // avoir cessé toute activité. Le registre ne prouve donc jamais qu'une
  // entreprise vit encore, et ne peut pas contredire l'équipe qui la sait
  // éteinte. On ne se sert du registre que pour retirer une affirmation,
  // jamais pour en ajouter une.
  if (e.statut_registre === 'Cessée') return 'Éteinte';
  return e.statut || 'Inconnu';
}

function tabCounts() {
  const currentYear = new Date().getFullYear();
  const counts = { all: 0, active: 0, raised: 0, eteinte: 0 };
  const s = filters.search.toLowerCase().trim();
  state.entreprises.forEach(e => {
    if (s && !(e.nom || '').toLowerCase().includes(s) && !(e.description_courte || '').toLowerCase().includes(s)) return;
    if (filters.promotions.size && !(e.promotions || []).some(p => filters.promotions.has(p))) return;
    if (filters.programmes.size && !(e.programmes || []).some(p => filters.programmes.has(p))) return;
    if (filters.thematiques.size && !(e.thematiques || []).some(t => filters.thematiques.has(t))) return;
    if (filters.villes.size && !filters.villes.has(e.ville)) return;
    counts.all++;
    if (statutEffectif(e) === 'Active') counts.active++;
    if ((e.fonds_leves || 0) >= 1000000) counts.raised++;
    if (statutEffectif(e) === 'Éteinte') counts.eteinte++;
  });
  return counts;
}

function setPortfolioTab(t) { portfolioState.tab = t; renderHome(); }
function setPortfolioSort(s) { portfolioState.sort = s; renderHome(); }
function setPortfolioView(v) { portfolioState.view = v; renderHome(); }
window.setPortfolioTab = setPortfolioTab;
window.setPortfolioSort = setPortfolioSort;
window.setPortfolioView = setPortfolioView;

function bindFilterEvents() {
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.filter;
      const val = chip.dataset.value;
      if (filters[key].has(val)) filters[key].delete(val);
      else filters[key].add(val);
      renderHome();
    });
  });
  document.querySelectorAll('[data-remove-filter]').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const key = btn.dataset.filter;
      const val = btn.dataset.value;
      filters[key].delete(val);
      renderHome();
    });
  });
}

function resetFilters() {
  filters = { search: filters.search, promotions: new Set(), programmes: new Set(), thematiques: new Set(), statuts: new Set(), villes: new Set() };
  renderHome();
}

// ----- DETAIL -----

function renderDetail(id) {
  const e = state.entreprises.find(x => x.id === id);
  if (!e) {
    document.getElementById('app').innerHTML = `<div class="detail-page"><div class="empty-state"><h4>Entreprise introuvable</h4><p><a href="#/alumni">Retour au portfolio</a></p></div></div>`;
    return;
  }
  const eid = escapeHtml(e.id);
  const openInline = `openEntrepriseInlineEditor('${eid}')`;
  const accent = themeAccentFor(e);
  const statutLabel = statutEffectif(e);
  const emplois = e.emplois || 0;
  const fondsAff = e.fonds_confidentiel ? 'Confidentiel' : (e.fonds_leves ? formatMoney(e.fonds_leves) : '—');
  document.getElementById('app').innerHTML = `
    <div class="detail-page detail-page--v2" style="--theme-accent:${accent.color};">
      <div class="detail-sticky-bar" id="detail-sticky-bar">
        <div class="detail-sticky-inner">
          <a class="back-link" href="#/alumni">←</a>
          <div class="detail-sticky-logo">
            ${e.logo_url ? `<img src="${escapeHtml(e.logo_url)}" alt="">` : `<span>${escapeHtml(initials(e.nom))}</span>`}
          </div>
          <div class="detail-sticky-name">${escapeHtml(e.nom)}</div>
          <div class="detail-sticky-actions">
            ${e.site_web ? `<a class="sticky-action" href="${escapeHtml(e.site_web)}" target="_blank" rel="noreferrer">Site ↗</a>` : ''}
            ${e.linkedin ? `<a class="sticky-action" href="${escapeHtml(e.linkedin)}" target="_blank" rel="noreferrer">LinkedIn ↗</a>` : ''}
          </div>
        </div>
      </div>

      <a class="back-link back-link-header" href="#/alumni">← Retour au portfolio</a>

      <div class="detail-hero editable" data-editable-type="entreprise-header" data-editable-id="${eid}">
        ${editPencil(openInline)}
        <div class="detail-hero-bg"></div>
        <div class="detail-hero-inner">
          <div class="detail-eyebrow">
            <span class="detail-eyebrow-dot" style="background:${accent.color};"></span>
            ${escapeHtml(accent.label || 'Alumni Accélérateur M')}
            <span class="hero-sep"></span>
            <span>${escapeHtml(statutLabel)}</span>
          </div>
          <div class="detail-hero-logo">
            ${e.logo_url
              ? `<img src="${escapeHtml(e.logo_url)}" alt="${escapeHtml(e.nom)}" onerror="this.outerHTML='<span class=&quot;detail-hero-fb&quot;>${escapeHtml(initials(e.nom))}</span>'">`
              : `<span class="detail-hero-fb">${escapeHtml(initials(e.nom))}</span>`}
          </div>
          <h1 class="detail-hero-title kinetic-title">${escapeHtml(e.nom)}</h1>
          <div class="detail-hero-tagline">${escapeHtml(e.description_courte || e.ville || 'Start-up accompagnée par l\'Accélérateur M')}</div>
          <div class="detail-hero-chips">
            ${e.ville ? `<span class="detail-chip">📍 ${escapeHtml(e.ville)}${e.code_postal ? ' · ' + escapeHtml(e.code_postal) : ''}</span>` : ''}
            ${e.annee_creation ? `<span class="detail-chip">Depuis ${e.annee_creation}</span>` : ''}
            ${(e.promotions || []).map(p => `<span class="detail-chip detail-chip-alt">${escapeHtml(p)}</span>`).join('')}
            ${(e.programmes || []).map(p => `<span class="detail-chip detail-chip-alt">${escapeHtml(p)}</span>`).join('')}
          </div>
          <div class="detail-hero-metrics">
            <div class="detail-hero-metric">
              <b>${emplois}</b>
              <span>Emplois créés</span>
            </div>
            <div class="detail-hero-metric">
              <b>${fondsAff}</b>
              <span>Fonds levés</span>
            </div>
            <div class="detail-hero-metric">
              <b>${(e.thematiques || []).length}</b>
              <span>Thématique${(e.thematiques || []).length > 1 ? 's' : ''}</span>
            </div>
            <div class="detail-hero-metric">
              <b>${(e.personnes || []).length}</b>
              <span>Cofondateur${(e.personnes || []).length > 1 ? 's' : ''}</span>
            </div>
          </div>
          <div class="detail-hero-actions">
            ${e.site_web ? `<a class="btn-primary detail-cta" href="${escapeHtml(e.site_web)}" target="_blank" rel="noreferrer">Visiter le site ↗</a>` : ''}
            ${e.linkedin ? `<a class="btn-secondary detail-cta" href="${escapeHtml(e.linkedin)}" target="_blank" rel="noreferrer">LinkedIn</a>` : ''}
          </div>
        </div>
      </div>
      <div class="detail-body">
        <div>
          <div class="detail-section editable" data-editable-type="entreprise-about" data-editable-id="${eid}">
            ${editPencil(openInline)}
            <h3>À propos</h3>
            ${(e.description_longue || e.description_courte)
              ? `<p>${escapeHtml(e.description_longue || e.description_courte)}</p>${renderSourceLine(e)}`
              : `<p class="detail-nodata">Cette entreprise n'a pas encore de description rédigée. Les éléments ci-contre — promotion, programme, thématique, implantation — proviennent du fichier de suivi de l'accélérateur.</p>`}
          </div>
          ${renderRecitSection(e)}
          ${(e.programmes || []).length ? `
            <div class="detail-section editable" style="margin-top:20px;" data-editable-type="entreprise-parcours" data-editable-id="${eid}">
              ${editPencil(openInline)}
              <h3>Parcours à l'Accélérateur M</h3>
              <div class="detail-programs-timeline">
                ${e.programmes.map((p, i) => `
                  ${i > 0 ? '<span class="detail-program-arrow">→</span>' : ''}
                  <span class="detail-program-node">${escapeHtml(p)}</span>
                `).join('')}
              </div>
              ${(e.promotions || []).length ? `<p style="margin-top:12px;font-size:13px;color:var(--text-muted);">Via ${e.promotions.map(escapeHtml).join(', ')}</p>` : ''}
            </div>
          ` : ''}
          <div class="detail-section editable" style="margin-top:20px;" data-editable-type="entreprise-team" data-editable-id="${eid}">
            ${editPencil(openInline)}
            <h3>Équipe fondatrice (${e.personnes?.length || 0})</h3>
            ${(e.personnes || []).length ? e.personnes.map(p => `
              <div class="person-item person-item-rich">
                <div class="person-avatar">${escapeHtml(personInitials(p))}</div>
                <div class="person-info">
                  <h5>${escapeHtml(p.prenom || '')} ${escapeHtml(p.nom || '')}</h5>
                  <small>${escapeHtml(p.role || 'Cofondateur')}</small>
                  <div class="person-contacts">
                    ${p.email && window.PRIVE_MODE ? `<a href="mailto:${escapeHtml(p.email)}" class="person-contact">${iconSvg('speech', 12)} ${escapeHtml(p.email)}</a>` : ''}
                    ${p.telephone && window.PRIVE_MODE ? `<a href="tel:${escapeHtml(p.telephone.replace(/\s/g,''))}" class="person-contact">${iconSvg('pin', 12)} ${escapeHtml(p.telephone)}</a>` : ''}
                    ${p.linkedin ? `<a href="${escapeHtml(p.linkedin)}" target="_blank" rel="noreferrer" class="person-contact">${iconSvg('arrow', 12)} LinkedIn</a>` : ''}
                  </div>
                </div>
              </div>
            `).join('') : '<p style="color:var(--text-muted);font-size:13px;">Aucun cofondateur renseigné.</p>'}
          </div>
        </div>
        <div>
          <div class="detail-section editable" data-editable-type="entreprise-stats" data-editable-id="${eid}">
            ${editPencil(openInline)}
            <h3>Chiffres clés</h3>
            <div class="kv-list">
              <div class="kv-item"><span class="key">Emplois créés</span><span class="val">${e.emplois || '—'}</span></div>
              <div class="kv-item"><span class="key">Fonds levés</span><span class="val">${e.fonds_confidentiel ? 'Confidentiel' : (e.fonds_leves ? formatMoney(e.fonds_leves) : '—')}</span></div>
              <div class="kv-item"><span class="key">Statut</span><span class="val">${escapeHtml(statutEffectif(e))}${e.statut_registre ? '' : ' <small>(déclaratif)</small>'}</span></div>
              ${e.annee_creation ? `<div class="kv-item"><span class="key">Créée en</span><span class="val">${e.annee_creation}</span></div>` : ''}
              ${e.nationalite ? `<div class="kv-item"><span class="key">Nationalité</span><span class="val">${escapeHtml(e.nationalite)}</span></div>` : ''}
            </div>
          </div>

          ${renderContactsLinks(e, eid, openInline)}
          ${renderIdentiteJuridique(e, eid, openInline)}
          ${renderCroissanceSection(e, eid, openInline)}
          ${renderPresseSection(e)}
          ${renderSimilarStartupsSection(e)}
          ${(e.thematiques || []).length ? `
            <div class="detail-section editable" style="margin-top:20px;" data-editable-type="entreprise-themes" data-editable-id="${eid}">
              ${editPencil(openInline)}
              <h3>Thématiques</h3>
              <div class="tags" style="display:flex;flex-wrap:wrap;gap:6px;">
                ${e.thematiques.map(t => `<span class="tag tag-them">${escapeHtml(t)}</span>`).join('')}
              </div>
            </div>` : ''}
          ${(e.site_web || e.linkedin) ? `
            <div class="detail-section editable" style="margin-top:20px;" data-editable-type="entreprise-links" data-editable-id="${eid}">
              ${editPencil(openInline)}
              <h3>Liens</h3>
              ${e.site_web ? `<p><a href="${escapeHtml(e.site_web)}" target="_blank">Site web ↗</a></p>` : ''}
              ${e.linkedin ? `<p style="margin-top:6px;"><a href="${escapeHtml(e.linkedin)}" target="_blank">LinkedIn ↗</a></p>` : ''}
            </div>` : ''}
        </div>
      </div>
    </div>
  `;
  bindDetailStickyBar();
}

// ================================================================
// FICHE ENTREPRISE — Sections Identité juridique + Croissance
// ================================================================

// ================================================================
// PROVENANCE — d'où vient chaque texte affiché sur une fiche.
// Rien n'est affirmé sans que sa source soit lisible à l'écran.
// ================================================================

function formatDateCourte(iso) {
  if (!iso) return '';
  const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
                'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const d = new Date(iso);
  if (isNaN(d)) return escapeHtml(iso);
  return `${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()}`;
}

function renderSourceLine(e) {
  if (!e.description_source) {
    if (e.description_origine === 'registre') {
      return `<p class="detail-source">
        Activité déclarée au <a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${escapeHtml(e.siret || '')}" target="_blank" rel="noreferrer">registre national des entreprises</a>,
        consulté le ${formatDateCourte(e.registre_date)}. Il s'agit de l'objet social immatriculé, pas d'une description commerciale.
      </p>`;
    }
    if (e.description_origine === 'suivi') {
      return `<p class="detail-source">
        Éléments tirés du fichier de suivi de l'Accélérateur M. Cette entreprise
        n'a pas été retrouvée au registre français : elle est étrangère, ou immatriculée
        sous une autre raison sociale.
      </p>`;
    }
    // Texte saisi en interne : on le dit plutôt que de laisser croire
    // qu'il a été recoupé avec l'entreprise.
    if (e.description_longue || e.description_courte) {
      return `<p class="detail-source">Description issue du fichier de suivi de l'Accélérateur M.</p>`;
    }
    return '';
  }
  const url = e.description_source.startsWith('http')
    ? e.description_source
    : 'https://' + e.description_source;
  return `
    <p class="detail-source">
      D'après le site de l'entreprise —
      <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(e.description_source)}</a>,
      relevé le ${formatDateCourte(e.description_source_date)}.
      ${e.description_source_note ? `<br><span class="detail-source-note">${escapeHtml(e.description_source_note)}</span>` : ''}
    </p>`;
}

function renderRecitSection(e) {
  if (!e.recit) return '';
  const paragraphes = String(e.recit)
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p)}</p>`)
    .join('');
  return `
    <div class="detail-section detail-recit" style="margin-top:20px;">
      <h3>Le parcours</h3>
      ${paragraphes}
      <p class="detail-source">
        Rédigé à partir de la fiche de suivi de l'accélérateur et du contenu publié
        par l'entreprise sur son site. Aucun fait n'est ajouté à ces deux sources.
      </p>
    </div>`;
}

function renderPresseSection(e) {
  const arts = Array.isArray(e.presse) ? e.presse : [];
  if (!arts.length) return '';
  return `
    <div class="detail-section detail-presse" style="margin-top:20px;">
      <h3>Ils en parlent</h3>
      <div class="presse-list">
        ${arts.map(a => `
          <a class="presse-item" href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">
            <span class="presse-titre">${escapeHtml(a.titre)}</span>
            <span class="presse-meta">${escapeHtml(a.source || 'Source non précisée')}${a.date ? ' · ' + formatDateCourte(a.date) : ''}</span>
          </a>
        `).join('')}
      </div>
      <p class="detail-source">
        Articles relevés automatiquement via Google Actualités le 26 août 2026.
        Chaque titre renvoie à l'article d'origine.
      </p>
    </div>`;
}

function renderContactsLinks(e, eid, openInline) {
  const rows = [];
  if (e.site_web) rows.push({ k: 'Site web', v: e.site_web, href: e.site_web, ext: true });
  if (e.linkedin) rows.push({ k: 'LinkedIn', v: e.linkedin.replace(/^https?:\/\/(www\.)?/, ''), href: e.linkedin, ext: true });
  if (e.email) rows.push({ k: 'Email', v: e.email, href: 'mailto:' + e.email });
  if (e.telephone) rows.push({ k: 'Téléphone', v: e.telephone, href: 'tel:' + e.telephone.replace(/\s/g,'') });
  if (e.adresse) rows.push({ k: 'Adresse', v: [e.adresse, e.code_postal, e.ville].filter(Boolean).join(', ') });
  if (e.nationalite || e.pays) rows.push({ k: 'Pays', v: e.pays || e.nationalite });
  if (e.forme_juridique) rows.push({ k: 'Forme', v: e.forme_juridique });
  if (e.siret) rows.push({ k: 'SIRET', v: e.siret });
  if (e.annee_creation) rows.push({ k: 'Année création', v: String(e.annee_creation) });
  if (e.date_creation) rows.push({ k: 'Date création', v: formatDateFr(e.date_creation) });
  if (e.statut) rows.push({ k: 'Statut', v: e.statut });
  if ((e.promotions || []).length) rows.push({ k: 'Promotion(s)', v: e.promotions.join(', ') });
  if ((e.programmes || []).length) rows.push({ k: 'Programme(s)', v: e.programmes.join(', ') });
  if ((e.thematiques || []).length) rows.push({ k: 'Thématique(s)', v: e.thematiques.join(', ') });
  if (typeof e.emplois === 'number') rows.push({ k: 'Emplois', v: String(e.emplois) });
  if (e.fonds_leves) rows.push({ k: 'Fonds levés', v: formatMoney(e.fonds_leves) });
  if (rows.length === 0) return '';
  return `
    <div class="detail-section editable detail-contacts" style="margin-top:20px;" data-editable-type="entreprise-contacts" data-editable-id="${eid}">
      ${editPencil(openInline)}
      <h3>Fiche complète</h3>
      <div class="contacts-list">
        ${rows.map(r => `
          <div class="contact-row">
            <span class="contact-key">${escapeHtml(r.k)}</span>
            ${r.href
              ? `<a class="contact-val" href="${escapeHtml(r.href)}" ${r.ext ? 'target="_blank" rel="noreferrer"' : ''}>${escapeHtml(r.v)}${r.ext ? ' ↗' : ''}</a>`
              : `<span class="contact-val">${escapeHtml(r.v)}</span>`}
          </div>
        `).join('')}
      </div>
    </div>`;
}

function renderIdentiteJuridique(e, eid, openInline) {
  const forme = e.forme_juridique || '';
  // La date n'est affichée que si date_creation est réellement renseignée
  const dateC = e.date_creation || '';
  const adresseParts = [
    e.adresse,
    e.code_postal && e.ville ? `${e.code_postal} ${e.ville}` : '',
    e.pays,
  ].filter(Boolean);
  const siret = e.siret || '';
  const rows = [];
  if (forme) rows.push(['Forme juridique', escapeHtml(forme)]);
  if (dateC) rows.push(['Date de création', formatDateFr(dateC)]);
  if (adresseParts.length) rows.push(['Adresse', adresseParts.map(escapeHtml).join('<br>')]);
  if (siret) rows.push(['SIRET', escapeHtml(siret)]);
  if (e.statut_registre) {
    const cesse = e.statut_registre === 'Cessée';
    rows.push(['État au registre',
      `<span class="etat-registre ${cesse ? 'is-cesse' : 'is-actif'}">${escapeHtml(e.statut_registre)}</span>` +
      (cesse && e.date_fermeture ? ` <span class="etat-registre-date">depuis le ${formatDateFr(e.date_fermeture)}</span>` : '')]);
  }
  if (!rows.length) return '';
  return `
    <div class="detail-section detail-identite" style="margin-top:20px;">
      <h3>Identité juridique</h3>
      <div class="kv-list">
        ${rows.map(([k, v]) => `<div class="kv-item"><span class="key">${k}</span><span class="val">${v}</span></div>`).join('')}
      </div>
      ${e.registre_date ? `<p class="detail-source">Registre national des entreprises (INSEE), consulté le ${formatDateCourte(e.registre_date)}.</p>` : ''}
    </div>
  `;
}

function formatDateFr(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return escapeHtml(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Retourne la série de croissance UNIQUEMENT si des données réelles existent
function buildGrowthSeries(e) {
  if (!Array.isArray(e.historique) || e.historique.length < 2) return null;
  return e.historique
    .map(h => ({
      year: parseInt(h.annee || h.year),
      emplois: parseInt(h.emplois || 0),
      fonds: parseInt(h.fonds || h.fonds_leves || 0),
    }))
    .filter(h => h.year && !isNaN(h.year))
    .sort((a, b) => a.year - b.year);
}

function renderCroissanceSection(e, eid, openInline) {
  const series = buildGrowthSeries(e);
  if (!series || series.length < 2) {
    return '';
  }

  const accent = e.logo_url ? 'var(--card-accent, var(--brand-primary))' : themeAccentFor(e).color;

  // KPIs calculés
  const first = series[0];
  const last = series[series.length - 1];
  const years = last.year - first.year || 1;
  const cagrEmplois = last.emplois && first.emplois > 0
    ? Math.round((Math.pow(last.emplois / Math.max(1, first.emplois), 1 / years) - 1) * 100)
    : (last.emplois > 0 ? '+∞' : '—');
  const deltaEmplois = last.emplois - first.emplois;

  return `
    <div class="detail-section editable detail-growth" style="margin-top:20px;" data-editable-type="entreprise-growth" data-editable-id="${eid}" data-e="${eid}" style="--growth-accent:${accent};">
      ${editPencil(openInline)}
      <h3>Croissance</h3>
      <div class="growth-kpis">
        <div class="growth-kpi">
          <span class="growth-kpi-label">Δ emplois</span>
          <b class="growth-kpi-val">${deltaEmplois >= 0 ? '+' : ''}${deltaEmplois}</b>
          <span class="growth-kpi-hint">sur ${years} an${years > 1 ? 's' : ''}</span>
        </div>
        <div class="growth-kpi">
          <span class="growth-kpi-label">CAGR emplois</span>
          <b class="growth-kpi-val">${typeof cagrEmplois === 'number' ? (cagrEmplois >= 0 ? '+' : '') + cagrEmplois + '%' : cagrEmplois}</b>
          <span class="growth-kpi-hint">annuel moyen</span>
        </div>
        <div class="growth-kpi">
          <span class="growth-kpi-label">Fonds cumulés</span>
          <b class="growth-kpi-val">${last.fonds ? formatMoney(last.fonds) : '—'}</b>
          <span class="growth-kpi-hint">${first.year} → ${last.year}</span>
        </div>
      </div>
      <div class="growth-chart" data-growth-chart="${escapeHtml(e.id)}">
        ${growthChartSvg(series, accent)}
      </div>
      <div class="growth-legend">
        <span class="growth-legend-item"><span class="growth-legend-dot" style="background:${accent};"></span>Emplois</span>
        <span class="growth-legend-item"><span class="growth-legend-dot growth-legend-dot--outline" style="border-color:${accent};"></span>Fonds levés</span>
      </div>
    </div>
  `;
}

function growthChartSvg(series, accent) {
  const w = 480, h = 180, pad = { top: 20, right: 20, bottom: 32, left: 44 };
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;
  const maxE = Math.max(1, ...series.map(s => s.emplois));
  const maxF = Math.max(1, ...series.map(s => s.fonds));
  const stepX = innerW / (series.length - 1 || 1);

  const ptE = series.map((s, i) => [pad.left + i * stepX, pad.top + innerH - (s.emplois / maxE) * innerH]);
  const ptF = series.map((s, i) => [pad.left + i * stepX, pad.top + innerH - (s.fonds / maxF) * innerH]);

  const pathE = ptE.map(([x, y], i) => (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
  const areaE = pathE + ` L${(pad.left + innerW).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${pad.left.toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;
  const pathF = ptF.map(([x, y], i) => (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1)).join(' ');

  const gridLines = [0.25, 0.5, 0.75].map(r => {
    const y = pad.top + innerH * r;
    return `<line x1="${pad.left}" y1="${y}" x2="${pad.left + innerW}" y2="${y}" stroke="currentColor" stroke-opacity="0.06" stroke-dasharray="3 4"/>`;
  }).join('');

  const xTicks = series.map((s, i) => {
    const x = pad.left + i * stepX;
    return `<text x="${x}" y="${h - 12}" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.55" font-family="Inter, sans-serif" font-weight="600">${s.year}</text>`;
  }).join('');

  const dots = ptE.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="${accent}"/>`).join('') +
               ptF.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="#FFFFFF" stroke="${accent}" stroke-width="1.5"/>`).join('');

  return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="color:var(--brand-deep);">
      <defs>
        <linearGradient id="growthGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${accent}" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path d="${areaE}" fill="url(#growthGrad)"/>
      <path d="${pathE}" fill="none" stroke="${accent}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${pathF}" fill="none" stroke="${accent}" stroke-width="1.8" stroke-dasharray="4 4" stroke-linecap="round"/>
      ${dots}
      ${xTicks}
    </svg>
  `;
}

function bindDetailStickyBar() {
  const bar = document.getElementById('detail-sticky-bar');
  if (!bar) return;
  const onScroll = () => {
    if (window.scrollY > 400) bar.classList.add('is-visible');
    else bar.classList.remove('is-visible');
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

// ----- ADMIN -----

let adminTab = 'entreprises';

function renderAdmin() {
  document.getElementById('app').innerHTML = `
    <div class="admin-page">
      <div class="admin-header">
        <h2>Espace administration</h2>
        ${adminTab === 'chiffres' ? '' : '<button class="btn-primary" onclick="openNewModal()">+ Nouvelle entrée</button>'}
      </div>
      <div class="admin-tabs">
        <button class="admin-tab ${adminTab==='entreprises'?'active':''}" onclick="setAdminTab('entreprises')">Entreprises (${state.entreprises.length})</button>
        <button class="admin-tab ${adminTab==='promotions'?'active':''}" onclick="setAdminTab('promotions')">Promotions (${state.promotions.length})</button>
        <button class="admin-tab ${adminTab==='programmes'?'active':''}" onclick="setAdminTab('programmes')">Programmes (${state.programmes.length})</button>
        <button class="admin-tab ${adminTab==='thematiques'?'active':''}" onclick="setAdminTab('thematiques')">Thématiques (${state.thematiques.length})</button>
        <button class="admin-tab ${adminTab==='chiffres'?'active':''}" onclick="setAdminTab('chiffres')">Chiffres clés</button>
      </div>
      ${renderAdminTable()}
    </div>
  `;
}

function setAdminTab(t) { adminTab = t; renderAdmin(); }

function renderAdminTable() {
  if (adminTab === 'chiffres') return renderChiffresCles();
  if (adminTab === 'entreprises') {
    return `
      <table class="admin-table">
        <thead><tr><th>Entreprise</th><th>Ville</th><th>Promotion</th><th>Programme</th><th>Statut</th><th>Actions</th></tr></thead>
        <tbody>
          ${state.entreprises.map(e => `
            <tr>
              <td><strong>${escapeHtml(e.nom)}</strong></td>
              <td>${escapeHtml(e.ville || '—')}</td>
              <td>${escapeHtml((e.promotions || []).join(', ') || '—')}</td>
              <td>${escapeHtml((e.programmes || []).join(', ') || '—')}</td>
              <td>${escapeHtml(e.statut || 'Inconnu')}</td>
              <td class="actions">
                <button class="btn-edit" onclick="openEntrepriseModal('${escapeHtml(e.id)}')">Modifier</button>
                <button class="btn-danger" onclick="deleteEntreprise('${escapeHtml(e.id)}')">Supprimer</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
  const items = state[adminTab] || [];
  return `
    <table class="admin-table">
      <thead><tr><th>Nom</th><th>Nb entreprises</th><th>Actions</th></tr></thead>
      <tbody>
        ${items.map(item => {
          const count = state.entreprises.filter(e => (e[adminTab] || []).includes(item)).length;
          return `
            <tr>
              <td><strong>${escapeHtml(item)}</strong></td>
              <td>${count}</td>
              <td class="actions">
                <button class="btn-edit" onclick="renameReferential('${adminTab}', '${escapeHtml(item)}')">Renommer</button>
                <button class="btn-danger" onclick="deleteReferential('${adminTab}', '${escapeHtml(item)}')">Supprimer</button>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
    <p style="margin-top:12px;font-size:12px;color:#6b7280;">
      Les ${adminTab} se créent automatiquement quand tu les ajoutes à une entreprise.
      Renommer met à jour toutes les fiches concernées.
    </p>
  `;
}

// ----- MODAL ENTREPRISE -----

let currentEditId = null;

function openNewModal() {
  if (adminTab !== 'entreprises') {
    const val = prompt(`Nouveau nom (${adminTab}) :`);
    if (val && val.trim()) {
      state[adminTab] = [...new Set([...state[adminTab], val.trim()])].sort();
      saveData();
      renderAdmin();
      showToast(`Ajouté : ${val.trim()}`, 'success');
    }
    return;
  }
  currentEditId = null;
  openEntrepriseModal(null);
}

function openEntrepriseModal(id) {
  currentEditId = id;
  const e = id ? state.entreprises.find(x => x.id === id) : {
    nom: '', personnes: [], promotions: [], programmes: [], thematiques: [],
    ville: '', code_postal: '', statut: 'Active', emplois: 0, fonds_leves: 0,
    fonds_confidentiel: false, description_courte: '', description_longue: '',
    site_web: '', linkedin: '', annee_creation: null, nationalite: ''
  };

  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${id ? 'Modifier' : 'Nouvelle'} entreprise</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="form-row">
        <label>Nom de l'entreprise *</label>
        <input type="text" id="f-nom" value="${escapeHtml(e.nom || '')}" required>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Ville</label>
          <input type="text" id="f-ville" value="${escapeHtml(e.ville || '')}">
        </div>
        <div>
          <label>Code postal</label>
          <input type="text" id="f-cp" value="${escapeHtml(e.code_postal || '')}">
        </div>
      </div>
      <div class="form-row">
        <label>Description courte (une ligne, pour les cards)</label>
        <input type="text" id="f-desc-courte" value="${escapeHtml(e.description_courte || '')}" maxlength="140">
      </div>
      <div class="form-row">
        <label>Description longue (paragraphe, pour la fiche)</label>
        <textarea id="f-desc-longue">${escapeHtml(e.description_longue || '')}</textarea>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Statut</label>
          <select id="f-statut">
            <option ${e.statut==='Active'?'selected':''}>Active</option>
            <option ${e.statut==='Éteinte'?'selected':''}>Éteinte</option>
            <option ${e.statut==='Rachetée'?'selected':''}>Rachetée</option>
            <option ${e.statut==='Pivotée'?'selected':''}>Pivotée</option>
            <option ${e.statut==='Inconnu'?'selected':''}>Inconnu</option>
          </select>
        </div>
        <div>
          <label>Année de création</label>
          <input type="number" id="f-annee" value="${e.annee_creation || ''}" min="1990" max="2035">
        </div>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Emplois créés</label>
          <input type="number" id="f-emplois" value="${e.emplois || 0}" min="0">
        </div>
        <div>
          <label>Fonds levés (€)</label>
          <input type="number" id="f-fonds" value="${e.fonds_leves || 0}" min="0">
        </div>
      </div>
      <div class="form-row">
        <label><input type="checkbox" id="f-conf" ${e.fonds_confidentiel?'checked':''} style="width:auto;margin-right:6px;"> Montant des fonds confidentiel</label>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Site web</label>
          <input type="url" id="f-web" value="${escapeHtml(e.site_web || '')}" placeholder="https://...">
        </div>
        <div>
          <label>LinkedIn</label>
          <input type="url" id="f-linkedin" value="${escapeHtml(e.linkedin || '')}" placeholder="https://linkedin.com/company/...">
        </div>
      </div>

      <div class="subsection-title">Rattachements</div>
      <div class="form-row">
        <label>Promotions (Entrée pour valider)</label>
        <div class="tag-input" id="ti-promotions">${renderTagPills(e.promotions, 'promotions')}<input type="text" placeholder="Ex: MPU#26" onkeydown="handleTagInput(event, 'promotions')"></div>
      </div>
      <div class="form-row">
        <label>Programmes</label>
        <div class="tag-input" id="ti-programmes">${renderTagPills(e.programmes, 'programmes')}<input type="text" placeholder="Ex: M'Scale Up" onkeydown="handleTagInput(event, 'programmes')"></div>
      </div>
      <div class="form-row">
        <label>Thématiques</label>
        <div class="tag-input" id="ti-thematiques">${renderTagPills(e.thematiques, 'thematiques')}<input type="text" placeholder="Ex: Économie bleue" onkeydown="handleTagInput(event, 'thematiques')"></div>
      </div>

      <div class="subsection-title">
        Cofondateurs
        <button class="btn-secondary" style="float:right;padding:4px 10px;font-size:12px;" onclick="addPersonEditor()">+ Ajouter</button>
      </div>
      <div id="persons-editor">
        ${(e.personnes || []).map((p, i) => renderPersonEditor(p, i)).join('')}
      </div>

      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Annuler</button>
        <button class="btn-primary" onclick="saveEntreprise()">${id ? 'Enregistrer les modifications' : 'Créer l\'entreprise'}</button>
      </div>
    </div>
  `;
  overlay.classList.add('active');
}

function renderTagPills(tags, kind) {
  return (tags || []).map(t => `<span class="tag-pill">${escapeHtml(t)}<button type="button" onclick="removeTag('${kind}', '${escapeHtml(t)}')">×</button></span>`).join('');
}

let modalTags = { promotions: [], programmes: [], thematiques: [] };

function handleTagInput(event, kind) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const val = event.target.value.trim();
  if (!val) return;
  if (!modalTags[kind].includes(val)) modalTags[kind].push(val);
  event.target.value = '';
  refreshTagInput(kind);
}

function removeTag(kind, val) {
  modalTags[kind] = modalTags[kind].filter(t => t !== val);
  refreshTagInput(kind);
}

function refreshTagInput(kind) {
  const container = document.getElementById('ti-' + kind);
  if (!container) return;
  const input = container.querySelector('input');
  container.innerHTML = renderTagPills(modalTags[kind], kind);
  container.appendChild(input);
  input.focus();
}

function renderPersonEditor(p, i) {
  return `
    <div class="person-editor" data-idx="${i}">
      <div class="form-row"><label>Prénom</label><input type="text" class="pf-prenom" value="${escapeHtml(p.prenom || '')}"></div>
      <div class="form-row"><label>Nom</label><input type="text" class="pf-nom" value="${escapeHtml(p.nom || '')}"></div>
      <div class="form-row"><label>Email</label><input type="email" class="pf-email" value="${escapeHtml(p.email || '')}"></div>
      <button class="btn-remove" onclick="this.parentElement.remove()">×</button>
    </div>
  `;
}

function addPersonEditor() {
  const container = document.getElementById('persons-editor');
  const idx = container.children.length;
  container.insertAdjacentHTML('beforeend', renderPersonEditor({}, idx));
}

function saveEntreprise() {
  const nom = document.getElementById('f-nom').value.trim();
  if (!nom) { showToast('Le nom est obligatoire', 'error'); return; }

  const personnes = [...document.querySelectorAll('.person-editor')].map(row => ({
    prenom: row.querySelector('.pf-prenom').value.trim(),
    nom: row.querySelector('.pf-nom').value.trim(),
    email: row.querySelector('.pf-email').value.trim(),
    role: 'Cofondateur'
  })).filter(p => p.prenom || p.nom);

  const data = {
    nom,
    ville: document.getElementById('f-ville').value.trim(),
    code_postal: document.getElementById('f-cp').value.trim(),
    description_courte: document.getElementById('f-desc-courte').value.trim(),
    description_longue: document.getElementById('f-desc-longue').value.trim(),
    statut: document.getElementById('f-statut').value,
    annee_creation: parseInt(document.getElementById('f-annee').value) || null,
    emplois: parseInt(document.getElementById('f-emplois').value) || 0,
    fonds_leves: parseInt(document.getElementById('f-fonds').value) || 0,
    fonds_confidentiel: document.getElementById('f-conf').checked,
    site_web: document.getElementById('f-web').value.trim(),
    linkedin: document.getElementById('f-linkedin').value.trim(),
    promotions: [...modalTags.promotions],
    programmes: [...modalTags.programmes],
    thematiques: [...modalTags.thematiques],
    personnes
  };

  if (currentEditId) {
    const idx = state.entreprises.findIndex(x => x.id === currentEditId);
    state.entreprises[idx] = { ...state.entreprises[idx], ...data };
  } else {
    data.id = slugify(nom);
    let base = data.id, n = 2;
    while (state.entreprises.some(x => x.id === data.id)) { data.id = base + '-' + n; n++; }
    state.entreprises.unshift(data);
  }

  refreshReferentials();
  saveData();
  closeModal();
  showToast(currentEditId ? 'Fiche mise à jour' : 'Entreprise créée', 'success');
  router();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
  modalTags = { promotions: [], programmes: [], thematiques: [] };
}

function deleteEntreprise(id) {
  const e = state.entreprises.find(x => x.id === id);
  if (!e) return;
  if (!confirm(`Supprimer définitivement "${e.nom}" ?`)) return;
  state.entreprises = state.entreprises.filter(x => x.id !== id);
  refreshReferentials();
  saveData();
  renderAdmin();
  showToast('Entreprise supprimée', 'success');
}

function renameReferential(kind, oldVal) {
  const newVal = prompt(`Renommer "${oldVal}" :`, oldVal);
  if (!newVal || newVal === oldVal) return;
  state.entreprises.forEach(e => {
    if (e[kind]) e[kind] = e[kind].map(v => v === oldVal ? newVal.trim() : v);
  });
  refreshReferentials();
  saveData();
  renderAdmin();
  showToast(`Renommé : ${oldVal} → ${newVal.trim()}`, 'success');
}

function deleteReferential(kind, val) {
  if (!confirm(`Retirer "${val}" de toutes les fiches ?`)) return;
  state.entreprises.forEach(e => {
    if (e[kind]) e[kind] = e[kind].filter(v => v !== val);
  });
  refreshReferentials();
  saveData();
  renderAdmin();
  showToast(`Retiré de toutes les fiches : ${val}`, 'success');
}

// ----- UTILS -----

function slugify(str) {
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function ensureToastStack() {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  return stack;
}

function showToast(msg, type = 'info', opts = {}) {
  const stack = ensureToastStack();
  const item = document.createElement('div');
  item.className = 'toast-item toast-item--' + (type || 'info');
  item.innerHTML = `
    <div class="toast-item-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</div>
    <div class="toast-item-body">${escapeHtml(msg)}</div>
    <button class="toast-item-close" aria-label="Fermer">×</button>
    <div class="toast-item-progress"></div>
  `;
  const remove = () => {
    if (item.classList.contains('leaving')) return;
    item.classList.add('leaving');
    setTimeout(() => item.remove(), 300);
  };
  item.querySelector('.toast-item-close').addEventListener('click', remove);
  stack.appendChild(item);
  // Limite : garde les 4 plus récents
  while (stack.children.length > 4) stack.firstChild.remove();
  setTimeout(remove, opts.duration || 4000);
}

// ================================================================
// COMMAND PALETTE ⌘K
// ================================================================
let cmdkOpen = false;
let cmdkActiveIndex = 0;
let cmdkResults = [];

function ensureCmdkOverlay() {
  let overlay = document.getElementById('cmdk-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cmdk-overlay';
    overlay.className = 'cmdk-overlay';
    overlay.innerHTML = `
      <div class="cmdk-panel" onclick="event.stopPropagation()">
        <div class="cmdk-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="cmdk-input" placeholder="Rechercher une start-up, un fondateur, une promotion, une thématique…" autocomplete="off">
          <kbd>Esc</kbd>
        </div>
        <div class="cmdk-results" id="cmdk-results"></div>
        <div class="cmdk-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span>
          <span><kbd>Enter</kbd> ouvrir</span>
          <span><kbd>Esc</kbd> fermer</span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) closeCmdk(); });
    const input = overlay.querySelector('#cmdk-input');
    input.addEventListener('input', () => renderCmdkResults(input.value));
    input.addEventListener('keydown', handleCmdkKey);
  }
  return overlay;
}

function openCmdk() {
  if (cmdkOpen) return;
  const overlay = ensureCmdkOverlay();
  cmdkOpen = true;
  cmdkActiveIndex = 0;
  overlay.classList.add('active');
  const input = overlay.querySelector('#cmdk-input');
  input.value = '';
  renderCmdkResults('');
  setTimeout(() => input.focus(), 30);
}

function closeCmdk() {
  const overlay = document.getElementById('cmdk-overlay');
  if (!overlay) return;
  overlay.classList.remove('active');
  cmdkOpen = false;
}

function collectCmdkItems() {
  const items = [];
  // Actions rapides
  const actions = [
    { title: 'Basculer thème clair / sombre', run: () => toggleTheme(), icon: '◐' },
    { title: 'Mode présentation (touche P)', run: () => togglePresentMode(), icon: '🖥' },
    { title: 'Réinitialiser tous les filtres', run: () => resetFilters(), icon: '⟲' },
    { title: 'Voir la vue liste', run: () => setPortfolioView('list'), icon: '☰' },
    { title: 'Voir la vue grid', run: () => setPortfolioView('grid'), icon: '▦' },
    { title: 'Trier par fonds levés ↓', run: () => setPortfolioSort('fonds_desc'), icon: '↓' },
    { title: 'Trier par plus récentes', run: () => setPortfolioSort('year_desc'), icon: '↓' },
  ];
  actions.forEach(a => items.push({
    type: 'action', tag: 'Action', title: a.title, icon: a.icon,
    action: a.run, search: a.title.toLowerCase(),
  }));
  // Entreprises
  state.entreprises.forEach(e => {
    items.push({
      type: 'entreprise', tag: 'Start-up',
      title: e.nom, sub: [e.ville, (e.promotions || [])[0], (e.programmes || [])[0]].filter(Boolean).join(' · '),
      logo: e.logo_url || '', icon: initials(e.nom),
      hash: `#/alumni/entreprise/${e.id}`,
      entrepriseObj: e,
      search: [e.nom, e.ville, e.description_courte, (e.promotions || []).join(' '), (e.programmes || []).join(' '), (e.thematiques || []).join(' ')].join(' ').toLowerCase(),
    });
  });
  // Promotions
  state.promotions.forEach(p => items.push({
    type: 'promotion', tag: 'Promotion',
    title: p, sub: `${state.entreprises.filter(e => (e.promotions || []).includes(p)).length} start-ups`,
    icon: '📅', hash: `#/alumni`, filter: { key: 'promotions', val: p },
    search: p.toLowerCase(),
  }));
  // Thématiques
  state.thematiques.forEach(t => items.push({
    type: 'thematique', tag: 'Thématique',
    title: t, sub: `${state.entreprises.filter(e => (e.thematiques || []).includes(t)).length} start-ups`,
    icon: '⬢', hash: `#/alumni`, filter: { key: 'thematiques', val: t },
    search: t.toLowerCase(),
  }));
  // Pages
  const pages = [
    { title: 'Portfolio', hash: '#/alumni', icon: '▦' },
    { title: 'Timeline', hash: '#/alumni/timeline', icon: '▤' },
    { title: 'Carte', hash: '#/alumni/carte', icon: '◎' },
    { title: 'Statistiques', hash: '#/alumni/stats', icon: '☰' },
  ];
  pages.forEach(p => items.push({ ...p, type: 'page', tag: 'Page', search: p.title.toLowerCase() }));
  return items;
}

function renderCmdkResults(query) {
  const q = query.toLowerCase().trim();
  const all = collectCmdkItems();
  cmdkResults = q
    ? all.map(it => ({ ...it, __score: fuzzyScore(q, it.search) + (it.type === 'entreprise' && it.entrepriseObj ? fuzzyMatchEntreprise(q, it.entrepriseObj) * 0.5 : 0) }))
        .filter(it => it.__score > 20)
        .sort((a, b) => b.__score - a.__score)
        .slice(0, 40)
    : all.filter(it => it.type === 'page').concat(all.filter(it => it.type === 'entreprise').slice(0, 6));
  cmdkActiveIndex = 0;
  const container = document.getElementById('cmdk-results');
  if (!container) return;
  if (!cmdkResults.length) {
    container.innerHTML = `<div class="cmdk-empty">Aucun résultat pour "<b>${escapeHtml(query)}</b>"</div>`;
    return;
  }
  const groups = {};
  cmdkResults.forEach((r, i) => {
    (groups[r.tag] = groups[r.tag] || []).push({ ...r, index: i });
  });
  container.innerHTML = Object.entries(groups).map(([tag, list]) => `
    <div class="cmdk-group">
      <div class="cmdk-group-title">${escapeHtml(tag)}</div>
      ${list.map(it => `
        <div class="cmdk-item ${it.index === 0 ? 'active' : ''}" data-index="${it.index}">
          <div class="cmdk-item-icon">${it.logo ? `<img src="${escapeHtml(it.logo)}" alt="">` : escapeHtml(it.icon || '·')}</div>
          <div class="cmdk-item-body">
            <div class="cmdk-item-title">${escapeHtml(it.title)}</div>
            ${it.sub ? `<div class="cmdk-item-sub">${escapeHtml(it.sub)}</div>` : ''}
          </div>
          <span class="cmdk-item-tag">${escapeHtml(it.tag)}</span>
        </div>
      `).join('')}
    </div>
  `).join('');
  container.querySelectorAll('.cmdk-item').forEach(el => {
    el.addEventListener('mouseenter', () => setCmdkActive(parseInt(el.dataset.index)));
    el.addEventListener('click', () => triggerCmdkItem(cmdkResults[parseInt(el.dataset.index)]));
  });
}

function setCmdkActive(index) {
  cmdkActiveIndex = Math.max(0, Math.min(index, cmdkResults.length - 1));
  document.querySelectorAll('.cmdk-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.index) === cmdkActiveIndex);
  });
  const active = document.querySelector('.cmdk-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function triggerCmdkItem(item) {
  if (!item) return;
  closeCmdk();
  if (item.action) {
    try { item.action(); } catch (e) { console.warn(e); }
    return;
  }
  if (item.filter) {
    if (!filters[item.filter.key]) filters[item.filter.key] = new Set();
    filters[item.filter.key].add(item.filter.val);
  }
  if (location.hash === item.hash) router(); else location.hash = item.hash;
}

function handleCmdkKey(ev) {
  if (ev.key === 'ArrowDown') { ev.preventDefault(); setCmdkActive(cmdkActiveIndex + 1); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); setCmdkActive(cmdkActiveIndex - 1); }
  else if (ev.key === 'Enter') { ev.preventDefault(); triggerCmdkItem(cmdkResults[cmdkActiveIndex]); }
  else if (ev.key === 'Escape') { ev.preventDefault(); closeCmdk(); }
}

function attachCmdkGlobal() {
  document.addEventListener('keydown', ev => {
    const isCmdK = (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k';
    if (isCmdK) { ev.preventDefault(); cmdkOpen ? closeCmdk() : openCmdk(); }
    else if (ev.key === '/' && document.activeElement === document.body && !cmdkOpen) {
      ev.preventDefault(); openCmdk();
    }
  });
  // Hint bar
  const hint = document.createElement('button');
  hint.className = 'cmdk-hint';
  hint.innerHTML = `<kbd>⌘</kbd><kbd>K</kbd> Rechercher partout`;
  hint.onclick = openCmdk;
  document.body.appendChild(hint);
}

window.openCmdk = openCmdk;
window.closeCmdk = closeCmdk;

// ================================================================
// DIAGNOSTIC — Inspecte le localStorage pour vérifier les logos/descs
// ================================================================
function openDiagnostic() {
  const raw = localStorage.getItem(STORAGE_KEY);
  const rawSize = raw ? (raw.length / 1024).toFixed(1) + ' Ko' : 'vide';

  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (e) {}
  const list = (parsed && parsed.entreprises) || state.entreprises || [];

  const withLogo = list.filter(e => e.logo_url && e.logo_url.length > 50);
  const withDescLongue = list.filter(e => e.description_longue && e.description_longue.trim().length > 20);
  const withDescCourte = list.filter(e => e.description_courte && e.description_courte.trim().length > 5);

  const topLogos = withLogo.slice(0, 8);
  const topDescs = withDescLongue.slice(0, 5);

  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="modal modal-compact" style="max-width:720px;">
      <div class="modal-header">
        <div>
          <h3>🔍 Diagnostic des données</h3>
          <p class="modal-sub">Ce qui est actuellement stocké dans ton navigateur (localStorage)</p>
        </div>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>

      <div class="diag-summary">
        <div class="diag-stat"><b>${list.length}</b><span>Entreprises en base</span></div>
        <div class="diag-stat ${withLogo.length ? 'diag-ok' : 'diag-ko'}"><b>${withLogo.length}</b><span>Avec logo importé</span></div>
        <div class="diag-stat ${withDescLongue.length ? 'diag-ok' : 'diag-ko'}"><b>${withDescLongue.length}</b><span>Avec description longue</span></div>
        <div class="diag-stat"><b>${withDescCourte.length}</b><span>Avec description courte</span></div>
        <div class="diag-stat"><b>${rawSize}</b><span>Taille du store</span></div>
      </div>

      ${withLogo.length ? `
        <div class="diag-block">
          <h4>Logos détectés (${withLogo.length}) — aperçu des ${topLogos.length} premiers</h4>
          <div class="diag-logos">
            ${topLogos.map(e => `
              <div class="diag-logo-item" title="${escapeHtml(e.nom)}">
                <div class="diag-logo-img"><img src="${escapeHtml(e.logo_url)}" alt=""></div>
                <span>${escapeHtml(e.nom)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : `
        <div class="diag-block diag-block-warn">
          <h4>⚠️ Aucun logo trouvé dans le localStorage</h4>
          <p>Soit tu n'as pas encore importé de logo, soit le store a été vidé. Les logos importés via le mode édition sont normalement sauvegardés automatiquement dans ton navigateur.</p>
        </div>
      `}

      ${withDescLongue.length ? `
        <div class="diag-block">
          <h4>Descriptions longues (${withDescLongue.length}) — aperçu</h4>
          <ul class="diag-desc-list">
            ${topDescs.map(e => `
              <li>
                <b>${escapeHtml(e.nom)}</b>
                <span>${escapeHtml(e.description_longue.slice(0, 120))}${e.description_longue.length > 120 ? '…' : ''}</span>
              </li>
            `).join('')}
          </ul>
        </div>
      ` : `
        <div class="diag-block diag-block-warn">
          <h4>⚠️ Aucune description longue détaillée trouvée</h4>
          <p>Aucune entreprise n'a de description longue de plus de 20 caractères.</p>
        </div>
      `}

      ${(function () {
        const backups = listBackups();
        if (!backups.length) return `
          <div class="diag-block">
            <h4>Snapshots rolling</h4>
            <p style="font-size:12px;color:var(--text-muted);">Aucun snapshot local pour l'instant. À partir de maintenant, chaque sauvegarde en crée un automatiquement (${MAX_LOCAL_BACKUPS} snapshots max, rotation).</p>
          </div>
        `;
        return `
          <div class="diag-block">
            <h4>Snapshots rolling disponibles (${backups.length})</h4>
            <div class="diag-backups">
              ${backups.reverse().map(b => `
                <div class="diag-backup-row">
                  <div>
                    <b>${escapeHtml(b.date)}</b>
                    <span>${(b.size / 1024).toFixed(1)} Ko</span>
                  </div>
                  <button class="btn-secondary" onclick="restoreBackup('${escapeHtml(b.date)}')">Restaurer</button>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      })()}

      <div class="diag-actions">
        <button class="btn-secondary" onclick="exportDiagnostic()">📥 Exporter tout en JSON</button>
        <button class="btn-primary" onclick="closeModal()">Fermer</button>
      </div>
    </div>
  `;
  overlay.classList.add('active');
  overlay.onclick = ev => { if (ev.target === overlay) closeModal(); };
}

// ================================================================
// IMPORT BULK LOGOS — Sélection multiple, fuzzy match nom→entreprise
// ================================================================

const COMPANY_SUFFIXES = ['sasu', 'sas', 'sarl', 'sa', 'ltd', 'inc', 'pty', 'llc', 'gmbh', 'io', 'app', 'com', 'fr', 'eu', 'group', 'groupe', 'company', 'lab', 'labs', 'studio', 'digital', 'talents'];

function normalizeName(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // enlève les accents
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(str) {
  return normalizeName(str).split(' ').filter(t => t && !COMPANY_SUFFIXES.includes(t));
}

function similarityScore(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  const setA = new Set(ta), setB = new Set(tb);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const jaccard = inter / (setA.size + setB.size - inter);
  const na = normalizeName(a), nb = normalizeName(b);
  const contains = na.includes(nb) || nb.includes(na) ? 0.15 : 0;
  return jaccard + contains;
}

function bestMatchEntreprise(candidateName) {
  let best = null, bestScore = 0, runnerUp = 0;
  state.entreprises.forEach(e => {
    const score = similarityScore(candidateName, e.nom);
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = e;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  });
  const confidence = bestScore >= 0.6 ? 'sure' : (bestScore >= 0.35 ? 'maybe' : 'weak');
  return { entreprise: best, score: bestScore, confidence, delta: bestScore - runnerUp };
}

function parseFilenameToName(filename) {
  let base = filename.replace(/\.[^.]+$/, '');   // enlève .jpeg / .png / etc
  base = base.replace(/[-_]?logo[-_]?/i, ' ');    // enlève "_logo" / "logo_"
  return normalizeName(base);
}

let _bulkImportRows = [];

function openBulkLogoImport() {
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="modal modal-compact bulk-import-modal" style="max-width:780px;">
      <div class="modal-header">
        <div>
          <h3>Importer plusieurs logos en une fois</h3>
          <p class="modal-sub">Sélectionne tous les fichiers de ton dossier logos. L'app matche automatiquement chaque fichier à la bonne entreprise et compresse les images.</p>
        </div>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="bulk-import-drop" id="bulk-import-drop">
        <input type="file" id="bulk-logo-input" accept="image/*" multiple style="display:none;" onchange="handleBulkLogoFiles(this.files)">
        <div class="bulk-import-drop-inner">
          <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <h4>Glisse-dépose ou sélectionne tes logos</h4>
          <p>Nommage attendu : <code>entreprise_logo.jpeg</code> (ex: <code>iadys_logo.jpeg</code>). Multiple sélection OK.</p>
          <button class="btn-primary" onclick="document.getElementById('bulk-logo-input').click()">
            Sélectionner les fichiers
          </button>
        </div>
      </div>
      <div id="bulk-import-results" class="bulk-import-results"></div>
    </div>
  `;
  overlay.classList.add('active');
  overlay.onclick = ev => { if (ev.target === overlay) closeModal(); };

  // Drag-and-drop
  const drop = document.getElementById('bulk-import-drop');
  ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files.length) handleBulkLogoFiles(e.dataTransfer.files); });
}

async function handleBulkLogoFiles(files) {
  const arr = [...files].filter(f => f.type.startsWith('image/'));
  if (!arr.length) { showToast('Aucune image sélectionnée', 'error'); return; }
  showToast(`Analyse de ${arr.length} fichier${arr.length > 1 ? 's' : ''}…`, 'info');

  _bulkImportRows = arr.map((file, i) => {
    // Ignore le logo de l'accélérateur lui-même
    if (/accelerateurm|acc[eé]l[eé]rateur_m/i.test(file.name)) {
      return { file, status: 'skip', reason: 'Logo Accélérateur M ignoré', entreprise: null };
    }
    const candidate = parseFilenameToName(file.name);
    if (!candidate) return { file, status: 'skip', reason: 'Nom non parsable', entreprise: null };
    const { entreprise, score, confidence } = bestMatchEntreprise(candidate);
    return { file, candidate, entreprise, score, confidence, status: entreprise ? 'match' : 'no-match' };
  });

  renderBulkImportResults();
}

function renderBulkImportResults() {
  const container = document.getElementById('bulk-import-results');
  if (!container) return;
  const rows = _bulkImportRows;
  const matched = rows.filter(r => r.status === 'match' && r.confidence !== 'weak').length;
  const uncertain = rows.filter(r => r.confidence === 'maybe' || r.confidence === 'weak').length;
  const noMatch = rows.filter(r => r.status === 'no-match').length;
  const skipped = rows.filter(r => r.status === 'skip').length;

  container.innerHTML = `
    <div class="bulk-import-summary">
      <div class="bulk-stat bulk-stat-ok"><b>${matched}</b><span>Match sûr</span></div>
      <div class="bulk-stat bulk-stat-warn"><b>${uncertain}</b><span>À vérifier</span></div>
      <div class="bulk-stat bulk-stat-ko"><b>${noMatch}</b><span>Aucun match</span></div>
      <div class="bulk-stat"><b>${skipped}</b><span>Ignoré</span></div>
    </div>
    <div class="bulk-import-list">
      ${rows.map((r, idx) => renderBulkImportRow(r, idx)).join('')}
    </div>
    <div class="bulk-import-actions">
      <button class="btn-secondary" onclick="closeModal()">Annuler</button>
      <button class="btn-primary" onclick="applyBulkLogoImport()">
        Importer les logos matchés (${rows.filter(r => r.entreprise && r.status !== 'skip').length})
      </button>
    </div>
  `;
}

function renderBulkImportRow(r, idx) {
  const cls = r.status === 'skip' ? 'skip' : (r.confidence === 'sure' ? 'sure' : (r.confidence === 'maybe' ? 'maybe' : (r.entreprise ? 'weak' : 'no-match')));
  const options = state.entreprises.map(e => `<option value="${escapeHtml(e.id)}" ${r.entreprise && r.entreprise.id === e.id ? 'selected' : ''}>${escapeHtml(e.nom)}</option>`).join('');
  return `
    <div class="bulk-row bulk-row--${cls}">
      <div class="bulk-row-file">
        <span class="bulk-row-name">${escapeHtml(r.file.name)}</span>
        <span class="bulk-row-hint">${(r.file.size / 1024).toFixed(0)} Ko${r.candidate ? ' → « ' + escapeHtml(r.candidate) + ' »' : ''}</span>
      </div>
      <div class="bulk-row-arrow">→</div>
      ${r.status === 'skip'
        ? `<div class="bulk-row-target"><span class="bulk-row-skip">${escapeHtml(r.reason)}</span></div>`
        : `<div class="bulk-row-target">
            <select onchange="setBulkRowEntreprise(${idx}, this.value)">
              <option value="">— Aucune —</option>
              ${options}
            </select>
            ${r.confidence === 'sure' ? '<span class="bulk-conf-badge bulk-conf-sure">Sûr</span>' : ''}
            ${r.confidence === 'maybe' ? '<span class="bulk-conf-badge bulk-conf-maybe">À vérifier</span>' : ''}
            ${r.confidence === 'weak' && r.entreprise ? '<span class="bulk-conf-badge bulk-conf-weak">Douteux</span>' : ''}
            ${!r.entreprise ? '<span class="bulk-conf-badge bulk-conf-none">Aucun match</span>' : ''}
          </div>`}
    </div>
  `;
}

function setBulkRowEntreprise(idx, entrepriseId) {
  const r = _bulkImportRows[idx];
  if (!r) return;
  if (!entrepriseId) { r.entreprise = null; r.status = 'no-match'; r.confidence = 'weak'; }
  else {
    r.entreprise = state.entreprises.find(e => e.id === entrepriseId);
    r.status = 'match';
    r.confidence = 'sure';
  }
  renderBulkImportResults();
}
window.setBulkRowEntreprise = setBulkRowEntreprise;

async function applyBulkLogoImport() {
  const rows = _bulkImportRows.filter(r => r.entreprise && r.status !== 'skip');
  if (!rows.length) { showToast('Rien à importer', 'error'); return; }
  showToast(`Import de ${rows.length} logos… (compression en cours)`, 'info', { duration: 3000 });

  let success = 0, failed = 0;
  for (const r of rows) {
    try {
      const compressed = await compressImageFile(r.file, 400, 0.85);
      r.entreprise.logo_url = compressed.dataUrl;
      success++;
    } catch (e) {
      console.warn('Compression échouée pour', r.file.name, e);
      failed++;
    }
  }

  const save = saveData();
  if (!save.ok) { showToast('Sauvegarde locale échouée', 'error', { duration: 10000 }); return; }

  // Push chaque entreprise modifiée à l'API (fire-and-forget)
  if (API_AVAILABLE) {
    Promise.all(rows.map(r => apiPutEntreprise(r.entreprise).catch(() => {}))).then(() => {
      console.log(`[api] ${rows.length} entreprises push vers backend`);
    });
  }

  showToast(`✅ ${success} logo${success > 1 ? 's' : ''} importé${success > 1 ? 's' : ''}${failed ? `, ${failed} échec${failed > 1 ? 's' : ''}` : ''}`, 'success', { duration: 6000 });
  closeModal();
  router();
}

window.openBulkLogoImport = openBulkLogoImport;
window.handleBulkLogoFiles = handleBulkLogoFiles;
window.applyBulkLogoImport = applyBulkLogoImport;

// ================================================================
// IMPORT BACKUP JSON — Restaure depuis un fichier de sauvegarde
// ================================================================
function openImportBackup() {
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="modal modal-compact" style="max-width:520px;">
      <div class="modal-header">
        <div>
          <h3>Restaurer un backup JSON</h3>
          <p class="modal-sub">Sélectionne un fichier <code>m-alumni-*.json</code> exporté précédemment. Les logos et descriptions seront fusionnés avec l'état actuel.</p>
        </div>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="bulk-import-drop">
        <input type="file" id="backup-file-input" accept=".json,application/json" style="display:none;" onchange="handleBackupImport(this.files[0])">
        <div class="bulk-import-drop-inner">
          <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
          <h4>Choisis ton fichier de backup</h4>
          <p>Un fichier <code>.json</code> commençant par <code>m-alumni-</code></p>
          <button class="btn-primary" onclick="document.getElementById('backup-file-input').click()">Sélectionner le fichier</button>
        </div>
      </div>
      <div id="backup-import-report"></div>
    </div>
  `;
  overlay.classList.add('active');
  overlay.onclick = ev => { if (ev.target === overlay) closeModal(); };
}

async function handleBackupImport(file) {
  if (!file) return;
  const report = document.getElementById('backup-import-report');
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.entreprises || !Array.isArray(data.entreprises)) throw new Error('Format invalide');

    // Merge : on prend les données du backup si elles sont meilleures
    const byName = {};
    const byId = {};
    data.entreprises.forEach(e => {
      byName[(e.nom || '').toLowerCase().trim()] = e;
      if (e.id) byId[e.id] = e;
    });
    const FIELDS = ['logo_url', 'description_longue', 'description_courte', 'site_web', 'linkedin', 'fonds_leves', 'emplois', 'annee_creation', 'statut'];
    let restored = 0, logosR = 0, descsR = 0;
    state.entreprises.forEach(e => {
      const b = byId[e.id] || byName[(e.nom || '').toLowerCase().trim()];
      if (!b) return;
      let any = false;
      FIELDS.forEach(f => {
        const bv = b[f];
        if (bv === undefined || bv === null || bv === '' || bv === 0) return;
        const cur = e[f];
        if (!cur || (typeof cur === 'string' && typeof bv === 'string' && bv.length > cur.length)) {
          e[f] = bv; any = true;
          if (f === 'logo_url') logosR++;
          if (f === 'description_longue') descsR++;
        }
      });
      if (any) restored++;
    });

    saveData();
    report.innerHTML = `
      <div class="diag-block" style="background:rgba(46,165,95,0.08);border-color:rgba(46,165,95,0.35);margin-top:14px;">
        <h4>✅ Restauration effectuée</h4>
        <p style="font-size:12.5px;">
          Fichier : <b>${escapeHtml(file.name)}</b> · ${data.entreprises.length} entreprises dans le backup<br>
          Fusionnées : <b>${restored}</b> · Logos restaurés : <b>${logosR}</b> · Descriptions restaurées : <b>${descsR}</b>
        </p>
        <button class="btn-primary" onclick="closeModal(); router();" style="margin-top:10px;">Voir le portfolio</button>
      </div>
    `;
    showToast(`Backup restauré : ${logosR} logos + ${descsR} descriptions`, 'success');
  } catch (err) {
    report.innerHTML = `<div class="diag-block diag-block-warn"><h4>❌ Erreur</h4><p>${escapeHtml(err.message || String(err))}</p></div>`;
  }
}

function forceReloadFromSeed() {
  if (!confirm('Recharger toutes les données depuis le fichier seed sur disque ? Tes modifications non exportées seront perdues (les logos/descriptions du seed seront restaurés).')) return;
  if (!window.SEED_DATA) { showToast('Seed indisponible', 'error'); return; }
  state = JSON.parse(JSON.stringify(window.SEED_DATA));
  saveData();
  showToast('Rechargé depuis le seed', 'success');
  router();
}

window.openImportBackup = openImportBackup;
window.handleBackupImport = handleBackupImport;
window.forceReloadFromSeed = forceReloadFromSeed;

function exportDiagnostic() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `m-alumni-backup-${new Date().toISOString().replace(/:/g, '-').slice(0, 19)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup complet exporté', 'success');
}

window.openDiagnostic = openDiagnostic;
window.exportDiagnostic = exportDiagnostic;

// ================================================================
// DARK MODE
// ================================================================
function initTheme() {
  const saved = localStorage.getItem('m-historique-theme') || 'light';
  document.body.setAttribute('data-theme', saved);
}
function toggleTheme() {
  const cur = document.body.getAttribute('data-theme') || 'light';
  const next = cur === 'light' ? 'dark' : 'light';
  document.body.setAttribute('data-theme', next);
  localStorage.setItem('m-historique-theme', next);
  showToast(next === 'dark' ? 'Mode sombre activé' : 'Mode clair activé', 'info');
}
window.toggleTheme = toggleTheme;

// ================================================================
// COMPTEURS ANIMÉS
// ================================================================
function animateCounter(el, target, opts = {}) {
  if (!el) return;
  const duration = opts.duration || 1500;
  const formatter = opts.formatter || (v => Math.round(v).toString());
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const elapsed = now - start;
    const t = Math.min(1, elapsed / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = from + (target - from) * eased;
    el.textContent = formatter(val);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = formatter(target);
  }
  requestAnimationFrame(tick);
}

function animateHeroStats() {
  // Prise en charge du nouveau bento (kpi-tile-value) et de l'ancien layout (stat-value)
  document.querySelectorAll('.kpi-tile-value[data-count-target], .stats .stat-card .stat-value[data-count-target]').forEach(el => {
    const target = parseInt(el.dataset.countTarget || '0');
    const money = el.dataset.countMoney === '1';
    el.textContent = money ? formatMoney(0) : '0';
    animateCounter(el, target, { formatter: money ? formatMoney : v => Math.round(v).toString() });
  });
}

// ================================================================
// SKELETON
// ================================================================
function skeletonCards(n = 8) {
  return Array.from({ length: n }, () => `
    <div class="skeleton-card">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
        <div class="skeleton sk-avatar"></div>
        <div style="flex:1;">
          <div class="skeleton sk-line short"></div>
          <div class="skeleton sk-line mid" style="margin-bottom:0;height:10px;"></div>
        </div>
      </div>
      <div class="skeleton sk-line full"></div>
      <div class="skeleton sk-line mid"></div>
      <div style="margin-top:8px;">
        <span class="skeleton sk-tag"></span>
        <span class="skeleton sk-tag"></span>
      </div>
    </div>
  `).join('');
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `m-historique-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      state = JSON.parse(ev.target.result);
      refreshReferentials();
      saveData();
      router();
      showToast('Données importées', 'success');
    } catch (e) { showToast('Fichier invalide', 'error'); }
  };
  reader.readAsText(file);
}

// ----- OPEN MODAL ENTREPRISE HOOK -----

const _origOpenEntrepriseModal = openEntrepriseModal;
openEntrepriseModal = function(id) {
  const e = id ? state.entreprises.find(x => x.id === id) : { promotions: [], programmes: [], thematiques: [] };
  modalTags = {
    promotions: [...(e.promotions || [])],
    programmes: [...(e.programmes || [])],
    thematiques: [...(e.thematiques || [])]
  };
  _origOpenEntrepriseModal(id);
};

// ----- BOOTSTRAP -----

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  await loadData();
  refreshReferentials();
  saveData();

  document.getElementById('search-input').addEventListener('input', e => {
    filters.search = e.target.value;
    if (location.hash === '#/alumni' || location.hash === '#/alumni/') renderHome();
  });

  applyEditModeChrome();
  attachCmdkGlobal();
  window.addEventListener('hashchange', () => {
    if (document.startViewTransition && !window.__reduceMotion) {
      document.startViewTransition(() => router());
    } else router();
  });
  router();
  // Mode présentation : touche P
  document.addEventListener('keydown', ev => {
    if (ev.key === 'p' && !ev.metaKey && !ev.ctrlKey && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) {
      togglePresentMode();
    }
  });
  // Cache le loader avec un délai minimum de 900 ms pour laisser l'animation être vue
  setTimeout(() => {
    const loader = document.getElementById('app-loader');
    if (loader) loader.classList.add('hidden');
  }, 900);
});

window.navigate = navigate;
window.resetFilters = resetFilters;
window.setAdminTab = setAdminTab;
window.openNewModal = openNewModal;
window.openEntrepriseModal = openEntrepriseModal;
window.closeModal = closeModal;
window.saveEntreprise = saveEntreprise;
window.deleteEntreprise = deleteEntreprise;
window.renameReferential = renameReferential;
window.deleteReferential = deleteReferential;
window.handleTagInput = handleTagInput;
window.removeTag = removeTag;
window.addPersonEditor = addPersonEditor;
window.exportData = exportData;
window.importData = importData;

// ================================================================
// TIMELINE
// ================================================================

const PROMO_YEARS = {
  'MPU#01': 2019, 'MPU#02': 2019, 'MPU#03': 2020, 'MPU#04': 2021,
  'MPU4BIS': 2021, 'MPU#05': 2022, 'MPU5BIS': 2022,
  'MPU#23 M\'SCALE UP': 2023, 'MPU#23 FTT Prépa': 2023,
  'MPU#24': 2024, 'MPU#24 FTTP': 2024, 'MPU#24 FTTI': 2024,
  'MPU#24 COMORES': 2024, 'MPU#24 Med\'Innov': 2024,
  'MPU#24 SL PAC': 2024, 'MPU#24 Smart ESA': 2024,
  'MPU#25': 2025, 'MPU#25 FTTP': 2025, 'MPU#25 SLPAC': 2025, 'MPU#25 Comores': 2025,
  'MPU#26': 2026, 'MPU#26 Comores': 2026, 'MPU#26 IncubMe': 2026, 'MPU#26 SL PAC': 2026,
};

function guessYear(promo) {
  if (PROMO_YEARS[promo]) return PROMO_YEARS[promo];
  const m = promo.match(/#?(\d{2})/);
  if (m) {
    const n = parseInt(m[1]);
    if (n <= 5) return 2018 + n;
    return 2000 + n;
  }
  return 2020;
}

function renderTimeline() {
  const byYear = {};
  state.promotions.forEach(p => {
    const y = guessYear(p);
    if (!byYear[y]) byYear[y] = {};
    if (!byYear[y][p]) byYear[y][p] = { promo: p, entreprises: [] };
  });

  state.entreprises.forEach(e => {
    (e.promotions || []).forEach(p => {
      const y = guessYear(p);
      if (byYear[y] && byYear[y][p]) {
        byYear[y][p].entreprises.push(e);
      }
    });
  });

  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  const totalPromos = state.promotions.length;
  const totalEntr = getOfficialCount();
  const nYears = years.length || 1;
  const avgPerYear = Math.round(totalEntr / nYears);
  const marqueeText = years.slice().reverse().join(' · ') + ' · ';

  document.getElementById('app').innerHTML = `
    <div class="timeline-v2">
      <div class="hero hero--v4 hero--timeline">
        <div class="hero-v4-mark" aria-hidden="true">
          <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 80 L20 20 L50 60 L80 20 L80 80" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="hero-v4-orbs" aria-hidden="true">
          <div class="orb orb-1"></div>
          <div class="orb orb-2"></div>
          <div class="orb orb-3"></div>
        </div>
        <div class="hero-v4-marquee" aria-hidden="true">
          <div class="marquee-track">${(marqueeText.repeat(6))}</div>
        </div>
        <div class="hero-v4-inner hero--timeline-inner">
          <div class="hero-eyebrow">
            <span>M alumni</span>
            <span class="hero-sep"></span>
            <span>Timeline · ${years[years.length-1]} → ${years[0]}</span>
          </div>
        </div>
      </div>

      <div class="timeline-kpis">
        <div class="tl-kpi">
          <div class="tl-kpi-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
          </div>
          <b>${nYears}</b>
          <span>Années</span>
        </div>
        <div class="tl-kpi">
          <div class="tl-kpi-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </div>
          <b>${totalPromos}</b>
          <span>Promotions</span>
        </div>
        <div class="tl-kpi">
          <div class="tl-kpi-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14"/></svg>
          </div>
          <b>${totalEntr}</b>
          <span>Start-ups</span>
        </div>
        <div class="tl-kpi">
          <div class="tl-kpi-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 20 10 14 14 18 20 8"/><polyline points="16 8 20 8 20 12"/></svg>
          </div>
          <b>~${avgPerYear}</b>
          <span>En moyenne / an</span>
        </div>
      </div>

      <div class="content-area">
        <h3 class="section-title">
          <span>Chronologie des cohortes</span>
          <span class="count">${totalPromos} promotions · ${nYears} années</span>
        </h3>

        <div class="tl-track">
          <div class="tl-line" aria-hidden="true"></div>
          ${years.map(y => {
            const promos = Object.values(byYear[y]);
            const totalYearEntr = promos.reduce((s, p) => s + p.entreprises.length, 0);
            return `
              <div class="tl-year-block">
                <div class="tl-year-marker">
                  <div class="tl-year-dot"></div>
                  <div class="tl-year-badge">
                    <b>${y}</b>
                    <span>${totalYearEntr} start-up${totalYearEntr > 1 ? 's' : ''} · ${promos.length} promo${promos.length > 1 ? 's' : ''}</span>
                  </div>
                </div>
                <div class="tl-year-promos">
                  ${promos.map((p, idx) => {
                    const progs = [...new Set(p.entreprises.flatMap(e => e.programmes || []))];
                    const withLogos = p.entreprises.filter(e => (e.logo_url || '').startsWith('data:'));
                    const withoutLogos = p.entreprises.filter(e => !(e.logo_url || '').startsWith('data:'));
                    return `
                      <article class="tl-promo-card tilt-3d">
                        <div class="tl-promo-glow"></div>
                        <div class="tl-promo-head">
                          <div class="tl-promo-title-wrap">
                            <h4>${escapeHtml(p.promo)}</h4>
                            ${progs.length ? `<div class="tl-promo-progs">${progs.map(pg => `<span class="tl-promo-tag">${escapeHtml(pg)}</span>`).join('')}</div>` : ''}
                          </div>
                          <div class="tl-promo-count-wrap">
                            <b>${p.entreprises.length}</b>
                            <span>start-up${p.entreprises.length > 1 ? 's' : ''}</span>
                          </div>
                        </div>

                        ${withLogos.length ? `
                          <div class="tl-promo-logos">
                            ${withLogos.map(e => `
                              <a class="tl-promo-logo" href="#/alumni/entreprise/${escapeHtml(e.id)}" title="${escapeHtml(e.nom)}">
                                <img src="${escapeHtml(e.logo_url)}" alt="${escapeHtml(e.nom)}" loading="lazy">
                                <span class="tl-promo-logo-label">${escapeHtml(e.nom)}</span>
                              </a>
                            `).join('')}
                          </div>
                        ` : ''}

                        ${withoutLogos.length ? `
                          <div class="tl-promo-names">
                            ${withoutLogos.map(e => `
                              <a class="tl-promo-name-pill" href="#/alumni/entreprise/${escapeHtml(e.id)}" title="${escapeHtml(e.nom)}">
                                ${escapeHtml(e.nom)}
                                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                              </a>
                            `).join('')}
                          </div>
                        ` : ''}
                      </article>
                    `;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
  setTimeout(initMotionSystems, 100);
}

// ================================================================
// PERSONNES
// ================================================================

function slugPerson(p) {
  return slugify((p.prenom || '') + '-' + (p.nom || ''));
}

function getAllPersons() {
  const map = new Map();
  state.entreprises.forEach(e => {
    (e.personnes || []).forEach(p => {
      const key = slugPerson(p);
      if (!key || key === '-') return;
      if (!map.has(key)) {
        map.set(key, {
          slug: key,
          prenom: p.prenom, nom: p.nom, email: p.email,
          telephone: p.telephone, role: p.role, linkedin: p.linkedin,
          entreprises: []
        });
      }
      map.get(key).entreprises.push(e);
    });
  });
  return [...map.values()].sort((a, b) => (a.nom || '').localeCompare(b.nom || ''));
}

function renderPersonnes() {
  const persons = getAllPersons();
  const totalEntreprises = getOfficialCount();
  const totalMulti = persons.filter(p => p.entreprises.length > 1).length;
  const roles = [...new Set(persons.map(p => (p.role || '').trim()).filter(Boolean))].slice(0, 8);
  const letters = [...new Set(persons.map(p => (p.nom || p.prenom || '?').charAt(0).toUpperCase()))].filter(l => /[A-Z]/.test(l)).sort();

  document.getElementById('app').innerHTML = `
    <div class="alumni-page">
      <div class="alumni-aurora"></div>
      <header class="alumni-hero reveal-init">
        <h2 class="p26-h2">Annuaire alumni</h2>
        <div class="alumni-hero-stats">
          <div class="alumni-stat"><b data-count="${persons.length}">${persons.length}</b><span>alumni</span></div>
          <div class="alumni-stat"><b data-count="${totalEntreprises}">${totalEntreprises}</b><span>start-ups</span></div>
          <div class="alumni-stat"><b data-count="${totalMulti}">${totalMulti}</b><span>serial founders</span></div>
        </div>
      </header>

      <div class="alumni-toolbar reveal-init">
        <div class="alumni-search-wrap">
          <svg class="alumni-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="text" class="alumni-search" id="persons-search" placeholder="Rechercher un alumni, une entreprise...">
          <kbd class="alumni-search-kbd">⌘K</kbd>
        </div>
        <div class="alumni-filters" id="alumni-filters">
          <button class="alumni-filter-pill active" data-filter-type="all" data-filter-val="all">Tous</button>
          <button class="alumni-filter-pill" data-filter-type="multi" data-filter-val="1">Serial</button>
          ${roles.map(r => `<button class="alumni-filter-pill" data-filter-type="role" data-filter-val="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('')}
        </div>
      </div>

      ${letters.length > 6 ? `
      <div class="alumni-alphabet reveal-init" id="alumni-alphabet">
        ${letters.map(l => `<button class="alumni-alpha-btn" data-letter="${l}">${l}</button>`).join('')}
      </div>` : ''}

      <div id="persons-grid" class="alumni-grid">
        ${renderPersonsGrid(persons)}
      </div>
    </div>
  `;

  const filterState = { q: '', type: 'all', val: 'all', letter: null };
  const applyFilters = () => {
    let filtered = persons;
    if (filterState.q) {
      const q = filterState.q.toLowerCase();
      filtered = filtered.filter(p =>
        (p.prenom + ' ' + p.nom).toLowerCase().includes(q) ||
        (p.role || '').toLowerCase().includes(q) ||
        p.entreprises.some(e => (e.nom || '').toLowerCase().includes(q))
      );
    }
    if (filterState.type === 'multi') filtered = filtered.filter(p => p.entreprises.length > 1);
    else if (filterState.type === 'role') filtered = filtered.filter(p => (p.role || '') === filterState.val);
    if (filterState.letter) filtered = filtered.filter(p => (p.nom || p.prenom || '?').charAt(0).toUpperCase() === filterState.letter);
    document.getElementById('persons-grid').innerHTML = renderPersonsGrid(filtered);
    initAlumniReveals();
  };

  document.getElementById('persons-search').addEventListener('input', ev => {
    filterState.q = ev.target.value;
    applyFilters();
  });
  document.querySelectorAll('.alumni-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.alumni-filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterState.type = btn.dataset.filterType;
      filterState.val = btn.dataset.filterVal;
      applyFilters();
    });
  });
  document.querySelectorAll('.alumni-alpha-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const letter = btn.dataset.letter;
      if (filterState.letter === letter) {
        filterState.letter = null;
        btn.classList.remove('active');
      } else {
        document.querySelectorAll('.alumni-alpha-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        filterState.letter = letter;
      }
      applyFilters();
    });
  });

  requestAnimationFrame(() => {
    document.querySelectorAll('.alumni-page .reveal-init').forEach((el, i) => {
      setTimeout(() => el.classList.add('reveal-in'), 60 * i);
    });
    initAlumniReveals();
    initAlumniCounters();
  });
}

function renderPersonsGrid(persons) {
  if (!persons.length) return `
    <div class="alumni-empty">
      <div class="alumni-empty-orb"></div>
      <h4>Aucun alumni ne correspond</h4>
      <p>Essaie un autre nom, une autre entreprise ou retire les filtres.</p>
    </div>`;
  return persons.map((p, i) => {
    const primary = p.entreprises[0];
    const primaryLogo = (primary?.logo_url || '').startsWith('data:') ? primary.logo_url : '';
    const otherEnts = p.entreprises.slice(1, 3);
    const overflow = Math.max(0, p.entreprises.length - 3);
    const role = (p.role || '').trim();
    return `
    <article class="alumni-card reveal-init" style="--i:${i};" data-slug="${escapeHtml(p.slug)}" onclick="navigate('#/alumni/personne/${encodeURIComponent(p.slug)}')">
      <div class="alumni-card-glow"></div>
      ${p.entreprises.length > 1 ? `<div class="alumni-card-badge">×${p.entreprises.length}</div>` : ''}
      <div class="alumni-card-head">
        <div class="alumni-avatar${primaryLogo ? ' has-logo' : ''}">
          ${primaryLogo ? `<img src="${primaryLogo}" alt="">` : `<span>${escapeHtml(personInitials(p))}</span>`}
          <div class="alumni-avatar-ring"></div>
        </div>
        <div class="alumni-card-id">
          <h5>${escapeHtml(p.prenom || '')} ${escapeHtml(p.nom || '')}</h5>
          ${role ? `<span class="alumni-card-role">${escapeHtml(role)}</span>` : ''}
        </div>
      </div>
      <div class="alumni-card-sep"></div>
      <div class="alumni-card-body">
        ${primary ? `<span class="alumni-card-primary">${escapeHtml(primary.nom)}</span>` : ''}
        <div class="alumni-card-pills">
          ${otherEnts.map(e => `<span class="alumni-card-pill">${escapeHtml(e.nom)}</span>`).join('')}
          ${overflow > 0 ? `<span class="alumni-card-pill alumni-card-pill--more">+${overflow}</span>` : ''}
        </div>
      </div>
      <div class="alumni-card-foot">
        <span class="alumni-card-cta">Voir le profil</span>
        <span class="alumni-card-arrow">→</span>
      </div>
    </article>`;
  }).join('');
}

function initAlumniReveals() {
  const cards = document.querySelectorAll('.alumni-card.reveal-init:not(.reveal-in)');
  if (!cards.length) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const i = parseInt(entry.target.style.getPropertyValue('--i') || '0', 10);
        setTimeout(() => entry.target.classList.add('reveal-in'), Math.min(i, 20) * 30);
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });
  cards.forEach(c => io.observe(c));
}

function initAlumniCounters() {
  document.querySelectorAll('.alumni-stat b[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count, 10);
    if (!target || target > 9999) return;
    const dur = 900;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased);
      if (p < 1) requestAnimationFrame(tick);
    };
    el.textContent = '0';
    requestAnimationFrame(tick);
  });
}

function renderPersonneDetail(slug) {
  const persons = getAllPersons();
  const p = persons.find(x => x.slug === slug);
  if (!p) {
    document.getElementById('app').innerHTML = `<div class="person-detail"><div class="empty-state"><h4>Personne introuvable</h4><p><a href="#/alumni/personnes">Retour à l'annuaire</a></p></div></div>`;
    return;
  }
  const isPrive = window.PRIVE_MODE;
  document.getElementById('app').innerHTML = `
    <div class="person-detail">
      <a class="back-link" href="#/alumni/personnes">← Retour à l'annuaire</a>
      <div class="banner">
        <div class="avatar-big">${escapeHtml(personInitials(p))}</div>
        <div>
          <h1>${escapeHtml(p.prenom)} ${escapeHtml(p.nom)}</h1>
          <div class="role">${escapeHtml(p.role || 'Cofondateur')}</div>
          <div class="contact">
            ${p.entreprises.length} start-up${p.entreprises.length > 1 ? 's' : ''} accompagnée${p.entreprises.length > 1 ? 's' : ''} par l'Accélérateur M
          </div>
        </div>
      </div>
      ${isPrive && (p.email || p.telephone) ? `
        <div class="private-contact">
          <strong>Coordonnées privées (mode alumni)</strong><br>
          ${p.email ? 'Email : ' + escapeHtml(p.email) : ''}
          ${p.email && p.telephone ? ' · ' : ''}
          ${p.telephone ? 'Téléphone : ' + escapeHtml(p.telephone) : ''}
        </div>
      ` : ''}
      <div class="person-companies">
        <h3>Boîtes fondées ou cofondées</h3>
        <div class="grid">
          ${p.entreprises.map(e => renderCard(e, state.entreprises)).join('')}
        </div>
      </div>
    </div>
  `;
}

// ================================================================
// CARTE INTERACTIVE
// ================================================================

const CITY_COORDS = {
  'Marseille': [43.2965, 5.3698],
  'Aix-en-Provence': [43.5297, 5.4474],
  'Paris': [48.8566, 2.3522],
  'Tunis': [36.8065, 10.1815],
  'Beirut': [33.8886, 35.4955],
  'La Ciotat': [43.1748, 5.6053],
  "Roquefort la Bedoule": [43.2000, 5.6167],
  'Mimet': [43.4166, 5.5000],
  'Eguilles': [43.5697, 5.3550],
  'Aubagne': [43.2925, 5.5654],
  'Cassis': [43.2141, 5.5397],
  'Allauch': [43.3364, 5.4780],
  'Les Pennes-Mirabeau': [43.4108, 5.3125],
  'Biot': [43.6285, 7.0954],
  'Cameroun': [3.8480, 11.5021],
  'Lomé': [6.1725, 1.2314],
  'Glasgow/Marseille': [55.8642, -4.2518],
  "La Roque d'Anthéron": [43.7208, 5.3080],
};

// Mapping ville → code pays ISO3 (utilisé par le fichier GeoJSON monde)
const CITY_TO_COUNTRY = {
  'Marseille': 'FRA', 'Aix-en-Provence': 'FRA', 'Paris': 'FRA',
  'La Ciotat': 'FRA', 'Roquefort la Bedoule': 'FRA', 'Mimet': 'FRA',
  'Eguilles': 'FRA', 'Aubagne': 'FRA', 'Cassis': 'FRA', 'Allauch': 'FRA',
  'Les Pennes-Mirabeau': 'FRA', 'Biot': 'FRA', "La Roque d'Anthéron": 'FRA',
  'Tunis': 'TUN',
  'Beirut': 'LBN',
  'Lomé': 'TGO',
  'Cameroun': 'CMR',
  'Glasgow/Marseille': 'GBR',
};

const COUNTRY_NAMES = {
  FRA: 'France', TUN: 'Tunisie', LBN: 'Liban', TGO: 'Togo',
  CMR: 'Cameroun', GBR: 'Royaume-Uni',
};

// Palette éditoriale : terres claires, mer bleutée, dégradé cyan/navy sur les pays actifs
const MAP_SEA_COLOR = '#B8DFEC';        // Mer bleu clair aquatique
const MAP_LAND_EMPTY = '#F5EFE1';       // Terres sans start-up : crème chaud
const MAP_LAND_BORDER = '#D8CFBB';      // Bordures pays inactifs : beige plus foncé

function colorForCount(count) {
  if (!count) return MAP_LAND_EMPTY;
  if (count >= 100) return '#0D1E26';   // Noir profond
  if (count >= 30) return '#193947';    // Bleu Minuit
  if (count >= 10) return '#005E78';    // Bleu Profond
  if (count >= 3) return '#007EA1';     // Bleu Céleste
  return '#4EBED6';                     // Bleu Horizon clair
}

// Année d'arrivée d'une entreprise = année de sa promotion la plus ancienne
function getCompanyYear(e) {
  if (!e.promotions || !e.promotions.length) return null;
  const years = e.promotions.map(p => guessYear(p)).filter(Boolean);
  return years.length ? Math.min(...years) : null;
}

function labelForRange(range) {
  return { 0: 'Aucune', 1: '1 à 2', 2: '3 à 9', 3: '10 à 29', 4: '30 à 99', 5: '100+' }[range];
}

let worldGeoJson = null;

let mapInstance = null;

function computeCountryCounts() {
  const counts = {};
  state.entreprises.forEach(e => {
    if (!e.ville) return;
    const iso = CITY_TO_COUNTRY[e.ville];
    if (!iso) return;
    counts[iso] = (counts[iso] || 0) + 1;
  });
  return counts;
}

let carteFilters = { search: '', promotions: new Set(), programmes: new Set(), thematiques: new Set() };

const CARTE_FILTER_KEYS = ['promotions', 'programmes', 'thematiques'];

function countActiveCarteFilters() {
  return CARTE_FILTER_KEYS.reduce((n, k) => n + carteFilters[k].size, 0);
}

function carteHasFilters() {
  return !!carteFilters.search || countActiveCarteFilters() > 0;
}

function getCarteEntreprises() {
  const s = carteFilters.search.toLowerCase().trim();
  return state.entreprises.filter(e => {
    if (s) {
      const match =
        (e.nom || '').toLowerCase().includes(s) ||
        (e.ville || '').toLowerCase().includes(s) ||
        (e.description_courte || '').toLowerCase().includes(s);
      if (!match) return false;
    }
    if (carteFilters.promotions.size && !(e.promotions || []).some(p => carteFilters.promotions.has(p))) return false;
    if (carteFilters.programmes.size && !(e.programmes || []).some(p => carteFilters.programmes.has(p))) return false;
    if (carteFilters.thematiques.size && !(e.thematiques || []).some(t => carteFilters.thematiques.has(t))) return false;
    return true;
  });
}

function computeCountryCountsFor(entreprises) {
  const counts = {};
  entreprises.forEach(e => {
    if (!e.ville) return;
    const iso = CITY_TO_COUNTRY[e.ville];
    if (!iso) return;
    counts[iso] = (counts[iso] || 0) + 1;
  });
  return counts;
}

function computeCountryAggregatesFor(entreprises) {
  const agg = {};
  entreprises.forEach(e => {
    const iso = CITY_TO_COUNTRY[e.ville];
    if (!iso) return;
    if (!agg[iso]) agg[iso] = { count: 0, fonds: 0, emplois: 0, themes: {} };
    agg[iso].count++;
    agg[iso].fonds += (e.fonds_leves || 0);
    agg[iso].emplois += (e.emplois || 0);
    (e.thematiques || []).forEach(t => {
      agg[iso].themes[t] = (agg[iso].themes[t] || 0) + 1;
    });
  });
  Object.keys(agg).forEach(iso => {
    agg[iso].topThemes = Object.entries(agg[iso].themes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);
  });
  return agg;
}

function computeCityAggregate(entrs) {
  const themes = {};
  entrs.forEach(e => (e.thematiques || []).forEach(t => {
    themes[t] = (themes[t] || 0) + 1;
  }));
  return {
    count: entrs.length,
    fonds: entrs.reduce((s, e) => s + (e.fonds_leves || 0), 0),
    emplois: entrs.reduce((s, e) => s + (e.emplois || 0), 0),
    topThemes: Object.entries(themes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t),
  };
}

const CARTE_ZOOM_PRESETS = {
  marseille: { center: [43.297, 5.375], zoom: 12, label: 'Marseille' },
  france:    { center: [46.6, 2.5],  zoom: 6, label: 'France' },
  europe:    { center: [48, 10],     zoom: 4, label: 'Europe' },
  monde:     { center: [25, 15],     zoom: 3, label: 'Monde' },
};

// Layers de tuiles : plan classique, satellite, hybride
const MAP_TILE_LAYERS = {
  satellite: {
    label: 'Satellite',
    build: () => L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Tiles © Esri' }
    ),
  },
  plan: {
    label: 'Plan',
    build: () => L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, attribution: '© OpenStreetMap' }
    ),
  },
  clair: {
    label: 'Clair',
    build: () => L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      { maxZoom: 20, attribution: '© CARTO' }
    ),
  },
  sombre: {
    label: 'Sombre',
    build: () => L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { maxZoom: 20, attribution: '© CARTO' }
    ),
  },
};
let currentTileLayer = null;
let currentTileMode = 'clair';
let choroplethVisible = false;

function renderCarte() {
  const entreprises = getCarteEntreprises();
  const villesActives = new Set(entreprises.map(e => e.ville).filter(Boolean));
  const countryCounts = computeCountryCountsFor(entreprises);
  const paysActifs = Object.keys(countryCounts).length;
  const fondsTotal = entreprises.reduce((s, e) => s + (e.fonds_leves || 0), 0);
  const filteredLabel = carteHasFilters() ? ' filtrées' : '';

  document.getElementById('app').innerHTML = `
    <div class="p26-page carte-2026">
      <div class="p26-aurora"></div>
      <header class="p26-hero p26-reveal">
        <div>
          <h2 class="p26-h2">Carte du monde</h2>
          <p class="p26-hero-tagline">Répartition géographique des start-ups accompagnées. Zoome, filtre et clique sur un pays ou une ville pour explorer.</p>
        </div>
        <div class="p26-hero-stats">
          <div class="p26-stat clickable" onclick="openStatModal('entreprises')" style="cursor:pointer;"><b id="carte-stat-entr">${carteHasFilters() ? entreprises.length : getOfficialCount()}</b><span>${carteHasFilters() ? 'filtrées' : 'accompagnées'}</span></div>
          <div class="p26-stat clickable" onclick="openStatModal('pays')" style="cursor:pointer;"><b id="carte-stat-pays">${paysActifs}</b><span>pays</span></div>
          <div class="p26-stat clickable" onclick="openStatModal('villes')" style="cursor:pointer;"><b id="carte-stat-villes">${villesActives.size}</b><span>villes</span></div>
        </div>
      </header>

      <div class="map-toolbar-2026 p26-reveal">
        <div class="map-search-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="carte-search-input" placeholder="Rechercher une ville, une entreprise…" value="${escapeHtml(carteFilters.search)}" autocomplete="off">
        </div>
        <button class="p26-filter-pill" onclick="openCarteFilterModal()">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          Filtrer
          ${countActiveCarteFilters() ? `<span class="filter-count-badge" style="background:var(--blue-primary);color:#fff;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:700;">${countActiveCarteFilters()}</span>` : ''}
        </button>
        <div class="map-zoom-presets" role="group" aria-label="Zoom rapide">
          ${Object.entries(CARTE_ZOOM_PRESETS).map(([k, p]) => `
            <button onclick="zoomCarteTo('${k}')">${p.label}</button>
          `).join('')}
        </div>
        <div class="map-tile-toggle" role="group" aria-label="Type de carte">
          ${Object.entries(MAP_TILE_LAYERS).map(([k, l]) => `
            <button data-tile="${k}" class="${k === 'clair' ? 'active' : ''}" onclick="switchTileLayer('${k}')">${l.label}</button>
          `).join('')}
        </div>
        <button class="p26-filter-pill" id="btn-choropleth" onclick="toggleChoropleth()" title="Afficher / masquer la densité par pays">
          <span id="choropleth-lbl">◔ Densité pays</span>
        </button>
      </div>
      <div id="carte-active-filters">${renderCarteActiveFilters()}</div>

      <div class="map-precision-wrap p26-reveal">
        <div id="map"></div>
        <div class="map-grain"></div>
        <div class="map-empty-overlay" id="map-empty-overlay" style="${entreprises.length ? 'display:none;' : ''}">
          <div>
            <h4>Aucune start-up ne correspond</h4>
            <p>Modifie ta recherche ou tes filtres.</p>
            <button class="btn-secondary" onclick="resetCarteFilters()">Réinitialiser</button>
          </div>
        </div>
      </div>

      <div class="map-legend-2026 p26-reveal">
        <div>
          <div class="lg-title">Densité par pays</div>
          <div class="lg-scale">
            <span class="lg-item"><span class="lg-swatch" style="background:${MAP_LAND_EMPTY};border-color:${MAP_LAND_BORDER};"></span>0</span>
            <span class="lg-item"><span class="lg-swatch" style="background:#4EBED6;"></span>1–2</span>
            <span class="lg-item"><span class="lg-swatch" style="background:#007EA1;"></span>3–9</span>
            <span class="lg-item"><span class="lg-swatch" style="background:#005E78;"></span>10–29</span>
            <span class="lg-item"><span class="lg-swatch" style="background:#193947;"></span>30–99</span>
            <span class="lg-item"><span class="lg-swatch" style="background:#0D1E26;"></span>100+</span>
          </div>
        </div>
        <div style="text-align:right;">
          <b class="lg-total">${formatMoney(fondsTotal)}</b>
          <span class="lg-total-lbl">Fonds levés cumulés</span>
        </div>
      </div>
    </div>
  `;

  requestAnimationFrame(() => {
    document.querySelectorAll('.carte-2026 .p26-reveal').forEach((el, i) => {
      setTimeout(() => el.classList.add('reveal-in'), 80 * i);
    });
  });

  bindCarteSearch();
  bindCarteActiveFilterRemovals();

  setTimeout(async () => {
    const mapEl = document.getElementById('map');
    if (!mapEl) return; // l'utilisateur a quitté la carte entre-temps
    if (typeof L === 'undefined') {
      mapEl.innerHTML = '<div class="empty-state" style="padding:40px;"><h4>Carte indisponible</h4><p>Le fond de carte se charge depuis internet. Vérifiez la connexion, puis rechargez la page.</p></div>';
      return;
    }
    if (mapInstance) { mapInstance.remove(); mapInstance = null; }

    const preset = CARTE_ZOOM_PRESETS.france;
    mapInstance = L.map('map', {
      worldCopyJump: true,
      zoomControl: false,
      attributionControl: true,
      minZoom: 2,
      maxZoom: 19,
      maxBounds: [[-85, -220], [85, 220]],
    }).setView(preset.center, preset.zoom);
    L.control.zoom({ position: 'topright' }).addTo(mapInstance);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(mapInstance);

    // Tuiles de fond
    currentTileLayer = MAP_TILE_LAYERS[currentTileMode].build().addTo(mapInstance);

    if (!worldGeoJson) {
      try {
        const res = await fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json');
        worldGeoJson = await res.json();
      } catch (e) {
        console.warn('GeoJSON monde non disponible', e);
      }
    }

    if (worldGeoJson && choroplethVisible) {
      window._countryLayer = L.geoJSON(worldGeoJson, {
        smoothFactor: 0.35,
        style: feature => {
          const c = countryCounts[feature.id] || 0;
          return {
            fillColor: colorForCount(c),
            weight: c ? 1.4 : 0.8,
            color: c ? '#0D1E26' : MAP_LAND_BORDER,
            fillOpacity: 1,
            lineJoin: 'round',
            lineCap: 'round',
          };
        },
        onEachFeature: (feature, layer) => {
          layer.feature = feature;
          layer.on({
            mouseover: e => {
              const cur = window._currentCountryCounts || countryCounts;
              const c = cur[feature.id] || 0;
              e.target.setStyle({ weight: 3, color: c ? '#0099FF' : '#0099FF', dashArray: '' });
              e.target.bringToFront();
            },
            mouseout: e => {
              const cur = window._currentCountryCounts || countryCounts;
              const c = cur[feature.id] || 0;
              e.target.setStyle({
                weight: c ? 1.4 : 0.8,
                color: c ? '#0D1E26' : MAP_LAND_BORDER,
              });
            },
          });
        },
      }).addTo(mapInstance);
    }

    window._cityLayerGroup = L.layerGroup().addTo(mapInstance);
    updateChoropleth();
    redrawCityMarkers();
  }, 50);
}

function redrawCityMarkers() {
  if (!window._cityLayerGroup) return;
  window._cityLayerGroup.clearLayers();
  const entreprises = getCarteEntreprises();
  const byCity = {};
  entreprises.forEach(e => {
    if (!e.ville) return;
    if (!byCity[e.ville]) byCity[e.ville] = [];
    byCity[e.ville].push(e);
  });
  const cityEntries = Object.entries(byCity)
    .filter(([v]) => CITY_COORDS[v])
    .sort((a, b) => a[1].length - b[1].length);

  cityEntries.forEach(([ville, entrs]) => {
    const coord = CITY_COORDS[ville];
    const agg = computeCityAggregate(entrs);
    const radius = Math.min(30, 6 + Math.sqrt(agg.count) * 3.5);
    const circle = L.circleMarker(coord, {
      radius,
      fillColor: '#FFFFFF',
      color: '#0D1E26',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.95,
      className: 'city-marker',
    }).addTo(window._cityLayerGroup);

    if (agg.count > 1) {
      const badge = L.divIcon({
        className: 'city-count-badge',
        html: `<span>${agg.count}</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      L.marker(coord, { icon: badge, interactive: false, keyboard: false }).addTo(window._cityLayerGroup);
    }

    const shown = entrs.slice(0, 8);
    const rest = entrs.length - shown.length;
    const themesHtml = agg.topThemes.length
      ? `<div class="city-popup-themes">${agg.topThemes.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>`
      : '';
    const fondsHtml = agg.fonds ? `<div class="city-popup-metric"><b>${formatMoney(agg.fonds)}</b><span>fonds levés</span></div>` : '';
    const emploisHtml = agg.emplois ? `<div class="city-popup-metric"><b>${agg.emplois}</b><span>emplois</span></div>` : '';

    circle.bindPopup(`
      <div class="city-popup">
        <div class="city-popup-head">
          <div>
            <div class="city-popup-title">${escapeHtml(ville)}</div>
            <div class="city-popup-sub">${agg.count} start-up${agg.count > 1 ? 's' : ''}</div>
          </div>
        </div>
        ${(fondsHtml || emploisHtml) ? `<div class="city-popup-metrics">${fondsHtml}${emploisHtml}</div>` : ''}
        ${themesHtml}
        <ul class="city-popup-list">
          ${shown.map(e => {
            const tag = (e.programmes || [])[0] || (e.promotions || [])[0] || '';
            return `<li><a href="#/alumni/entreprise/${escapeHtml(e.id)}">${escapeHtml(e.nom)}</a>${tag ? `<span class="city-popup-tag">${escapeHtml(tag)}</span>` : ''}</li>`;
          }).join('')}
          ${rest > 0 ? `<li class="city-popup-more">…et ${rest} de plus</li>` : ''}
        </ul>
      </div>
    `, { className: 'city-popup-wrap', maxWidth: 320 });
  });
}

function updateChoropleth() {
  if (!window._countryLayer) return;
  const entreprises = getCarteEntreprises();
  const agg = computeCountryAggregatesFor(entreprises);
  const counts = {};
  Object.keys(agg).forEach(iso => { counts[iso] = agg[iso].count; });
  window._currentCountryCounts = counts;
  window._countryLayer.eachLayer(layer => {
    const iso = layer.feature.id;
    const info = agg[iso];
    const c = info?.count || 0;
    layer.setStyle({
      fillColor: colorForCount(c),
      weight: c ? 1 : 0.6,
      color: c ? '#0D1E26' : MAP_LAND_BORDER,
    });
    layer.unbindTooltip();
    if (c > 0) {
      const name = COUNTRY_NAMES[iso] || layer.feature.properties?.name || iso;
      const fondsLine = info.fonds ? `<div class="ctt-line"><span>Fonds levés</span><b>${formatMoney(info.fonds)}</b></div>` : '';
      const emploisLine = info.emplois ? `<div class="ctt-line"><span>Emplois</span><b>${info.emplois}</b></div>` : '';
      const themesLine = info.topThemes.length ? `<div class="ctt-themes">${info.topThemes.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>` : '';
      layer.bindTooltip(
        `<div class="ctt">
          <div class="ctt-head"><b>${escapeHtml(name)}</b><span>${c} start-up${c > 1 ? 's' : ''}</span></div>
          ${fondsLine}${emploisLine}${themesLine}
        </div>`,
        { sticky: true, direction: 'top', className: 'country-tooltip' }
      );
    }
  });
}

// ================================================================
// CARTE — Interactions filtres, recherche, zoom
// ================================================================

function refreshCarteUI() {
  const entreprises = getCarteEntreprises();
  const villesActives = new Set(entreprises.map(e => e.ville).filter(Boolean));
  const counts = computeCountryCountsFor(entreprises);
  const filteredLabel = carteHasFilters() ? ' filtrées' : '';

  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText('carte-stat-entr', carteHasFilters() ? entreprises.length : getOfficialCount());
  setText('carte-stat-pays', Object.keys(counts).length);
  setText('carte-stat-villes', villesActives.size);

  const entrLbl = document.querySelector('#carte-stats .carte-stat:nth-child(1) .lbl');
  if (entrLbl) entrLbl.textContent = 'Entreprises' + filteredLabel;

  const active = document.getElementById('carte-active-filters');
  if (active) {
    active.innerHTML = renderCarteActiveFilters();
    bindCarteActiveFilterRemovals();
  }

  const btn = document.querySelector('.carte-btn-filter');
  if (btn) {
    const badge = btn.querySelector('.filter-count-badge');
    const n = countActiveCarteFilters();
    if (n > 0) {
      if (badge) badge.textContent = n;
      else btn.insertAdjacentHTML('beforeend', `<span class="filter-count-badge">${n}</span>`);
    } else if (badge) {
      badge.remove();
    }
  }

  const overlay = document.getElementById('map-empty-overlay');
  if (overlay) overlay.style.display = entreprises.length ? 'none' : 'flex';

  const legendFooter = document.querySelector('.map-legend-footer b');
  if (legendFooter) legendFooter.textContent = formatMoney(entreprises.reduce((s, e) => s + (e.fonds_leves || 0), 0));

  updateChoropleth();
  redrawCityMarkers();
}

function renderCarteActiveFilters() {
  const active = [];
  CARTE_FILTER_KEYS.forEach(k => {
    carteFilters[k].forEach(v => active.push({ key: k, val: v }));
  });
  if (!active.length && !carteFilters.search) return '';
  const searchPill = carteFilters.search
    ? `<span class="active-filter-pill active-filter-pill--search">
        <em>“${escapeHtml(carteFilters.search)}”</em>
        <button data-carte-clear-search aria-label="Effacer la recherche">×</button>
      </span>`
    : '';
  return `
    <div class="active-filters-bar carte-active-filters-bar">
      ${searchPill}
      ${active.map(f => `
        <span class="active-filter-pill" data-filter="${f.key}" data-value="${escapeHtml(f.val)}">
          ${escapeHtml(f.val.length > 22 ? f.val.slice(0, 20) + '…' : f.val)}
          <button data-carte-remove-filter data-filter="${f.key}" data-value="${escapeHtml(f.val)}">×</button>
        </span>
      `).join('')}
      ${(active.length > 1 || (active.length && carteFilters.search)) ? `<button class="btn-link" onclick="resetCarteFilters()">Tout effacer</button>` : ''}
    </div>
  `;
}

function bindCarteActiveFilterRemovals() {
  document.querySelectorAll('[data-carte-remove-filter]').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const key = btn.dataset.filter;
      const val = btn.dataset.value;
      carteFilters[key].delete(val);
      refreshCarteUI();
    });
  });
  document.querySelectorAll('[data-carte-clear-search]').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      clearCarteSearch();
    });
  });
}

let carteSearchDebounce = null;
function bindCarteSearch() {
  const input = document.getElementById('carte-search-input');
  if (!input) return;
  input.addEventListener('input', () => {
    const clearBtn = document.querySelector('.carte-search-clear');
    if (clearBtn) clearBtn.style.display = input.value ? '' : 'none';
    clearTimeout(carteSearchDebounce);
    carteSearchDebounce = setTimeout(() => {
      carteFilters.search = input.value;
      refreshCarteUI();
      maybeAutoZoomToSearch();
    }, 180);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { clearCarteSearch(); input.blur(); }
  });
}

function maybeAutoZoomToSearch() {
  if (!mapInstance || !carteFilters.search) return;
  const entreprises = getCarteEntreprises();
  const villes = new Set(entreprises.map(e => e.ville).filter(v => v && CITY_COORDS[v]));
  if (villes.size === 0) return;
  if (villes.size === 1) {
    const [v] = villes;
    mapInstance.flyTo(CITY_COORDS[v], Math.max(mapInstance.getZoom(), 8), { duration: 0.8 });
    return;
  }
  const coords = [...villes].map(v => CITY_COORDS[v]);
  const bounds = L.latLngBounds(coords).pad(0.4);
  mapInstance.flyToBounds(bounds, { duration: 0.8, maxZoom: 7 });
}

function clearCarteSearch() {
  carteFilters.search = '';
  const input = document.getElementById('carte-search-input');
  if (input) input.value = '';
  const clearBtn = document.querySelector('.carte-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  refreshCarteUI();
}

function zoomCarteTo(key) {
  const preset = CARTE_ZOOM_PRESETS[key];
  if (!preset || !mapInstance) return;
  mapInstance.flyTo(preset.center, preset.zoom, { duration: 0.8 });
}

function switchTileLayer(mode) {
  if (!mapInstance || !MAP_TILE_LAYERS[mode]) return;
  if (currentTileLayer) mapInstance.removeLayer(currentTileLayer);
  currentTileMode = mode;
  currentTileLayer = MAP_TILE_LAYERS[mode].build().addTo(mapInstance);
  currentTileLayer.bringToBack();
  document.querySelectorAll('.map-tile-toggle button').forEach(b => b.classList.toggle('active', b.dataset.tile === mode));
  // Sur satellite/sombre : on cache le choropleth par défaut car il masque les tuiles
  if (mode === 'satellite' || mode === 'sombre') {
    if (window._countryLayer) {
      window._countryLayer.setStyle({ fillOpacity: 0.35 });
    }
  } else if (window._countryLayer && choroplethVisible) {
    window._countryLayer.setStyle({ fillOpacity: 0.7 });
  }
  Sfx.play('tick');
}
window.switchTileLayer = switchTileLayer;

function toggleChoropleth() {
  choroplethVisible = !choroplethVisible;
  if (!mapInstance) return;
  const btn = document.getElementById('btn-choropleth');
  const lbl = document.getElementById('choropleth-lbl');
  if (choroplethVisible) {
    if (!worldGeoJson) return;
    if (!window._countryLayer) {
      const counts = computeCountryCountsFor(getCarteEntreprises());
      const overlayOpacity = (currentTileMode === 'satellite' || currentTileMode === 'sombre') ? 0.35 : 0.7;
      window._countryLayer = L.geoJSON(worldGeoJson, {
        smoothFactor: 0.35,
        style: feature => {
          const c = counts[feature.id] || 0;
          return {
            fillColor: colorForCount(c),
            weight: c ? 1.4 : 0.8,
            color: c ? '#0D1E26' : MAP_LAND_BORDER,
            fillOpacity: overlayOpacity,
            lineJoin: 'round',
          };
        },
        onEachFeature: (feature, layer) => {
          layer.feature = feature;
          layer.on({
            mouseover: e => {
              const cur = window._currentCountryCounts || counts;
              const c = cur[feature.id] || 0;
              e.target.setStyle({ weight: 3, color: '#0099FF' });
              e.target.bringToFront();
            },
            mouseout: e => {
              const cur = window._currentCountryCounts || counts;
              const c = cur[feature.id] || 0;
              e.target.setStyle({ weight: c ? 1.4 : 0.8, color: c ? '#0D1E26' : MAP_LAND_BORDER });
            },
          });
        },
      }).addTo(mapInstance);
      if (window._cityLayerGroup) window._cityLayerGroup.bringToFront();
    } else {
      window._countryLayer.addTo(mapInstance);
    }
    updateChoropleth();
    if (btn) btn.classList.add('active');
    if (lbl) lbl.textContent = '● Densité pays';
  } else {
    if (window._countryLayer) mapInstance.removeLayer(window._countryLayer);
    if (btn) btn.classList.remove('active');
    if (lbl) lbl.textContent = '◔ Densité pays';
  }
  Sfx.play('tick');
}
window.toggleChoropleth = toggleChoropleth;

function toggleCarteFilter(key, val) {
  if (!CARTE_FILTER_KEYS.includes(key)) return;
  if (carteFilters[key].has(val)) carteFilters[key].delete(val);
  else carteFilters[key].add(val);
  refreshCarteFilterModalChips();
  refreshCarteUI();
}

function refreshCarteFilterModalChips() {
  document.querySelectorAll('.filter-modal .filter-chip[data-carte-filter]').forEach(chip => {
    const key = chip.dataset.carteFilter;
    const val = chip.dataset.value;
    chip.classList.toggle('active', carteFilters[key].has(val));
  });
  const badge = document.querySelector('.filter-modal .modal-header .modal-badge');
  const n = countActiveCarteFilters();
  if (badge) badge.textContent = n ? `${n} actif${n > 1 ? 's' : ''}` : '';
}

function renderCarteFilterGroup(label, key, options, iconKey) {
  if (!options.length) return '';
  const counts = countByCarteFilter(key, options);
  const iconHtml = iconKey ? `<span class="filter-icon">${FILTER_ICONS[iconKey] || ''}</span>` : '';
  return `
    <div class="filter-group">
      <div class="filter-label">${iconHtml}${label}</div>
      <div class="filter-chips">
        ${options.map(opt => `
          <span class="filter-chip ${carteFilters[key].has(opt) ? 'active' : ''}" data-carte-filter="${key}" data-value="${escapeHtml(opt)}" onclick="toggleCarteFilter('${key}', ${escapeHtml(JSON.stringify(opt))})">
            ${escapeHtml(opt.length > 22 ? opt.slice(0, 20) + '…' : opt)}
            <span class="chip-count">${counts[opt] || 0}</span>
          </span>
        `).join('')}
      </div>
    </div>
  `;
}

function countByCarteFilter(key, options) {
  const counts = {};
  const base = getCarteEntreprisesIgnoring(key);
  for (const opt of options) {
    counts[opt] = base.filter(e => (e[key] || []).includes(opt)).length;
  }
  return counts;
}

function getCarteEntreprisesIgnoring(ignoreKey) {
  const s = carteFilters.search.toLowerCase().trim();
  return state.entreprises.filter(e => {
    if (s) {
      const match =
        (e.nom || '').toLowerCase().includes(s) ||
        (e.ville || '').toLowerCase().includes(s) ||
        (e.description_courte || '').toLowerCase().includes(s);
      if (!match) return false;
    }
    for (const k of CARTE_FILTER_KEYS) {
      if (k === ignoreKey) continue;
      if (carteFilters[k].size && !(e[k] || []).some(v => carteFilters[k].has(v))) return false;
    }
    return true;
  });
}

function openCarteFilterModal() {
  const overlay = document.getElementById('modal-overlay');
  const n = countActiveCarteFilters();
  overlay.innerHTML = `
    <div class="modal filter-modal">
      <div class="modal-header">
        <h3>Filtrer la carte ${n ? `<span class="modal-badge">${n} actif${n > 1 ? 's' : ''}</span>` : '<span class="modal-badge"></span>'}</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <p class="modal-hint">Les filtres s'appliquent en temps réel sur la carte, les stats et les popups.</p>
      ${renderCarteFilterGroup('Promotion', 'promotions', state.promotions, 'calendar')}
      ${renderCarteFilterGroup('Programme', 'programmes', state.programmes, 'zap')}
      ${renderCarteFilterGroup('Thématique', 'thematiques', state.thematiques, 'layers')}
      <div class="modal-actions">
        <button class="btn-secondary" onclick="resetCarteFiltersAndClose()">Tout réinitialiser</button>
        <button class="btn-primary" onclick="closeModal()">Voir la carte</button>
      </div>
    </div>
  `;
  overlay.classList.add('active');
  overlay.onclick = ev => { if (ev.target === overlay) closeModal(); };
}

function resetCarteFilters() {
  carteFilters = { search: '', promotions: new Set(), programmes: new Set(), thematiques: new Set() };
  const input = document.getElementById('carte-search-input');
  if (input) input.value = '';
  const clearBtn = document.querySelector('.carte-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  refreshCarteFilterModalChips();
  refreshCarteUI();
}

function resetCarteFiltersAndClose() {
  resetCarteFilters();
  closeModal();
}

window.clearCarteSearch = clearCarteSearch;
window.zoomCarteTo = zoomCarteTo;
window.toggleCarteFilter = toggleCarteFilter;
window.openCarteFilterModal = openCarteFilterModal;
window.resetCarteFilters = resetCarteFilters;
window.resetCarteFiltersAndClose = resetCarteFiltersAndClose;

// ================================================================
// STATISTIQUES
// ================================================================

// ================================================================
// STATISTIQUES
//
// Réunion du 01/09/2026 : « tu mets tout dans le truc stat, quitte à ce que
// dans le truc stat tu puisses filtrer ». Les filtres du portfolio pilotent
// donc cette page, et chaque chiffre s'y recalcule sur la sélection courante.
//
// L'onglet du portfolio (Tous / Actives / Éteintes) n'est délibérément PAS
// appliqué ici : c'est une commande de navigation du portfolio, pas un filtre
// d'analyse. Sinon la page mentirait sur son propre total.
// ================================================================

/** Les entreprises retenues par les filtres, sans l'onglet du portfolio. */
function entreprisesStats() {
  const s = filters.search.toLowerCase().trim();
  return state.entreprises.filter(e => {
    if (s && !(e.nom || '').toLowerCase().includes(s)
          && !(e.description_courte || '').toLowerCase().includes(s)) return false;
    if (filters.promotions.size && !(e.promotions || []).some(p => filters.promotions.has(p))) return false;
    if (filters.programmes.size && !(e.programmes || []).some(p => filters.programmes.has(p))) return false;
    if (filters.thematiques.size && !(e.thematiques || []).some(t => filters.thematiques.has(t))) return false;
    if (filters.statuts.size && !filters.statuts.has(e.statut)) return false;
    if (filters.villes.size && !filters.villes.has(e.ville)) return false;
    return true;
  });
}

/**
 * Ordre des promotions : celui de l'Excel, édition par édition.
 * MPU#01 … MPU#05, puis les BIS à la suite de leur édition, puis MPU#23 … MPU#26.
 * Un tri alphabétique plaçait MPU4BIS avant MPU#23 et MPU#05 après MPU#26.
 */
function rangPromotion(p) {
  const m = String(p).match(/(\d+)/);
  const num = m ? parseInt(m[1], 10) : 999;
  const bis = /bis/i.test(p) ? 0.5 : 0;
  const suffixe = String(p).replace(/^MPU#?\d+\s*(BIS)?/i, '').trim();
  return [num + bis, suffixe.toLowerCase()];
}

function trierPromotions(labels) {
  return labels.sort((a, b) => {
    const [na, sa] = rangPromotion(a);
    const [nb, sb] = rangPromotion(b);
    return na !== nb ? na - nb : sa.localeCompare(sb);
  });
}

/**
 * Répartition par secteur, en part du portefeuille.
 *
 * Une seule teinte pour toutes les barres : la catégorie est portée par
 * l'étiquette, pas par la couleur. Colorer chaque barre différemment
 * encoderait deux fois la même information et deux bleus de la charte
 * échouent au test de lisibilité (ΔE 9,3, sous le seuil de 15).
 */
function renderSecteurChart(entr) {
  const total = entr.length;
  if (!total) return '<p class="stat-vide">Aucune entreprise dans la sélection.</p>';

  const comptes = {};
  entr.forEach(e => {
    const th = (e.thematiques || []).filter(Boolean);
    if (!th.length) comptes['Non renseignée'] = (comptes['Non renseignée'] || 0) + 1;
    else th.forEach(t => { comptes[t] = (comptes[t] || 0) + 1; });
  });

  const lignes = Object.entries(comptes).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...lignes.map(l => l[1]));

  return `
    <div class="secteur-chart" role="img"
         aria-label="Répartition des entreprises par secteur, en part du portefeuille">
      ${lignes.map(([nom, n], i) => {
        const pct = (n / total) * 100;
        const nonRens = nom === 'Non renseignée';
        return `
          <div class="secteur-row${nonRens ? ' is-vide' : ''}" title="${escapeHtml(nom)} — ${n} entreprise${n > 1 ? 's' : ''} sur ${total}">
            <div class="secteur-nom">${escapeHtml(nom)}</div>
            <div class="secteur-piste">
              <div class="secteur-barre" style="width:${pct.toFixed(1)}%; animation-delay:${i * 60}ms;"></div>
            </div>
            <div class="secteur-valeur"><b>${pct.toFixed(0)} %</b><span>${n}</span></div>
          </div>`;
      }).join('')}
      <p class="secteur-note">
        Part calculée sur ${total} entreprise${total > 1 ? 's' : ''}. Une entreprise
        peut relever de plusieurs secteurs : le total des parts dépasse alors 100 %.
      </p>
    </div>`;
}


// ================================================================
// Communes de la Métropole Aix-Marseille-Provence.
// Sert à distinguer l'ancrage métropolitain du reste du territoire.
// Liste volontairement explicite : un code postal 13 déborde la Métropole
// (Arles, Tarascon) et certaines fiches n'ont pas de code postal du tout.
// ================================================================
const COMMUNES_AMP = new Set(['marseille','aix en provence','aubagne','la ciotat','martigues',
 'vitrolles','marignane','istres','salon de provence','gardanne','allauch','plan de cuques',
 'cassis','carnoux en provence','roquefort la bedoule','ceyreste','gemenos',
 'la penne sur huveaune','les pennes mirabeau','septemes les vallons','bouc bel air','cabries',
 'simiane collongue','mimet','le rove','ensues la redonne','carry le rouet','sausset les pins',
 'chateauneuf les martigues','gignac la nerthe','saint victoret','velaux','ventabren','eguilles',
 'le tholonet','meyreuil','fuveau','peynier','rousset','trets','saint cannat','lambesc',
 'puyricard','berre l etang','rognac','port de bouc','fos sur mer','port saint louis du rhone',
 'miramas','saint chamas','la fare les oliviers','coudoux','rognes','la roque d antheron',
 'peyrolles en provence','jouques','meyrargues','venelles','le puy sainte reparade']);

function communeNormalisee(v) {
  return (v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[-']/g, ' ').trim();
}
function estFrancaise(e) {
  return (e.nationalite || '').toLowerCase().startsWith('fran');
}

function renderStats() {
  const entr = entreprisesStats();
  const total = state.entreprises.length;
  const filtre = entr.length !== total;

  const somme = (f) => entr.reduce((s, e) => s + (f(e) || 0), 0);
  const emplois = somme(e => e.emplois);
  const fonds = somme(e => e.fonds_leves);

  // Deux dispositifs traversent plusieurs éditions : Soft Landing PAC et le
  // programme Comores. Les éclater par édition donnait trois barres pour un
  // même dispositif — et pour les Comores, comptait onze fois des entreprises
  // revenues d'une édition à l'autre. Réunis, ils comptent des ENTREPRISES.
  const familles = [
    { cle: 'SL PAC', test: p => /SL\s*PAC/i.test(p) },
    { cle: 'Comores', test: p => /comores/i.test(p) },
  ];
  const familleDe = p => (familles.find(f => f.test(p)) || {}).cle || p;

  const groupes = new Map();   // libellé -> Set d'entreprises
  const rangs = new Map();     // libellé -> rang de sa première édition
  entr.forEach(e => (e.promotions || []).forEach(p => {
    const cle = familleDe(p);
    if (!groupes.has(cle)) groupes.set(cle, new Set());
    groupes.get(cle).add(e.id + '|' + e.nom);
    const r = rangPromotion(p)[0];
    if (!rangs.has(cle) || r < rangs.get(cle)) rangs.set(cle, r);
  }));

  const passages = entr.reduce((n, e) => n + (e.promotions || []).length, 0);

  const parPromotion = {};
  groupes.forEach((set, cle) => { parPromotion[cle] = set.size; });
  const promotionsOrdonnees = Object.keys(parPromotion)
    .sort((a, b) => (rangs.get(a) - rangs.get(b)) || a.localeCompare(b));
  const nbRegroupees = familles.filter(f => parPromotion[f.cle]).length;

  const francaises = entr.filter(estFrancaise);
  const localisees = francaises.filter(e => e.ville);
  const dansAMP = localisees.filter(e => COMMUNES_AMP.has(communeNormalisee(e.ville)));
  const etrangeres = entr.filter(e => !estFrancaise(e));
  const paysDistincts = new Set(entr.map(e => (e.nationalite || '').trim()).filter(Boolean)).size;

  const levees = entr.map(e => e.fonds_leves || 0).filter(v => v > 0).sort((a, b) => a - b);
  const medianeLevee = levees.length
    ? (levees.length % 2 ? levees[(levees.length - 1) / 2]
       : Math.round((levees[levees.length / 2 - 1] + levees[levees.length / 2]) / 2))
    : 0;
  const TRANCHES = [
    ['moins de 100 k€', v => v < 100000],
    ['100 k€ à 500 k€', v => v >= 100000 && v < 500000],
    ['500 k€ à 1 M€',   v => v >= 500000 && v < 1000000],
    ['1 M€ à 5 M€',     v => v >= 1000000 && v < 5000000],
    ['5 M€ et plus',    v => v >= 5000000],
  ];
  const parTranche = {};
  TRANCHES.forEach(([lib, test]) => {
    const n = levees.filter(test).length;
    if (n) parTranche[lib] = n;
  });

  const fondsParSecteur = {};
  entr.forEach(e => (e.thematiques || []).forEach(t => {
    fondsParSecteur[t] = (fondsParSecteur[t] || 0) + (e.fonds_leves || 0);
  }));

  // Fidélité : combien d'entreprises sont revenues sur une autre promotion.
  const nbPromos = e => new Set(e.promotions || []).size;
  const revenues = entr.filter(e => nbPromos(e) > 1);
  const deuxFois = entr.filter(e => nbPromos(e) === 2).length;
  const troisFois = entr.filter(e => nbPromos(e) >= 3).length;

  // Part d'entreprises étrangères, édition par édition. On rattache chaque
  // entreprise à sa PREMIÈRE édition : c'est son entrée dans le dispositif.
  const numEdition = p => { const m = /MPU#?(\d+)/.exec(p || ''); return m ? +m[1] : null; };
  const parEdition = new Map();
  entr.forEach(e => {
    const eds = (e.promotions || []).map(numEdition).filter(Boolean);
    if (!eds.length) return;
    const ed = Math.min(...eds);
    if (!parEdition.has(ed)) parEdition.set(ed, { total: 0, etrangeres: 0 });
    const b = parEdition.get(ed);
    b.total++;
    if (!estFrancaise(e)) b.etrangeres++;
  });
  const editionsTriees = [...parEdition.keys()].sort((a, b) => a - b);

  const parPays = {};
  entr.forEach(e => {
    const n = (e.nationalite || '').trim();
    if (n) parPays[n] = (parPays[n] || 0) + 1;
  });

  const parVille = {};
  entr.forEach(e => { if (e.ville) parVille[e.ville] = (parVille[e.ville] || 0) + 1; });

  const topFonds = [...entr].filter(e => e.fonds_leves)
    .sort((a, b) => b.fonds_leves - a.fonds_leves).slice(0, 10);

  document.getElementById('app').innerHTML = `
    <div class="p26-page stats-page-2026">
      <div class="p26-aurora"></div>
      <header class="p26-hero p26-reveal">
        <div>
          <h2 class="p26-h2">Statistiques</h2>
          <p class="p26-hero-tagline">
            Le portrait chiffré du portefeuille. Tous les chiffres de cette page se
            recalculent sur la sélection en cours.
          </p>
        </div>
      </header>

      <div class="stats-barre-filtres p26-reveal">
        <button class="btn-filter" onclick="openFilterModal()">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          Filtrer
          ${countActiveFilters() ? `<span class="filter-count-badge">${countActiveFilters()}</span>` : ''}
        </button>
        <div class="stats-portee">
          ${filtre
            ? `<b>${entr.length}</b> entreprise${entr.length > 1 ? 's' : ''} sur ${total} — sélection filtrée`
            : `<b>${total}</b> entreprises — portefeuille complet`}
        </div>
        ${filtre ? `<button class="btn-link" onclick="resetFilters()">Tout afficher</button>` : ''}
      </div>
      ${renderActiveFiltersBar()}

      <div class="stats-summary-2026 p26-reveal">
        <div class="stat-hero-card">
          <div class="stat-hero-value">${entr.length}</div>
          <div class="stat-hero-label">Entreprises du portefeuille</div>
        </div>
        <div class="stat-hero-card">
          <div class="stat-hero-value">${formatMoney(fonds)}</div>
          <div class="stat-hero-label">Fonds levés cumulés</div>
        </div>
        <div class="stat-hero-card">
          <div class="stat-hero-value">${emplois}</div>
          <div class="stat-hero-label">Emplois déclarés</div>
        </div>
      </div>

      <div class="stats-grid-2026">
        <div class="stat-block-2026 p26-reveal" style="grid-column: 1 / -1;">
          <div class="stat-block-head">
            <h3 class="stat-block-title">Répartition par secteur</h3>
            <span class="stat-block-sub">Part du portefeuille</span>
          </div>
          ${renderSecteurChart(entr)}
        </div>

        <div class="stat-block-2026 p26-reveal" style="grid-column: 1 / -1;">
          <div class="stat-block-head">
            <h3 class="stat-block-title">Entreprises par promotion</h3>
            <span class="stat-block-sub">${entr.length} entreprises · ${passages} passages en programme</span>
          </div>
          ${renderBarChart2026(Object.fromEntries(promotionsOrdonnees.map(p => [p, parPromotion[p]])), v => v, { trier: false, labelsComplets: true })}
          <p class="secteur-note">
            Les promotions MPU sont les éditions successives de M'Power Up : elles
            restent comptées une par une, les regrouper sous un seul programme
            effacerait onze ans d'activité derrière une barre unique. Une entreprise
            revenue sur plusieurs éditions apparaît dans chacune.
            <br>
            <b>Soft Landing PAC</b> et <b>Comores</b> font exception : ces deux
            dispositifs traversent les éditions ${'#24'} à ${'#26'} et sont réunis sur une
            seule ligne. Là, ce sont des entreprises qui sont comptées, pas des
            passages — une société revenue d'une édition à l'autre ne compte qu'une fois.
            <br>
            C'est aussi ce qui explique l'écart entre les deux chiffres de
            l'accélérateur : le fichier de suivi recense ${entr.length} entreprises
            distinctes et ${passages} passages en programme. Les deux sont exacts,
            ils ne comptent simplement pas la même chose.
          </p>
        </div>

        <div class="stat-block-2026 p26-reveal" style="grid-column: 1 / -1;">
          <div class="stat-block-head">
            <h3 class="stat-block-title">Ancrage et rayonnement</h3>
            <span class="stat-block-sub">Où sont les entreprises, et d'où elles viennent</span>
          </div>
          <div class="faits-marquants">
            <div class="fait">
              <b>${localisees.length ? Math.round(100 * dansAMP.length / localisees.length) : 0} %</b>
              <span>des entreprises françaises dont la commune est connue sont implantées
              dans la Métropole Aix-Marseille-Provence</span>
              <i>${dansAMP.length} sur ${localisees.length} localisées</i>
            </div>
            <div class="fait">
              <b>${entr.length ? Math.round(100 * etrangeres.length / entr.length) : 0} %</b>
              <span>des entreprises accompagnées sont étrangères, venues se développer
              depuis le territoire</span>
              <i>${etrangeres.length} entreprises · ${paysDistincts} pays représentés</i>
            </div>
          </div>
        </div>

        <div class="stat-block-2026 p26-reveal" style="grid-column: 1 / -1;">
          <div class="stat-block-head">
            <h3 class="stat-block-title">Ouverture internationale, édition par édition</h3>
            <span class="stat-block-sub">Part d'entreprises étrangères à leur entrée dans le dispositif</span>
          </div>
          <div class="secteur-chart">
            ${editionsTriees.map((ed, i) => {
              const b = parEdition.get(ed);
              const pct = b.total ? (100 * b.etrangeres / b.total) : 0;
              return `
                <div class="secteur-row" title="MPU#${String(ed).padStart(2, '0')} — ${b.etrangeres} entreprises étrangères sur ${b.total}">
                  <div class="secteur-nom">MPU#${String(ed).padStart(2, '0')}</div>
                  <div class="secteur-piste">
                    <div class="secteur-barre" style="width:${pct.toFixed(1)}%; animation-delay:${i * 60}ms;"></div>
                  </div>
                  <div class="secteur-valeur"><b>${Math.round(pct)} %</b><span>${b.etrangeres}/${b.total}</span></div>
                </div>`;
            }).join('')}
          </div>
          <p class="secteur-note">
            Chaque entreprise est rattachée à sa première édition. La bascule se lit
            à l'œil nu : marginale jusqu'à MPU#04, l'ouverture internationale devient
            majoritaire à partir de MPU#23, portée par les dispositifs Soft Landing PAC
            et Comores.
          </p>
        </div>

        <div class="stat-block-2026 p26-reveal">
          <div class="stat-block-head">
            <h3 class="stat-block-title">Fidélité au dispositif</h3>
            <span class="stat-block-sub">Entreprises revenues sur une autre promotion</span>
          </div>
          <div class="faits-marquants">
            <div class="fait">
              <b>${revenues.length}</b>
              <span>entreprises sont revenues suivre une seconde promotion, voire une troisième</span>
              <i>${deuxFois} sur deux promotions · ${troisFois} sur trois · soit ${entr.length ? Math.round(100 * revenues.length / entr.length) : 0} % du portefeuille</i>
            </div>
          </div>
          <p class="secteur-note">
            C'est ce qui explique l'écart entre le nombre d'entreprises et celui des
            passages en programme : l'accompagnement se poursuit au-delà d'une seule
            édition pour une entreprise sur huit.
          </p>
        </div>

        <div class="stat-block-2026 p26-reveal">
          <div class="stat-block-head">
            <h3 class="stat-block-title">Taille des levées</h3>
            <span class="stat-block-sub">${levees.length} entreprises ayant levé · médiane ${formatMoney(medianeLevee)}</span>
          </div>
          ${renderBarChart2026(parTranche, v => v, { trier: false })}
          <p class="secteur-note">
            La médiane dit mieux que la moyenne ce que lève une entreprise du
            portefeuille : la moyenne est tirée vers le haut par quelques opérations.
          </p>
        </div>

        <div class="stat-block-2026 p26-reveal">
          <div class="stat-block-head">
            <h3 class="stat-block-title">Fonds levés par secteur</h3>
            <span class="stat-block-sub">Montants cumulés</span>
          </div>
          ${renderBarChart2026(fondsParSecteur, formatMoney)}
        </div>

        <div class="stat-block-2026 p26-reveal">
          <div class="stat-block-head">
            <h3 class="stat-block-title">Répartition par pays</h3>
            <span class="stat-block-sub">Nationalité déclarée</span>
          </div>
          ${renderBarChart2026(parPays)}
        </div>

        <div class="stat-block-2026 p26-reveal">
          <div class="stat-block-head">
            <h3 class="stat-block-title">Implantation</h3>
            <span class="stat-block-sub">Les 8 premières villes</span>
          </div>
          ${renderBarChart2026(Object.fromEntries(Object.entries(parVille).sort((a, b) => b[1] - a[1]).slice(0, 8)))}
        </div>

        <div class="stat-block-2026 p26-reveal" style="grid-column: 1 / -1;">
          <div class="stat-block-head">
            <h3 class="stat-block-title">Les dix plus grosses levées</h3>
            <span class="stat-block-sub">Montants cumulés déclarés</span>
          </div>
          ${renderBarChart2026(Object.fromEntries(topFonds.map(e => [e.nom, e.fonds_leves])), formatMoney)}
        </div>
      </div>
    </div>
  `;

  requestAnimationFrame(() => {
    document.querySelectorAll('.stats-page-2026 .p26-reveal').forEach((el, i) => {
      setTimeout(() => el.classList.add('reveal-in'), 80 * i);
    });
  });
}

function renderBarChart2026(data, formatter = v => v, opts = {}) {
  // Par défaut on classe du plus grand au plus petit. Les promotions font
  // exception : leur ordre chronologique EST l'information.
  const entries = opts.trier === false
    ? Object.entries(data)
    : Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<p style="color:var(--text-muted);font-size:13px;">Pas de données</p>';
  const max = Math.max(...entries.map(e => e[1]));
  return `
    <div class="bar-chart-2026">
      ${entries.map(([label, val], i) => `
        <div class="bar-row-2026">
          <div class="bar-label-2026${opts.labelsComplets ? ' bar-label-2026--complet' : ''}" title="${escapeHtml(label)}">${escapeHtml(opts.labelsComplets || label.length <= 22 ? label : label.slice(0, 20) + '…')}</div>
          <div class="bar-track-2026"><div class="bar-fill-2026" style="width: ${(val / max * 100).toFixed(1)}%; animation-delay: ${i * 40}ms;"></div></div>
          <div class="bar-value-2026">${formatter(val)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderBarChart(data, formatter = v => v) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<p style="color:var(--text-muted);font-size:13px;">Pas de données</p>';
  const max = Math.max(...entries.map(e => e[1]));
  return `
    <div class="bar-chart">
      ${entries.map(([label, val]) => `
        <div class="bar-row">
          <div class="bar-label">${escapeHtml(label.length > 20 ? label.slice(0, 18) + '...' : label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width: ${(val / max * 100).toFixed(1)}%"></div></div>
          <div class="bar-value">${formatter(val)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

// ================================================================
// ESPACE PRIVÉ ALUMNI (démo simple)
// ================================================================

window.PRIVE_MODE = localStorage.getItem('m-historique-prive') === '1';
window.EDIT_MODE = localStorage.getItem('m-historique-edit-mode') === '1';

// ================================================================
// MODE ÉDITION INLINE
// Toggle depuis le bouton "Édition" du header. Active des pencils
// sur les blocs marqués .editable, ouvre des éditeurs contextuels.
// ================================================================

function toggleEditMode() {
  if (!window.PRIVE_MODE) {
    showToast('Connexion privée requise pour éditer', 'error');
    navigate('#/alumni/login');
    return;
  }
  window.EDIT_MODE = !window.EDIT_MODE;
  localStorage.setItem('m-historique-edit-mode', window.EDIT_MODE ? '1' : '0');
  applyEditModeChrome();
  showToast(window.EDIT_MODE ? 'Mode édition activé' : 'Mode édition désactivé', 'success');
  router();
}

function applyEditModeChrome() {
  window.EDIT_MODE = false;
  document.body.dataset.editMode = 'off';
  const btn = document.getElementById('btn-admin');
  if (btn) {
    btn.classList.toggle('is-on', window.EDIT_MODE);
    const label = btn.querySelector('.edit-label');
    if (label) label.textContent = window.EDIT_MODE ? 'Édition ON' : 'Édition';
    btn.title = window.EDIT_MODE ? 'Désactiver le mode édition' : 'Activer le mode édition inline';
  }
}

function editPencil(handler, extra) {
  return '';
}

// ---------- Éditeur inline de card entreprise ----------

function openEntrepriseInlineEditor(id) {
  const e = state.entreprises.find(x => x.id === id);
  if (!e) return;
  modalTags = {
    promotions: [...(e.promotions || [])],
    programmes: [...(e.programmes || [])],
    thematiques: [...(e.thematiques || [])],
  };
  window._editingEntrepriseId = id;
  const overlay = document.getElementById('modal-overlay');
  const logoSrc = e.logo_url || '';
  overlay.innerHTML = `
    <div class="modal modal-compact edit-modal">
      <div class="modal-header">
        <div>
          <h3>Modifier ${escapeHtml(e.nom)}</h3>
          <p class="modal-sub">Édition inline · les changements sont sauvegardés localement</p>
        </div>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>

      <div class="edit-logo-row">
        <div class="edit-logo-preview" id="edit-logo-preview">
          ${logoSrc ? `<img src="${escapeHtml(logoSrc)}" alt="">` : `<span>${escapeHtml(initials(e.nom))}</span>`}
        </div>
        <div class="edit-logo-actions">
          <label class="btn-secondary" style="cursor:pointer;">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Importer un logo
            <input type="file" accept="image/*" style="display:none;" onchange="handleLogoUpload(this, '${escapeHtml(id)}')">
          </label>
          ${logoSrc ? `<button class="btn-link" onclick="clearLogo('${escapeHtml(id)}')">Retirer</button>` : ''}
          <p class="edit-logo-hint">PNG/JPG · 500 Ko max · stocké localement</p>
        </div>
      </div>

      <div class="form-row two-col">
        <div>
          <label>Nom</label>
          <input type="text" id="f-nom" value="${escapeHtml(e.nom || '')}">
        </div>
        <div>
          <label>Ville</label>
          <input type="text" id="f-ville" value="${escapeHtml(e.ville || '')}">
        </div>
      </div>
      <div class="form-row">
        <label>Description courte</label>
        <input type="text" id="f-desc-courte" value="${escapeHtml(e.description_courte || '')}" maxlength="140">
      </div>
      <div class="form-row">
        <label>Description longue</label>
        <textarea id="f-desc-longue" rows="4">${escapeHtml(e.description_longue || '')}</textarea>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Statut</label>
          <select id="f-statut">
            <option ${e.statut==='Active'?'selected':''}>Active</option>
            <option ${e.statut==='Éteinte'?'selected':''}>Éteinte</option>
            <option ${e.statut==='Rachetée'?'selected':''}>Rachetée</option>
            <option ${e.statut==='Pivotée'?'selected':''}>Pivotée</option>
            <option ${e.statut==='Inconnu'?'selected':''}>Inconnu</option>
          </select>
        </div>
        <div>
          <label>Année</label>
          <input type="number" id="f-annee" value="${e.annee_creation || ''}" min="1990" max="2035">
        </div>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Emplois</label>
          <input type="number" id="f-emplois" value="${e.emplois || 0}" min="0">
        </div>
        <div>
          <label>Fonds levés (€)</label>
          <input type="number" id="f-fonds" value="${e.fonds_leves || 0}" min="0">
        </div>
      </div>
      <div class="form-row two-col">
        <div>
          <label>Site web</label>
          <input type="url" id="f-web" value="${escapeHtml(e.site_web || '')}">
        </div>
        <div>
          <label>LinkedIn</label>
          <input type="url" id="f-linkedin" value="${escapeHtml(e.linkedin || '')}">
        </div>
      </div>

      <div class="subsection-title">Identité juridique</div>
      <div class="form-row two-col">
        <div>
          <label>Forme juridique</label>
          <select id="f-forme">
            <option value="">—</option>
            ${['SAS','SARL','EURL','SASU','SA','SCOP','SCIC','Association','Micro-entreprise','Auto-entrepreneur','SNC','SCI','Autre'].map(f =>
              `<option ${e.forme_juridique === f ? 'selected' : ''}>${f}</option>`
            ).join('')}
          </select>
        </div>
        <div>
          <label>Date de création précise</label>
          <input type="date" id="f-date-creation" value="${escapeHtml(e.date_creation || (e.annee_creation ? e.annee_creation + '-01-01' : ''))}">
        </div>
      </div>
      <div class="form-row">
        <label>Adresse (rue + numéro)</label>
        <input type="text" id="f-adresse" value="${escapeHtml(e.adresse || '')}" placeholder="Ex: 45 rue de la République">
      </div>
      <div class="form-row two-col">
        <div>
          <label>Code postal</label>
          <input type="text" id="f-cp" value="${escapeHtml(e.code_postal || '')}" placeholder="13001">
        </div>
        <div>
          <label>Pays</label>
          <input type="text" id="f-pays" value="${escapeHtml(e.pays || 'France')}">
        </div>
      </div>
      <div class="form-row two-col">
        <div>
          <label>SIRET (optionnel)</label>
          <input type="text" id="f-siret" value="${escapeHtml(e.siret || '')}" placeholder="14 chiffres">
        </div>
        <div>
          <label>Nationalité</label>
          <input type="text" id="f-nationalite" value="${escapeHtml(e.nationalite || '')}">
        </div>
      </div>

      <div class="subsection-title">Historique de croissance (optionnel)</div>
      <p class="form-hint">Renseigne l'évolution année par année pour afficher le graphe. Format : <code>2019:5:100000</code> (année:emplois:fonds), une ligne par année.</p>
      <div class="form-row">
        <textarea id="f-historique" rows="4" placeholder="Ex:\n2019:2:0\n2020:5:150000\n2021:12:500000\n2022:22:1200000">${escapeHtml((e.historique || []).map(h => `${h.annee || h.year}:${h.emplois || 0}:${h.fonds || h.fonds_leves || 0}`).join('\n'))}</textarea>
      </div>

      <div class="form-row">
        <label>Promotions (Entrée pour ajouter)</label>
        <div class="tag-input" id="ti-promotions">${renderTagPills(modalTags.promotions, 'promotions')}<input type="text" placeholder="Ex: MPU#26" onkeydown="handleTagInput(event, 'promotions')"></div>
      </div>
      <div class="form-row">
        <label>Programmes</label>
        <div class="tag-input" id="ti-programmes">${renderTagPills(modalTags.programmes, 'programmes')}<input type="text" placeholder="Ex: M'Scale Up" onkeydown="handleTagInput(event, 'programmes')"></div>
      </div>
      <div class="form-row">
        <label>Thématiques</label>
        <div class="tag-input" id="ti-thematiques">${renderTagPills(modalTags.thematiques, 'thematiques')}<input type="text" placeholder="Ex: Économie bleue" onkeydown="handleTagInput(event, 'thematiques')"></div>
      </div>

      <div class="modal-actions">
        <button class="btn-danger" onclick="deleteEntrepriseInline('${escapeHtml(id)}')" title="Supprimer">Supprimer</button>
        <div style="display:flex;gap:8px;">
          <button class="btn-secondary" onclick="closeModal()">Annuler</button>
          <button class="btn-primary" onclick="saveEntrepriseInline('${escapeHtml(id)}')">Enregistrer</button>
        </div>
      </div>
    </div>
  `;
  overlay.classList.add('active');
  overlay.onclick = ev => { if (ev.target === overlay) closeModal(); };
}

function saveEntrepriseInline(id) {
  const e = state.entreprises.find(x => x.id === id);
  if (!e) return;
  e.nom = document.getElementById('f-nom').value.trim() || e.nom;
  e.ville = document.getElementById('f-ville').value.trim();
  e.description_courte = document.getElementById('f-desc-courte').value.trim();
  e.description_longue = document.getElementById('f-desc-longue').value.trim();
  e.statut = document.getElementById('f-statut').value;
  const annee = parseInt(document.getElementById('f-annee').value);
  e.annee_creation = isNaN(annee) ? null : annee;
  e.emplois = parseInt(document.getElementById('f-emplois').value) || 0;
  e.fonds_leves = parseInt(document.getElementById('f-fonds').value) || 0;
  e.site_web = document.getElementById('f-web').value.trim();
  e.linkedin = document.getElementById('f-linkedin').value.trim();

  // Identité juridique
  const fForme = document.getElementById('f-forme');
  if (fForme) e.forme_juridique = fForme.value.trim();
  const fDate = document.getElementById('f-date-creation');
  if (fDate) {
    e.date_creation = fDate.value.trim();
    if (e.date_creation) {
      const y = parseInt(e.date_creation.slice(0, 4));
      if (!isNaN(y) && !e.annee_creation) e.annee_creation = y;
    }
  }
  const fAdr = document.getElementById('f-adresse'); if (fAdr) e.adresse = fAdr.value.trim();
  const fCp = document.getElementById('f-cp'); if (fCp) e.code_postal = fCp.value.trim();
  const fPays = document.getElementById('f-pays'); if (fPays) e.pays = fPays.value.trim();
  const fSir = document.getElementById('f-siret'); if (fSir) e.siret = fSir.value.trim();
  const fNat = document.getElementById('f-nationalite'); if (fNat) e.nationalite = fNat.value.trim();

  // Historique de croissance : parse le textarea "année:emplois:fonds" par ligne
  const fHist = document.getElementById('f-historique');
  if (fHist) {
    const lines = fHist.value.split('\n').map(l => l.trim()).filter(Boolean);
    const parsed = lines.map(l => {
      const [y, em, f] = l.split(':').map(x => (x || '').trim());
      const year = parseInt(y);
      if (!year || year < 1990 || year > 2100) return null;
      return { annee: year, emplois: parseInt(em) || 0, fonds: parseInt(f) || 0 };
    }).filter(Boolean).sort((a, b) => a.annee - b.annee);
    e.historique = parsed;
  }

  e.promotions = [...modalTags.promotions];
  e.programmes = [...modalTags.programmes];
  e.thematiques = [...modalTags.thematiques];
  refreshReferentials();
  saveData({ entreprise: e });
  closeModal();
  showToast('Modifications enregistrées', 'success');
  router();
}

function deleteEntrepriseInline(id) {
  if (!confirm('Supprimer définitivement cette entreprise ?')) return;
  state.entreprises = state.entreprises.filter(x => x.id !== id);
  refreshReferentials();
  saveData();
  if (API_AVAILABLE) apiDeleteEntreprise(id).catch(err => console.warn('API delete failed:', err));
  closeModal();
  showToast('Entreprise supprimée', 'success');
  navigate('#/alumni');
}

async function handleLogoUpload(input, id) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Format non supporté (image uniquement)', 'error');
    input.value = '';
    return;
  }
  // Limite HAUTE à 8 Mo (compression va tout écraser à quelques dizaines de Ko)
  if (file.size > 8 * 1024 * 1024) {
    showToast('Image trop lourde (max 8 Mo à la source)', 'error');
    input.value = '';
    return;
  }
  const e = state.entreprises.find(x => x.id === id);
  if (!e) return;

  showToast('Compression du logo…', 'info', { duration: 1500 });

  let result;
  try {
    result = await compressImageFile(file, 400, 0.85);
  } catch (err) {
    console.error(err);
    showToast('Compression échouée, réessaie avec un autre format', 'error');
    input.value = '';
    return;
  }

  // Backup local du logo précédent (au cas où la nouvelle image casse quelque chose)
  const previousLogo = e.logo_url;
  e.logo_url = result.dataUrl;

  const save = saveData({ entreprise: e });
  if (!save.ok) {
    // Rollback en mémoire
    e.logo_url = previousLogo;
    input.value = '';
    return;
  }

  const preview = document.getElementById('edit-logo-preview');
  if (preview) preview.innerHTML = `<img src="${result.dataUrl}" alt="">`;
  const sizeKb = (result.size / 1024).toFixed(1);
  showToast(`Logo importé (${sizeKb} Ko après compression)`, 'success');
  input.value = '';
}

function clearLogo(id) {
  const e = state.entreprises.find(x => x.id === id);
  if (!e) return;
  e.logo_url = '';
  saveData({ entreprise: e });
  const preview = document.getElementById('edit-logo-preview');
  if (preview) preview.innerHTML = `<span>${escapeHtml(initials(e.nom))}</span>`;
  showToast('Logo retiré', 'success');
}

window.toggleEditMode = toggleEditMode;
window.openEntrepriseInlineEditor = openEntrepriseInlineEditor;
window.saveEntrepriseInline = saveEntrepriseInline;
window.deleteEntrepriseInline = deleteEntrepriseInline;
window.handleLogoUpload = handleLogoUpload;
window.clearLogo = clearLogo;

function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login-page">
      <h2>Espace privé alumni</h2>
      <p>Accès réservé aux alumni de l'Accélérateur M. Renseigne le mot de passe communiqué à ta promotion pour accéder aux fonctionnalités privées.</p>
      <div class="form-row">
        <label>Mot de passe</label>
        <input type="password" id="prive-pw" placeholder="Mot de passe alumni">
      </div>
      <button class="btn-primary" style="width:100%;" onclick="tryLogin()">Se connecter</button>
      <div class="login-hint">
        <strong>Démo :</strong> tape <code>alumni2026</code> pour explorer l'espace privé.
      </div>
    </div>
  `;
  setTimeout(() => document.getElementById('prive-pw').focus(), 100);
  document.getElementById('prive-pw').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') tryLogin();
  });
}

function tryLogin() {
  const pw = document.getElementById('prive-pw').value;
  if (pw === 'alumni2026') {
    window.PRIVE_MODE = true;
    localStorage.setItem('m-historique-prive', '1');
    showToast('Bienvenue dans l\'espace privé', 'success');
    if (location.hash === '#/alumni/prive' || location.hash === '#/alumni/login') {
      renderPrive();
      updateNavActive('prive');
      window.scrollTo(0, 0);
    } else {
      navigate('#/alumni/prive');
    }
  } else {
    showToast('Mot de passe incorrect', 'error');
  }
}

function logoutPrive() {
  window.PRIVE_MODE = false;
  localStorage.removeItem('m-historique-prive');
  showToast('Déconnexion effectuée', 'success');
  navigate('#/');
}

function renderPrive() {
  if (!window.PRIVE_MODE) { renderLogin(); return; }
  const persons = getAllPersons();
  const totalEnt = getOfficialCount();
  const features = [
    { icon: '◐', title: 'Annuaire complet', desc: `${persons.length} alumni identifiés avec leurs coordonnées (email, téléphone) désormais visibles.`, cta: "Voir l'annuaire", action: `navigate('#/alumni/personnes')` },
    { icon: '⌘', title: 'Recrutements', desc: 'Voir quelles start-ups recrutent et contacter les fondateurs directement.', cta: 'Voir les offres', action: `navigate('#/alumni/prive/recrutements')` },
    { icon: '✦', title: 'Assistant M', desc: "Chatbot qui répond aux questions sur l'Accélérateur M, ses programmes et résultats.", cta: "Ouvrir l'assistant", action: `toggleChatbot()` },
    { icon: '◈', title: 'Événements privés', desc: "S'inscrire aux événements réservés aux alumni.", cta: 'Voir les événements', action: `navigate('#/alumni/prive/evenements')` },
    { icon: '★', title: 'Offres partenaires', desc: "Bénéficier des offres et réductions négociées avec les partenaires de l'Accélérateur M.", cta: 'Voir les offres', action: `navigate('#/alumni/prive/offres')` },
    { icon: '☰', title: 'Mes statistiques', desc: 'Suivre l\'évolution de ta start-up, comparer avec ta promo.', cta: 'Voir mes stats', action: `navigate('#/alumni/prive/mes-stats')` },
  ];

  document.getElementById('app').innerHTML = `
    <div class="p26-page prive-page-2026">
      <div class="p26-aurora"></div>
      <header class="p26-hero p26-reveal">
        <div>
          <span class="prive-badge-2026">Mode alumni · Connecté</span>
          <p class="p26-hero-tagline prive-hero-intro">Bienvenue dans ton espace privé. Accès aux coordonnées des ${persons.length} alumni, aux offres partenaires, aux événements et à ta communauté.</p>
        </div>
        <div class="p26-hero-stats">
          <div class="p26-stat"><b>${persons.length}</b><span>alumni</span></div>
          <div class="p26-stat"><b>${totalEnt}</b><span>entreprises</span></div>
          <div class="p26-stat"><b>${features.length}</b><span>features</span></div>
        </div>
      </header>

      <div class="prive-features-2026">
        ${features.map((f, i) => `
          <article class="prive-feature-2026 p26-reveal" style="transition-delay:${i * 60}ms;" onclick="${f.action}">
            <div class="prive-feature-glow"></div>
            <div class="prive-feature-icon">${f.icon}</div>
            <h4>${escapeHtml(f.title)}</h4>
            <p>${escapeHtml(f.desc)}</p>
            <div class="prive-feature-cta">
              <span>${escapeHtml(f.cta)}</span>
              <i>→</i>
            </div>
          </article>
        `).join('')}
      </div>

      <div style="margin-top:32px;text-align:center;">
        <button class="p26-filter-pill" onclick="logoutPrive()" style="padding:10px 20px;">Se déconnecter</button>
      </div>
    </div>
  `;

  requestAnimationFrame(() => {
    document.querySelectorAll('.prive-page-2026 .p26-reveal').forEach((el, i) => {
      setTimeout(() => el.classList.add('reveal-in'), 60 * i);
    });
  });
}

window.tryLogin = tryLogin;
window.logoutPrive = logoutPrive;

// ================================================================
// ESPACE PRIVÉ - Sous-pages
// ================================================================

function requirePrive() {
  if (!window.PRIVE_MODE) { renderLogin(); return false; }
  return true;
}

// ----- RECRUTEMENTS -----

const DEMO_JOBS = [
  { entreprise: 'IADYS', roles: ['Ingénieur robotique', 'Responsable BizDev'], type: ['CDI'], remote: false, urgent: true },
  { entreprise: 'GreenCityzen', roles: ['Développeur IoT'], type: ['CDI', 'Stage'], remote: true, urgent: false },
  { entreprise: 'Cynoia', roles: ['Product Manager'], type: ['CDI'], remote: true, urgent: true },
  { entreprise: 'Anotherway', roles: ['Community Manager', 'Chargé de production'], type: ['CDI', 'Alternance'], remote: false, urgent: false },
  { entreprise: 'Touchify', roles: ['Développeur Full-Stack'], type: ['CDI'], remote: true, urgent: false },
  { entreprise: 'Lily Facilite La Vie', roles: ['UX Designer', 'Chargé de développement'], type: ['Stage'], remote: false, urgent: false },
  { entreprise: 'Green PRAXIS', roles: ['Ingénieur environnement'], type: ['CDI'], remote: false, urgent: true },
  { entreprise: 'Winshot', roles: ['Sales', 'Data Analyst'], type: ['CDI'], remote: true, urgent: false },
];

function renderPriveRecrutements() {
  if (!requirePrive()) return;
  const jobs = DEMO_JOBS.map(j => ({ ...j, entrepriseObj: state.entreprises.find(e => e.nom === j.entreprise) }));

  document.getElementById('app').innerHTML = `
    <div class="prive-sub-page">
      <a class="back-link" href="#/alumni/prive">← Retour à l'espace privé</a>
      <span class="prive-badge">Mode alumni</span>
      <h2>Recrutements en cours</h2>
      <p class="subtitle">${jobs.length} start-ups de la communauté recrutent en ce moment. Contacte les fondateurs directement.</p>

      <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;">
        <button class="btn-secondary" onclick="filterJobs('all')">Tous (${jobs.length})</button>
        <button class="btn-secondary" onclick="filterJobs('urgent')">Urgent (${jobs.filter(j=>j.urgent).length})</button>
        <button class="btn-secondary" onclick="filterJobs('remote')">Télétravail (${jobs.filter(j=>j.remote).length})</button>
        <button class="btn-secondary" onclick="filterJobs('stage')">Stages / Alternance</button>
      </div>

      <div id="jobs-list">
        ${jobs.map(renderJobCard).join('')}
      </div>
    </div>
  `;
}

function renderJobCard(j) {
  const e = j.entrepriseObj;
  return `
    <div class="job-card">
      <div class="job-logo">${escapeHtml(initials(j.entreprise))}</div>
      <div class="job-info">
        <h4>${escapeHtml(j.entreprise)} ${j.urgent ? '<span class="urgent-badge">URGENT</span>' : ''}</h4>
        <div class="meta">${e ? escapeHtml(e.ville || '—') + ' · ' + escapeHtml((e.promotions || []).join(', ')) : ''}</div>
        <div class="role">${j.roles.map(r => escapeHtml(r)).join(' · ')}</div>
        <div class="job-tags">
          ${j.type.map(t => `<span class="tag tag-prog">${escapeHtml(t)}</span>`).join('')}
          ${j.remote ? '<span class="tag tag-promo">Télétravail</span>' : '<span class="tag tag-them">Présentiel</span>'}
        </div>
      </div>
      <div class="job-actions">
        <button class="btn-secondary" onclick="navigate('#/alumni/entreprise/${escapeHtml(e ? e.id : '')}')">Voir la start-up</button>
        <button class="btn-primary" onclick="openMessageTo('${escapeHtml(j.entreprise)}')">Contacter</button>
      </div>
    </div>
  `;
}

function filterJobs(kind) {
  const all = DEMO_JOBS.map(j => ({ ...j, entrepriseObj: state.entreprises.find(e => e.nom === j.entreprise) }));
  let filtered = all;
  if (kind === 'urgent') filtered = all.filter(j => j.urgent);
  else if (kind === 'remote') filtered = all.filter(j => j.remote);
  else if (kind === 'stage') filtered = all.filter(j => j.type.some(t => /stage|altern/i.test(t)));
  document.getElementById('jobs-list').innerHTML = filtered.map(renderJobCard).join('');
}

// ----- MESSAGERIE -----

const MSG_STORAGE = 'm-historique-messages';

function getConversations() {
  const stored = localStorage.getItem(MSG_STORAGE);
  if (stored) return JSON.parse(stored);
  const seed = [
    { id: 'nathanael', name: 'Nathanaël (Accélérateur M)', preview: 'Bienvenue dans la communauté alumni.', time: '10:24',
      messages: [
        { from: 'them', text: 'Bonjour Kelyan, bienvenue dans l\'espace privé alumni de l\'Accélérateur M.', time: '10:20' },
        { from: 'them', text: 'N\'hésite pas si tu as des questions sur la plateforme ou si tu veux mettre en relation avec d\'autres alumni.', time: '10:24' },
      ]
    },
    { id: 'iadys', name: 'Nicolas MANNONI (IADYS)', preview: 'On recrute un ingénieur robotique...', time: 'Hier',
      messages: [
        { from: 'them', text: 'Salut, j\'ai vu que tu venais rejoindre l\'espace alumni.', time: 'Hier 15:12' },
        { from: 'them', text: 'On recrute un ingénieur robotique chez IADYS, tu connais quelqu\'un dans ton réseau qui pourrait être intéressé ?', time: 'Hier 15:14' },
      ]
    },
    { id: 'green', name: 'Alexandre (GreenCityzen)', preview: 'Merci pour ta prise de contact.', time: 'Lun',
      messages: [
        { from: 'me', text: 'Bonjour Alexandre, j\'aimerais échanger sur votre modèle de capteurs urbains, on est en réflexion sur un projet similaire.', time: 'Lun 09:30' },
        { from: 'them', text: 'Merci pour ta prise de contact. Avec plaisir, es-tu disponible cette semaine pour un appel ?', time: 'Lun 11:20' },
      ]
    },
  ];
  localStorage.setItem(MSG_STORAGE, JSON.stringify(seed));
  return seed;
}

function saveConversations(convs) {
  localStorage.setItem(MSG_STORAGE, JSON.stringify(convs));
}

let currentConv = null;

function renderPriveMessagerie() {
  if (!requirePrive()) return;
  const convs = getConversations();
  currentConv = currentConv || convs[0]?.id;
  const active = convs.find(c => c.id === currentConv) || convs[0];

  document.getElementById('app').innerHTML = `
    <div class="prive-sub-page">
      <a class="back-link" href="#/alumni/prive">← Retour à l'espace privé</a>
      <span class="prive-badge">Mode alumni</span>
      <h2>Messagerie interne</h2>
      <p class="subtitle">Échange directement avec les autres alumni de l'Accélérateur M.</p>

      <div class="messaging">
        <div class="msg-sidebar">
          <div class="msg-search">
            <input type="text" placeholder="Rechercher un alumni..." id="msg-search-input">
          </div>
          ${convs.map(c => `
            <div class="msg-conv ${c.id === active?.id ? 'active' : ''}" onclick="selectConv('${c.id}')">
              <div class="avatar">${escapeHtml(initials(c.name))}</div>
              <div class="info">
                <div class="name">${escapeHtml(c.name)}</div>
                <div class="preview">${escapeHtml(c.preview)}</div>
              </div>
              <div class="time">${escapeHtml(c.time)}</div>
            </div>
          `).join('')}
        </div>
        <div class="msg-thread">
          ${active ? `
            <div class="msg-header">
              <div class="avatar" style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#cfe9f1,#a5d5e3);color:#005E78;font-weight:700;display:flex;align-items:center;justify-content:center;">${escapeHtml(initials(active.name))}</div>
              <div>
                <h4>${escapeHtml(active.name)}</h4>
                <div class="meta">En ligne · Alumni Accélérateur M</div>
              </div>
            </div>
            <div class="msg-body" id="msg-body">
              ${active.messages.map(m => `
                <div class="msg-bubble ${m.from === 'me' ? 'sent' : 'received'}">
                  ${escapeHtml(m.text)}
                  <div class="msg-time">${escapeHtml(m.time)}</div>
                </div>
              `).join('')}
            </div>
            <div class="msg-input">
              <input type="text" id="msg-input" placeholder="Écris un message..." onkeydown="handleMsgSend(event)">
              <button class="btn-primary" onclick="sendMessage()">Envoyer</button>
            </div>
          ` : '<div class="msg-empty">Sélectionne une conversation</div>'}
        </div>
      </div>
    </div>
  `;
  setTimeout(() => {
    const body = document.getElementById('msg-body');
    if (body) body.scrollTop = body.scrollHeight;
  }, 50);
}

function selectConv(id) { currentConv = id; renderPriveMessagerie(); }

function handleMsgSend(ev) { if (ev.key === 'Enter') sendMessage(); }

function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  const convs = getConversations();
  const conv = convs.find(c => c.id === currentConv);
  if (!conv) return;
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  conv.messages.push({ from: 'me', text, time });
  conv.preview = text;
  conv.time = 'À l\'instant';
  saveConversations(convs);
  input.value = '';
  renderPriveMessagerie();
}

function openMessageTo(entrepriseName) {
  const convs = getConversations();
  const id = slugify(entrepriseName);
  let conv = convs.find(c => c.id === id);
  if (!conv) {
    conv = {
      id, name: entrepriseName, preview: 'Nouvelle conversation', time: 'Maintenant',
      messages: [{ from: 'me', text: `Bonjour, je vous contacte via M alumni au sujet de votre annonce de recrutement.`, time: 'Maintenant' }]
    };
    convs.unshift(conv);
    saveConversations(convs);
  }
  currentConv = id;
  navigate('#/alumni/prive/messagerie');
}

// ----- ÉVÉNEMENTS -----

const DEMO_EVENTS = [
  { day: 12, month: 'JUIL', year: 2026, title: 'Demoday MPU#26', desc: 'Présentation des 18 start-ups de la promotion aux investisseurs, partenaires et alumni.', location: 'Accélérateur M, Marseille', time: '17h-21h', capacity: '200 places', mine: false },
  { day: 24, month: 'JUIL', year: 2026, title: 'Afterwork alumni d\'été', desc: 'Retrouvailles annuelles de la communauté alumni autour d\'un cocktail sur la Corniche.', location: 'Rooftop Marseille', time: '19h-23h', capacity: '80 places', mine: true },
  { day: 5, month: 'SEPT', year: 2026, title: 'Workshop levée de fonds', desc: 'Session de coaching collectif animée par 3 investisseurs. Réservée aux start-ups en phase de scale.', location: 'Accélérateur M', time: '9h-13h', capacity: '25 places', mine: false },
  { day: 18, month: 'SEPT', year: 2026, title: 'Rentrée alumni + pitch new promo', desc: 'Bienvenue à la promotion MPU#27 et présentation croisée avec les alumni.', location: 'Accélérateur M', time: '18h-22h', capacity: '150 places', mine: false },
  { day: 10, month: 'OCT', year: 2026, title: 'Masterclass IA & startups', desc: 'Comment intégrer l\'IA dans son business model, avec 4 alumni qui ont pivoté sur l\'IA.', location: 'En ligne + Marseille', time: '18h-20h', capacity: 'Illimité', mine: false },
];

function renderPriveEvenements() {
  if (!requirePrive()) return;
  const events = DEMO_EVENTS;
  const myRsvps = JSON.parse(localStorage.getItem('m-historique-rsvps') || '{}');

  document.getElementById('app').innerHTML = `
    <div class="prive-sub-page">
      <a class="back-link" href="#/alumni/prive">← Retour à l'espace privé</a>
      <span class="prive-badge">Mode alumni</span>
      <h2>Événements privés</h2>
      <p class="subtitle">Événements réservés à la communauté Accélérateur M. Inscris-toi en un clic.</p>

      ${events.map((ev, i) => {
        const key = `${ev.day}-${ev.month}`;
        const rsvp = myRsvps[key];
        return `
          <div class="event-card">
            <div class="event-date">
              <div class="day">${ev.day}</div>
              <div class="month">${escapeHtml(ev.month)}</div>
            </div>
            <div class="event-info">
              <h4>${escapeHtml(ev.title)}</h4>
              <div class="meta">${escapeHtml(ev.location)} · ${escapeHtml(ev.time)} · ${escapeHtml(ev.capacity)}</div>
              <div class="desc">${escapeHtml(ev.desc)}</div>
            </div>
            <div>
              ${rsvp ? `
                <span class="tag tag-prog" style="padding:8px 14px;">Inscrit</span>
                <button class="btn-secondary" style="display:block;margin-top:8px;font-size:12px;" onclick="rsvpEvent('${key}', false)">Annuler</button>
              ` : `
                <button class="btn-primary" onclick="rsvpEvent('${key}', true)">S'inscrire</button>
              `}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function rsvpEvent(key, register) {
  const rsvps = JSON.parse(localStorage.getItem('m-historique-rsvps') || '{}');
  if (register) rsvps[key] = true;
  else delete rsvps[key];
  localStorage.setItem('m-historique-rsvps', JSON.stringify(rsvps));
  showToast(register ? 'Inscription confirmée' : 'Inscription annulée', 'success');
  renderPriveEvenements();
}

// ----- OFFRES PARTENAIRES -----

const DEMO_OFFERS = [
  { partner: 'AWS Activate', title: '5 000 $ de crédits cloud offerts', desc: 'Programme startup AWS avec support technique premium.', code: 'MHIST-AWS-2026' },
  { partner: 'Notion', title: '6 mois de Notion Plus gratuits', desc: 'Notion Plus pour toute l\'équipe (jusqu\'à 10 personnes).', code: 'ACC-M-NOTION' },
  { partner: 'HubSpot', title: '90% de réduction sur HubSpot Starter', desc: 'Premier CRM + Marketing Hub pour lancer ton acquisition.', code: 'STARTUP-MSTORE' },
  { partner: 'Figma', title: 'Plan Professional offert 1 an', desc: 'Pour les équipes design de moins de 5 personnes.', code: 'FIG-ACCM-2026' },
  { partner: 'Cabinet Legal Startup', title: '3 heures de conseil juridique offertes', desc: 'Statuts, pacte d\'associés, CGU/CGV, RGPD.', code: 'ACCM-JURI-3H' },
  { partner: 'La French Tech', title: 'Accès prioritaire aux événements FT', desc: 'French Tech Nights, salons, missions internationales.', code: 'ACCM-FT-VIP' },
];

function renderPriveOffres() {
  if (!requirePrive()) return;
  document.getElementById('app').innerHTML = `
    <div class="prive-sub-page">
      <a class="back-link" href="#/alumni/prive">← Retour à l'espace privé</a>
      <span class="prive-badge">Mode alumni</span>
      <h2>Offres partenaires</h2>
      <p class="subtitle">Réductions et avantages négociés par l'Accélérateur M pour la communauté alumni. Clique sur un code pour le copier.</p>

      ${DEMO_OFFERS.map(o => `
        <div class="offer-card">
          <div class="offer-icon">${escapeHtml(o.partner[0])}</div>
          <div class="offer-info">
            <div class="partner">${escapeHtml(o.partner)}</div>
            <h4>${escapeHtml(o.title)}</h4>
            <div class="desc">${escapeHtml(o.desc)}</div>
          </div>
          <div class="offer-code" onclick="copyCode('${escapeHtml(o.code)}')" title="Cliquer pour copier">${escapeHtml(o.code)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function copyCode(code) {
  navigator.clipboard.writeText(code).then(() => {
    showToast('Code copié : ' + code, 'success');
  });
}

// ----- MES STATS PERSOS -----

function renderPriveStats() {
  if (!requirePrive()) return;
  const savedId = localStorage.getItem('m-historique-mon-alumni');
  const monEntreprise = savedId ? state.entreprises.find(e => e.id === savedId) : null;

  const moyenneEmplois = Math.round(state.entreprises.reduce((s, e) => s + e.emplois, 0) / state.entreprises.length);
  const moyenneFonds = Math.round(state.entreprises.reduce((s, e) => s + e.fonds_leves, 0) / state.entreprises.length);

  let comparaisonHtml = '';
  if (monEntreprise) {
    const meilleurEmplois = monEntreprise.emplois > moyenneEmplois;
    const meilleurFonds = monEntreprise.fonds_leves > moyenneFonds;
    const mapromo = monEntreprise.promotions?.[0];
    const promoBoites = state.entreprises.filter(e => (e.promotions || []).includes(mapromo));
    const monRangEmplois = [...state.entreprises].sort((a, b) => b.emplois - a.emplois).findIndex(e => e.id === monEntreprise.id) + 1;

    comparaisonHtml = `
      <h3 style="margin-top:24px;font-size:16px;">Ma start-up : ${escapeHtml(monEntreprise.nom)}</h3>
      <div class="compare-grid">
        <div class="compare-card">
          <div class="label">Emplois créés</div>
          <div class="value">${monEntreprise.emplois}</div>
          <div class="comp ${meilleurEmplois ? 'better' : ''}">${meilleurEmplois ? '↑' : '↓'} vs moyenne (${moyenneEmplois})</div>
        </div>
        <div class="compare-card">
          <div class="label">Fonds levés</div>
          <div class="value">${formatMoney(monEntreprise.fonds_leves)}</div>
          <div class="comp ${meilleurFonds ? 'better' : ''}">${meilleurFonds ? '↑' : '↓'} vs moyenne (${formatMoney(moyenneFonds)})</div>
        </div>
        <div class="compare-card">
          <div class="label">Mon rang emplois</div>
          <div class="value">#${monRangEmplois}</div>
          <div class="comp">sur ${state.entreprises.length} start-ups</div>
        </div>
      </div>

      <h3 style="margin-top:24px;font-size:16px;">Ma promotion : ${escapeHtml(mapromo || '—')}</h3>
      <div class="compare-grid">
        <div class="compare-card">
          <div class="label">Boîtes de ma promo</div>
          <div class="value">${promoBoites.length}</div>
          <div class="comp">dont la mienne</div>
        </div>
        <div class="compare-card">
          <div class="label">Total emplois promo</div>
          <div class="value">${promoBoites.reduce((s, e) => s + e.emplois, 0)}</div>
          <div class="comp">dont ${monEntreprise.emplois} pour toi</div>
        </div>
        <div class="compare-card">
          <div class="label">Total fonds promo</div>
          <div class="value">${formatMoney(promoBoites.reduce((s, e) => s + e.fonds_leves, 0))}</div>
          <div class="comp">dont ${formatMoney(monEntreprise.fonds_leves)} pour toi</div>
        </div>
      </div>
    `;
  }

  document.getElementById('app').innerHTML = `
    <div class="prive-sub-page">
      <a class="back-link" href="#/alumni/prive">← Retour à l'espace privé</a>
      <span class="prive-badge">Mode alumni</span>
      <h2>Mes statistiques</h2>
      <p class="subtitle">Suis ton évolution et compare avec les autres alumni de ta promotion.</p>

      <div class="mes-stats-profile">
        <label>Sélectionne ta start-up pour afficher tes stats personnalisées</label>
        <select id="mon-alumni-select" onchange="selectMonAlumni(this.value)">
          <option value="">-- Choisir ma start-up --</option>
          ${state.entreprises.map(e => `<option value="${escapeHtml(e.id)}" ${e.id === savedId ? 'selected' : ''}>${escapeHtml(e.nom)}</option>`).join('')}
        </select>
      </div>

      ${comparaisonHtml || '<div class="empty-state"><h4>Choisis ta start-up pour voir tes statistiques personnalisées.</h4></div>'}
    </div>
  `;
}

function selectMonAlumni(id) {
  if (id) localStorage.setItem('m-historique-mon-alumni', id);
  else localStorage.removeItem('m-historique-mon-alumni');
  renderPriveStats();
}

window.filterJobs = filterJobs;
window.selectConv = selectConv;
window.sendMessage = sendMessage;
window.handleMsgSend = handleMsgSend;
window.openMessageTo = openMessageTo;
window.rsvpEvent = rsvpEvent;
window.copyCode = copyCode;
window.selectMonAlumni = selectMonAlumni;

// ================================================================
// STAT MODAL — Petites fenêtres de détail sur la page Carte
// ================================================================

function openStatModal(type) {
  const overlay = document.getElementById('modal-overlay');
  let html = '';

  if (type === 'entreprises') {
    const list = [...state.entreprises].sort((a, b) => (a.nom || '').localeCompare(b.nom || ''));
    html = `
      <div class="modal modal-compact">
        <div class="modal-header">
          <div>
            <h3>${list.length} entreprises accompagnées</h3>
            <p class="modal-sub">Toutes les start-ups du portfolio Accélérateur M</p>
          </div>
          <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <input type="text" class="stat-search" placeholder="Rechercher une entreprise..." oninput="filterStatList(this.value)">
        <div class="stat-list" id="stat-list">
          ${list.map(e => `
            <a class="stat-item" href="#/alumni/entreprise/${escapeHtml(e.id)}" onclick="closeModal()">
              <div class="stat-item-avatar">${escapeHtml(initials(e.nom))}</div>
              <div class="stat-item-info">
                <div class="stat-item-name">${escapeHtml(e.nom)}</div>
                <div class="stat-item-meta">${escapeHtml(e.ville || '—')} · ${escapeHtml((e.promotions || [])[0] || '—')}</div>
              </div>
              <span class="stat-item-arrow">›</span>
            </a>
          `).join('')}
        </div>
      </div>
    `;
  } else if (type === 'pays') {
    const counts = computeCountryCounts();
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    html = `
      <div class="modal modal-compact">
        <div class="modal-header">
          <div>
            <h3>${entries.length} pays représentés</h3>
            <p class="modal-sub">Répartition internationale des start-ups accompagnées</p>
          </div>
          <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <div class="stat-list">
          ${entries.map(([iso, count]) => {
            const name = COUNTRY_NAMES[iso] || iso;
            const pct = Math.round(count / state.entreprises.length * 100);
            return `
              <div class="stat-item stat-item-country">
                <div class="stat-country-flag" style="background:${colorForCount(count)};"></div>
                <div class="stat-item-info">
                  <div class="stat-item-name">${escapeHtml(name)}</div>
                  <div class="stat-item-meta">${count} start-up${count > 1 ? 's' : ''} · ${pct}% du total</div>
                </div>
                <div class="stat-item-bar-wrap">
                  <div class="stat-item-bar" style="width:${pct}%;"></div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  } else if (type === 'villes') {
    const byCity = {};
    state.entreprises.forEach(e => {
      if (!e.ville) return;
      if (!byCity[e.ville]) byCity[e.ville] = [];
      byCity[e.ville].push(e);
    });
    const entries = Object.entries(byCity).sort((a, b) => b[1].length - a[1].length);
    const localises = entries.filter(([v]) => CITY_COORDS[v]).length;
    html = `
      <div class="modal modal-compact">
        <div class="modal-header">
          <div>
            <h3>${entries.length} villes différentes</h3>
            <p class="modal-sub">${localises} géolocalisées sur la carte · ${entries.length - localises} restantes à ajouter</p>
          </div>
          <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <input type="text" class="stat-search" placeholder="Rechercher une ville..." oninput="filterStatList(this.value)">
        <div class="stat-list" id="stat-list">
          ${entries.map(([ville, entrs]) => {
            const localise = !!CITY_COORDS[ville];
            const pays = CITY_TO_COUNTRY[ville];
            return `
              <div class="stat-item ${localise ? '' : 'stat-item-warn'}">
                <div class="stat-city-pin ${localise ? 'ok' : 'ko'}"></div>
                <div class="stat-item-info">
                  <div class="stat-item-name">${escapeHtml(ville)}</div>
                  <div class="stat-item-meta">
                    ${entrs.length} start-up${entrs.length > 1 ? 's' : ''}
                    ${pays ? ' · ' + escapeHtml(COUNTRY_NAMES[pays] || pays) : ''}
                    ${!localise ? ' · non géolocalisée' : ''}
                  </div>
                </div>
                <span class="stat-item-badge">${entrs.length}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  overlay.innerHTML = html;
  overlay.classList.add('active');
  overlay.onclick = ev => { if (ev.target === overlay) closeModal(); };
}

function filterStatList(q) {
  q = q.toLowerCase().trim();
  const list = document.getElementById('stat-list');
  if (!list) return;
  [...list.children].forEach(item => {
    const name = item.querySelector('.stat-item-name')?.textContent.toLowerCase() || '';
    const meta = item.querySelector('.stat-item-meta')?.textContent.toLowerCase() || '';
    item.style.display = (name.includes(q) || meta.includes(q)) ? '' : 'none';
  });
}

window.openStatModal = openStatModal;
window.filterStatList = filterStatList;

// ================================================================
// ADMIN - CHIFFRES CLÉS
// ================================================================

function renderChiffresCles() {
  const s = state.meta || calculeMeta(state.entreprises);
  const calc = state.meta || {};
  return `
    <div class="chiffres-page">
      <div class="chiffres-header">
        <div>
          <h3 class="chiffres-title">Chiffres clés officiels</h3>
          <p class="chiffres-sub">Ces chiffres sont affichés dans les stats principales de la page d'accueil et de la page Statistiques. Modifie-les quand ton tuteur te communique les nouveaux chiffres officiels.</p>
        </div>
        <button class="btn-secondary btn-reset-official" onclick="resetChiffresOfficiels()">Réinitialiser aux valeurs Excel</button>
      </div>

      <div class="chiffres-grid">
        <div class="chiffre-field">
          <label>Startups accompagnées</label>
          <input type="number" id="cf-entreprises" value="${s.total_entreprises}" min="0">
          <div class="chiffre-help">Cumul des participations sur toutes les promotions. Valeur Excel : 199.</div>
        </div>

        <div class="chiffre-field">
          <label>Emplois créés</label>
          <input type="number" id="cf-emplois" value="${s.total_emplois}" min="0">
          <div class="chiffre-help">Nombre total d'emplois créés par les startups accompagnées. Valeur Excel : 230.</div>
        </div>

        <div class="chiffre-field">
          <label>Fonds levés (en euros)</label>
          <input type="number" id="cf-fonds" value="${s.total_fonds}" min="0" step="1000">
          <div class="chiffre-help">Montant total en euros. Sera affiché en M€ ou K€ automatiquement. Valeur Excel : 73 671 800 €.</div>
        </div>

        <div class="chiffre-field">
          <label>Promotions</label>
          <input type="number" id="cf-promotions" value="${s.total_promotions}" min="0">
          <div class="chiffre-help">Nombre de promotions principales (MPU#01 à MPU#26). Valeur Excel : 11.</div>
        </div>

        <div class="chiffre-field">
          <label>Startups éteintes</label>
          <input type="number" id="cf-eteintes" value="${s.startups_eteintes || 0}" min="0">
          <div class="chiffre-help">Nombre de startups qui ont fermé. Utilisé dans la page Statistiques. Valeur Excel : 35.</div>
        </div>
      </div>

      <div class="chiffres-actions">
        <button class="btn-primary" onclick="saveChiffresCles()">Enregistrer les modifications</button>
      </div>

      <div class="chiffres-comparaison">
        <div class="chiffres-comparaison-title">Chiffres calculés à titre indicatif</div>
        <div class="chiffres-comparaison-list">
          <div><span class="key">Entreprises uniques dans la base :</span> <strong>${calc.entreprises_uniques || state.entreprises.length}</strong></div>
          <div><span class="key">Emplois cumulés depuis les fiches :</span> <strong>${calc.emplois_calcules || 0}</strong></div>
          <div><span class="key">Fonds cumulés depuis les fiches :</span> <strong>${formatMoney(calc.fonds_calcules || 0)}</strong></div>
          <div><span class="key">Sous-cohortes détectées :</span> <strong>${state.promotions.length}</strong></div>
        </div>
        <p class="chiffres-comparaison-note">
          Ces chiffres sont calculés automatiquement à partir des fiches entreprises. Ils peuvent différer légèrement des chiffres officiels car ils reflètent le contenu exact de la base et non le compte cumulé de communication.
        </p>
      </div>
    </div>
  `;
}

function saveChiffresCles() {
  const s = {
    total_entreprises: parseInt(document.getElementById('cf-entreprises').value) || 0,
    total_emplois: parseInt(document.getElementById('cf-emplois').value) || 0,
    total_fonds: parseInt(document.getElementById('cf-fonds').value) || 0,
    total_promotions: parseInt(document.getElementById('cf-promotions').value) || 0,
    startups_eteintes: parseInt(document.getElementById('cf-eteintes').value) || 0,
  };
  state.meta = calculeMeta(state.entreprises);
  saveData();
  showToast('Chiffres officiels enregistrés', 'success');
  renderAdmin();
}

function resetChiffresOfficiels() {
  if (!confirm('Réinitialiser aux valeurs du fichier Excel d\'origine ?')) return;
  state.meta = calculeMeta(state.entreprises);
  saveData();
  showToast('Chiffres réinitialisés aux valeurs Excel', 'success');
  renderAdmin();
}

window.saveChiffresCles = saveChiffresCles;
window.resetChiffresOfficiels = resetChiffresOfficiels;

// ================================================================
// FILTER MODAL (refonte minimaliste : sidebar → modal)
// ================================================================
function countActiveFilters() {
  return ['programmes', 'promotions', 'thematiques', 'statuts', 'villes']
    .reduce((n, k) => n + filters[k].size, 0);
}

function openFilterModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="modal filter-modal">
      <div class="modal-header">
        <h3>Filtrer les entreprises</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      ${renderFilterGroup('Programme', 'programmes', state.programmes, 'zap')}
      ${renderFilterGroup('Promotion', 'promotions', state.promotions, 'calendar')}
      ${renderFilterGroup('Thématique', 'thematiques', state.thematiques, 'layers')}
      ${renderFilterGroup('Statut', 'statuts', ['Active', 'Éteinte', 'Inconnu'], 'activity')}
      ${renderFilterGroup('Ville', 'villes', state.villes.slice(0, 15), 'map-pin')}
      <div class="modal-actions">
        <button class="btn-secondary" onclick="resetFiltersAndClose()">Tout réinitialiser</button>
        <button class="btn-primary" onclick="closeModal()">Appliquer</button>
      </div>
    </div>
  `;
  overlay.classList.add('active');
  overlay.onclick = ev => { if (ev.target === overlay) closeModal(); };
  bindFilterEvents();
}

function resetFiltersAndClose() {
  filters = { search: filters.search, promotions: new Set(), programmes: new Set(), thematiques: new Set(), statuts: new Set(), villes: new Set() };
  closeModal();
  renderHome();
}

window.openFilterModal = openFilterModal;
window.countActiveFilters = countActiveFilters;
window.resetFiltersAndClose = resetFiltersAndClose;

// ================================================================
// CHATBOT ASSISTANT M
// Base de connaissance + scoring par mots-clés
// ================================================================

const CHATBOT_KNOWLEDGE = [
  {
    keywords: ['bonjour', 'salut', 'hello', 'coucou', 'hey'],
    response: () => "Bonjour ! Je suis l'assistant de l'Accélérateur M. Je peux répondre à tes questions sur nos programmes, nos startups accompagnées, ou tout ce qui touche au fonctionnement d'un accélérateur. Que veux-tu savoir ?"
  },
  {
    keywords: ["qu'est-ce qu'un accélérateur", "c'est quoi un accélérateur", "définition accélérateur", "role d'un accélérateur", "rôle d'un accélérateur"],
    response: () => "Un accélérateur startup accompagne des entreprises déjà lancées pour les faire grandir plus vite. Contrairement à un incubateur qui aide à créer une entreprise depuis zéro, l'accélérateur intervient après le lancement pour accompagner le passage à l'échelle. L'accompagnement comprend du mentorat expert, l'accès à un réseau d'investisseurs et de partenaires, du financement dans certains cas, et un programme intensif sur plusieurs mois."
  },
  {
    keywords: ["différence entre accélérateur et incubateur", "incubateur", "incubation", "difference incubateur"],
    response: () => "Un incubateur accompagne dès l'idée jusqu'au lancement de l'entreprise. Un accélérateur intervient après le lancement pour aider à grandir vite. Deux stades différents dans la vie d'une startup. L'Accélérateur M propose principalement des programmes d'accélération pour des start-ups qui ont déjà leur produit et leurs premiers clients, plus quelques programmes en amont comme IncubMe."
  },
  {
    keywords: ["combien de startups", "combien d'entreprises", "combien de start-ups accompagnées", "combien accompagnées"],
    response: () => `L'Accélérateur M a accompagné ${state.meta.total_entreprises} startups depuis sa création. Ces start-ups ont créé ${state.meta.total_emplois} emplois directs et levé ${formatMoney(state.meta.total_fonds)} au total. Tu peux les explorer une par une dans le Portfolio.`
  },
  {
    keywords: ["quels programmes", "programme", "quels sont vos programmes"],
    response: () => "L'Accélérateur M propose plusieurs programmes selon le stade et le secteur de la startup : M'Scale Up (accélération pour scale-ups), M'Plug In, M'Power Up, IncubMe (incubation), Med'Innovant (santé), French Tech Tremplin, FTT Prépa, plus des programmes internationaux comme Comores et SL PAC. Chaque programme est adapté à un profil précis."
  },
  {
    keywords: ["postuler", "candidater", "candidature", "s'inscrire", "rejoindre", "comment intégrer"],
    response: () => "Pour postuler à un programme, tu peux passer par le site officiel de l'Accélérateur M et remplir le formulaire de candidature correspondant. Les critères principaux : avoir une entreprise créée, un produit ou service déjà commercialisé, et une ambition de croissance. Chaque programme a ses propres sessions d'ouverture, souvent une ou deux par an."
  },
  {
    keywords: ["où êtes-vous", "où sont vos", "où se trouve", "localisation", "adresse", "basé à", "situé", "marseille"],
    response: () => "L'Accélérateur M est basé à Marseille, dans la région Sud PACA. Ses locaux accueillent les startups en présentiel pour les programmes. Des sessions à distance sont possibles pour les start-ups internationales, notamment celles des programmes Comores ou SL PAC."
  },
  {
    keywords: ["combien ça coûte", "prix", "tarif", "gratuit", "payant", "quel coût", "coût du programme"],
    response: () => "Les programmes de l'Accélérateur M sont en majorité gratuits pour les startups sélectionnées. Certains programmes peuvent prendre un pourcentage minoritaire au capital (généralement 3 à 8 %), et d'autres fonctionnent sur un modèle mixte avec un forfait modeste. Les modalités précises sont communiquées lors de la candidature."
  },
  {
    keywords: ["combien de temps", "durée du programme", "durée des programmes", "combien de mois"],
    response: () => "Les programmes durent entre 3 et 9 mois selon le format. M'Scale Up dure environ 6 mois avec un rythme intensif. Les programmes de préparation comme FTT Prépa sont plus courts, autour de 3 mois. Les programmes internationaux ont leur propre cadence."
  },
  {
    keywords: ["thématique", "secteur", "domaine d'expertise", "spécialité", "quels secteurs"],
    response: () => "L'Accélérateur M est spécialisé dans plusieurs thématiques : Économie bleue (mer, ports), Qualité de vie et urbanisme méditerranéen, Santé, bien-être et prévention, Industries culturelles et créatives (ICC), et Innovation à impact social. Ces thématiques reflètent son ancrage territorial méditerranéen."
  },
  {
    keywords: ["mission", "objectif", "but", "vocation"],
    response: () => "La mission de l'Accélérateur M est d'accélérer la métamorphose entrepreneuriale des territoires pour une société plus inclusive, responsable, créative, innovante et solidaire. En pratique, cela signifie accompagner des startups à impact positif sur leur territoire, en priorité en Méditerranée."
  },
  {
    keywords: ["levée de fonds", "levée", "combien levé", "montant levé", "fonds levés", "investissement"],
    response: () => `Les startups accompagnées par l'Accélérateur M ont levé au total ${formatMoney(state.meta.total_fonds)}. L'accélérateur ne finance pas directement les startups mais les met en relation avec des investisseurs, business angels et fonds de capital-risque via son réseau.`
  },
  {
    keywords: ["emplois créés", "combien d'emplois", "emplois", "création d'emplois", "recrutement"],
    response: () => `Les startups accompagnées ont créé ${state.meta.total_emplois} emplois directs à ce jour. Beaucoup continuent à recruter, tu peux consulter les offres dans l'espace privé alumni ou contacter directement les fondateurs des start-ups qui t'intéressent.`
  },
  {
    keywords: ["mentorat", "mentor", "coach", "accompagnement", "comment fonctionne l'accompagnement"],
    response: () => "L'accompagnement combine du mentorat individuel avec des experts et entrepreneurs séniors, plus des sessions collectives sur les sujets clés : stratégie, produit, croissance commerciale, financement, ressources humaines, juridique. Chaque startup est suivie par une équipe dédiée tout au long du programme, avec un rythme intensif."
  },
  {
    keywords: ["contacter", "contact", "joindre", "vous joindre", "envoyer un mail", "email"],
    response: () => "Pour contacter l'Accélérateur M, passe par leur site officiel accelerateur-m.com ou par leur page LinkedIn. Pour les questions spécifiques à cette plateforme M alumni, tu peux t'adresser à l'équipe stage de l'Accélérateur."
  },
  {
    keywords: ["alumni", "anciens", "ancienne", "diplômés", "portfolio", "quelles startups", "annuaire"],
    response: () => `L'Accélérateur M compte plus de ${state.meta.total_entreprises} startups alumni. Tu peux consulter la liste complète dans l'onglet Portfolio ou explorer l'annuaire des fondateurs dans l'onglet Alumni. Tu peux aussi filtrer par programme, promotion, thématique ou ville.`
  },
  {
    keywords: ["success story", "réussite", "success", "exemple de startup", "startups connues", "belles histoires"],
    response: () => "Quelques success stories notables : IADYS (robotique de nettoyage marin, 25,7 M€ levés), Green Technologie (mobilité électrique, 4,6 M€), Lily Facilite La Vie (aide au handicap, 4,1 M€), Anotherway (hygiène durable, 1,2 M€), Cynoia, Touchify, GreenCityzen. Explore le Portfolio pour découvrir toutes les start-ups."
  },
  {
    keywords: ["taux de survie", "taux de mortalité", "taux d'échec", "combien ont échoué", "combien ont fermé"],
    response: () => {
      const total = state.meta.total_entreprises;
      const eteintes = state.meta.startups_eteintes || 35;
      const survie = Math.round((1 - eteintes / total) * 100);
      return `Sur ${total} startups accompagnées, environ ${eteintes} ont cessé leur activité, ce qui donne un taux de survie d'environ ${survie} %. C'est un excellent chiffre pour l'écosystème startup, où la mortalité classique est bien plus élevée.`;
    }
  },
  {
    keywords: ["m historique", "cette plateforme", "ce site", "à quoi sert ce site"],
    response: () => "M alumni est le portfolio dynamique des start-ups accompagnées par l'Accélérateur M depuis 2014. Tu peux y explorer les alumni par programme, promotion, thématique ou ville, consulter la timeline chronologique de l'accélérateur, voir la carte des alumni dans le monde, ou accéder aux statistiques globales. L'espace privé propose des services exclusifs pour les alumni. Le portail M startups (en construction) sera dédié aux start-ups actuellement en accompagnement."
  },
  {
    keywords: ["promotion", "promotions", "cohorte", "combien de promotions"],
    response: () => `L'Accélérateur M a organisé ${state.meta.total_promotions} promotions principales depuis 2019 (MPU#01 à MPU#26). Chaque promotion regroupe environ 15 à 30 startups. Tu peux voir la répartition année par année dans l'onglet Timeline.`
  },
  {
    keywords: ["merci", "thanks", "super", "top"],
    response: () => "Avec plaisir ! Si tu as d'autres questions, je reste disponible. Bonne exploration du portfolio."
  },
  {
    keywords: ["carte", "où sont les startups", "répartition géographique", "international"],
    response: () => "Les startups accompagnées sont majoritairement basées en France (surtout autour de Marseille) mais l'Accélérateur M rayonne à l'international : Tunisie, Liban, Cameroun, Togo, Royaume-Uni. Tu peux visualiser tout ça dans l'onglet Carte, avec une choroplèthe qui colorie chaque pays selon le nombre de start-ups accompagnées."
  }
];

// ================================================================
// CHATBOT V2 — fullscreen, sessions, client/admin
// ================================================================

const CHAT_SESSIONS_KEY = 'm-chat-sessions-v2';
const CHAT_CURRENT_KEY = 'm-chat-current-session';
let chatbotOpen = false;
let chatbotMode = 'client'; // 'client' or 'admin'

function chatGetSessions() {
  try { return JSON.parse(localStorage.getItem(CHAT_SESSIONS_KEY) || '[]'); }
  catch (e) { return []; }
}
function chatSaveSessions(sessions) {
  localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(sessions.slice(0, 40)));
}
function chatCurrentSessionId() {
  return localStorage.getItem(CHAT_CURRENT_KEY) || null;
}
function chatSetCurrentSessionId(id) {
  localStorage.setItem(CHAT_CURRENT_KEY, id);
}
function chatGetOrCreateCurrent() {
  const sessions = chatGetSessions();
  let id = chatCurrentSessionId();
  let s = sessions.find(x => x.id === id);
  if (!s) {
    s = { id: 'sess-' + Date.now(), title: 'Nouvelle conversation', mode: chatbotMode, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    sessions.unshift(s);
    chatSaveSessions(sessions);
    chatSetCurrentSessionId(s.id);
  }
  return s;
}
function chatUpdateCurrent(mutator) {
  const sessions = chatGetSessions();
  const id = chatCurrentSessionId();
  const idx = sessions.findIndex(x => x.id === id);
  if (idx < 0) return null;
  mutator(sessions[idx]);
  sessions[idx].updatedAt = Date.now();
  // Titre auto : première question utilisateur
  if (sessions[idx].title === 'Nouvelle conversation' && sessions[idx].messages.length) {
    const firstUser = sessions[idx].messages.find(m => m.type === 'user');
    if (firstUser) sessions[idx].title = firstUser.text.slice(0, 40) + (firstUser.text.length > 40 ? '…' : '');
  }
  chatSaveSessions(sessions);
  return sessions[idx];
}
function chatDeleteSession(id) {
  const sessions = chatGetSessions().filter(s => s.id !== id);
  chatSaveSessions(sessions);
  if (chatCurrentSessionId() === id) {
    if (sessions[0]) chatSetCurrentSessionId(sessions[0].id);
    else localStorage.removeItem(CHAT_CURRENT_KEY);
  }
  chatRenderSidebar();
  chatRenderMessages();
}
function chatNewSession() {
  const sessions = chatGetSessions();
  const s = { id: 'sess-' + Date.now(), title: 'Nouvelle conversation', mode: chatbotMode, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  sessions.unshift(s);
  chatSaveSessions(sessions);
  chatSetCurrentSessionId(s.id);
  chatRenderSidebar();
  chatRenderMessages();
  chatRenderWelcome();
  Sfx.play('tick');
}
function chatSwitchSession(id) {
  chatSetCurrentSessionId(id);
  const s = chatGetSessions().find(x => x.id === id);
  if (s && s.mode) chatSwitchMode(s.mode, true);
  chatRenderSidebar();
  chatRenderMessages();
}
function chatSwitchMode(mode, silent) {
  if (mode !== 'admin' && mode !== 'client') return;
  if (mode === 'admin' && !window.PRIVE_MODE) {
    showToast('Mode admin réservé aux alumni connectés. Connecte-toi dans Espace privé.', 'error');
    return;
  }
  chatbotMode = mode;
  document.querySelectorAll('#chatbot-fs-mode-wrap button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const badge = document.getElementById('chatbot-fs-badge');
  if (badge) badge.textContent = mode === 'admin' ? 'Mode Admin' : 'Mode Client';
  const wrap = document.getElementById('chatbot-panel');
  if (wrap) wrap.dataset.chatMode = mode;
  const hint = document.getElementById('chatbot-fs-hint');
  if (hint) hint.textContent = mode === 'admin'
    ? '⚡ Admin : "ajoute une entreprise X à Marseille, promo MPU#28, logo https://…" · "nouvelle promo MPU#28 : A, B, C"'
    : '💡 Client : questions sur l\'Accélérateur M, ses programmes, ses startups';
  chatUpdateCurrent(s => { s.mode = mode; });
  chatRenderSuggestions();
  if (!silent) Sfx.play('tick');
}

function chatGetResponse(userMessage) {
  const q = userMessage.toLowerCase().trim();
  if (!q) return null;
  let best = { score: 0, response: null };
  for (const item of CHATBOT_KNOWLEDGE) {
    let score = 0;
    for (const k of item.keywords) {
      if (q.includes(k.toLowerCase())) score += k.length;
    }
    if (score > best.score) best = { score, response: item.response };
  }
  if (best.response && best.score >= 3) {
    return typeof best.response === 'function' ? best.response() : best.response;
  }
  return "Je n'ai pas de réponse précise à ta question. Essaie de la reformuler ou explore les onglets Portfolio, Timeline, Carte, Statistiques. Pour une réponse humaine, contacte l'équipe M.";
}

// ---------- ADMIN parser : ajoute entreprise / promotion / logo ----------
function chatAdminParse(msg) {
  const s = msg.trim();
  const low = s.toLowerCase();
  // Détecte l'intention
  if (/\b(ajoute?r?|nouvelle?|cr[eé]er?)\b.*\b(entreprise|start-?up|société)\b/i.test(s)
      || /^(entreprise|start-?up)\s*:/i.test(s)
      || /\b(ajoute?r?|cr[eé]er?)\s+["«]?[a-z0-9]/i.test(s) && /\bville\b|\bpromo\b|\bprogramme\b|\blogo\b/i.test(s)) {
    return chatAdminParseEntreprise(s);
  }
  if (/\b(ajoute?r?|nouvelle?|cr[eé]er?)\b.*\b(promo(tion)?|cohorte)\b/i.test(s)) {
    return chatAdminParsePromotion(s);
  }
  if (/^(logo|photo|image|url)\s*(pour|de|:)/i.test(s) || /\blogo\s+(pour|de)\s+/i.test(s)) {
    return chatAdminParseLogo(s);
  }
  if (/\b(liste|combien|nombre|combien\s+d[e']?)\b.*\b(entreprises?|start-?ups?)\b/i.test(low)) {
    return { type: 'info', text: `Il y a actuellement ${state.entreprises.length} entreprises dans le portfolio, dont ${state.entreprises.filter(e => (e.logo_url||'').startsWith('data:')).length} avec logo.` };
  }
  return null;
}

function chatExtractField(s, patterns) {
  for (const p of patterns) {
    const m = s.match(p);
    if (m && m[1]) return m[1].trim().replace(/^["«»']+|["«»']+$/g, '');
  }
  return null;
}

function chatAdminParseEntreprise(s) {
  const nom = chatExtractField(s, [
    /(?:entreprise|start-?up|nom(?:\s*ée|s)?)\s*[:=]?\s*["«]([^"»]+)["»]/i,
    /(?:ajoute?r?|cr[eé]er?)\s+(?:l[ae]\s+)?(?:entreprise|start-?up)\s+["«]?([^",«»]+?)(?:[,;.]|\s+(?:à|ville|promo|programme|logo)|$)/i,
    /(?:ajoute?r?)\s+["«]([^"»]+)["»]/i,
    /^["«]([^"»]+)["»]/i,
  ]);
  const ville = chatExtractField(s, [/ville\s*[:=]?\s*["«]?([^",;«»]+?)["»]?(?=\s*[,;.]|\s+(?:promo|programme|logo|thème|thématique)|$)/i, /\bà\s+([A-ZÀ-Ÿ][a-zà-ÿ\-\s]+?)(?=\s*[,;.]|$|\s+(?:promo|programme|logo))/]);
  const promo = chatExtractField(s, [/promo(?:tion)?\s*[:=]?\s*([A-Z]+#?\d+)/i, /(MPU#\d+|MPU\s*Comores|MPU\s*Incubme)/i]);
  const programme = chatExtractField(s, [/programme\s*[:=]?\s*["«]?([^",;«»]+?)["»]?(?=\s*[,;.]|\s+(?:promo|ville|logo|thème)|$)/i]);
  const thematique = chatExtractField(s, [/(?:th[eè]me|th[eé]matique)\s*[:=]?\s*["«]?([^",;«»]+?)["»]?(?=\s*[,;.]|\s+(?:promo|ville|logo|programme)|$)/i]);
  const logo = chatExtractField(s, [/logo\s*[:=]?\s*(https?:\/\/\S+)/i, /(https?:\/\/\S+\.(?:png|jpg|jpeg|webp|svg)(?:\?\S*)?)/i]);
  const desc = chatExtractField(s, [/description\s*[:=]?\s*["«]([^"»]+)["»]/i]);
  if (!nom) {
    return { type: 'help', text: 'Format attendu : « ajoute une entreprise "NomStartup" à Marseille, promo MPU#28, programme M\'Scale Up, logo https://…/logo.png »' };
  }
  return {
    type: 'entreprise-preview',
    data: {
      nom,
      id: nom.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),
      ville: ville || '',
      promotions: promo ? [promo.toUpperCase().replace(/\s+/g,' ')] : [],
      programmes: programme ? [programme] : [],
      thematiques: thematique ? [thematique] : [],
      description_courte: desc || '',
      description_longue: '',
      statut: 'Active',
      annee_creation: new Date().getFullYear(),
      logo_url: logo || '',
      _logoRemote: !!logo,
    },
  };
}

function chatAdminParsePromotion(s) {
  const nom = chatExtractField(s, [/(MPU#\d+(?:\s*Comores|\s*Incubme)?)/i, /promo(?:tion)?\s*["«]?([A-Z0-9#\s]+?)["»]?(?=\s*[,;.:]|\s+avec|$)/i]);
  const entListStr = chatExtractField(s, [/(?:avec|entreprises?|start-?ups?)\s*(?:les\s+)?(?:entreprises?)?\s*[:=]?\s*(.+?)$/i]);
  const entreprises = entListStr ? entListStr.split(/[,;]+|\bet\b/i).map(x => x.trim()).filter(Boolean) : [];
  if (!nom) return { type: 'help', text: 'Format : « nouvelle promotion MPU#28 avec entreprises A, B, C »' };
  return { type: 'promotion-preview', data: { nom: nom.toUpperCase().replace(/\s+/g,' '), entreprises } };
}

function chatAdminParseLogo(s) {
  const target = chatExtractField(s, [/(?:logo|photo|image)\s+(?:pour|de|à|sur)\s+["«]?([^",;«»]+?)["»]?(?=\s*[:,]|\s+https?|$)/i]);
  const url = chatExtractField(s, [/(https?:\/\/\S+)/i]);
  const hasAttached = chatAttachedFile && (chatAttachedFile.type||'').startsWith('image/');
  if (!target) return { type: 'help', text: 'Format : « logo pour NomEntreprise » puis joins un fichier via + ou colle une URL https://…' };
  if (!url && !hasAttached) return { type: 'help', text: `Pour "${target}", joins un fichier image via le bouton + ou colle une URL https://…` };
  return { type: 'logo-preview', data: { target, url: url || 'attached' } };
}

// ---------- Application des actions admin ----------
async function chatAdminApplyEntreprise(data) {
  if (!data.id) return { ok: false, msg: 'ID manquant' };
  // Dedup
  let id = data.id, n = 2;
  while (state.entreprises.find(e => e.id === id)) { id = data.id + '-' + n; n++; }
  const entreprise = { ...data, id };
  delete entreprise._logoRemote;
  // Traite le logo : data URL (fichier joint) ou URL http
  if (data.logo_url) {
    try {
      if (data.logo_url.startsWith('data:')) {
        entreprise.logo_url = await chatCompressDataUrl(data.logo_url);
      } else if (data.logo_url.startsWith('http')) {
        entreprise.logo_url = await chatFetchAndCompressLogo(data.logo_url);
      }
    } catch (e) {
      entreprise.logo_url = '';
    }
  }
  state.entreprises.push(entreprise);
  await saveData({ entreprise });
  return { ok: true, id: entreprise.id, nom: entreprise.nom };
}

async function chatAdminApplyLogo(data) {
  const target = data.target.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const e = state.entreprises.find(x => (x.nom || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'') === target)
         || state.entreprises.find(x => (x.nom || '').toLowerCase().includes(target));
  if (!e) return { ok: false, msg: `Entreprise "${data.target}" introuvable dans le portfolio` };
  try {
    if ((data.url || '').startsWith('data:')) {
      e.logo_url = await chatCompressDataUrl(data.url);
    } else {
      e.logo_url = await chatFetchAndCompressLogo(data.url);
    }
  } catch (err) {
    return { ok: false, msg: 'Impossible de traiter le logo : ' + err.message };
  }
  await saveData({ entreprise: e });
  return { ok: true, nom: e.nom };
}

async function chatCompressDataUrl(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const max = 400;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      res(c.toDataURL('image/webp', 0.85));
    };
    img.onerror = rej;
    img.src = dataUrl;
  });
}

async function chatAdminApplyPromotion(data) {
  const promo = data.nom;
  const added = [];
  for (const name of data.entreprises) {
    const targetLow = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
    let e = state.entreprises.find(x => (x.nom || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'') === targetLow);
    if (!e) {
      // On crée l'entreprise directement dans cette promo
      e = { id: name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-'), nom: name, promotions: [promo], programmes: [], thematiques: [], statut: 'Active' };
      let cid = e.id, n = 2;
      while (state.entreprises.find(x => x.id === cid)) { cid = e.id + '-' + n; n++; }
      e.id = cid;
      state.entreprises.push(e);
    } else {
      e.promotions = [...new Set([...(e.promotions || []), promo])];
    }
    added.push(e.nom);
  }
  await saveData({});
  return { ok: true, count: added.length, promo, entreprises: added };
}

async function chatFetchAndCompressLogo(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch failed');
  const blob = await r.blob();
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const dataUrl = await new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.onerror = rej;
    reader.readAsDataURL(blob);
  });
  return new Promise((res, rej) => {
    img.onload = () => {
      const max = 400;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      res(c.toDataURL('image/webp', 0.85));
    };
    img.onerror = rej;
    img.src = dataUrl;
  });
}

// ---------- UI Chatbot ----------
function toggleChatbot() {
  chatbotOpen = !chatbotOpen;
  const panel = document.getElementById('chatbot-panel');
  const fab = document.getElementById('chat-fab');
  if (!panel) return;
  panel.classList.toggle('open', chatbotOpen);
  panel.setAttribute('aria-hidden', chatbotOpen ? 'false' : 'true');
  if (fab) fab.classList.toggle('open', chatbotOpen);
  document.body.style.overflow = chatbotOpen ? 'hidden' : '';
  if (chatbotOpen) {
    // Init état
    const adminBtn = document.getElementById('chatbot-mode-admin');
    if (adminBtn) {
      adminBtn.disabled = !window.PRIVE_MODE;
      adminBtn.title = window.PRIVE_MODE ? 'Mode admin (ajouter des entreprises)' : 'Nécessite une connexion privée';
      adminBtn.style.opacity = window.PRIVE_MODE ? '1' : '0.4';
    }
    chatGetOrCreateCurrent();
    chatSwitchMode(chatGetSessions().find(s => s.id === chatCurrentSessionId())?.mode || 'client', true);
    chatRenderSidebar();
    chatRenderMessages();
    chatRenderWelcome();
    setTimeout(() => document.getElementById('chatbot-input')?.focus(), 200);
    setTimeout(() => chatNeuralInit(), 100);
    setTimeout(() => initChatbot3DCube(), 200);
  } else {
    document.body.style.overflow = '';
  }
}

function chatRenderSidebar() {
  const el = document.getElementById('chatbot-fs-sessions');
  if (!el) return;
  const sessions = chatGetSessions();
  const currentId = chatCurrentSessionId();
  if (!sessions.length) {
    el.innerHTML = '<div class="chatbot-fs-empty">Aucune session encore</div>';
    return;
  }
  el.innerHTML = sessions.map(s => `
    <div class="chatbot-fs-session ${s.id === currentId ? 'active' : ''}" data-sid="${s.id}">
      <div class="chatbot-fs-session-body" onclick="chatSwitchSession('${s.id}')">
        <div class="chatbot-fs-session-title">${escapeHtml(s.title)}</div>
        <div class="chatbot-fs-session-meta">
          <span class="chatbot-fs-session-mode chatbot-fs-session-mode--${s.mode || 'client'}">${(s.mode||'client').toUpperCase()}</span>
          <span>${chatFormatRelative(s.updatedAt)}</span>
        </div>
      </div>
      <button class="chatbot-fs-session-del" onclick="event.stopPropagation(); chatDeleteSession('${s.id}')" title="Supprimer">×</button>
    </div>
  `).join('');
}

function chatFormatRelative(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "à l'instant";
  if (d < 3600) return Math.floor(d/60) + ' min';
  if (d < 86400) return Math.floor(d/3600) + ' h';
  return Math.floor(d/86400) + ' j';
}

function chatRenderMessages() {
  const container = document.getElementById('chatbot-messages');
  if (!container) return;
  container.innerHTML = '';
  const s = chatGetSessions().find(x => x.id === chatCurrentSessionId());
  if (!s || !s.messages.length) return;
  s.messages.forEach(m => chatAppendMessage(m.type, m.text, m.html, false));
  chatScrollBottom();
}

function chatRenderWelcome() {
  const s = chatGetSessions().find(x => x.id === chatCurrentSessionId());
  if (s && s.messages.length) return;
  const welcome = chatbotMode === 'admin'
    ? "Mode Admin activé ✦ Je peux ajouter des entreprises, créer des promotions ou attacher un logo à une fiche existante. Tape par exemple : « ajoute une entreprise Solaris à Marseille, promo MPU#28, programme M'Scale Up, logo https://exemple.com/solaris.png »"
    : "Bonjour ! Je suis l'Assistant M. Pose-moi tes questions sur l'Accélérateur M, ses programmes, ses startups accompagnées.";
  setTimeout(() => chatAppendMessage('bot', welcome), 200);
}

function chatRenderSuggestions() {
  const container = document.getElementById('chatbot-suggestions');
  if (!container) return;
  const suggestions = chatbotMode === 'admin'
    ? [
      'ajoute une entreprise "Solaris" à Marseille, promo MPU#28, programme M\'Scale Up',
      'logo pour IADYS https://exemple.com/iadys.png',
      'nouvelle promotion MPU#28 avec entreprises Solaris, Ocean AI, Nexus',
      'combien d\'entreprises dans le portfolio ?',
    ]
    : [
      "Qu'est-ce qu'un accélérateur ?",
      'Quels programmes proposez-vous ?',
      'Combien de startups accompagnées ?',
      'Où êtes-vous basés ?',
    ];
  container.innerHTML = suggestions.map(s =>
    `<span class="chatbot-fs-suggestion">${escapeHtml(s)}</span>`
  ).join('');
  container.querySelectorAll('.chatbot-fs-suggestion').forEach((el, i) => {
    el.addEventListener('click', () => {
      document.getElementById('chatbot-input').value = suggestions[i];
      document.getElementById('chatbot-input').focus();
    });
  });
}

function chatAppendMessage(type, text, html, save = true) {
  const container = document.getElementById('chatbot-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'chatbot-fs-msg ' + type;
  if (html) div.innerHTML = html;
  else div.textContent = text;
  container.appendChild(div);
  chatScrollBottom();
  if (save) chatUpdateCurrent(s => { s.messages.push({ type, text, html }); });
}

function chatScrollBottom() {
  const c = document.getElementById('chatbot-messages');
  if (c) c.scrollTop = c.scrollHeight;
}

function chatShowTyping() {
  const c = document.getElementById('chatbot-messages');
  if (!c) return;
  const div = document.createElement('div');
  div.className = 'chatbot-fs-msg bot';
  div.id = 'chatbot-typing';
  div.innerHTML = '<div class="chatbot-fs-typing"><span></span><span></span><span></span></div>';
  c.appendChild(div);
  chatScrollBottom();
}
function chatHideTyping() { document.getElementById('chatbot-typing')?.remove(); }

async function sendChatMessage() {
  const input = document.getElementById('chatbot-input');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;
  // Injecte le fichier joint dans le message user pour trace
  const attached = chatAttachedFile;
  const displayMsg = attached ? `${message}\n⎯ ${attached.name}` : message;
  chatAppendMessage('user', displayMsg);
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('chatbot-suggestions').innerHTML = '';
  chatRenderSidebar();
  chatShowTyping();
  chatNeuralAgitate();

  if (chatbotMode === 'admin') {
    const parsed = chatAdminParse(message);
    // Si un fichier image est joint et que le parser a détecté une entreprise/logo sans URL,
    // on injecte le fichier joint comme logo
    if (parsed && attached && (attached.type || '').startsWith('image/')) {
      if (parsed.type === 'entreprise-preview' && !parsed.data.logo_url) {
        parsed.data.logo_url = attached.dataUrl;
        parsed.data._logoRemote = false;
      } else if (parsed.type === 'logo-preview' && parsed.data.url && parsed.data.url.startsWith('http') === false) {
        parsed.data.url = attached.dataUrl;
      } else if (parsed.type === 'logo-preview') {
        // priorité au fichier joint sur l'URL fournie
        parsed.data.url = attached.dataUrl;
        parsed.data._fromFile = true;
      }
    }
    chatAttachedFile = null;
    chatRenderAttachPreview();
    setTimeout(() => {
      chatHideTyping();
      if (!parsed) {
        chatAppendMessage('bot', "Je n'ai pas compris. En mode admin, tu peux : ajouter une entreprise, créer une promotion, attacher un logo. Tape « aide » pour voir les formats.");
        return;
      }
      if (parsed.type === 'entreprise-preview') {
        chatAdminShowPreview(parsed.data);
      } else if (parsed.type === 'promotion-preview') {
        chatAdminShowPromoPreview(parsed.data);
      } else if (parsed.type === 'logo-preview') {
        chatAdminShowLogoPreview(parsed.data);
      } else if (parsed.type === 'info') {
        chatAppendMessage('bot', parsed.text);
      } else {
        chatAppendMessage('bot', parsed.text);
      }
    }, 3000);
    return;
  }

  setTimeout(() => {
    chatHideTyping();
    chatAppendMessage('bot', chatGetResponse(message));
  }, 3000);
}

function chatAdminShowPreview(data) {
  const logoHtml = data.logo_url ? `<img src="${escapeHtml(data.logo_url)}" alt="" style="width:64px;height:64px;object-fit:contain;border-radius:8px;background:#fff;padding:4px;"/>` : '<div style="width:64px;height:64px;background:rgba(26,166,255,0.15);border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:\'D-DIN Condensed\';font-size:22px;color:#38B6FF;">'+escapeHtml((data.nom||'?').slice(0,2).toUpperCase())+'</div>';
  const html = `
    <div class="chatbot-fs-preview">
      <div class="chatbot-fs-preview-head">
        ${logoHtml}
        <div>
          <div class="chatbot-fs-preview-title">${escapeHtml(data.nom)}</div>
          <div class="chatbot-fs-preview-sub">${escapeHtml(data.ville || '—')} · ${data.promotions.length ? escapeHtml(data.promotions.join(', ')) : 'sans promo'}</div>
        </div>
      </div>
      <div class="chatbot-fs-preview-fields">
        ${data.programmes.length ? `<span>${iconSvg('pin', 12)} ${escapeHtml(data.programmes.join(', '))}</span>` : ''}
        ${data.thematiques.length ? `<span>${iconSvg('target', 12)} ${escapeHtml(data.thematiques.join(', '))}</span>` : ''}
        ${data.description_courte ? `<span>${iconSvg('speech', 12)} ${escapeHtml(data.description_courte)}</span>` : ''}
      </div>
      <div class="chatbot-fs-preview-actions">
        <button class="chatbot-fs-confirm" onclick="chatAdminConfirmAdd(this)">${iconSvg('check', 14)} Ajouter au portfolio</button>
        <button class="chatbot-fs-cancel" onclick="this.closest('.chatbot-fs-msg').remove()">Annuler</button>
      </div>
    </div>`;
  chatAppendMessage('bot', 'Voici l\'aperçu — confirme pour ajouter au portfolio :', html);
  const last = document.querySelector('#chatbot-messages .chatbot-fs-msg.bot:last-child');
  if (last) last.dataset.payload = JSON.stringify(data);
}

async function chatAdminConfirmAdd(btn) {
  const bubble = btn.closest('.chatbot-fs-msg');
  const data = JSON.parse(bubble.dataset.payload || '{}');
  btn.textContent = '⏳ Ajout en cours…';
  btn.disabled = true;
  const res = await chatAdminApplyEntreprise(data);
  if (res.ok) {
    chatAppendMessage('bot', `✓ Entreprise "${res.nom}" ajoutée au portfolio (id: ${res.id}). Vue liste rafraîchie automatiquement.`);
    Sfx.play('ok');
    if (location.hash.startsWith('#/alumni') && !location.hash.includes('entreprise')) router();
  } else {
    chatAppendMessage('bot', `✗ Erreur : ${res.msg}`);
    Sfx.play('err');
  }
  bubble.querySelector('.chatbot-fs-preview-actions')?.remove();
}
window.chatAdminConfirmAdd = chatAdminConfirmAdd;

function chatAdminShowLogoPreview(data) {
  const html = `
    <div class="chatbot-fs-preview">
      <div class="chatbot-fs-preview-head">
        <img src="${escapeHtml(data.url)}" style="width:64px;height:64px;object-fit:contain;border-radius:8px;background:#fff;padding:4px;" onerror="this.style.display='none'">
        <div>
          <div class="chatbot-fs-preview-title">Logo pour "${escapeHtml(data.target)}"</div>
          <div class="chatbot-fs-preview-sub">${escapeHtml(data.url.slice(0, 60))}${data.url.length>60?'…':''}</div>
        </div>
      </div>
      <div class="chatbot-fs-preview-actions">
        <button class="chatbot-fs-confirm" onclick="chatAdminConfirmLogo(this)">${iconSvg('check', 14)} Télécharger et attacher</button>
        <button class="chatbot-fs-cancel" onclick="this.closest('.chatbot-fs-msg').remove()">Annuler</button>
      </div>
    </div>`;
  chatAppendMessage('bot', 'Logo à télécharger et rattacher :', html);
  const last = document.querySelector('#chatbot-messages .chatbot-fs-msg.bot:last-child');
  if (last) last.dataset.payload = JSON.stringify(data);
}

async function chatAdminConfirmLogo(btn) {
  const bubble = btn.closest('.chatbot-fs-msg');
  const data = JSON.parse(bubble.dataset.payload || '{}');
  btn.textContent = '⏳ Téléchargement…';
  btn.disabled = true;
  const res = await chatAdminApplyLogo(data);
  if (res.ok) {
    chatAppendMessage('bot', `✓ Logo attaché à "${res.nom}". Wall of Alumni rafraîchi.`);
    Sfx.play('ok');
    if (location.hash.startsWith('#/alumni') && !location.hash.includes('entreprise')) router();
  } else {
    chatAppendMessage('bot', `✗ Erreur : ${res.msg}`);
    Sfx.play('err');
  }
  bubble.querySelector('.chatbot-fs-preview-actions')?.remove();
}
window.chatAdminConfirmLogo = chatAdminConfirmLogo;

function chatAdminShowPromoPreview(data) {
  const html = `
    <div class="chatbot-fs-preview">
      <div class="chatbot-fs-preview-head">
        <div style="width:64px;height:64px;background:linear-gradient(135deg,#1AA6FF,#0099FF);border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-family:'D-DIN Condensed';font-size:14px;">${escapeHtml(data.nom.slice(0,8))}</div>
        <div>
          <div class="chatbot-fs-preview-title">Promotion ${escapeHtml(data.nom)}</div>
          <div class="chatbot-fs-preview-sub">${data.entreprises.length} entreprise${data.entreprises.length>1?'s':''} : ${escapeHtml(data.entreprises.join(', '))}</div>
        </div>
      </div>
      <div class="chatbot-fs-preview-actions">
        <button class="chatbot-fs-confirm" onclick="chatAdminConfirmPromo(this)">${iconSvg('check', 14)} Créer la promotion</button>
        <button class="chatbot-fs-cancel" onclick="this.closest('.chatbot-fs-msg').remove()">Annuler</button>
      </div>
    </div>`;
  chatAppendMessage('bot', 'Aperçu de la promotion :', html);
  const last = document.querySelector('#chatbot-messages .chatbot-fs-msg.bot:last-child');
  if (last) last.dataset.payload = JSON.stringify(data);
}

async function chatAdminConfirmPromo(btn) {
  const bubble = btn.closest('.chatbot-fs-msg');
  const data = JSON.parse(bubble.dataset.payload || '{}');
  btn.textContent = '⏳ Création…';
  btn.disabled = true;
  const res = await chatAdminApplyPromotion(data);
  if (res.ok) {
    chatAppendMessage('bot', `✓ Promotion ${res.promo} créée avec ${res.count} entreprise${res.count>1?'s':''}. Timeline rafraîchie.`);
    Sfx.play('ok');
    if (location.hash.startsWith('#/alumni')) router();
  } else {
    chatAppendMessage('bot', `✗ ${res.msg}`);
    Sfx.play('err');
  }
  bubble.querySelector('.chatbot-fs-preview-actions')?.remove();
}
window.chatAdminConfirmPromo = chatAdminConfirmPromo;

function handleChatKey(ev) {
  const input = ev.target;
  // Auto-grow textarea
  input.style.height = 'auto';
  input.style.height = Math.min(160, input.scrollHeight) + 'px';
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendChatMessage();
  }
  if (ev.key === 'Escape') toggleChatbot();
}

document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && chatbotOpen) toggleChatbot();
});

window.toggleChatbot = toggleChatbot;
window.sendChatMessage = sendChatMessage;
window.handleChatKey = handleChatKey;
window.chatNewSession = chatNewSession;
window.chatSwitchSession = chatSwitchSession;
window.chatDeleteSession = chatDeleteSession;
window.chatSwitchMode = chatSwitchMode;

// ---------- Cerveau virtuel Jarvis en fond du chatbot ----------
let neuralRAF = null;
let neuralAgitation = 0; // 0 = calme, 1 = agité (décroit dans le temps)
let neuralNodes = [];

function chatNeuralAgitate() {
  neuralAgitation = 1;
}
window.chatNeuralAgitate = chatNeuralAgitate;

function chatNeuralInit() {
  const canvas = document.getElementById('chatbot-neural');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  };
  resize();
  window.addEventListener('resize', resize);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const N = 90;
  neuralNodes = Array.from({ length: N }, () => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    vx: (Math.random() - 0.5) * 0.25,
    vy: (Math.random() - 0.5) * 0.25,
    r: 1.2 + Math.random() * 1.8,
    phase: Math.random() * Math.PI * 2,
  }));
  if (neuralRAF) cancelAnimationFrame(neuralRAF);
  const step = () => {
    if (!chatbotOpen) { neuralRAF = null; return; }
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    // Décroissance de l'agitation
    neuralAgitation *= 0.982;
    const speed = 1 + neuralAgitation * 4;
    const linkDist = 140 + neuralAgitation * 60;
    const lineAlpha = 0.15 + neuralAgitation * 0.35;
    const nodeAlpha = 0.55 + neuralAgitation * 0.4;
    const t = performance.now() / 1000;
    // Update positions
    for (const n of neuralNodes) {
      n.x += n.vx * speed;
      n.y += n.vy * speed;
      if (n.x < 0 || n.x > W) n.vx *= -1;
      if (n.y < 0 || n.y > H) n.vy *= -1;
      // Petit jitter agité
      if (neuralAgitation > 0.05) {
        n.x += (Math.random() - 0.5) * neuralAgitation * 0.8;
        n.y += (Math.random() - 0.5) * neuralAgitation * 0.8;
      }
    }
    // Lignes
    ctx.lineWidth = 0.7 + neuralAgitation * 0.5;
    for (let i = 0; i < neuralNodes.length; i++) {
      for (let j = i + 1; j < neuralNodes.length; j++) {
        const a = neuralNodes[i], b = neuralNodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < linkDist) {
          const alpha = (1 - d / linkDist) * lineAlpha;
          ctx.strokeStyle = `rgba(56,182,255,${alpha})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    // Nœuds : pulsation légère
    for (const n of neuralNodes) {
      const pulse = 0.85 + Math.sin(t * 2 + n.phase) * 0.15;
      const r = n.r * pulse * (1 + neuralAgitation * 0.4);
      // Halo
      const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3);
      grad.addColorStop(0, `rgba(56,182,255,${nodeAlpha})`);
      grad.addColorStop(1, `rgba(56,182,255,0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r * 3, 0, Math.PI * 2);
      ctx.fill();
      // Cœur
      ctx.fillStyle = `rgba(180,220,255,${Math.min(1, nodeAlpha + 0.2)})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    neuralRAF = requestAnimationFrame(step);
  };
  step();
}
window.chatNeuralInit = chatNeuralInit;

// ---------- Fichier joint dans le chatbot ----------
let chatAttachedFile = null; // { name, type, size, dataUrl }
function chatAttachFile(input) {
  const f = input.files?.[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) {
    showToast('Fichier trop lourd (max 5 Mo)', 'error');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    chatAttachedFile = { name: f.name, type: f.type, size: f.size, dataUrl: reader.result };
    chatRenderAttachPreview();
  };
  reader.readAsDataURL(f);
  input.value = '';
}
function chatRemoveAttachment() {
  chatAttachedFile = null;
  chatRenderAttachPreview();
}
function chatRenderAttachPreview() {
  const box = document.getElementById('chatbot-attach-preview');
  if (!box) return;
  if (!chatAttachedFile) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'flex';
  const isImg = (chatAttachedFile.type || '').startsWith('image/');
  const thumb = isImg
    ? `<img src="${chatAttachedFile.dataUrl}" alt="">`
    : `<div class="chatbot-fs-attach-icon">${iconSvg('paperclip', 16)}</div>`;
  const kb = Math.round(chatAttachedFile.size / 1024);
  box.innerHTML = `
    <div class="chatbot-fs-attach-chip">
      ${thumb}
      <div class="chatbot-fs-attach-info">
        <div class="chatbot-fs-attach-name">${escapeHtml(chatAttachedFile.name)}</div>
        <div class="chatbot-fs-attach-size">${kb} ko · ${escapeHtml(chatAttachedFile.type || 'fichier')}</div>
      </div>
      <button class="chatbot-fs-attach-remove" onclick="chatRemoveAttachment()" title="Retirer">×</button>
    </div>`;
}
window.chatAttachFile = chatAttachFile;
window.chatRemoveAttachment = chatRemoveAttachment;

// ================================================================
// ACTUALITÉS - fil d'actualité de la communauté alumni
// ================================================================

const ALUMNI_NEWS = [
  { date: '2026-06-15', cat: 'Levée', entreprise: 'IADYS', titre: 'IADYS boucle une série B de 25 M€', teaser: "Nicolas Mannoni annonce la clôture d'un tour de 25 millions d'euros mené par Bpifrance et Serena Capital pour accélérer le déploiement international de la robotique de nettoyage marin." },
  { date: '2026-06-02', cat: 'Recrutement', entreprise: 'Cynoia', titre: 'Cynoia recrute 15 personnes cette année', teaser: "L'équipe de Cynoia à Tunis passe de 13 à 28 collaborateurs. Postes ouverts : Product Manager, développeurs full-stack, ingénieurs QA. Formation continue et remote friendly." },
  { date: '2026-05-28', cat: 'Distinction', entreprise: 'GreenCityzen', titre: 'GreenCityzen certifiée B Corp', teaser: "Après 18 mois d'audit, la start-up marseillaise rejoint la communauté des entreprises engagées certifiées B Corp. Un signal fort pour ses partenaires collectivités." },
  { date: '2026-05-14', cat: 'Lancement', entreprise: 'Anotherway', titre: 'Anotherway signe un partenariat avec Carrefour Bio', teaser: "Les 12 références d'hygiène solide d'Anotherway seront distribuées dans 250 magasins Carrefour Bio dès septembre. Un nouveau chapitre pour la start-up marseillaise fondée en 2019." },
  { date: '2026-04-30', cat: 'Levée', entreprise: 'Green Technologie', titre: 'Green Technologie ouvre une seconde usine près de Lyon', teaser: "Après Marseille, la start-up de mobilité électrique se déploie à Vaulx-en-Velin. Objectif : 60 emplois créés d'ici fin 2027." },
  { date: '2026-04-12', cat: 'Distinction', entreprise: 'Lily Facilite La Vie', titre: 'Lily remporte le prix Startup Inclusion', teaser: "La plateforme d'aide aux personnes handicapées est distinguée aux Trophées de l'innovation sociale à Paris. 15 nouvelles collectivités partenaires depuis." },
  { date: '2026-04-04', cat: 'Levée', entreprise: 'Touchify', titre: "Touchify lève 3 M€ en série A", teaser: "Le SaaS retail marseillais annonce une série A menée par Elaia. La solution est déjà déployée chez 800 enseignes dont Sephora et Nespresso." },
  { date: '2026-03-22', cat: 'Lancement', entreprise: 'Jimbei / Aquaverse', titre: "Jimbei ouvre son aquaculture pilote à Cassis", teaser: "Le premier bassin d'aquaculture régénérative de Méditerranée voit le jour. Production de dorades responsables : 30 tonnes en 2026." },
  { date: '2026-03-08', cat: 'Recrutement', entreprise: 'Winshot', titre: 'Winshot cherche un data analyst', teaser: "L'outil retail tunisien recrute son premier data analyst pour construire le module de reporting. Remote possible. Contact via la fiche entreprise." },
  { date: '2026-02-20', cat: 'Distinction', entreprise: 'Green PRAXIS', titre: "Green PRAXIS reconnue expert par l'ADEME", teaser: "La start-up aixoise de dépollution des sols intègre le réseau des experts référencés par l'ADEME. Nouveaux marchés publics accessibles dès 2026." },
  { date: '2026-02-05', cat: 'Levée', entreprise: 'Morbiket', titre: 'Morbiket boucle un premier tour à 500 K€', teaser: "La marque ICC tunisienne récolte 500 000 € auprès de business angels de l'écosystème Accélérateur M. Objectif : lancer la ligne premium au printemps." },
  { date: '2026-01-28', cat: 'Autre', entreprise: 'Tawa Digital', titre: 'Tawa Digital ouvre un bureau à Alger', teaser: "L'agence tunisienne étend son terrain de jeu vers le marché algérien. Deux nouvelles collaborations signées avec des startups locales." },
];

function iconForCategory(cat) {
  return {
    'Levée': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    'Recrutement': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
    'Lancement': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/></svg>',
    'Distinction': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>',
    'Autre': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  }[cat] || '';
}

function formatNewsDate(iso) {
  const d = new Date(iso);
  const months = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'août', 'sep', 'oct', 'nov', 'déc'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

let newsCatFilter = null;

let ACTUALITES_LIVE = null; // cache des actus tirées de l'API (veille hebdo)
async function fetchActualitesLive() {
  if (ACTUALITES_LIVE !== null) return ACTUALITES_LIVE;
  try {
    const r = await apiRequest('/api/actualites?limit=200');
    if (!Array.isArray(r)) throw new Error('bad response');
    // Format API → format ALUMNI_NEWS
    ACTUALITES_LIVE = r.map(a => ({
      entreprise: a.entreprise || '',
      titre: a.titre,
      teaser: a.teaser || '',
      url: a.url,
      source: a.source || '',
      date: a.date,
      cat: a.cat || 'Autre',
      _live: true,
    }));
  } catch (e) {
    ACTUALITES_LIVE = [];
  }
  return ACTUALITES_LIVE;
}
function getAllActualites() {
  const live = ACTUALITES_LIVE || [];
  // Live d'abord (plus récent), puis demo en fallback si vide
  if (live.length) return live;
  return ALUMNI_NEWS;
}
function renderActualites() {
  const cats = ['Levée', 'Recrutement', 'Lancement', 'Distinction', 'Autre'];
  // Lance le fetch API si pas déjà fait, re-render à la réception
  if (ACTUALITES_LIVE === null) fetchActualitesLive().then(() => { if (location.hash.includes('actualites')) renderActualites(); });
  const news = getAllActualites();
  const filtered = newsCatFilter ? news.filter(n => n.cat === newsCatFilter) : news;
  const thisWeek = news.filter(n => {
    const d = new Date(n.date);
    const diff = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
    return diff < 7;
  }).length;
  const levees = news.filter(n => n.cat === 'Levée').length;
  const isLive = news.some(n => n._live);

  document.getElementById('app').innerHTML = `
    <div class="p26-page news-page-2026">
      <div class="p26-aurora"></div>
      <header class="p26-hero p26-reveal">
        <div>
          <h2 class="p26-h2">Actualités</h2>
          <p class="p26-hero-tagline">Levées, recrutements, lancements et distinctions du réseau. Une timeline centralisée pour suivre ce qui bouge chez les alumni.</p>
        </div>
        <div class="p26-hero-stats">
          <div class="p26-stat"><b>${news.length}</b><span>actus totales${isLive ? ' · veille active' : ''}</span></div>
          <div class="p26-stat"><b>${thisWeek}</b><span>cette semaine</span></div>
          <div class="p26-stat"><b>${levees}</b><span>levées</span></div>
        </div>
      </header>

      <div class="viz-block p26-reveal" id="viz-news-heatmap"></div>

      <div class="p26-toolbar p26-reveal">
        <button class="p26-filter-pill ${!newsCatFilter ? 'active' : ''}" onclick="filterNewsCat(null)">Toutes · ${news.length}</button>
        ${cats.map(c => `
          <button class="p26-filter-pill ${newsCatFilter === c ? 'active' : ''}" onclick="filterNewsCat('${c}')">
            ${iconForCategory(c)} ${c} · ${news.filter(n => n.cat === c).length}
          </button>
        `).join('')}
      </div>

      <div class="news-timeline">
        ${filtered.map((n, i) => {
          const ent = state.entreprises.find(e => e.nom === n.entreprise);
          const openUrl = n.url ? `window.open('${n.url.replace(/'/g, "\\'")}', '_blank', 'noopener')` : (ent ? `navigate('#/alumni/entreprise/${escapeHtml(ent.id)}')` : '');
          return `
            <article class="news-item-2026 p26-reveal" style="transition-delay:${i * 40}ms;" ${openUrl ? `onclick="${openUrl}"` : ''}>
              <div class="news-meta-2026">
                <span>${escapeHtml(formatNewsDate(n.date))}</span>
                <span class="news-cat-2026 cat-${n.cat.toLowerCase()}">${iconForCategory(n.cat)} ${escapeHtml(n.cat)}</span>
                ${n.source ? `<span class="news-source">${escapeHtml(n.source)}</span>` : ''}
              </div>
              <h3 class="news-title-2026">${escapeHtml(n.titre)}</h3>
              <p class="news-teaser-2026">${escapeHtml(n.teaser)}</p>
              <div class="news-footer-2026">
                ${ent ? `<a href="#/alumni/entreprise/${escapeHtml(ent.id)}" onclick="event.stopPropagation()">Voir ${escapeHtml(n.entreprise)}</a>` : `<span class="news-entreprise-plain">${escapeHtml(n.entreprise)}</span>`}
                ${n.url ? `<a href="${escapeHtml(n.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="news-source-link">Lire l'article ↗</a>` : ''}
              </div>
            </article>
          `;
        }).join('')}
      </div>
    </div>
  `;

  requestAnimationFrame(() => {
    document.querySelectorAll('.news-page-2026 .p26-reveal').forEach((el, i) => {
      setTimeout(() => el.classList.add('reveal-in'), 40 * i);
    });
    const hm = document.getElementById('viz-news-heatmap');
    if (hm) renderHeatmapCalendar(hm, news.map(n => n.date));
  });
}

function filterNewsCat(cat) {
  newsCatFilter = cat;
  renderActualites();
}

window.filterNewsCat = filterNewsCat;

// ================================================================
// RÉCITS - histoires d'alumni pour les alumni
// ================================================================

const ALUMNI_RECITS = [
  {
    id: 'iadys-nettoyage-marin',
    entreprise: 'IADYS',
    fondateur: 'Nicolas Mannoni',
    titre: "De la Ciotat à la mer du Nord",
    sous_titre: "Comment IADYS a industrialisé la robotique de nettoyage marin en 5 ans",
    duree_lecture: 8,
    date: '2026-05-10',
    chapitres: [
      { titre: "Le déclic sur le port de La Ciotat", contenu: "En 2018, Nicolas Mannoni est ingénieur en robotique. Il passe un après-midi sur le port de La Ciotat et observe des équipes municipales tenter de récupérer à l'épuisette les déchets flottants. \"Je me suis dit qu'il devait exister une meilleure solution, et je n'en trouvais pas.\" C'est le point de départ d'IADYS." },
      { titre: "Le passage à l'Accélérateur M", contenu: "Après avoir bricolé un premier prototype dans son garage, Nicolas candidate à la promotion MPU#01 en 2019. Le programme M'Scale Up lui apporte trois choses fondamentales : un mentor industriel qui a scaler une PME similaire, une méthodologie pour construire son business model canvas, et surtout un accès direct à ses 3 premiers clients pilotes." },
      { titre: "La première levée : 1,2 M€", contenu: "L'accélération se traduit en chiffres 18 mois plus tard : un tour de seed de 1,2 million d'euros auprès de business angels de l'écosystème. \"Sans le réseau de l'accélérateur, on n'aurait jamais rencontré ces investisseurs.\" 5 emplois sont créés dans la foulée." },
      { titre: "La stratégie de scale internationale", contenu: "En 2023, IADYS déploie ses robots à Amsterdam, Rotterdam puis Copenhague. Le pivot international est piloté depuis Roquefort-la-Bédoule. \"On a gardé notre ancrage territorial méditerranéen, mais notre marché n'est plus régional. C'est cette dualité qui fait notre force.\"" },
      { titre: "Les leçons pour les autres alumni", contenu: "Nicolas partage 3 conseils pour les start-ups qui suivent : 1/ Ne pas chercher à lever tout de suite, prendre le temps de valider avec des clients pilotes. 2/ Choisir 2 mentors, un opérationnel et un stratégique. 3/ Utiliser le réseau alumni sans complexe, personne ne refuse un café à un pair de l'accélérateur." },
    ],
  },
  {
    id: 'anotherway-reinventer-hygiene',
    entreprise: 'Anotherway',
    fondateur: 'Samuel Olichon',
    titre: "Réinventer l'hygiène du quotidien",
    sous_titre: "Comment Anotherway est devenue une marque de référence en 6 ans",
    duree_lecture: 7,
    date: '2026-04-18',
    chapitres: [
      { titre: "Le constat initial", contenu: "Samuel Olichon fait le tour de ses placards en 2019. \"J'avais 30 produits d'hygiène différents, tous emballés dans du plastique, tous pleins d'ingrédients que je ne comprenais pas.\" L'idée de simplifier avec des solides sans emballages naît de ce constat personnel." },
      { titre: "L'apport du programme M'Scale Up", contenu: "L'accélération lui permet de professionnaliser une start-up de 3 personnes qui expédie depuis une cuisine. \"Ils m'ont poussé à trouver un vrai partenaire logistique, à structurer ma prod, et à recruter une DAF avant les autres postes.\" Le passage à 15 salariés se fait en 24 mois." },
      { titre: "La bataille sur les linéaires", contenu: "En 2022, Anotherway signe avec Monoprix. \"C'était David contre Goliath. On a passé 8 mois à négocier les fiches produits, la logistique, les MOQ.\" Le déclic vient d'un mentor de l'accélérateur qui l'aide à structurer sa proposition commerciale." },
      { titre: "Le pivot marque + éditeur", contenu: "En 2024, Samuel choisit de ne plus se battre que sur son propre linéaire. Il crée une agence de conseil qui aide les grandes marques à passer aux solides. Un pivot audacieux, salué par ses pairs alumni." },
      { titre: "Ses conseils pour les alumni qui suivent", contenu: "\"Ne recrutez pas avant d'avoir mesuré 3 fois le besoin. Prenez un mentor industriel dès le début, pas un consultant startup. Et surtout, allez voir les autres alumni : on ne se rend pas compte à quel point on peut s'entraider quand on demande.\"" },
    ],
  },
  {
    id: 'greencityzen-capteurs-urbains',
    entreprise: 'GreenCityzen',
    fondateur: 'Alexandre Boudonne, François Hamon, Guy Lecurieux-Lafayette',
    titre: "Faire parler les villes",
    sous_titre: "L'histoire de GreenCityzen, des capteurs urbains à la certification B Corp",
    duree_lecture: 6,
    date: '2026-03-25',
    chapitres: [
      { titre: "Trois fondateurs, une même intuition", contenu: "Alexandre, François et Guy se rencontrent lors d'un hackathon marseillais en 2018. Tous les trois convaincus que les villes ont besoin de capter des données environnementales pour mieux se piloter, ils fondent GreenCityzen. \"On a commencé à trois dans un cowork près du Vieux Port.\"" },
      { titre: "Le passage à l'Accélérateur M", contenu: "Le programme M'Scale Up en 2019 leur apporte une structuration. \"On avait la techno, il nous manquait la méthode pour vendre à des collectivités. L'accélérateur nous a mis en relation avec des DGS et des adjoints à l'écologie.\"" },
      { titre: "Le premier gros contrat", contenu: "La ville de Marseille les choisit en 2021 pour équiper le port. \"On a mesuré la qualité de l'air en temps réel dans 15 zones portuaires. Les résultats ont surpris tout le monde et débouché sur un plan d'action municipal.\"" },
      { titre: "La certification B Corp", contenu: "En 2026, après 18 mois d'audit, GreenCityzen devient B Corp. \"On voulait matérialiser notre engagement pour aller au-delà des mots. Ce label ouvre des portes chez nos clients collectivités et les investisseurs impact.\"" },
      { titre: "Leur message aux alumni", contenu: "\"Ne sous-estimez pas la lenteur des ventes B2G. On a mis 18 mois à signer notre premier gros contrat. Et n'ayez pas peur d'utiliser le nom de l'Accélérateur M dans vos prises de contact : c'est reconnu et ça ouvre des portes.\"" },
    ],
  },
  {
    id: 'lily-handicap',
    entreprise: 'Lily Facilite La Vie',
    fondateur: 'Fondatrice Lily',
    titre: "Digitaliser l'aide aux personnes handicapées",
    sous_titre: "Comment Lily est devenue la référence des aidants en France",
    duree_lecture: 5,
    date: '2026-02-14',
    chapitres: [
      { titre: "Une histoire personnelle", contenu: "L'idée vient d'un vécu familial. Une proche est aidante d'un parent en situation de handicap, et se retrouve seule face à un empilement de démarches administratives, d'aides mal connues et d'informations éparpillées. \"Il y avait un vrai vide dans le paysage numérique.\"" },
      { titre: "Le programme d'accélération", contenu: "MPU#03 en 2020 apporte à Lily un cadrage produit et un premier réseau institutionnel. \"L'accélérateur nous a mis en contact avec la MDPH des Bouches-du-Rhône dès la troisième semaine. Ça a validé notre thèse.\"" },
      { titre: "Le déploiement national", contenu: "Après Marseille, Lily s'étend à Paris, Lyon, Bordeaux. En 2024, la plateforme est utilisée par 50 000 aidants et 15 collectivités. Le prix Startup Inclusion en 2026 marque une nouvelle étape." },
      { titre: "Les conseils de Lily aux alumni", contenu: "\"Chez nous, chaque nouvelle collectivité prend 6 mois de commercial. Il faut préparer sa trésorerie pour tenir. Et le réseau alumni de l'accélérateur nous a aidés à recruter deux personnes clés en 2023.\"" },
    ],
  },
];

let currentRecitFilter = 'tous';

function renderRecits() {
  const totalMinutes = ALUMNI_RECITS.reduce((s, r) => s + r.duree_lecture, 0);
  document.getElementById('app').innerHTML = `
    <div class="p26-page recits-page-2026">
      <div class="p26-aurora"></div>
      <header class="p26-hero p26-reveal">
        <div>
          <h2 class="p26-h2">Récits d'alumni</h2>
          <p class="p26-hero-tagline">Des histoires racontées par les alumni pour les alumni. Parcours, décisions clés, leçons apprises. Un espace de partage entre pairs.</p>
        </div>
        <div class="p26-hero-stats">
          <div class="p26-stat"><b>${ALUMNI_RECITS.length}</b><span>récits</span></div>
          <div class="p26-stat"><b>${totalMinutes}</b><span>min de lecture</span></div>
          <div class="p26-stat"><b>${new Set(ALUMNI_RECITS.map(r => r.entreprise)).size}</b><span>fondateurs</span></div>
        </div>
      </header>

      <div class="recits-grid-2026">
        ${ALUMNI_RECITS.map((r, i) => {
          const entObj = state.entreprises.find(e => e.nom === r.entreprise);
          return `
            <article class="recit-card-2026 p26-reveal" style="transition-delay:${i * 60}ms;" onclick="navigate('#/alumni/recit/${escapeHtml(r.id)}')">
              <div class="recit-cover-2026">
                <span class="recit-duration-badge">${r.duree_lecture} min</span>
                <span class="recit-initials-2026">${escapeHtml(initials(r.entreprise))}</span>
              </div>
              <div class="recit-content-2026">
                <div class="recit-meta-2026">
                  <span>${escapeHtml(formatNewsDate(r.date))}</span>
                  <span>·</span>
                  <span>${escapeHtml(r.entreprise)}</span>
                </div>
                <h3 class="recit-titre-2026">${escapeHtml(r.titre)}</h3>
                <p class="recit-soustitre-2026">${escapeHtml(r.sous_titre)}</p>
                <div class="recit-footer-2026">
                  <span class="recit-fondateur-2026">${escapeHtml(r.fondateur)}</span>
                  <span class="recit-cta-arrow">→</span>
                </div>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    </div>
  `;

  requestAnimationFrame(() => {
    document.querySelectorAll('.recits-page-2026 .p26-reveal').forEach((el, i) => {
      setTimeout(() => el.classList.add('reveal-in'), 60 * i);
    });
  });
}

function renderRecitDetail(id) {
  const r = ALUMNI_RECITS.find(x => x.id === id);
  if (!r) {
    document.getElementById('app').innerHTML = `<div class="recit-detail"><div class="empty-state"><h4>Récit introuvable</h4><p><a href="#/alumni/recits">Retour aux récits</a></p></div></div>`;
    return;
  }
  const ent = state.entreprises.find(e => e.nom === r.entreprise);
  document.getElementById('app').innerHTML = `
    <div class="recit-detail">
      <a class="back-link" href="#/alumni/recits">← Retour aux récits</a>
      <div class="recit-hero">
        <div class="recit-hero-meta">
          <span>${escapeHtml(formatNewsDate(r.date))}</span>
          <span>·</span>
          <span>${r.duree_lecture} min de lecture</span>
          <span>·</span>
          <span>${escapeHtml(r.entreprise)}</span>
        </div>
        <h1 class="recit-hero-titre">${escapeHtml(r.titre)}</h1>
        <p class="recit-hero-soustitre">${escapeHtml(r.sous_titre)}</p>
        <div class="recit-hero-signature">
          <div class="recit-signature-avatar">${escapeHtml(initials(r.fondateur))}</div>
          <div>
            <div class="recit-signature-nom">${escapeHtml(r.fondateur)}</div>
            <div class="recit-signature-role">Fondateur ${escapeHtml(r.entreprise)}</div>
          </div>
        </div>
      </div>
      <div class="recit-body">
        ${r.chapitres.map((c, i) => `
          <section class="recit-chapitre">
            <div class="recit-chapitre-num">${String(i + 1).padStart(2, '0')}</div>
            <h2 class="recit-chapitre-titre">${escapeHtml(c.titre)}</h2>
            <p class="recit-chapitre-contenu">${escapeHtml(c.contenu)}</p>
          </section>
        `).join('')}
      </div>
      ${ent ? `
        <div class="recit-cta">
          <p>Envie d'en savoir plus sur ${escapeHtml(r.entreprise)} ?</p>
          <a class="btn-primary" href="#/alumni/entreprise/${escapeHtml(ent.id)}">Voir la fiche entreprise</a>
        </div>
      ` : ''}
    </div>
  `;
}

// ================================================================
// COMPARATEUR — page /alumni/compare
// ================================================================
function renderCompare() {
  const ids = CompareStore.get();
  const ents = ids.map(id => state.entreprises.find(e => e.id === id)).filter(Boolean);
  if (!ents.length) {
    document.getElementById('app').innerHTML = `
      <div class="p26-page compare-page-2026">
        <div class="p26-aurora"></div>
        <header class="p26-hero">
          <div>
            <h2 class="p26-h2">Comparateur</h2>
            <p class="p26-hero-tagline">Sélectionne 2 à 4 entreprises depuis le portfolio ou la carte, puis reviens ici pour un comparatif chiffré côte à côte.</p>
          </div>
        </header>
        <div class="alumni-empty" style="margin-top:40px;">
          <div class="alumni-empty-orb"></div>
          <h4>Aucune entreprise sélectionnée</h4>
          <p>Clique sur l'icône <b>⇄</b> sur une card entreprise pour l'ajouter au comparatif.</p>
          <a class="btn-primary" href="#/alumni" style="margin-top:20px;display:inline-block;">Aller au portfolio</a>
        </div>
      </div>`;
    return;
  }
  const rows = [
    { label: 'Ville', fn: e => e.ville || '—' },
    { label: 'Statut', fn: e => e.statut || '—' },
    { label: 'Année création', fn: e => e.annee_creation || e.date_creation || '—' },
    { label: 'Programme(s)', fn: e => (e.programmes || []).join(', ') || '—' },
    { label: 'Promotion(s)', fn: e => (e.promotions || []).join(', ') || '—' },
    { label: 'Thématiques', fn: e => (e.thematiques || []).join(', ') || '—' },
    { label: 'Fonds levés', fn: e => e.fonds_leves ? formatMoney(e.fonds_leves) : '—' },
    { label: 'Emplois', fn: e => e.emplois || '—' },
    { label: 'Forme juridique', fn: e => e.forme_juridique || '—' },
    { label: 'Description', fn: e => (e.description_courte || e.description_longue || '—').slice(0, 140) },
  ];
  document.getElementById('app').innerHTML = `
    <div class="p26-page compare-page-2026">
      <div class="p26-aurora"></div>
      <header class="p26-hero p26-reveal">
        <div>
          <h2 class="p26-h2">Comparateur</h2>
          <p class="p26-hero-tagline">${ents.length} entreprises côte à côte. Compare fonds, emplois, programmes, thématiques.</p>
        </div>
        <div class="p26-hero-stats">
          <div class="p26-stat"><b>${ents.length}</b><span>en comparaison</span></div>
          <div class="p26-stat"><b>${formatMoney(ents.reduce((s,e)=>s+(e.fonds_leves||0),0))}</b><span>cumul fonds</span></div>
          <div class="p26-stat"><b>${ents.reduce((s,e)=>s+(e.emplois||0),0)}</b><span>emplois cumul</span></div>
        </div>
      </header>
      <div class="compare-toolbar p26-reveal">
        <button class="p26-filter-pill" onclick="exportComparePNG()">${iconSvg('camera', 14)} <span>Export PNG</span></button>
        <button class="p26-filter-pill" onclick="CompareStore.clear(); renderCompare();">Vider</button>
        <a class="p26-filter-pill" href="#/alumni">+ Ajouter</a>
      </div>
      <div class="compare-grid p26-reveal" id="compare-grid" style="grid-template-columns: 160px repeat(${ents.length}, minmax(180px, 1fr));">
        <div class="compare-th"></div>
        ${ents.map(e => `
          <div class="compare-th compare-th--entreprise">
            <div class="compare-th-logo">${(e.logo_url||'').startsWith('data:') ? `<img src="${e.logo_url}" alt="">` : `<span>${escapeHtml(initials(e.nom))}</span>`}</div>
            <div class="compare-th-name">${escapeHtml(e.nom)}</div>
            <button class="compare-th-remove" onclick="CompareStore.toggle('${escapeHtml(e.id)}'); renderCompare();" title="Retirer">×</button>
          </div>
        `).join('')}
        ${rows.map(row => `
          <div class="compare-row-label">${escapeHtml(row.label)}</div>
          ${ents.map(e => `<div class="compare-row-val">${escapeHtml(String(row.fn(e)))}</div>`).join('')}
        `).join('')}
      </div>
    </div>
  `;
  requestAnimationFrame(() => {
    document.querySelectorAll('.compare-page-2026 .p26-reveal').forEach((el, i) => {
      setTimeout(() => el.classList.add('reveal-in'), 60 * i);
    });
  });
}

function exportComparePNG() {
  const grid = document.getElementById('compare-grid');
  if (!grid) return;
  const ids = CompareStore.get();
  const ents = ids.map(id => state.entreprises.find(e => e.id === id)).filter(Boolean);
  const W = 1200, H = 800 + ents.length * 20;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  // Fond
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#F0F5F7'); grad.addColorStop(1, '#DDE7EE');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  // Titre
  g.fillStyle = '#193947';
  g.font = '300 42px "D-DIN Condensed"';
  g.fillText('Comparateur M alumni', 40, 60);
  g.font = '14px "D-DIN"';
  g.fillStyle = 'rgba(25,57,71,0.6)';
  g.fillText(`${ents.length} entreprises · ${new Date().toLocaleDateString('fr-FR')}`, 40, 90);
  // Table
  const startY = 130;
  const colW = (W - 260) / ents.length;
  ents.forEach((e, i) => {
    const x = 240 + i * colW;
    g.fillStyle = '#193947';
    g.font = '500 18px "D-DIN Condensed"';
    g.fillText(e.nom.slice(0, 20), x + 10, startY);
  });
  const rows = [
    ['Ville', e => e.ville || '—'],
    ['Statut', e => e.statut || '—'],
    ['Année', e => e.annee_creation || '—'],
    ['Fonds', e => e.fonds_leves ? formatMoney(e.fonds_leves) : '—'],
    ['Emplois', e => e.emplois || '—'],
    ['Programmes', e => (e.programmes || []).join(', ').slice(0, 30)],
    ['Thèmes', e => (e.thematiques || []).join(', ').slice(0, 30)],
  ];
  rows.forEach((row, ri) => {
    const y = startY + 40 + ri * 44;
    g.strokeStyle = 'rgba(25,57,71,0.1)';
    g.beginPath(); g.moveTo(40, y - 20); g.lineTo(W - 40, y - 20); g.stroke();
    g.fillStyle = 'rgba(25,57,71,0.55)';
    g.font = '600 11px "D-DIN"';
    g.fillText(row[0].toUpperCase(), 40, y);
    g.fillStyle = '#193947';
    g.font = '14px "D-DIN"';
    ents.forEach((e, i) => {
      const x = 240 + i * colW;
      g.fillText(String(row[1](e)).slice(0, 24), x + 10, y);
    });
  });
  // Footer
  g.fillStyle = 'rgba(25,57,71,0.4)';
  g.font = '11px "D-DIN"';
  g.fillText('m-alumni.accelerateurm.com', 40, H - 20);
  // Download
  c.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `m-alumni-compare-${Date.now()}.png`;
    a.click();
    Sfx.play('ok');
    showToast('Comparatif exporté en PNG', 'success');
  });
}
window.exportComparePNG = exportComparePNG;
window.renderCompare = renderCompare;

// ================================================================
// GRAPHE DE CONNEXIONS — force-directed canvas
// ================================================================
function renderGraphe() {
  const entr = state.entreprises;
  document.getElementById('app').innerHTML = `
    <div class="p26-page graphe-page-2026">
      <div class="p26-aurora"></div>
      <header class="p26-hero p26-reveal">
        <div>
          <h2 class="p26-h2">Graphe de connexions</h2>
          <p class="p26-hero-tagline">${entr.length} start-ups reliées par leurs programmes et thématiques communes. Glisse pour déplacer, molette pour zoomer, clique un nœud pour ouvrir sa fiche.</p>
        </div>
        <div class="p26-hero-stats">
          <div class="p26-stat"><b>${entr.length}</b><span>nœuds</span></div>
          <div class="p26-stat"><b id="graphe-links">…</b><span>connexions</span></div>
        </div>
      </header>
      <div class="graphe-toolbar p26-reveal">
        <button class="p26-filter-pill graphe-mode active" data-mode="programme" onclick="switchGrapheMode('programme')">Par programme</button>
        <button class="p26-filter-pill graphe-mode" data-mode="thematique" onclick="switchGrapheMode('thematique')">Par thématique</button>
        <button class="p26-filter-pill graphe-mode" data-mode="ville" onclick="switchGrapheMode('ville')">Par ville</button>
      </div>
      <div class="graphe-wrap p26-reveal">
        <canvas id="graphe-canvas"></canvas>
        <div id="graphe-tooltip" class="graphe-tooltip" style="display:none;"></div>
      </div>
    </div>
  `;
  requestAnimationFrame(() => {
    document.querySelectorAll('.graphe-page-2026 .p26-reveal').forEach((el, i) => {
      setTimeout(() => el.classList.add('reveal-in'), 60 * i);
    });
    initGraphe('programme');
  });
}

function switchGrapheMode(mode) {
  document.querySelectorAll('.graphe-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  initGraphe(mode);
}
window.switchGrapheMode = switchGrapheMode;

let grapheRAF = null;
function initGraphe(mode) {
  if (grapheRAF) cancelAnimationFrame(grapheRAF);
  const canvas = document.getElementById('graphe-canvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = 620;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const entr = state.entreprises;
  const getKey = e => mode === 'programme' ? (e.programmes || []) : mode === 'thematique' ? (e.thematiques || []) : (e.ville ? [e.ville] : []);

  // Nœuds
  const nodes = entr.map(e => ({
    id: e.id, e,
    x: W/2 + (Math.random()-0.5)*W*0.8,
    y: H/2 + (Math.random()-0.5)*H*0.8,
    vx: 0, vy: 0,
    r: 4 + Math.min(12, Math.sqrt((e.fonds_leves||0) / 100000)),
  }));
  const idx = new Map(nodes.map(n => [n.id, n]));

  // Liens : on filtre pour ne garder que les connexions significatives
  const linkMap = new Map();
  entr.forEach((a, i) => {
    entr.slice(i+1).forEach(b => {
      const ka = new Set(getKey(a).map(k => k.toLowerCase()));
      const kb = new Set(getKey(b).map(k => k.toLowerCase()));
      const inter = [...ka].filter(k => kb.has(k));
      if (inter.length) linkMap.set(`${a.id}::${b.id}`, { a: a.id, b: b.id, w: inter.length });
    });
  });
  let links = [...linkMap.values()];
  // Si trop dense (>800 liens), on ne garde que les paires de poids >= 2, sinon top-800
  if (links.length > 800) {
    const strong = links.filter(l => l.w >= 2);
    links = strong.length >= 40 ? strong : links.sort((a,b) => b.w - a.w).slice(0, 800);
  }
  const linkEl = document.getElementById('graphe-links');
  if (linkEl) linkEl.textContent = links.length;

  // Camera
  let cam = { x: 0, y: 0, s: 1 };
  let dragging = null, panning = false, panLast = null;
  let hoverNode = null;

  canvas.onmousedown = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left - cam.x) / cam.s;
    const my = (e.clientY - rect.top - cam.y) / cam.s;
    const n = nodes.find(n => Math.hypot(n.x - mx, n.y - my) < n.r + 4);
    if (n) { dragging = n; n.vx = n.vy = 0; }
    else { panning = true; panLast = { x: e.clientX, y: e.clientY }; }
  };
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    if (dragging) {
      dragging.x = (e.clientX - rect.left - cam.x) / cam.s;
      dragging.y = (e.clientY - rect.top - cam.y) / cam.s;
      return;
    }
    if (panning) {
      cam.x += e.clientX - panLast.x;
      cam.y += e.clientY - panLast.y;
      panLast = { x: e.clientX, y: e.clientY };
      return;
    }
    const mx = (e.clientX - rect.left - cam.x) / cam.s;
    const my = (e.clientY - rect.top - cam.y) / cam.s;
    hoverNode = nodes.find(n => Math.hypot(n.x - mx, n.y - my) < n.r + 4) || null;
    const tt = document.getElementById('graphe-tooltip');
    if (hoverNode && tt) {
      tt.style.display = 'block';
      tt.style.left = (e.clientX - rect.left + 12) + 'px';
      tt.style.top = (e.clientY - rect.top + 12) + 'px';
      const modeVal = mode === 'ville' ? [hoverNode.e.ville].filter(Boolean) : (hoverNode.e[mode+'s'] || []);
      tt.innerHTML = `<b>${escapeHtml(hoverNode.e.nom)}</b><span>${escapeHtml(hoverNode.e.ville || '')} · ${modeVal.slice(0,2).join(', ')}</span>`;
      canvas.style.cursor = 'pointer';
    } else if (tt) { tt.style.display = 'none'; canvas.style.cursor = panning ? 'grabbing' : 'grab'; }
  };
  canvas.onmouseup = (e) => {
    if (dragging && !panning) {
      const moved = Math.hypot(e.movementX||0, e.movementY||0);
      if (moved < 3 && hoverNode) navigate('#/alumni/entreprise/' + dragging.e.id);
    }
    dragging = null; panning = false;
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const before = { x: (mx - cam.x) / cam.s, y: (my - cam.y) / cam.s };
    cam.s = Math.max(0.3, Math.min(3, cam.s * (e.deltaY > 0 ? 0.9 : 1.1)));
    cam.x = mx - before.x * cam.s;
    cam.y = my - before.y * cam.s;
  };

  const step = () => {
    // Physique force-directed
    for (const n of nodes) { n.vx *= 0.85; n.vy *= 0.85; }
    // Répulsion (n²)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i+1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx*dx + dy*dy + 0.01;
        const f = 1200 / d2;
        const d = Math.sqrt(d2);
        const fx = f * dx / d, fy = f * dy / d;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    // Attraction liens
    for (const l of links) {
      const a = idx.get(l.a), b = idx.get(l.b);
      const dx = b.x - a.x, dy = b.y - a.y;
      const f = 0.005 * l.w;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    // Centre gravity
    for (const n of nodes) {
      n.vx += (W/2 - n.x) * 0.001;
      n.vy += (H/2 - n.y) * 0.001;
    }
    for (const n of nodes) {
      if (n !== dragging) { n.x += n.vx; n.y += n.vy; }
    }
    // Draw
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.s, cam.s);
    // Liens
    ctx.lineCap = 'round';
    for (const l of links) {
      const a = idx.get(l.a), b = idx.get(l.b);
      ctx.strokeStyle = `rgba(0,153,255,${Math.min(0.35, 0.06 + l.w * 0.08)})`;
      ctx.lineWidth = Math.min(2.5, 0.5 + l.w * 0.4);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // Nœuds — couleur adaptée thème
    const isDark = document.body.dataset.theme === 'dark';
    const nodeFill = isDark ? '#F0F5F7' : '#193947';
    for (const n of nodes) {
      ctx.fillStyle = n === hoverNode ? '#0099FF' : nodeFill;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
      if (n === hoverNode) {
        ctx.strokeStyle = 'rgba(0,153,255,0.5)';
        ctx.lineWidth = 6;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
    grapheRAF = requestAnimationFrame(step);
  };
  step();
}
window.renderGraphe = renderGraphe;

// ================================================================
// MODE PRÉSENTATION — touche P
// ================================================================
function togglePresentMode() {
  const on = document.body.dataset.mode !== 'present';
  document.body.dataset.mode = on ? 'present' : '';
  Sfx.play(on ? 'whoosh' : 'tick');
  if (on) {
    try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); } catch(e){}
    showToast('Mode présentation activé (P pour quitter)', 'success', { duration: 3000 });
  } else {
    try { document.exitFullscreen && document.fullscreenElement && document.exitFullscreen(); } catch(e){}
  }
}
window.togglePresentMode = togglePresentMode;

// ================================================================
// GÉNÉRATEUR D'AFFICHE PNG — pour une fiche entreprise
// ================================================================
function generatePoster(entrepriseId) {
  const e = state.entreprises.find(x => x.id === entrepriseId);
  if (!e) { showToast('Entreprise introuvable', 'error'); return; }
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  // Fond gradient
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#193947'); grad.addColorStop(0.6, '#0F2530'); grad.addColorStop(1, '#0D1E26');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  // Aurora bleue
  const aurora = g.createRadialGradient(W*0.3, H*0.2, 100, W*0.3, H*0.2, W*0.8);
  aurora.addColorStop(0, 'rgba(0,153,255,0.4)'); aurora.addColorStop(1, 'transparent');
  g.fillStyle = aurora; g.fillRect(0, 0, W, H);
  // Iso-cube grain
  g.fillStyle = 'rgba(255,255,255,0.03)';
  for (let y = 0; y < H; y += 40) for (let x = 0; x < W; x += 40) {
    g.beginPath(); g.arc(x, y, 1, 0, Math.PI*2); g.fill();
  }
  // Header eyebrow
  g.fillStyle = 'rgba(0,153,255,0.9)';
  g.font = '600 20px "D-DIN"';
  g.fillText('M ALUMNI · ACCÉLÉRATEUR M', 60, 100);
  // Nom XXL
  g.fillStyle = '#FFFFFF';
  g.font = '400 88px "D-DIN Condensed"';
  const name = e.nom.length > 18 ? e.nom.slice(0, 16) + '…' : e.nom;
  g.fillText(name, 60, 220);
  // Sous-titre
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.font = '400 28px "D-DIN"';
  const sub = (e.description_courte || e.description_longue || '').slice(0, 80);
  wrapText(g, sub, 60, 280, W - 120, 40);
  // Logo panel
  if ((e.logo_url||'').startsWith('data:')) {
    const img = new Image();
    img.onload = () => {
      g.fillStyle = '#FFFFFF';
      g.beginPath(); g.roundRect(60, 460, 240, 240, 24); g.fill();
      const sz = 200;
      g.drawImage(img, 80, 480, sz, sz);
      drawPosterKPIs();
    };
    img.src = e.logo_url;
  } else {
    // Initiales
    g.fillStyle = '#FFFFFF';
    g.beginPath(); g.roundRect(60, 460, 240, 240, 24); g.fill();
    g.fillStyle = '#193947';
    g.font = '300 100px "D-DIN Condensed"';
    g.textAlign = 'center';
    g.fillText(initials(e.nom), 180, 615);
    g.textAlign = 'left';
    drawPosterKPIs();
  }
  function drawPosterKPIs() {
    const kpis = [
      { v: e.fonds_leves ? formatMoney(e.fonds_leves) : '—', l: 'FONDS LEVÉS' },
      { v: e.emplois || '—', l: 'EMPLOIS' },
      { v: e.annee_creation || e.date_creation || '—', l: 'FONDÉE' },
    ];
    kpis.forEach((k, i) => {
      const y = 480 + i * 90;
      g.fillStyle = '#FFFFFF';
      g.font = '300 56px "D-DIN Condensed"';
      g.fillText(k.v, 360, y);
      g.fillStyle = 'rgba(0,153,255,0.9)';
      g.font = '600 14px "D-DIN"';
      g.fillText(k.l, 360, y + 24);
    });
    // Programmes/tags
    const tags = [...(e.programmes||[]).slice(0,2), ...(e.thematiques||[]).slice(0,2)];
    let tx = 60;
    tags.forEach(t => {
      const tw = g.measureText(t).width + 40;
      g.fillStyle = 'rgba(0,153,255,0.15)';
      g.strokeStyle = 'rgba(0,153,255,0.4)';
      g.beginPath(); g.roundRect(tx, 800, tw, 40, 20); g.fill(); g.stroke();
      g.fillStyle = '#4EBED6';
      g.font = '600 14px "D-DIN"';
      g.fillText(t.toUpperCase(), tx + 20, 826);
      tx += tw + 8;
    });
    // Footer
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.font = '500 20px "D-DIN"';
    g.fillText(e.ville || '', 60, 1240);
    g.fillStyle = 'rgba(0,153,255,0.9)';
    g.font = '600 14px "D-DIN"';
    g.fillText('M-ALUMNI.ACCELERATEURM.COM', 60, 1290);
    // Cube marque M en bas droit
    g.fillStyle = 'rgba(255,255,255,0.15)';
    g.font = '400 120px "D-DIN Condensed"';
    g.textAlign = 'right';
    g.fillText('M', W - 60, 1300);
    g.textAlign = 'left';
    c.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `m-alumni-${e.id}.png`;
      a.click();
      Sfx.play('ok');
      showToast(`Affiche ${e.nom} téléchargée`, 'success');
    });
  }
}
function wrapText(g, text, x, y, maxW, lh) {
  const words = text.split(' ');
  let line = '';
  for (const w of words) {
    const test = line + w + ' ';
    if (g.measureText(test).width > maxW && line) {
      g.fillText(line, x, y); line = w + ' '; y += lh;
    } else line = test;
  }
  g.fillText(line, x, y);
}
window.generatePoster = generatePoster;

// ================================================================
// STORYTELLING — particules canvas sur landing
// ================================================================
function initLandingParticles() {
  const canvas = document.getElementById('landing-particles');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  };
  resize();
  window.addEventListener('resize', resize);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const N = 60;
  const particles = Array.from({ length: N }, () => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
    r: 1 + Math.random() * 2,
  }));
  let scrollY = 0;
  window.addEventListener('scroll', () => { scrollY = window.scrollY; }, { passive: true });
  const step = () => {
    if (!document.getElementById('landing-particles')) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const pull = Math.min(1, scrollY / 400);
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    particles.forEach(p => {
      p.x += p.vx * (1 - pull);
      p.y += p.vy * (1 - pull);
      // Attraction vers centre quand on scroll
      p.x += (cx - p.x) * 0.008 * pull;
      p.y += (cy - p.y) * 0.008 * pull;
      if (p.x < 0 || p.x > window.innerWidth) p.vx *= -1;
      if (p.y < 0 || p.y > window.innerHeight) p.vy *= -1;
      ctx.fillStyle = `rgba(0,153,255,${0.15 + pull * 0.4})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    });
    // Liens entre particules proches
    for (let i = 0; i < particles.length; i++) {
      for (let j = i+1; j < particles.length; j++) {
        const a = particles[i], b = particles[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 120) {
          ctx.strokeStyle = `rgba(0,153,255,${(1 - d/120) * 0.15 * (0.4 + pull)})`;
          ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    requestAnimationFrame(step);
  };
  step();
}
window.initLandingParticles = initLandingParticles;

// ================================================================
// REALTIME COLLAB — SSE client
// ================================================================
function initRealtimeCollab() {
  if (!window.API_BASE) return;
  try {
    const es = new EventSource(window.API_BASE + '/api/events');
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'entreprise-updated' && msg.id) {
          // Rafraîchit silencieusement l'entreprise en mémoire
          apiGetFullState().then(full => {
            if (full && full.entreprises) {
              state.entreprises = full.entreprises;
              showToast(`✦ ${msg.by || 'Un alumni'} vient de mettre à jour ${msg.nom || 'une fiche'}`, 'info', { duration: 4000 });
              router();
            }
          }).catch(()=>{});
        }
      } catch(e) {}
    };
    es.onerror = () => { /* silencieux */ };
  } catch(e) {}
}
window.initRealtimeCollab = initRealtimeCollab;

// ================================================================
// CURSOR SPOTLIGHT — halo bleu qui suit la souris
// ================================================================
(function initCursorSpotlight() {
  const el = document.getElementById('cursor-spotlight');
  if (!el) return;
  let visible = false;
  let raf = null;
  let tx = 0, ty = 0, cx = 0, cy = 0;
  const step = () => {
    cx += (tx - cx) * 0.18;
    cy += (ty - cy) * 0.18;
    el.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
    raf = requestAnimationFrame(step);
  };
  document.addEventListener('mousemove', (e) => {
    tx = e.clientX; ty = e.clientY;
    if (!visible) { el.classList.add('visible'); visible = true; }
    if (!raf) raf = requestAnimationFrame(step);
    const t = e.target;
    const interactive = t.closest && t.closest('a, button, .card, .alumni-card, .stat-block-2026, [onclick], .p26-filter-pill, .card-quick-btn, input, textarea, select');
    el.classList.toggle('interactive', !!interactive);
  }, { passive: true });
  document.addEventListener('mouseleave', () => {
    el.classList.remove('visible'); visible = false;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  });
})();

// ================================================================
// SPLIT-TYPE KINETIC — anime chaque lettre des .kinetic-title
// ================================================================
function applyKineticSplit(root) {
  const scope = root || document;
  scope.querySelectorAll('.kinetic-title:not(.k-done)').forEach(el => {
    const text = el.textContent;
    el.classList.add('k-done');
    el.innerHTML = '';
    const wrap = document.createElement('span');
    wrap.className = 'kinetic-split';
    let i = 0;
    for (const ch of text) {
      const span = document.createElement('span');
      if (ch === ' ') {
        span.className = 'k-space';
        span.innerHTML = '&nbsp;';
      } else {
        span.className = 'k-char';
        span.style.setProperty('--i', i);
        span.textContent = ch;
      }
      wrap.appendChild(span);
      i++;
    }
    el.appendChild(wrap);
  });
}
window.applyKineticSplit = applyKineticSplit;
// Auto-apply after each router() render
const _origRouter = window.router;
if (_origRouter && typeof _origRouter === 'function') {
  window.router = function() {
    const r = _origRouter.apply(this, arguments);
    requestAnimationFrame(() => applyKineticSplit());
    return r;
  };
}

// ================================================================
// CUBE 3D CHATBOT — rotation liée au scroll de la conv
// ================================================================
function initChatbot3DCube() {
  const cube = document.getElementById('chatbot-cube3d');
  const scroller = document.getElementById('chatbot-messages');
  if (!cube || !scroller) return;
  let rx = 30, ry = 45, scrollProxy = 0, tickRAF = null;
  const idleTick = () => {
    rx = 30 + Math.sin(performance.now() / 3000) * 6;
    ry = 45 + (performance.now() / 60) % 360; // rotation continue lente
    cube.style.transform = `translate(-50%, -50%) rotateX(${rx}deg) rotateY(${ry}deg)`;
    tickRAF = requestAnimationFrame(idleTick);
  };
  scroller.addEventListener('scroll', () => {
    scrollProxy = scroller.scrollTop;
    ry = 45 + scrollProxy * 0.3;
    rx = 30 + Math.sin(scrollProxy * 0.01) * 10;
    cube.style.transform = `translate(-50%, -50%) rotateX(${rx}deg) rotateY(${ry}deg)`;
  }, { passive: true });
  if (!tickRAF) idleTick();
}
window.initChatbot3DCube = initChatbot3DCube;

// ================================================================
// SANKEY DIAGRAM — programme → thématique → entreprises
// ================================================================

// ================================================================
// CHORD DIAGRAM — matrice programmes ↔ thématiques
// ================================================================

// ================================================================
// RADIAL PIE — donuts pour stats agrégées
// ================================================================

// ================================================================
// HEATMAP CALENDAR — actus par jour (year-in-review)
// ================================================================
function renderHeatmapCalendar(container, dateList) {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end); start.setDate(end.getDate() - 364);
  // Aligne sur lundi
  while (start.getDay() !== 1) start.setDate(start.getDate() - 1);
  const perDay = new Map();
  dateList.forEach(d => {
    const key = new Date(d).toISOString().slice(0, 10);
    perDay.set(key, (perDay.get(key) || 0) + 1);
  });
  const cells = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const k = cursor.toISOString().slice(0, 10);
    const c = perDay.get(k) || 0;
    const level = c === 0 ? 0 : c === 1 ? 1 : c <= 3 ? 2 : c <= 5 ? 3 : 4;
    cells.push(`<div class="h-cell" data-level="${level}" title="${k} : ${c} actu${c>1?'s':''}"></div>`);
    cursor.setDate(cursor.getDate() + 1);
  }
  container.innerHTML = `
    <div class="viz-title">Fréquence des actualités (12 mois)</div>
    <div class="viz-sub">${dateList.length} actus totales</div>
    <div class="viz-heatmap">${cells.join('')}</div>
    <div class="viz-heatmap-legend">
      Moins
      <div class="h-cell" data-level="0" style="width:10px;height:10px;"></div>
      <div class="h-cell" data-level="1" style="width:10px;height:10px;"></div>
      <div class="h-cell" data-level="2" style="width:10px;height:10px;"></div>
      <div class="h-cell" data-level="3" style="width:10px;height:10px;"></div>
      <div class="h-cell" data-level="4" style="width:10px;height:10px;"></div>
      Plus
    </div>`;
}
window.renderHeatmapCalendar = renderHeatmapCalendar;

// ================================================================
// ICONS — SVG maison pour remplacer les emojis
// ================================================================
const ICONS = {
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.7.5 1 1.3 1 2.1V18h6v-1.2c0-.8.3-1.6 1-2.1A7 7 0 0 0 12 2z"/>',
  bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  pin: '<path d="M12 2v6M12 22v-9M8 12h8"/><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  speech: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  newspaper: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8M15 18h-5M10 6h8v4h-8z"/>',
  columns: '<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="4" height="12" rx="1"/><rect x="16" y="3" width="5" height="16" rx="1"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
};
function iconSvg(name, size = 16, extraCls = '') {
  const paths = ICONS[name] || '';
  return `<svg class="ico ${extraCls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
window.iconSvg = iconSvg;

// ================================================================
// MEDIA MENTIONS — "Ils en parlent" (démo générée par entreprise)
// ================================================================
const MEDIAS = [
  { nom: 'Les Échos', couleur: '#E60028' },
  { nom: 'La Tribune', couleur: '#003399' },
  { nom: 'Maddyness', couleur: '#FF3B00' },
  { nom: 'Frenchweb', couleur: '#00A0DC' },
  { nom: 'La Provence', couleur: '#D71920' },
  { nom: 'Made In Marseille', couleur: '#0096C7' },
  { nom: 'Marsactu', couleur: '#F49F13' },
  { nom: 'BFM Business', couleur: '#005E86' },
  { nom: 'Usine Digitale', couleur: '#004B87' },
  { nom: 'Journal du Net', couleur: '#0057A0' },
];
const MENTION_MODELS = [
  e => `${e.nom} lève ${e.fonds_leves ? formatMoney(e.fonds_leves) : 'un tour de seed'} pour accélérer son déploiement`,
  e => `Comment ${e.nom} réinvente ${(e.thematiques||[])[0] || 'son secteur'}`,
  e => `${e.nom} recrute massivement à ${e.ville || 'Marseille'}`,
  e => `Portrait : ${e.nom}, la pépite ${(e.programmes||[])[0] || "de l'Accélérateur M"}`,
  e => `${e.nom} signe un partenariat stratégique avec un acteur majeur du secteur`,
  e => `${e.nom} figure au palmarès des 50 start-ups à suivre en 2026`,
];
function seedRand(seed) {
  let x = 0;
  for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return () => { x = (x * 1103515245 + 12345) >>> 0; return x / 4294967295; };
}
function getMentionsFor(e) {
  const rnd = seedRand(e.id || e.nom || 'x');
  const n = 3 + Math.floor(rnd() * 2);
  const out = [];
  const usedM = new Set(), usedT = new Set();
  for (let i = 0; i < n; i++) {
    let mi = Math.floor(rnd() * MEDIAS.length);
    while (usedM.has(mi)) mi = (mi + 1) % MEDIAS.length;
    usedM.add(mi);
    let ti = Math.floor(rnd() * MENTION_MODELS.length);
    while (usedT.has(ti)) ti = (ti + 1) % MENTION_MODELS.length;
    usedT.add(ti);
    const daysAgo = Math.floor(rnd() * 240) + 5;
    const d = new Date(); d.setDate(d.getDate() - daysAgo);
    out.push({ media: MEDIAS[mi], titre: MENTION_MODELS[ti](e), date: d.toISOString().slice(0, 10) });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}
function renderMediaMentionsSection(e) {
  const mentions = getMentionsFor(e);
  return `
    <section class="detail-section media-mentions">
      <h3 class="detail-section-title">${iconSvg('newspaper', 16)} Ils en parlent</h3>
      <div class="mentions-list">
        ${mentions.map(m => `
          <a href="#" onclick="event.preventDefault()" class="mention-item">
            <div class="mention-logo" style="background:${m.media.couleur};">${escapeHtml(m.media.nom.slice(0,2).toUpperCase())}</div>
            <div class="mention-body">
              <div class="mention-title">${escapeHtml(m.titre)}</div>
              <div class="mention-meta">${escapeHtml(m.media.nom)} · ${formatNewsDate(m.date)}</div>
            </div>
            ${iconSvg('arrow', 14, 'mention-arrow')}
          </a>
        `).join('')}
      </div>
    </section>`;
}
window.renderMediaMentionsSection = renderMediaMentionsSection;

// ================================================================
// VUE KANBAN portfolio par statut
// ================================================================
const KANBAN_COLS = [
  { key: 'Active', color: '#24F121' },
  { key: 'Rachetée', color: '#0099FF' },
  { key: 'Pivotée', color: '#FFB703' },
  { key: 'Éteinte', color: '#E5324B' },
  { key: 'Inconnu', color: '#727275' },
];
function renderKanbanView(entreprises) {
  const groups = {};
  KANBAN_COLS.forEach(c => groups[c.key] = []);
  entreprises.forEach(e => {
    const st = e.statut || 'Inconnu';
    (groups[st] || groups.Inconnu).push(e);
  });
  return `
    <div class="kanban-wrap">
      ${KANBAN_COLS.map(col => `
        <div class="kanban-col" style="--kb-color:${col.color};">
          <div class="kanban-col-head">
            <div class="kanban-col-dot"></div>
            <h4>${escapeHtml(col.key)}</h4>
            <span class="kanban-col-count">${groups[col.key].length}</span>
          </div>
          <div class="kanban-col-body">
            ${groups[col.key].slice(0, 30).map(e => {
              const logo = (e.logo_url || '').startsWith('data:')
                ? `<img src="${escapeHtml(e.logo_url)}" alt="">`
                : `<span>${escapeHtml(initials(e.nom))}</span>`;
              return `
                <div class="kanban-card" onclick="navigate('#/alumni/entreprise/${escapeHtml(e.id)}')">
                  <div class="kanban-card-logo">${logo}</div>
                  <div class="kanban-card-body">
                    <div class="kanban-card-name">${escapeHtml(e.nom)}</div>
                    <div class="kanban-card-meta">${escapeHtml(e.ville || '')} ${e.fonds_leves ? '· ' + formatMoney(e.fonds_leves) : ''}</div>
                  </div>
                </div>`;
            }).join('')}
            ${groups[col.key].length > 30 ? `<div class="kanban-more">+${groups[col.key].length - 30} de plus</div>` : ''}
          </div>
        </div>
      `).join('')}
    </div>`;
}
window.renderKanbanView = renderKanbanView;

// ================================================================
// RAPPORT PDF portfolio (jsPDF)
// ================================================================
async function generatePortfolioReport() {
  if (!window.jspdf) { showToast('jsPDF pas encore chargé, réessaie dans 2s', 'error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, H = 297, M = 18;
  const brand = { blue: [0, 153, 255], midnight: [25, 57, 71], gray: [115, 115, 117] };
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR');
  const entr = state.entreprises;
  const totalFonds = entr.reduce((s, e) => s + (e.fonds_leves || 0), 0);
  const totalEmplois = entr.reduce((s, e) => s + (e.emplois || 0), 0);
  const withLogo = entr.filter(e => (e.logo_url || '').startsWith('data:')).length;
  const active = entr.filter(e => e.statut === 'Active').length;
  const byProg = {}, byTheme = {}, byCity = {};
  entr.forEach(e => {
    (e.programmes || []).forEach(p => byProg[p] = (byProg[p] || 0) + 1);
    (e.thematiques || []).forEach(t => byTheme[t] = (byTheme[t] || 0) + 1);
    if (e.ville) byCity[e.ville] = (byCity[e.ville] || 0) + 1;
  });
  const topFonds = [...entr].filter(e => e.fonds_leves).sort((a, b) => b.fonds_leves - a.fonds_leves).slice(0, 20);
  // --- PAGE 1 : Couverture ---
  doc.setFillColor(...brand.midnight);
  doc.rect(0, 0, W, H, 'F');
  doc.setFillColor(...brand.blue);
  doc.rect(0, 40, W, 3, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(38);
  doc.text('Portfolio', M, 90);
  doc.text('M alumni', M, 108);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(14);
  doc.setTextColor(0, 153, 255);
  doc.text('ACCÉLÉRATEUR M · MARSEILLE', M, 128);
  doc.setTextColor(200, 220, 235);
  doc.setFontSize(11);
  doc.text('Rapport généré le ' + dateStr, M, 138);
  doc.setDrawColor(0, 153, 255);
  doc.setLineWidth(0.3);
  doc.line(M, 200, W - M, 200);
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(entr.length + ' start-ups accompagnées', M, 212);
  doc.text('depuis 2014', M, 218);
  // Big KPIs on cover
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  doc.setTextColor(0, 153, 255);
  doc.text(String(entr.length), W - M - 60, 212, { align: 'left' });
  doc.text(formatMoney(totalFonds).replace('€', ' EUR'), W - M - 60, 226, { align: 'left' });
  doc.text(String(totalEmplois), W - M - 60, 240, { align: 'left' });
  doc.setFontSize(8);
  doc.setTextColor(180, 200, 215);
  doc.setFont('helvetica', 'normal');
  doc.text('START-UPS', W - M - 60 + 30, 216);
  doc.text('FONDS LEVÉS', W - M - 60 + 30, 230);
  doc.text('EMPLOIS CRÉÉS', W - M - 60 + 30, 244);
  doc.setFontSize(8);
  doc.setTextColor(160, 160, 160);
  doc.text('m-alumni.accelerateurm.com', M, H - 12);
  // --- PAGE 2 : Vue d'ensemble ---
  doc.addPage();
  pdfHeader(doc, 'Vue d\'ensemble', brand);
  let y = 40;
  doc.setFontSize(10); doc.setTextColor(...brand.midnight); doc.setFont('helvetica', 'bold');
  doc.text('Répartition par statut', M, y); y += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...brand.gray);
  const byStat = { Active: 0, Rachetée: 0, Éteinte: 0, Pivotée: 0, Inconnu: 0 };
  entr.forEach(e => byStat[e.statut || 'Inconnu']++);
  Object.entries(byStat).forEach(([k, v]) => {
    doc.setTextColor(...brand.midnight);
    doc.text(k, M, y);
    doc.setTextColor(...brand.blue);
    doc.text(String(v), W - M - 40, y);
    doc.setDrawColor(0, 153, 255);
    doc.setLineWidth(2);
    const w = Math.max(1, (v / entr.length) * 60);
    doc.line(W - M - 30, y - 1, W - M - 30 + w, y - 1);
    y += 6;
  });
  y += 8;
  // Top programmes
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...brand.midnight);
  doc.text('Répartition par programme (top 8)', M, y); y += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  Object.entries(byProg).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => {
    doc.setTextColor(...brand.midnight);
    doc.text(k.slice(0, 40), M, y);
    doc.setTextColor(...brand.blue);
    doc.text(String(v), W - M - 40, y);
    const w = Math.max(1, (v / entr.length) * 60);
    doc.setDrawColor(0, 153, 255); doc.setLineWidth(2);
    doc.line(W - M - 30, y - 1, W - M - 30 + w, y - 1);
    y += 6;
  });
  y += 8;
  // Top villes
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...brand.midnight);
  doc.text('Top 10 villes', M, y); y += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => {
    doc.setTextColor(...brand.midnight); doc.text(k, M, y);
    doc.setTextColor(...brand.blue); doc.text(String(v), W - M - 40, y);
    const w = Math.max(1, (v / entr.length) * 60);
    doc.setDrawColor(0, 153, 255); doc.setLineWidth(2);
    doc.line(W - M - 30, y - 1, W - M - 30 + w, y - 1);
    y += 6;
  });
  pdfFooter(doc, brand);
  // --- PAGE 3 : Top 20 levées ---
  doc.addPage();
  pdfHeader(doc, 'Top 20 des plus grosses levées', brand);
  y = 40;
  doc.setFontSize(9);
  topFonds.forEach((e, i) => {
    if (y > H - 30) { pdfFooter(doc, brand); doc.addPage(); pdfHeader(doc, 'Top 20 (suite)', brand); y = 40; }
    doc.setTextColor(...brand.gray); doc.setFont('helvetica', 'normal');
    doc.text(String(i + 1).padStart(2, '0'), M, y);
    doc.setTextColor(...brand.midnight); doc.setFont('helvetica', 'bold');
    doc.text(e.nom.slice(0, 30), M + 10, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...brand.gray);
    doc.text((e.ville || '—').slice(0, 22), M + 90, y);
    doc.setTextColor(...brand.blue); doc.setFont('helvetica', 'bold');
    doc.text(formatMoney(e.fonds_leves).replace('€', ' EUR'), W - M, y, { align: 'right' });
    y += 6;
  });
  pdfFooter(doc, brand);
  // --- PAGE 4+ : Annuaire complet ---
  doc.addPage();
  pdfHeader(doc, 'Annuaire complet', brand);
  y = 40;
  const sorted = [...entr].sort((a, b) => (a.nom || '').localeCompare(b.nom || ''));
  doc.setFontSize(8);
  sorted.forEach(e => {
    if (y > H - 22) { pdfFooter(doc, brand); doc.addPage(); pdfHeader(doc, 'Annuaire (suite)', brand); y = 40; }
    doc.setTextColor(...brand.midnight); doc.setFont('helvetica', 'bold');
    doc.text(e.nom.slice(0, 40), M, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...brand.gray);
    const meta = [e.ville, (e.promotions || [])[0], (e.programmes || [])[0]].filter(Boolean).join(' · ');
    doc.text(meta.slice(0, 70), M + 55, y);
    if (e.fonds_leves) {
      doc.setTextColor(...brand.blue);
      doc.text(formatMoney(e.fonds_leves).replace('€', ' EUR'), W - M, y, { align: 'right' });
    }
    y += 4.5;
  });
  pdfFooter(doc, brand);
  // Save
  doc.save(`Portfolio-M-alumni-${now.toISOString().slice(0, 10)}.pdf`);
  Sfx.play('ok');
  showToast('Rapport PDF téléchargé ✓', 'success');
}
function pdfHeader(doc, title, brand) {
  doc.setFillColor(...brand.midnight);
  doc.rect(0, 0, 210, 22, 'F');
  doc.setFillColor(...brand.blue);
  doc.rect(0, 22, 210, 0.8, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text('M ALUMNI', 18, 14);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  doc.setTextColor(0, 153, 255);
  doc.text(title, 210 - 18, 14, { align: 'right' });
}
function pdfFooter(doc, brand) {
  doc.setDrawColor(200, 200, 200); doc.setLineWidth(0.2);
  doc.line(18, 285, 192, 285);
  doc.setTextColor(160, 160, 160); doc.setFontSize(7);
  doc.text('m-alumni.accelerateurm.com', 18, 290);
  doc.text('Accélérateur M · Marseille', 105, 290, { align: 'center' });
  doc.text('Page ' + doc.internal.getNumberOfPages(), 192, 290, { align: 'right' });
}
window.generatePortfolioReport = generatePortfolioReport;

// ================================================================
// BREADCRUMBS sticky — path automatique depuis location.hash
// ================================================================
function computeBreadcrumbs() {
  const h = location.hash.replace(/^#/, '').replace(/^\//, '');
  if (!h) return [];
  const parts = h.split('/').filter(Boolean);
  const map = {
    alumni: 'M alumni',
    startups: 'M startups',
    entreprise: 'Entreprise',
    personne: 'Personne',
    personnes: 'Alumni',
    timeline: 'Timeline',
    carte: 'Carte',
    actualites: 'Actualités',
    recits: 'Récits',
    recit: 'Récit',
    stats: 'Statistiques',
    prive: 'Espace privé',
    compare: 'Comparateur',
    graphe: 'Graphe',
    login: 'Connexion',
    admin: 'Administration',
  };
  const items = [];
  let cur = '';
  parts.forEach((p, i) => {
    cur += '/' + p;
    let label = map[p] || decodeURIComponent(p);
    // Si le segment précédent est 'entreprise' ou 'personne', c'est un ID → nom lisible
    if (i > 0 && (parts[i-1] === 'entreprise')) {
      const e = state.entreprises?.find(x => x.id === p);
      if (e) label = e.nom;
    }
    items.push({ label, href: '#' + cur, terminal: i === parts.length - 1 });
  });
  return items;
}
function renderBreadcrumbs() {
  const items = computeBreadcrumbs();
  const bar = document.getElementById('breadcrumbs-bar');
  if (!bar) return;
  if (items.length < 1) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  bar.innerHTML = `
    <nav class="crumbs">
      <a href="#/" class="crumbs-item">Accueil</a>
      ${items.map(it => `
        <span class="crumbs-sep">›</span>
        ${it.terminal
          ? `<span class="crumbs-item crumbs-current">${escapeHtml(it.label)}</span>`
          : `<a href="${escapeHtml(it.href)}" class="crumbs-item">${escapeHtml(it.label)}</a>`}
      `).join('')}
    </nav>`;
}
window.renderBreadcrumbs = renderBreadcrumbs;

// Hook router pour rafraîchir les breadcrumbs
(function hookBreadcrumbs() {
  const orig = window.router;
  if (typeof orig === 'function') {
    window.router = function() {
      const r = orig.apply(this, arguments);
      requestAnimationFrame(renderBreadcrumbs);
      return r;
    };
  }
})();

// ================================================================
// SIMILAR STARTUPS — 4 fiches recommandées en bas de fiche entreprise
// ================================================================
function computeSimilarStartups(e, all, n = 4) {
  const themes = new Set((e.thematiques || []).map(t => t.toLowerCase()));
  const progs = new Set((e.programmes || []).map(p => p.toLowerCase()));
  const ville = (e.ville || '').toLowerCase();
  const scored = all
    .filter(x => x.id !== e.id)
    .map(x => {
      let s = 0;
      (x.thematiques || []).forEach(t => { if (themes.has(t.toLowerCase())) s += 3; });
      (x.programmes || []).forEach(p => { if (progs.has(p.toLowerCase())) s += 2; });
      if (ville && (x.ville || '').toLowerCase() === ville) s += 2;
      if (x.statut === e.statut) s += 1;
      return { e: x, s };
    })
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n);
  return scored.map(x => x.e);
}
function renderSimilarStartupsSection(e) {
  const sim = computeSimilarStartups(e, state.entreprises, 4);
  if (!sim.length) return '';
  return `
    <section class="similar-startups" style="margin-top:40px;">
      <h3 class="p26-h2" style="font-size:22px !important; margin-bottom:16px !important;">Start-ups similaires</h3>
      <div class="similar-grid">
        ${sim.map(x => {
          const logo = (x.logo_url || '').startsWith('data:')
            ? `<img src="${escapeHtml(x.logo_url)}" alt="">`
            : `<span>${escapeHtml(initials(x.nom))}</span>`;
          const fonds = x.fonds_leves ? formatMoney(x.fonds_leves) : '';
          const prog = (x.programmes || [])[0] || '';
          return `
            <a class="similar-card" href="#/alumni/entreprise/${escapeHtml(x.id)}" onclick="Sfx && Sfx.play('nav')">
              <div class="similar-card-logo">${logo}</div>
              <div class="similar-card-name">${escapeHtml(x.nom)}</div>
              <div class="similar-card-meta">
                ${prog ? `<span>${escapeHtml(prog)}</span>` : ''}
                ${fonds ? `<span class="similar-card-fonds">${escapeHtml(fonds)}</span>` : ''}
              </div>
            </a>`;
        }).join('')}
      </div>
    </section>`;
}
window.renderSimilarStartupsSection = renderSimilarStartupsSection;

// ================================================================
// SKELETON SCREEN — placeholder pulsant pendant chargement
// ================================================================
function showSkeleton(kind = 'grid') {
  const app = document.getElementById('app');
  if (!app) return;
  if (kind === 'grid') {
    app.innerHTML = `
      <div style="padding:60px 32px;">
        <div class="skel skel-hero"></div>
        <div class="skel-grid">
          ${Array.from({length: 8}).map(() => `
            <div class="skel-card">
              <div class="skel skel-logo"></div>
              <div class="skel skel-line-lg"></div>
              <div class="skel skel-line-sm"></div>
            </div>
          `).join('')}
        </div>
      </div>`;
  } else if (kind === 'detail') {
    app.innerHTML = `
      <div style="padding:60px 32px; max-width:900px; margin:0 auto;">
        <div class="skel skel-avatar" style="width:120px; height:120px; border-radius:16px; margin:0 auto 20px;"></div>
        <div class="skel skel-line-hero"></div>
        <div class="skel skel-line-md" style="margin: 20px auto; max-width:60%;"></div>
        <div class="skel-detail-grid">
          <div class="skel-block"></div>
          <div class="skel-block"></div>
        </div>
      </div>`;
  }
}
window.showSkeleton = showSkeleton;

// Nombre officiel de start-ups accompagnées (source Accélérateur M) — utilisé partout
/** Tout chiffre affiché se recalcule sur les fiches. Aucune valeur figée. */
function calculeMeta(entreprises) {
  const E = entreprises || [];
  return {
    total_entreprises: E.length,
    total_emplois: E.reduce((s, e) => s + (e.emplois || 0), 0),
    total_fonds: E.reduce((s, e) => s + (e.fonds_leves || 0), 0),
    total_promotions: new Set(E.flatMap(e => e.promotions || [])).size,
    total_programmes: new Set(E.flatMap(e => e.programmes || [])).size,
    startups_eteintes: E.filter(e => (e.statut || '') === 'Éteinte').length,
    cessees_registre: E.filter(e => e.statut_registre === 'Cessée').length,
  };
}

function getOfficialCount() {
  return (state.meta && state.meta.total_entreprises) || state.entreprises.length;
}
window.getOfficialCount = getOfficialCount;

// ================================================================
// CHATBOT V4 : streaming + citations + slash commands + voice
// ================================================================

// --- Streaming typewriter effect ---
function chatStreamText(el, text, done) {
  let i = 0;
  const step = () => {
    if (i >= text.length) { done && done(); return; }
    const chunk = text.slice(i, Math.min(text.length, i + 2));
    el.append(document.createTextNode(chunk));
    i += 2;
    chatScrollBottom();
    setTimeout(step, 12);
  };
  step();
}

// --- Citations : détecte les entreprises mentionnées dans le texte du bot ---
function chatWrapCitations(text) {
  if (!state.entreprises || !state.entreprises.length) return escapeHtml(text);
  // Trie par longueur DESC pour matcher les noms longs d'abord
  const ents = [...state.entreprises].sort((a, b) => (b.nom || '').length - (a.nom || '').length);
  let html = escapeHtml(text);
  const seen = new Set();
  for (const e of ents) {
    if (!e.nom || e.nom.length < 3) continue;
    const key = e.nom.toLowerCase();
    if (seen.has(key)) continue;
    const re = new RegExp('\\b(' + e.nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b', 'i');
    if (re.test(html)) {
      html = html.replace(re, `<a class="chat-cite" href="#/alumni/entreprise/${escapeHtml(e.id)}" onclick="Sfx&&Sfx.play('nav')">$1</a>`);
      seen.add(key);
    }
  }
  return html;
}

// --- Override chatAppendMessage pour streaming + citations sur bot ---
const _origChatAppend = window.chatAppendMessage;
window.chatAppendMessage = function(type, text, html, save = true) {
  const container = document.getElementById('chatbot-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'chatbot-fs-msg ' + type;
  if (html) {
    div.innerHTML = html;
    container.appendChild(div);
    chatScrollBottom();
    if (save) chatUpdateCurrent(s => { s.messages.push({ type, text, html }); });
    return;
  }
  container.appendChild(div);
  if (type === 'bot' && text && text.length > 30) {
    // Stream, puis wrap citations à la fin
    chatStreamText(div, text, () => {
      div.innerHTML = chatWrapCitations(text);
      if (save) chatUpdateCurrent(s => { s.messages.push({ type, text }); });
    });
  } else {
    if (type === 'bot') div.innerHTML = chatWrapCitations(text || '');
    else div.textContent = text || '';
    if (save) chatUpdateCurrent(s => { s.messages.push({ type, text }); });
    chatScrollBottom();
  }
};

// --- Slash commands ---
const SLASH_COMMANDS = [
  { cmd: '/aide', label: 'Aide', desc: 'Voir les commandes admin', apply: () => 'aide' },
  { cmd: '/ajouter-entreprise', label: 'Ajouter entreprise', desc: 'Nouvelle fiche', apply: () => 'ajoute une entreprise "" à Marseille, promo MPU#28, programme M\'Scale Up' },
  { cmd: '/logo', label: 'Attacher un logo', desc: 'Logo pour une entreprise existante', apply: () => 'logo pour "NomEntreprise" ' },
  { cmd: '/promo', label: 'Nouvelle promotion', desc: 'Créer une promo + entreprises', apply: () => 'nouvelle promotion MPU#28 avec entreprises A, B, C' },
  { cmd: '/compteur', label: 'Compteur portfolio', desc: 'Combien d\'entreprises', apply: () => 'combien d\'entreprises dans le portfolio ?' },
];
function chatInitSlash() {
  const input = document.getElementById('chatbot-input');
  if (!input) return;
  let menu = document.getElementById('slash-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'slash-menu';
    menu.className = 'slash-menu';
    menu.style.display = 'none';
    input.parentElement.appendChild(menu);
  }
  input.addEventListener('input', () => {
    const v = input.value;
    if (v.startsWith('/') && chatbotMode === 'admin' && !v.includes(' ')) {
      const filter = v.slice(1).toLowerCase();
      const matches = SLASH_COMMANDS.filter(c => c.cmd.slice(1).includes(filter));
      if (matches.length) {
        menu.innerHTML = matches.map(c => `
          <div class="slash-item" data-cmd="${escapeHtml(c.cmd)}">
            <b>${escapeHtml(c.cmd)}</b>
            <span class="slash-desc">${escapeHtml(c.desc)}</span>
          </div>
        `).join('');
        menu.style.display = 'block';
        menu.querySelectorAll('.slash-item').forEach(el => {
          el.addEventListener('click', () => {
            const cmd = SLASH_COMMANDS.find(c => c.cmd === el.dataset.cmd);
            input.value = cmd.apply();
            menu.style.display = 'none';
            input.focus();
          });
        });
        return;
      }
    }
    menu.style.display = 'none';
  });
  input.addEventListener('blur', () => setTimeout(() => menu.style.display = 'none', 200));
}
window.chatInitSlash = chatInitSlash;

// --- Voice dictation (Web Speech API) ---
let voiceRec = null;
function chatToggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Reconnaissance vocale non supportée par ce navigateur', 'error'); return; }
  const input = document.getElementById('chatbot-input');
  const btn = document.getElementById('chatbot-voice');
  if (voiceRec) {
    voiceRec.stop();
    voiceRec = null;
    btn && btn.classList.remove('is-recording');
    return;
  }
  voiceRec = new SR();
  voiceRec.lang = 'fr-FR';
  voiceRec.continuous = false;
  voiceRec.interimResults = true;
  btn && btn.classList.add('is-recording');
  let finalTranscript = '';
  voiceRec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalTranscript += r[0].transcript;
      else interim += r[0].transcript;
    }
    input.value = finalTranscript + interim;
    input.dispatchEvent(new Event('input'));
  };
  voiceRec.onerror = () => { btn && btn.classList.remove('is-recording'); voiceRec = null; };
  voiceRec.onend = () => { btn && btn.classList.remove('is-recording'); voiceRec = null; input.focus(); };
  voiceRec.start();
  Sfx && Sfx.play('tick');
}
window.chatToggleVoice = chatToggleVoice;

// Init slash + voice à l'ouverture du chatbot
const _origToggleChatbot = window.toggleChatbot;
window.toggleChatbot = function() {
  const r = _origToggleChatbot.apply(this, arguments);
  if (chatbotOpen) {
    setTimeout(() => { chatInitSlash(); }, 250);
  }
  return r;
};
