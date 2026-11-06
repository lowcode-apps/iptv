#!/usr/bin/env node
// Builds the web player's channel index from this fork's streams/*.m3u files,
// enriched with metadata from the iptv-org API.
//
// Output (web/public/data/):
//   meta.json          countries + categories + counts, loaded at boot
//   channels/<cc>.json per-country channels, loaded on demand
//   search.json        compact global search index, loaded on first search
//
// Node builtins only, so the root package.json stays untouched and upstream
// merges stay clean.

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = resolve(HERE, '..')
const REPO_DIR = resolve(WEB_DIR, '..')
const STREAMS_DIR = process.env.STREAMS_DIR || join(REPO_DIR, 'streams')
const OUT_DIR = join(WEB_DIR, 'public', 'data')
const CACHE_DIR = join(WEB_DIR, '.cache')
const API = 'https://iptv-org.github.io/api'

const log = (...a) => console.log('[build-index]', ...a)

// --- api fetching, cached on disk so local rebuilds don't refetch ~15MB -----

async function api(name) {
  const cached = join(CACHE_DIR, `${name}.json`)
  const maxAge = Number(process.env.CACHE_MAX_AGE_MS ?? 6 * 60 * 60 * 1000)
  if (existsSync(cached) && maxAge > 0) {
    const { mtimeMs } = await import('node:fs').then(m => m.promises.stat(cached))
    if (Date.now() - mtimeMs < maxAge) {
      log(`${name}.json (cached)`)
      return JSON.parse(await readFile(cached, 'utf8'))
    }
  }
  log(`fetching ${name}.json`)
  const res = await fetch(`${API}/${name}.json`)
  if (!res.ok) throw new Error(`${API}/${name}.json -> HTTP ${res.status}`)
  const text = await res.text()
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(cached, text)
  return JSON.parse(text)
}

// --- m3u parsing -----------------------------------------------------------

// Splits `tvg-id="X" tvg-logo="Y",Title` into attrs and title, respecting quotes.
function splitExtinf(line) {
  const body = line.slice(line.indexOf(':') + 1)
  let inQuotes = false
  let comma = -1
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ',' && !inQuotes) { comma = i; break }
  }
  if (comma === -1) return { attrs: {}, title: body.trim() }
  const attrs = {}
  const attrText = body.slice(0, comma)
  for (const m of attrText.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2]
  return { attrs, title: body.slice(comma + 1).trim() }
}

// Titles look like `Al Arabiya (1080p) [Not 24/7]`.
function parseTitle(title) {
  let name = title
  let quality = null
  let notRoundTheClock = false
  name = name.replace(/\[([^\]]*)\]/g, (_, flag) => {
    if (/not 24\/7/i.test(flag)) notRoundTheClock = true
    return ''
  })
  name = name.replace(/\((\d{3,4}p)\)/i, (_, q) => { quality = q.toLowerCase(); return '' })
  return { name: name.replace(/\s+/g, ' ').trim(), quality, notRoundTheClock }
}

function parsePlaylist(text) {
  const out = []
  let pending = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      const { attrs, title } = splitExtinf(line)
      pending = { attrs, ...parseTitle(title), userAgent: null, referrer: null }
    } else if (line.startsWith('#EXTVLCOPT:')) {
      if (!pending) continue
      const opt = line.slice('#EXTVLCOPT:'.length)
      const eq = opt.indexOf('=')
      if (eq === -1) continue
      const key = opt.slice(0, eq).trim().toLowerCase()
      const value = opt.slice(eq + 1).trim()
      if (key === 'http-user-agent') pending.userAgent = value
      else if (key === 'http-referrer') pending.referrer = value
    } else if (!line.startsWith('#')) {
      if (!pending) continue
      pending.url = line
      out.push(pending)
      pending = null
    }
  }
  return out
}

function streamKind(url) {
  const path = url.split('?')[0].split('#')[0].toLowerCase()
  if (path.endsWith('.mpd')) return 'dash'
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls'
  if (path.endsWith('.mp4') || path.endsWith('.webm') || path.endsWith('.ogg')) return 'file'
  return 'hls' // extensionless endpoints in this dataset are overwhelmingly HLS
}

// --- logo selection --------------------------------------------------------

const FORMAT_SCORE = { SVG: 5, PNG: 4, WEBP: 3, JPEG: 2, JPG: 2, GIF: 1 }

// Build channel -> best logo, preferring the exact feed, then in-use, then a
// crisp format at a sane size.
function buildLogoMap(logos) {
  const best = new Map()
  for (const logo of logos) {
    if (!logo.url || !logo.channel) continue
    const score =
      (logo.in_use ? 100 : 0) +
      (FORMAT_SCORE[String(logo.format || '').toUpperCase()] || 0) * 5 +
      (logo.width >= 200 && logo.width <= 1000 ? 10 : 0)
    for (const key of [`${logo.channel}@${logo.feed || ''}`, logo.channel]) {
      const prev = best.get(key)
      if (!prev || score > prev.score) best.set(key, { score, url: logo.url })
    }
  }
  return best
}

function pickLogo(logoMap, channelId, feed) {
  return (
    logoMap.get(`${channelId}@${feed || ''}`)?.url ||
    logoMap.get(`${channelId}@`)?.url ||
    logoMap.get(channelId)?.url ||
    null
  )
}

// --- main ------------------------------------------------------------------

async function main() {
  const [channelsApi, logosApi, countriesApi, categoriesApi] = await Promise.all([
    api('channels'),
    api('logos'),
    api('countries'),
    api('categories')
  ])

  const channelById = new Map(channelsApi.map(c => [c.id, c]))
  const logoMap = buildLogoMap(logosApi)
  const countryByCode = new Map(countriesApi.map(c => [c.code, c]))
  const categoryById = new Map(categoriesApi.map(c => [c.id, c]))

  const files = (await readdir(STREAMS_DIR)).filter(f => f.endsWith('.m3u')).sort()
  log(`parsing ${files.length} playlists from ${STREAMS_DIR}`)

  // countryCode -> Map<channelKey, channel>
  const byCountry = new Map()
  const stats = { entries: 0, streams: 0, hls: 0, dash: 0, other: 0, insecure: 0, noMeta: 0 }

  for (const file of files) {
    // `in.m3u` -> IN, `at_pluto.m3u` -> AT (provider-specific playlists)
    const code = file.replace(/\.m3u$/, '').split('_')[0].toUpperCase()
    const entries = parsePlaylist(await readFile(join(STREAMS_DIR, file), 'utf8'))
    stats.entries += entries.length

    for (const entry of entries) {
      if (!entry.url) continue
      const tvgId = entry.attrs['tvg-id'] || ''
      const [channelId, feed] = tvgId ? tvgId.split('@') : ['', '']
      const meta = channelId ? channelById.get(channelId) : null
      if (!meta) stats.noMeta++

      // Group by tvg-id where known, else by display name within the playlist.
      const key = tvgId || `name:${entry.name.toLowerCase()}`
      const countryCode = meta?.country || code
      if (!byCountry.has(countryCode)) byCountry.set(countryCode, new Map())
      const bucket = byCountry.get(countryCode)

      if (!bucket.has(key)) {
        bucket.set(key, {
          id: key,
          name: meta?.name || entry.name,
          logo: channelId ? pickLogo(logoMap, channelId, feed) : null,
          country: countryCode,
          categories: meta?.categories?.length ? meta.categories : [],
          nsfw: meta?.is_nsfw === true,
          website: meta?.website || null,
          feed: feed || null,
          streams: []
        })
      }

      const channel = bucket.get(key)
      const kind = streamKind(entry.url)
      stats[kind === 'hls' ? 'hls' : kind === 'dash' ? 'dash' : 'other']++
      if (entry.url.startsWith('http://')) stats.insecure++
      stats.streams++

      channel.streams.push({
        url: entry.url,
        kind,
        quality: entry.quality,
        ...(entry.userAgent ? { userAgent: entry.userAgent } : {}),
        ...(entry.referrer ? { referrer: entry.referrer } : {}),
        ...(entry.notRoundTheClock ? { partTime: true } : {})
      })
    }
  }

  // Highest quality first, so the default pick is the best stream.
  const qualityRank = s => (s.quality ? parseInt(s.quality, 10) : 0)
  for (const bucket of byCountry.values()) {
    for (const channel of bucket.values()) {
      channel.streams.sort((a, b) => qualityRank(b) - qualityRank(a))
    }
  }

  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(join(OUT_DIR, 'channels'), { recursive: true })

  const countries = []
  const categoryCounts = new Map()
  const search = []

  for (const [code, bucket] of [...byCountry.entries()].sort()) {
    const channels = [...bucket.values()].sort((a, b) => a.name.localeCompare(b.name))
    const info = countryByCode.get(code)
    countries.push({
      code,
      name: info?.name || code,
      flag: info?.flag || '🏳️',
      count: channels.length
    })
    await writeFile(
      join(OUT_DIR, 'channels', `${code.toLowerCase()}.json`),
      JSON.stringify({ country: code, channels })
    )
    for (const channel of channels) {
      for (const category of channel.categories) {
        categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1)
      }
      // [id, name, countryCode, nsfw] — kept positional to keep this file small
      search.push([channel.id, channel.name, code, channel.nsfw ? 1 : 0])
    }
  }

  const categories = [...categoryCounts.entries()]
    .map(([id, count]) => ({ id, name: categoryById.get(id)?.name || id, count }))
    .sort((a, b) => b.count - a.count)

  const totalChannels = countries.reduce((n, c) => n + c.count, 0)
  await writeFile(
    join(OUT_DIR, 'meta.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalChannels,
      totalStreams: stats.streams,
      countries: countries.sort((a, b) => a.name.localeCompare(b.name)),
      categories
    })
  )
  await writeFile(join(OUT_DIR, 'search.json'), JSON.stringify(search))

  log(`entries=${stats.entries} streams=${stats.streams} channels=${totalChannels}`)
  log(`hls=${stats.hls} dash=${stats.dash} other=${stats.other}`)
  log(`http-only=${stats.insecure} (proxy required) no-api-metadata=${stats.noMeta}`)
  log(`countries=${countries.length} categories=${categories.length}`)
  log(`-> ${OUT_DIR}`)
}

main().catch(err => {
  console.error('[build-index] failed:', err)
  process.exit(1)
})
