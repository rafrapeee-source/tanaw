// Built-in playlists from the community-maintained iptv-org project
// (https://github.com/iptv-org/iptv), which lists publicly available streams.
// A source may list several URLs; their channels are merged.

const BASE = 'https://iptv-org.github.io/iptv';

export const BUILTIN_SOURCES = [
  { id: 'ph', section: 'local', emoji: '🇵🇭', name: 'Philippine channels', urls: [`${BASE}/countries/ph.m3u`] },
  {
    id: 'tagalog',
    section: 'local',
    emoji: '🗣️',
    name: 'Tagalog / Filipino',
    urls: [`${BASE}/languages/tgl.m3u`, `${BASE}/languages/fil.m3u`],
  },
  { id: 'sea', section: 'local', emoji: '🌏', name: 'Southeast Asia', urls: [`${BASE}/regions/sea.m3u`] },

  { id: 'news', section: 'intl', emoji: '📰', name: 'News', urls: [`${BASE}/categories/news.m3u`] },
  { id: 'sports', section: 'intl', emoji: '⚽', name: 'Sports', urls: [`${BASE}/categories/sports.m3u`] },
  { id: 'movies', section: 'intl', emoji: '🎬', name: 'Movies', urls: [`${BASE}/categories/movies.m3u`] },
  { id: 'entertainment', section: 'intl', emoji: '🎭', name: 'Entertainment', urls: [`${BASE}/categories/entertainment.m3u`] },
  { id: 'music', section: 'intl', emoji: '🎵', name: 'Music', urls: [`${BASE}/categories/music.m3u`] },
  { id: 'kids', section: 'intl', emoji: '🧸', name: 'Kids', urls: [`${BASE}/categories/kids.m3u`] },
  { id: 'documentary', section: 'intl', emoji: '🦁', name: 'Documentary', urls: [`${BASE}/categories/documentary.m3u`] },
  { id: 'english', section: 'intl', emoji: '🇬🇧', name: 'English-language', urls: [`${BASE}/languages/eng.m3u`] },
  { id: 'asia', section: 'intl', emoji: '🗺️', name: 'All of Asia', urls: [`${BASE}/regions/asia.m3u`] },
  { id: 'all', section: 'intl', emoji: '🌐', name: 'Every channel', urls: [`${BASE}/index.m3u`] },
];

export const LIBRARY_SOURCES = [
  { id: 'favorites', section: 'library', emoji: '❤️', name: 'Favorites' },
  { id: 'recent', section: 'library', emoji: '🕘', name: 'Recently watched' },
];
