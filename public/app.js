import { parseM3U } from './m3u.js';
import { BUILTIN_SOURCES, LIBRARY_SOURCES } from './sources.js';

const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 150;
const RECENT_LIMIT = 30;
const START_TIMEOUT_MS = 25000;

// ---------- Persistence ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('tanaw:' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('tanaw:' + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

const state = {
  serverProxy: false,
  proxyMode: store.get('proxyMode', 'auto'),
  hideGeo: store.get('hideGeo', false),
  custom: store.get('customSources', []), // {id, name, emoji, type: 'url'|'file'|'xtream', urls?, text?}
  favorites: store.get('favorites', []),
  recent: store.get('recent', []),
  counts: {},
  cache: new Map(), // source id -> channels
  memoryTexts: new Map(), // file playlists too large for localStorage
  activeSourceId: null,
  channels: [],
  filtered: [],
  group: '',
  query: '',
  rendered: 0,
  current: null,
};

// ---------- Elements ----------
const el = {
  video: $('#video'),
  player: $('#player'),
  overlay: $('#overlay'),
  spinner: $('#overlay .spinner'),
  overlayTitle: $('#overlay .overlay-title'),
  overlaySub: $('#overlay .overlay-sub'),
  retryBtn: $('#retryBtn'),
  search: $('#search'),
  groupSelect: $('#groupSelect'),
  channelList: $('#channelList'),
  listState: $('#listState'),
  sourceTitle: $('#sourceTitle'),
  channelCount: $('#channelCount'),
  npName: $('#npName'),
  npInfo: $('#npInfo'),
  npLogo: $('#npLogo'),
  favBtn: $('#favBtn'),
  qualitySelect: $('#qualitySelect'),
  proxyBadge: $('#proxyBadge'),
  toast: $('#toast'),
};

// ---------- Helpers ----------
function toast(message, ms = 2600) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function initials(name) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
}

function makeLogo(ch) {
  const box = document.createElement('div');
  box.className = 'logo';
  const fallback = () => {
    box.textContent = initials(ch.name);
  };
  if (ch.logo) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.src = ch.logo;
    img.onerror = fallback;
    box.append(img);
  } else {
    fallback();
  }
  return box;
}

function proxyUrl(url, { raw = false, ua = '', referer = '' } = {}) {
  let s = '/proxy?url=' + encodeURIComponent(url);
  if (raw) s += '&raw=1';
  if (ua) s += '&ua=' + encodeURIComponent(ua);
  if (referer) s += '&ref=' + encodeURIComponent(referer);
  return s;
}

function isMixedContent(url) {
  return location.protocol === 'https:' && url.startsWith('http:');
}

function slimChannel(ch) {
  const { name, url, logo, groups, quality, tags, geo, ua, referer } = ch;
  return { name, url, logo, groups, quality, tags, geo, ua, referer };
}

function allSources() {
  return [...LIBRARY_SOURCES, ...BUILTIN_SOURCES, ...state.custom];
}

function findSource(id) {
  return allSources().find((s) => s.id === id);
}

// ---------- Proxy detection ----------
async function checkProxy() {
  try {
    if (location.protocol === 'file:') throw new Error('file');
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
    const health = res.ok ? await res.json() : {};
    state.serverProxy = health.proxy === true;
    $('#logoutBtn').hidden = !health.auth;
  } catch {
    state.serverProxy = false;
  }
  el.proxyBadge.textContent = state.serverProxy ? 'Proxy: on' : 'Proxy: unavailable';
  el.proxyBadge.className = 'badge ' + (state.serverProxy ? 'ok' : 'off');
  el.proxyBadge.title = state.serverProxy
    ? 'Blocked streams can be routed through the local server'
    : 'Start the app with "npm start" to enable the stream proxy';
}

// ---------- Sources sidebar ----------
function sourceItem(src, removable) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.className = 'source-item';
  btn.dataset.id = src.id;
  btn.title = src.name;

  const emoji = document.createElement('span');
  emoji.className = 'emoji';
  emoji.textContent = src.emoji || '📺';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = src.name;
  const count = document.createElement('span');
  count.className = 'count';
  btn.append(emoji, label, count);

  if (removable) {
    const rm = document.createElement('span');
    rm.className = 'remove';
    rm.title = 'Remove playlist';
    rm.textContent = '×';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      removeCustomSource(src.id);
    });
    btn.append(rm);
  }
  btn.addEventListener('click', () => selectSource(src.id));
  li.append(btn);
  return li;
}

function renderNav() {
  const lists = { library: $('#libraryList'), local: $('#localList'), intl: $('#intlList'), custom: $('#customList') };
  Object.values(lists).forEach((ul) => ul.replaceChildren());
  for (const src of [...LIBRARY_SOURCES, ...BUILTIN_SOURCES]) lists[src.section].append(sourceItem(src, false));
  for (const src of state.custom) lists.custom.append(sourceItem(src, true));
  $('#customEmpty').hidden = state.custom.length > 0;
  updateNavState();
}

function updateNavState() {
  state.counts.favorites = state.favorites.length;
  state.counts.recent = state.recent.length;
  document.querySelectorAll('.source-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.id === state.activeSourceId);
    const n = state.counts[btn.dataset.id];
    btn.querySelector('.count').textContent = n != null ? n.toLocaleString() : '';
  });
}

// ---------- Loading playlists ----------
async function fetchText(url) {
  const tryFetch = async (u) => {
    const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
    if (res.status === 401 && u.startsWith('/proxy')) location.href = '/login?expired';
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };
  if (state.serverProxy && (state.proxyMode === 'always' || isMixedContent(url))) {
    return tryFetch(proxyUrl(url, { raw: true }));
  }
  try {
    return await tryFetch(url);
  } catch (err) {
    if (!state.serverProxy) throw err;
    return tryFetch(proxyUrl(url, { raw: true }));
  }
}

async function loadSourceChannels(src) {
  if (src.id === 'favorites') return state.favorites;
  if (src.id === 'recent') return state.recent;
  if (state.cache.has(src.id)) return state.cache.get(src.id);

  let text;
  if (src.type === 'file') {
    text = src.text ?? state.memoryTexts.get(src.id);
    if (text == null) throw new Error('This file playlist was too large to save. Please add the file again.');
  } else {
    const texts = await Promise.all(src.urls.map(fetchText));
    text = texts.join('\n');
  }
  const channels = parseM3U(text);
  state.cache.set(src.id, channels);
  state.counts[src.id] = channels.length;
  return channels;
}

let loadToken = 0;
async function selectSource(id) {
  const src = findSource(id);
  if (!src) return;
  const token = ++loadToken;
  state.activeSourceId = id;
  store.set('lastSource', id);
  updateNavState();

  el.sourceTitle.textContent = src.name;
  el.channelCount.textContent = '';
  el.channelList.replaceChildren();
  el.listState.textContent = 'Loading channels…';

  try {
    const channels = await loadSourceChannels(src);
    if (token !== loadToken) return;
    state.channels = channels;
    state.group = '';
    buildGroupSelect();
    applyFilter();
    updateNavState();
  } catch (err) {
    if (token !== loadToken) return;
    state.channels = [];
    state.filtered = [];
    el.groupSelect.replaceChildren();
    el.listState.textContent = `Couldn't load this playlist (${err.message}).`;
  }
}

// ---------- Channel list ----------
function buildGroupSelect() {
  const counts = new Map();
  for (const ch of state.channels) for (const g of ch.groups) counts.set(g, (counts.get(g) || 0) + 1);
  const groups = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const options = [new Option(`All categories`, '')];
  for (const g of groups) options.push(new Option(`${g} (${counts.get(g)})`, g));
  el.groupSelect.replaceChildren(...options);
  el.groupSelect.hidden = groups.length < 2;
}

function applyFilter() {
  const q = state.query.trim().toLowerCase();
  state.filtered = state.channels.filter(
    (ch) =>
      (!state.group || ch.groups.includes(state.group)) &&
      (!state.hideGeo || !ch.geo) &&
      (!q || ch.name.toLowerCase().includes(q) || ch.groups.some((g) => g.toLowerCase().includes(q)))
  );
  const total = state.channels.length;
  const shown = state.filtered.length;
  el.channelCount.textContent =
    shown === total ? `${total.toLocaleString()} channels` : `${shown.toLocaleString()} of ${total.toLocaleString()} channels`;
  renderList();
}

function renderList() {
  el.channelList.replaceChildren();
  state.rendered = 0;
  if (!state.filtered.length) {
    const emptyMsg = {
      favorites: 'No favorites yet. Tap the ♥ button while watching to save a channel.',
      recent: 'Channels you watch will appear here.',
    }[state.activeSourceId];
    el.listState.textContent = state.channels.length ? 'No channels match your search.' : emptyMsg || 'This playlist has no playable channels.';
    return;
  }
  el.listState.textContent = '';
  renderMore();
}

function renderMore() {
  const favUrls = new Set(state.favorites.map((f) => f.url));
  const frag = document.createDocumentFragment();
  const end = Math.min(state.rendered + PAGE_SIZE, state.filtered.length);
  for (let i = state.rendered; i < end; i++) frag.append(channelRow(state.filtered[i], i, favUrls));
  state.rendered = end;
  el.channelList.append(frag);
  // Keep a sentinel at the end of the list so scrolling loads the next page.
  if (state.rendered < state.filtered.length) {
    const sentinel = document.createElement('li');
    sentinel.className = 'list-state';
    sentinel.textContent = 'Loading more…';
    el.channelList.append(sentinel);
    sentinelObserver.observe(sentinel);
  }
}

const sentinelObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      sentinelObserver.unobserve(entry.target);
      entry.target.remove();
      renderMore();
    }
  },
  { rootMargin: '400px' }
);

function channelRow(ch, index, favUrls) {
  const li = document.createElement('li');
  li.className = 'channel';
  li.dataset.index = index;
  if (state.current?.url === ch.url) li.classList.add('active');

  const meta = document.createElement('div');
  meta.className = 'ch-meta';
  const name = document.createElement('div');
  name.className = 'ch-name';
  name.textContent = ch.name;
  const sub = document.createElement('div');
  sub.className = 'ch-sub';
  const group = document.createElement('span');
  group.textContent = ch.groups.join(', ');
  sub.append(group);
  if (ch.quality) sub.append(tag(ch.quality, 'q'));
  if (ch.geo) sub.append(tag('Geo-blocked', 'geo'));
  for (const t of ch.tags) if (!/geo/i.test(t)) sub.append(tag(t, ''));
  meta.append(name, sub);

  li.append(makeLogo(ch), meta);
  if (favUrls.has(ch.url)) {
    const dot = document.createElement('span');
    dot.className = 'fav-dot';
    dot.textContent = '♥';
    li.append(dot);
  }
  return li;
}

function tag(text, cls) {
  const s = document.createElement('span');
  s.className = 'tag ' + cls;
  s.textContent = text;
  return s;
}

function highlightCurrent() {
  el.channelList.querySelectorAll('.channel').forEach((li) => {
    li.classList.toggle('active', state.filtered[li.dataset.index]?.url === state.current?.url);
  });
}

// ---------- Player ----------
let hls = null;
let mpeg = null;
let playToken = 0;
let startTimer = null;
let nativeFail = null;

function showOverlay(mode, title = '', sub = '') {
  el.overlay.classList.toggle('hidden', mode === 'hidden');
  el.overlay.classList.toggle('loading', mode === 'loading');
  el.spinner.hidden = mode !== 'loading';
  el.retryBtn.hidden = mode !== 'error';
  el.overlayTitle.textContent = title;
  el.overlaySub.textContent = sub;
}

function destroyPlayers() {
  clearTimeout(startTimer);
  nativeFail = null;
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (mpeg) {
    try {
      mpeg.pause();
      mpeg.unload();
      mpeg.detachMediaElement();
      mpeg.destroy();
    } catch {}
    mpeg = null;
  }
  el.video.removeAttribute('src');
  el.video.load();
  el.qualitySelect.hidden = true;
}

function streamKind(url) {
  let p = '';
  try {
    p = new URL(url).pathname.toLowerCase();
  } catch {}
  if (/\.(m3u8|m3u)$/.test(p)) return 'hls';
  if (/\.ts$/.test(p)) return 'mpegts';
  if (/\.flv$/.test(p)) return 'flv';
  if (/\.(mp4|webm|mov|mkv|mp3|aac|ogg)$/.test(p)) return 'native';
  return 'hls'; // most IPTV streams without an extension are HLS
}

function shouldProxyFirst(ch) {
  if (!state.serverProxy || state.proxyMode === 'off') return false;
  if (state.proxyMode === 'always') return true;
  // Browsers can't set User-Agent/Referer or load http streams on https pages.
  return Boolean(ch.ua || ch.referer) || isMixedContent(ch.url);
}

function play(ch, { viaProxy } = {}) {
  if (!ch) return;
  viaProxy ??= shouldProxyFirst(ch);
  const token = ++playToken;
  destroyPlayers();
  state.current = ch;
  updateNowPlaying();
  highlightCurrent();
  addRecent(ch);
  showOverlay('loading', `Tuning in to ${ch.name}…`);

  const src = viaProxy ? new URL(proxyUrl(ch.url, ch), location.href).href : ch.url;
  const kind = streamKind(ch.url);
  let failed = false;

  const fail = (reason) => {
    if (token !== playToken || failed) return;
    failed = true;
    if (viaProxy && reason === 'HTTP 401') {
      location.href = '/login?expired'; // session cookie expired or password changed
      return;
    }
    if (!viaProxy && state.serverProxy && state.proxyMode === 'auto') {
      toast('Direct playback blocked — retrying through the proxy…');
      play(ch, { viaProxy: true });
      return;
    }
    destroyPlayers();
    const hint = ch.geo
      ? 'This channel is geo-blocked and may only work from its home country.'
      : 'The channel may be offline, geo-blocked or no longer broadcasting.';
    showOverlay('error', "Can't play this channel", `${hint} (${reason})`);
  };

  startTimer = setTimeout(() => fail('timed out'), START_TIMEOUT_MS);
  const tryPlay = () => el.video.play().catch(() => {});

  if (kind === 'hls' && window.Hls?.isSupported()) {
    let recovered = false;
    hls = new Hls({
      enableWorker: true,
      backBufferLength: 30,
      manifestLoadingMaxRetry: 1,
      levelLoadingMaxRetry: 2,
      fragLoadingMaxRetry: 3,
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      buildQualityMenu();
      tryPlay();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, updateNowPlayingInfo);
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
        recovered = true;
        hls.recoverMediaError();
        return;
      }
      fail(data.response?.code ? `HTTP ${data.response.code}` : data.details);
    });
    hls.loadSource(src);
    hls.attachMedia(el.video);
  } else if ((kind === 'mpegts' || kind === 'flv') && window.mpegts?.isSupported()) {
    mpeg = mpegts.createPlayer(
      { type: kind, isLive: true, url: src },
      { enableWorker: true, lazyLoad: false, liveBufferLatencyChasing: true }
    );
    mpeg.on(mpegts.Events.ERROR, (type, detail) => fail(detail || type));
    mpeg.attachMediaElement(el.video);
    mpeg.load();
    tryPlay();
  } else {
    // Native playback (Safari HLS, mp4, etc.)
    nativeFail = () => fail(el.video.error?.message || 'media error');
    el.video.src = src;
    tryPlay();
  }
}

function retryCurrent() {
  if (state.current) play(state.current);
}

el.video.addEventListener('playing', () => {
  clearTimeout(startTimer);
  showOverlay('hidden');
});
el.video.addEventListener('error', () => nativeFail?.());
el.retryBtn.addEventListener('click', retryCurrent);

function buildQualityMenu() {
  if (!hls || hls.levels.length < 2) {
    el.qualitySelect.hidden = true;
    return;
  }
  const opts = [new Option('Auto', '-1')];
  hls.levels
    .map((lvl, i) => ({ i, h: lvl.height, b: lvl.bitrate }))
    .sort((a, b) => b.h - a.h || b.b - a.b)
    .forEach(({ i, h, b }) => opts.push(new Option(h ? `${h}p` : `${Math.round(b / 1000)} kbps`, String(i))));
  el.qualitySelect.replaceChildren(...opts);
  el.qualitySelect.value = '-1';
  el.qualitySelect.hidden = false;
}

el.qualitySelect.addEventListener('change', () => {
  if (hls) hls.currentLevel = Number(el.qualitySelect.value);
});

function updateNowPlaying() {
  const ch = state.current;
  el.npName.textContent = ch ? ch.name : 'Nothing playing';
  if (ch?.logo) {
    el.npLogo.src = ch.logo;
    el.npLogo.hidden = false;
    el.npLogo.onerror = () => (el.npLogo.hidden = true);
  } else {
    el.npLogo.hidden = true;
  }
  el.favBtn.disabled = !ch;
  const isFav = ch && state.favorites.some((f) => f.url === ch.url);
  el.favBtn.classList.toggle('active', Boolean(isFav));
  el.favBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
  updateNowPlayingInfo();
  document.title = ch ? `${ch.name} · Tanaw TV` : 'Tanaw TV';
}

function updateNowPlayingInfo() {
  const ch = state.current;
  if (!ch) {
    el.npInfo.textContent = '';
    return;
  }
  const parts = [ch.groups.join(', ')];
  const lvl = hls && hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : null;
  if (lvl?.height) parts.push(`${lvl.height}p`);
  else if (ch.quality) parts.push(ch.quality);
  parts.push(...ch.tags);
  el.npInfo.textContent = parts.filter(Boolean).join(' · ');
}

// ---------- Favorites & recent ----------
function toggleFavorite() {
  const ch = state.current;
  if (!ch) return;
  const i = state.favorites.findIndex((f) => f.url === ch.url);
  if (i >= 0) {
    state.favorites.splice(i, 1);
    toast(`Removed ${ch.name} from favorites`);
  } else {
    state.favorites.unshift(slimChannel(ch));
    toast(`Added ${ch.name} to favorites ♥`);
  }
  store.set('favorites', state.favorites);
  updateNowPlaying();
  updateNavState();
  if (state.activeSourceId === 'favorites') applyFilter();
  else renderListPreservingScroll();
}

function ensureRendered(count) {
  while (state.rendered < Math.min(count, state.filtered.length)) {
    el.channelList.querySelector('.list-state')?.remove();
    renderMore();
  }
}

function renderListPreservingScroll() {
  const scroller = $('.channels');
  const top = scroller.scrollTop;
  const rendered = state.rendered;
  renderList();
  ensureRendered(rendered);
  scroller.scrollTop = top;
}

function addRecent(ch) {
  state.recent = [slimChannel(ch), ...state.recent.filter((r) => r.url !== ch.url)].slice(0, RECENT_LIMIT);
  store.set('recent', state.recent);
  updateNavState();
}

// ---------- Custom playlists ----------
function setupAddDialog() {
  const dialog = $('#addDialog');
  const form = $('#addForm');
  const errorEl = $('#addError');
  const submit = $('#addSubmit');
  let tab = 'url';

  form.querySelectorAll('.tab').forEach((btn) =>
    btn.addEventListener('click', () => {
      tab = btn.dataset.tab;
      form.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      form.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
      errorEl.hidden = true;
    })
  );

  $('#addBtn').addEventListener('click', () => {
    form.reset();
    errorEl.hidden = true;
    dialog.showModal();
  });
  $('#addCancel').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const data = new FormData(form);
    const id = 'custom-' + Date.now().toString(36);
    let src;
    let text;

    try {
      submit.disabled = true;
      submit.textContent = 'Loading…';
      if (tab === 'url') {
        const url = String(data.get('url') || '').trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('Enter a valid http(s) playlist URL.');
        text = await fetchText(url);
        src = { id, type: 'url', urls: [url], name: data.get('name') || new URL(url).hostname };
      } else if (tab === 'file') {
        const file = data.get('file');
        if (!file || !file.size) throw new Error('Choose an .m3u file.');
        text = await file.text();
        src = { id, type: 'file', name: data.get('name') || file.name.replace(/\.m3u8?$/i, '') };
      } else {
        const server = String(data.get('xserver') || '').trim().replace(/\/+$/, '');
        const user = String(data.get('xuser') || '').trim();
        const pass = String(data.get('xpass') || '');
        if (!/^https?:\/\//i.test(server) || !user || !pass) throw new Error('Fill in server URL, username and password.');
        const url = `${server}/get.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&type=m3u_plus&output=m3u8`;
        text = await fetchText(url);
        src = { id, type: 'xtream', urls: [url], name: data.get('name') || new URL(server).hostname };
      }

      const channels = parseM3U(text);
      if (!channels.length) throw new Error('No playable channels found in this playlist.');
      src.emoji = tab === 'xtream' ? '🔑' : tab === 'file' ? '📁' : '🔗';

      state.cache.set(id, channels);
      state.counts[id] = channels.length;
      state.custom.push(tab === 'file' ? { ...src, text } : src);
      if (!saveCustom()) {
        // Too big for localStorage: keep the file contents in memory for this session only.
        state.custom[state.custom.length - 1] = src;
        state.memoryTexts.set(id, text);
        saveCustom();
        toast('Playlist is large, so it will only be kept until you close this tab.', 4500);
      }
      renderNav();
      dialog.close();
      selectSource(id);
      toast(`Added ${src.name} · ${channels.length.toLocaleString()} channels`);
    } catch (err) {
      errorEl.textContent =
        err.name === 'TimeoutError' ? 'The playlist took too long to download.' : err.message || 'Could not load the playlist.';
      if (/Failed to fetch|NetworkError|HTTP/.test(err.message) && !state.serverProxy) {
        errorEl.textContent += ' The server may be blocking browsers — start the app with "npm start" to use the proxy.';
      }
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Add playlist';
    }
  });
}

function saveCustom() {
  return store.set('customSources', state.custom);
}

function removeCustomSource(id) {
  const src = findSource(id);
  if (!src || !confirm(`Remove "${src.name}"?`)) return;
  state.custom = state.custom.filter((s) => s.id !== id);
  state.cache.delete(id);
  state.memoryTexts.delete(id);
  saveCustom();
  renderNav();
  if (state.activeSourceId === id) selectSource('ph');
}

// ---------- Settings ----------
function setupSettings() {
  const dialog = $('#settingsDialog');
  $('#settingsBtn').addEventListener('click', () => {
    dialog.querySelectorAll('input[name=proxyMode]').forEach((r) => (r.checked = r.value === state.proxyMode));
    $('#hideGeo').checked = state.hideGeo;
    dialog.showModal();
  });
  dialog.querySelectorAll('input[name=proxyMode]').forEach((r) =>
    r.addEventListener('change', () => {
      state.proxyMode = r.value;
      store.set('proxyMode', r.value);
    })
  );
  $('#hideGeo').addEventListener('change', (e) => {
    state.hideGeo = e.target.checked;
    store.set('hideGeo', state.hideGeo);
    applyFilter();
  });
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Clear favorites, watch history and your playlists?')) return;
    state.favorites = [];
    state.recent = [];
    for (const s of state.custom) state.cache.delete(s.id);
    state.custom = [];
    state.memoryTexts.clear();
    store.set('favorites', []);
    store.set('recent', []);
    store.set('customSources', []);
    renderNav();
    updateNowPlaying();
    selectSource('ph');
    dialog.close();
    toast('Your data has been cleared');
  });
}

// ---------- Player controls & keyboard ----------
function step(delta) {
  if (!state.filtered.length) return;
  const i = state.filtered.findIndex((c) => c.url === state.current?.url);
  const next = i < 0 ? 0 : (i + delta + state.filtered.length) % state.filtered.length;
  ensureRendered(next + 1);
  play(state.filtered[next]);
  el.channelList.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else (el.player.requestFullscreen?.() ?? el.video.webkitEnterFullscreen?.());
}

function setupControls() {
  el.channelList.addEventListener('click', (e) => {
    const li = e.target.closest('.channel');
    if (li) play(state.filtered[li.dataset.index]);
  });
  el.groupSelect.addEventListener('change', () => {
    state.group = el.groupSelect.value;
    applyFilter();
  });
  let searchTimer;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = el.search.value;
      applyFilter();
    }, 120);
  });

  el.favBtn.addEventListener('click', toggleFavorite);
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));
  $('#fsBtn').addEventListener('click', toggleFullscreen);
  $('#pipBtn').addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.video.requestPictureInPicture();
    } catch {
      toast('Picture-in-picture is not available right now');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === 'Escape' && e.target === el.search) {
      el.search.blur();
      return;
    }
    if (typing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'm':
      case 'M':
        el.video.muted = !el.video.muted;
        toast(el.video.muted ? 'Muted' : 'Sound on', 1200);
        break;
      case '/':
        e.preventDefault();
        el.search.focus();
        break;
    }
  });
}

// ---------- Boot ----------
async function init() {
  renderNav();
  setupControls();
  setupAddDialog();
  setupSettings();
  await checkProxy();
  const last = store.get('lastSource', 'ph');
  selectSource(findSource(last) ? last : 'ph');
}

init();
