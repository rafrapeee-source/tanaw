// Minimal, forgiving M3U / M3U Plus parser for IPTV playlists.
//
//   #EXTM3U
//   #EXTINF:-1 tvg-id="x" tvg-logo="http://…" group-title="News",Channel Name (1080p) [Geo-blocked]
//   #EXTVLCOPT:http-user-agent=Mozilla/5.0 …
//   #EXTVLCOPT:http-referrer=https://…
//   http://stream.example/live.m3u8

const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const QUALITY_RE = /\s*\((\d{3,4}p|4K|UHD|FHD|HD|SD)\)/i;
const TAG_RE = /\s*\[([^\]]+)\]/g;

function splitExtinf(line) {
  // The title starts after the first comma that is not inside quotes.
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, ''];
}

function parseExtinf(line) {
  const [head, title] = splitExtinf(line);
  const attrs = {};
  for (const [, key, value] of head.matchAll(ATTR_RE)) attrs[key.toLowerCase()] = value.trim();
  return { attrs, title: title.trim() };
}

function cleanTitle(title) {
  let name = title;
  let quality = '';
  const q = name.match(QUALITY_RE);
  if (q) {
    quality = q[1];
    name = name.replace(QUALITY_RE, '');
  }
  const tags = [];
  name = name.replace(TAG_RE, (_, tag) => {
    tags.push(tag.trim());
    return '';
  });
  return { name: name.trim(), quality, tags };
}

export function parseM3U(text) {
  const channels = [];
  const seen = new Set();
  let info = null;
  let opts = {};
  let extgrp = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      info = parseExtinf(line);
      opts = {};
      extgrp = '';
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      const body = line.slice('#EXTVLCOPT:'.length);
      const eq = body.indexOf('=');
      if (eq > 0) {
        const key = body.slice(0, eq).trim().toLowerCase();
        const value = body.slice(eq + 1).trim();
        if (key === 'http-user-agent') opts.ua = value;
        if (key === 'http-referrer' || key === 'http-referer') opts.referer = value;
      }
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      extgrp = line.slice('#EXTGRP:'.length).trim();
      continue;
    }
    if (line.startsWith('#')) continue;

    // Anything else is a stream URL. Browsers can only play http(s) streams.
    const url = line;
    if (!/^https?:\/\//i.test(url) || seen.has(url)) {
      info = null;
      continue;
    }
    seen.add(url);

    const attrs = info?.attrs || {};
    const title = info?.title || attrs['tvg-name'] || url.split('/').pop();
    const { name, quality, tags } = cleanTitle(title);
    const groups = (attrs['group-title'] || extgrp || 'Uncategorized')
      .split(';')
      .map((g) => g.trim())
      .filter(Boolean);
    const ua = opts.ua || attrs['http-user-agent'] || attrs['user-agent'] || '';
    const referer = opts.referer || attrs['http-referrer'] || attrs['http-referer'] || '';

    channels.push({
      name: name || 'Unnamed channel',
      url,
      logo: attrs['tvg-logo'] || '',
      groups: groups.length ? groups : ['Uncategorized'],
      quality,
      tags,
      geo: tags.some((t) => /geo/i.test(t)),
      ...(ua && { ua }),
      ...(referer && { referer }),
    });
    info = null;
    opts = {};
  }
  return channels;
}
