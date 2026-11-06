/**
 * Cloudflare Pages Function: stream proxy, served at /proxy
 *
 * A browser cannot reach every stream in this repo on its own. Measured against
 * a 120-source sample of the generated index, the blockers are:
 *   1. Mixed content - 27% of sources are plain http://, which an https:// page
 *               refuses to load at all. We fetch them server-side instead.
 *   2. Headers - 8% carry #EXTVLCOPT http-user-agent / http-referrer, and both
 *               are forbidden headers that browser fetch refuses to set.
 *   3. CORS    - rarer than expected: every reachable https source in that
 *               sample already sent Access-Control-Allow-Origin. It still
 *               happens, so the player falls back here when a direct play
 *               fails, but it is not the common case.
 *
 * HLS manifests are rewritten so nested variants, segments, encryption keys and
 * init segments all come back through this proxy too; otherwise the browser
 * would fetch them directly and hit CORS again on the second hop.
 *
 * Query params (all base64url):
 *   u   target URL (required)
 *   ua  User-Agent to send upstream
 *   r   Referer to send upstream
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const MANIFEST_TYPES = /mpegurl|m3u8|vnd\.apple/i
const BINARY_PATH = /\.(ts|m4s|mp4|aac|m4a|vtt|webvtt|key|jpg|jpeg|png|webm|cmfv|cmfa)$/i
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

// --- base64url -------------------------------------------------------------

function b64urlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function b64urlEncode(value) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// --- SSRF guard ------------------------------------------------------------

// Blocks the obvious private/loopback/link-local targets so this proxy cannot
// be pointed at internal infrastructure. Note: a hostname that *resolves* to a
// private address still gets through, since Workers cannot resolve DNS before
// fetching. Acceptable for a personal player; do not treat this as a hardened
// open proxy.
function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = v4.slice(1).map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // multicast + reserved
    return false
  }

  if (host === '::' || host === '::1') return true
  if (/^::ffff:/.test(host)) return true // IPv4-mapped
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true // unique local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true // link-local fe80::/10

  return false
}

// --- helpers ---------------------------------------------------------------

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Timing-Allow-Origin': '*',
    ...extra
  }
}

function fail(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  })
}

// Rebuilds a /proxy URL for a resource discovered inside a manifest.
function proxied(origin, target, userAgent, referer) {
  const params = new URLSearchParams({ u: b64urlEncode(target) })
  if (userAgent) params.set('ua', b64urlEncode(userAgent))
  if (referer) params.set('r', b64urlEncode(referer))
  return `${origin}/proxy?${params.toString()}`
}

function looksLikeManifest(url, contentType) {
  if (MANIFEST_TYPES.test(contentType)) return true
  const path = url.split('?')[0].split('#')[0].toLowerCase()
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return true
  // Some origins serve manifests as text/plain from extensionless endpoints.
  return /^text\/(plain|html)/i.test(contentType) && !BINARY_PATH.test(path)
}

/**
 * Rewrites every resource reference in an HLS manifest to route back through
 * this proxy, resolving relative references against the manifest's own
 * (post-redirect) URL.
 */
function rewriteManifest(body, baseUrl, origin, userAgent, referer) {
  const toProxy = ref => {
    const trimmed = ref.trim()
    if (!trimmed || trimmed.startsWith('data:')) return ref
    let absolute
    try {
      absolute = new URL(trimmed, baseUrl).toString()
    } catch {
      return ref
    }
    if (!/^https?:$/.test(new URL(absolute).protocol)) return ref
    return proxied(origin, absolute, userAgent, referer)
  }

  return body
    .split('\n')
    .map(line => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#')) {
        // URI="..." appears on EXT-X-KEY, MAP, MEDIA, I-FRAME-STREAM-INF,
        // PART, PRELOAD-HINT, RENDITION-REPORT, SESSION-KEY.
        if (!trimmed.startsWith('#EXT')) return line
        return line.replace(/URI="([^"]*)"/g, (match, ref) =>
          ref ? `URI="${toProxy(ref)}"` : match
        )
      }
      // A bare line is a variant playlist or media segment reference.
      return toProxy(trimmed)
    })
    .join('\n')
}

// --- handler ---------------------------------------------------------------

export async function onRequest(context) {
  const { request } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders({ 'Max-Age': '86400' }) })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail(405, 'Only GET, HEAD and OPTIONS are supported')
  }

  const requestUrl = new URL(request.url)
  const encodedTarget = requestUrl.searchParams.get('u')
  if (!encodedTarget) return fail(400, 'Missing required parameter: u')

  let target
  try {
    target = new URL(b64urlDecode(encodedTarget))
  } catch {
    return fail(400, 'Parameter u is not a valid base64url-encoded URL')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return fail(400, `Unsupported protocol: ${target.protocol}`)
  }
  if (isBlockedHost(target.hostname)) {
    return fail(403, 'Target host is not allowed')
  }

  let userAgent = null
  let referer = null
  try {
    const ua = requestUrl.searchParams.get('ua')
    const ref = requestUrl.searchParams.get('r')
    if (ua) userAgent = b64urlDecode(ua)
    if (ref) referer = b64urlDecode(ref)
  } catch {
    return fail(400, 'Parameters ua and r must be base64url-encoded')
  }

  const upstreamHeaders = new Headers({
    'User-Agent': userAgent || DEFAULT_UA,
    Accept: '*/*'
  })
  if (referer) {
    upstreamHeaders.set('Referer', referer)
    try {
      upstreamHeaders.set('Origin', new URL(referer).origin)
    } catch {
      /* referrer values in the wild are not always valid URLs */
    }
  }
  const range = request.headers.get('Range')
  if (range) upstreamHeaders.set('Range', range)

  let upstream
  try {
    upstream = await fetch(target.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    })
  } catch (err) {
    return fail(502, `Upstream request failed: ${err?.message || 'unknown error'}`)
  }

  const contentType = upstream.headers.get('Content-Type') || ''
  // Redirects matter: relative references resolve against the *final* URL.
  const effectiveUrl = upstream.url || target.toString()

  const passthrough = corsHeaders({
    'Content-Type': contentType || 'application/octet-stream'
  })
  // Content-Encoding is deliberately NOT forwarded: the Workers runtime has
  // already decompressed the body, so advertising the original encoding would
  // make the browser try to decode plain bytes a second time.
  for (const header of ['Content-Range', 'Accept-Ranges']) {
    const value = upstream.headers.get(header)
    if (value) passthrough[header] = value
  }

  if (!upstream.ok) {
    passthrough['Cache-Control'] = 'no-store'
    return new Response(upstream.body, { status: upstream.status, headers: passthrough })
  }

  if (request.method !== 'HEAD' && looksLikeManifest(effectiveUrl, contentType)) {
    const length = Number(upstream.headers.get('Content-Length') || 0)
    if (length > MAX_MANIFEST_BYTES) return fail(502, 'Manifest is implausibly large')

    const body = await upstream.text()
    if (!body.trimStart().startsWith('#EXTM3U')) {
      // Not actually a manifest - hand it back untouched.
      return new Response(body, {
        status: upstream.status,
        headers: { ...passthrough, 'Cache-Control': 'no-store' }
      })
    }

    const rewritten = rewriteManifest(
      body,
      effectiveUrl,
      requestUrl.origin,
      userAgent,
      referer
    )
    return new Response(rewritten, {
      status: 200,
      headers: corsHeaders({
        'Content-Type': 'application/vnd.apple.mpegurl',
        // Live manifests change constantly; never serve a stale one.
        'Cache-Control': 'no-store'
      })
    })
  }

  // Segments and everything else stream straight through.
  //
  // Byte-range streams (fMP4/CMAF) address every segment by the SAME URL and
  // differ only by the Range header, so a cacheable response would be replayed
  // for the wrong range and the player would stall on empty fragments. Keep
  // ranged responses uncacheable and make Range part of the cache key.
  passthrough.Vary = 'Range'
  passthrough['Cache-Control'] =
    !range && BINARY_PATH.test(effectiveUrl.split('?')[0])
      ? 'public, max-age=15'
      : 'no-store'

  return new Response(upstream.body, { status: upstream.status, headers: passthrough })
}
