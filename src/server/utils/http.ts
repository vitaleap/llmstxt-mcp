import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildProxyAgent } from './index.js'

const CACHE_DIR = join(homedir(), '.llmstxt-mcp', 'cache')
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000 // 3 days

/**
 * Deterministic, filesystem-safe identifier for a URL. SHA-256 hex avoids
 * ambiguity that would come from lossy encodings (percent-encoding of `/`
 * would collide for `a/b` and `a%2Fb`; base64 of arbitrary bytes is not
 * safe in filenames on every platform).
 */
const hashUrl = (url: string) => createHash('sha256').update(url).digest('hex')

const cachePaths = (url: string) => {
  const id = hashUrl(url)
  return {
    docPath: join(CACHE_DIR, `${id}.md`),
    metaPath: join(CACHE_DIR, `${id}.json`),
  }
}

type CacheMeta = { updateTime: string }

const readCacheMeta = async (metaPath: string): Promise<CacheMeta | null> => {
  try {
    const raw = await readFile(metaPath, 'utf8')
    const parsed = JSON.parse(raw) as CacheMeta
    if (typeof parsed.updateTime !== 'string') return null
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // Corrupt metadata: treat as cache miss so the caller re-fetches.
    return null
  }
}

const writeCache = async (docPath: string, metaPath: string, text: string) => {
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(docPath, text, 'utf8')
  const meta: CacheMeta = { updateTime: new Date().toISOString() }
  await writeFile(metaPath, JSON.stringify(meta), 'utf8')
}

const fetchRemote = async (url: string) => {
  const dispatcher = buildProxyAgent()
  // `dispatcher` is an undici extension to RequestInit, not part of the
  // standard DOM fetch type — cast around it so callers stay typed.
  const init = dispatcher ? ({ dispatcher } as RequestInit) : undefined
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`failed to fetch document: ${response.status} ${response.statusText}`)
  }

  const text = await response.text()
  if (!text.trim()) {
    throw new Error('fetched document is empty')
  }

  return text
}

/**
 * Fetch the document at `url`, serving from the local on-disk cache when
 * the cache is present and younger than 3 days. Otherwise (no cache, or
 * `updateTime` older than 3 days) the URL is re-fetched and both the body
 * and a metadata sidecar are rewritten.
 *
 * Cache files live at:
 *   ~/.llmstxt-mcp/cache/<sha256(url)>.md
 *   ~/.llmstxt-mcp/cache/<sha256(url)>.json   // { "updateTime": ISO }
 *
 * The cache key is the URL itself (hashed) — different llms.txt entries
 * that happen to point at the same URL share one cache entry, which is
 * the whole point of moving from per-id storage to a content-addressed
 * cache.
 */
export const fetchDocTextCached = async (url: string) => {
  const { docPath, metaPath } = cachePaths(url)
  const meta = await readCacheMeta(metaPath)

  if (meta) {
    const ageMs = Date.now() - Date.parse(meta.updateTime)
    if (ageMs >= 0 && ageMs < CACHE_TTL_MS) {
      try {
        return await readFile(docPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
        // Metadata exists but body is missing — fall through to re-fetch.
      }
    }
  }

  const text = await fetchRemote(url)
  await writeCache(docPath, metaPath, text)
  return text
}
