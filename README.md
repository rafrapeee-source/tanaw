# Tanaw TV

A web IPTV player for Filipino and international TV channels. It plays M3U / M3U8
playlists, single HLS streams and Xtream Codes accounts right in the browser.

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer. There are no packages to install.

```bash
npm start
```

Then open http://localhost:1111.

| Variable          | Default     | Purpose                                                            |
|-------------------|-------------|--------------------------------------------------------------------|
| `PORT`            | `1111`      | Port to listen on                                                  |
| `HOST`            | `127.0.0.1` | Set to `0.0.0.0` to watch from phones/TVs on the same Wi‑Fi        |
| `ACCESS_PASSWORD` | *(none)*    | Requires this password to use the app and proxy. **Set it whenever the app is reachable by others.** |

If your network uses a proxy (`HTTP_PROXY` / `HTTPS_PROXY`), the server picks it up automatically.

## Deploy to Render (free tier)

The repo includes a [`render.yaml`](render.yaml) Blueprint set to the **Singapore** region (closest to the Philippines).

1. Push this folder to a GitHub (or GitLab) repository.
2. In the Render dashboard choose **New → Blueprint** and select the repository.
3. When asked for `ACCESS_PASSWORD`, enter a long password. That's what you'll type to sign in.
4. Click **Apply**. When the deploy finishes, open the `https://tanaw-tv-xxxx.onrender.com` URL.

Things to know about the free tier:

- The service sleeps after 15 minutes without visitors; the first visit afterwards takes about 30–60 s to wake it.
- Every stream that goes through the proxy counts against Render's monthly outbound bandwidth
  (roughly 1–1.5 GB per hour of 720p). In *Auto* mode most streams play directly from the viewer's
  own connection and don't use the server's bandwidth.
- The server's region doesn't unblock geo-blocked channels for its own country unless the stream goes
  through the proxy. Viewers in the Philippines already get Philippine-only channels directly.
- Some stream providers block cloud/datacenter IPs, so a few channels may fail only when proxied.
- To change the password, edit `ACCESS_PASSWORD` under the service's **Environment** tab. Everyone is signed out.

## Features

- **Built-in channel lists** from the community-run [iptv-org](https://github.com/iptv-org/iptv) project:
  Philippine channels, Tagalog/Filipino-language channels, Southeast Asia, and international
  News, Sports, Movies, Entertainment, Music, Kids, Documentary, English-language, all of Asia,
  and every channel (~11,000).
- **Your own playlists**: add an M3U link, upload an `.m3u` file, or sign in with Xtream Codes
  (server URL + username + password). These are saved in your browser.
- **Plays HLS (`.m3u8`), MPEG-TS (`.ts`), FLV and MP4** via hls.js and mpegts.js, with a quality picker.
- **Stream proxy**: many IPTV streams block browsers (CORS), use plain `http://`, or need a special
  User-Agent/Referer (`#EXTVLCOPT` lines). The built-in proxy handles all of these. In *Auto* mode
  the app tries a direct connection first and retries through the proxy if it fails.
- Search, category filter, favorites, recently watched, picture-in-picture, fullscreen, and a layout that works on phones.
- Keyboard: `↑`/`↓` change channel, `F` fullscreen, `M` mute, `/` search.

## Notes

- Public free streams come and go. Some channels will be offline, and channels tagged
  **Geo-blocked** usually only play from their home country. You can hide them in Settings.
- Major Philippine networks (e.g. GMA, Kapamilya/ABS-CBN, TV5) generally don't offer free public
  streams. To watch them you need a legitimate subscription/IPTV provider, whose M3U or Xtream
  login you can add under **+ Add playlist**.
- Only watch streams you have the right to access.

## Project layout

```
server.js          Static file server + /proxy endpoint (rewrites HLS playlists)
public/index.html  App shell
public/app.js      UI, playlist loading, player logic
public/m3u.js      M3U / M3U Plus parser
public/sources.js  Built-in playlist list (edit to add your own defaults)
public/styles.css  Styles
```
