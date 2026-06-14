import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  globalSettingsSchema,
  llmsConfigSchema,
  llmsItemSchema,
  type LlmsConfig,
  type LlmsItem,
} from '../types/index.js'
import { assertUnique, fetchDocTextCached, resolveDocLinks } from '../utils/index.js'

const baseDir = join(homedir(), '.llmstxt-mcp')
const configPath = join(baseDir, 'config.json')
const defaultRefreshTtlMs = 7 * 24 * 60 * 60 * 1000 // 7 days

const emptyConfig: LlmsConfig = llmsConfigSchema.parse({})

const now = () => new Date().toISOString()

/**
 * Atomic write: write to a sibling temp file then rename over the target.
 * Prevents partially-written config.json from corrupting subsequent reads.
 * Assumes the parent directory already exists — ensureConfig creates it.
 */
const writeJson = async (filePath: string, data: unknown) => {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8')
  await rename(tempPath, filePath)
}

/**
 * Ensure config.json exists and is parseable. If the file is missing, empty,
 * or contains invalid JSON, back it up and write a fresh empty config so
 * subsequent reads always succeed.
 */
const ensureConfig = async () => {
  await mkdir(baseDir, { recursive: true })

  let raw = ''
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  if (!raw.trim()) {
    await backupAndReset(raw, 'empty or missing file')
    return
  }

  try {
    JSON.parse(raw)
  } catch (error) {
    await backupAndReset(raw, `invalid JSON: ${(error as Error).message}`)
  }
}

const backupAndReset = async (raw: string, reason: string) => {
  const backupPath = `${configPath}.corrupt.${Date.now()}.bak`
  await writeFile(backupPath, raw, 'utf8')
  console.warn(
    `llmstxt-mcp: config.json unreadable (${reason}); backed up to ${backupPath} and resetting to empty config`,
  )
  await writeJson(configPath, emptyConfig)
}

const readConfig = async (): Promise<LlmsConfig> => {
  await ensureConfig()
  const raw = await readFile(configPath, 'utf8')
  return llmsConfigSchema.parse(JSON.parse(raw))
}

const writeConfig = async (config: LlmsConfig) => {
  await writeJson(configPath, config)
}

const findItemIndex = (config: LlmsConfig, id: string) => {
  const index = config.llms.findIndex((entry) => entry.id === id)
  if (index === -1) {
    throw new Error(`llms not found: ${id}`)
  }
  return index
}

/**
 * Fetch the source document for `item.url` through the on-disk URL cache
 * (see `utils/http.ts`). On a successful refresh, `item.updateTime` is set
 * to the current time so callers can reason about the freshness of the
 * item without having to inspect the cache.
 */
const syncItemDocument = async (item: LlmsItem) => {
  await fetchDocTextCached(item.url)
  item.updateTime = now()
}

/**
 * Serialize all public llmsStore operations through a single Promise chain.
 * Node's single-threaded event loop means a chained `.then` is sufficient
 * to make the critical section (read-modify-write of config.json) atomic
 * from the perspective of concurrent MCP tool invocations.
 */
let lockChain: Promise<unknown> = Promise.resolve()
const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = lockChain.then(fn, fn)
  lockChain = next.catch(() => {})
  return next
}

const getRefreshTtlMs = (config: LlmsConfig): number => {
  // readConfig() runs llmsConfigSchema.parse(...), so refreshTtlMs is already
  // guaranteed to be a positive integer if present.
  return config.globalSettings?.refreshTtlMs ?? defaultRefreshTtlMs
}

/**
 * An item is stale when its updateTime is empty (never fetched) or older
 * than ttlMs. The caller is responsible for serializing refresh.
 */
const isStale = (item: LlmsItem, ttlMs: number, nowMs: number) => {
  if (!item.updateTime) return true
  return nowMs - Date.parse(item.updateTime) >= ttlMs
}

const refreshItemById = async (config: LlmsConfig, id: string) => {
  const item = config.llms[findItemIndex(config, id)]
  await syncItemDocument(item)
  await writeConfig(config)
  return item
}

const refreshItem = async (config: LlmsConfig, item: LlmsItem) => {
  await syncItemDocument(item)
  await writeConfig(config)
  return item
}

// Re-export schemas for callers that need to validate inputs.
export { llmsItemSchema, globalSettingsSchema, llmsConfigSchema }

export const llmsStore = {
  configPath,
  baseDir,
  add(input: { name: string; url: string; description: string }) {
    return withLock(async () => {
      const config = await readConfig()
      assertUnique(config.llms, { name: input.name, url: input.url })

      const item: LlmsItem = {
        id: randomUUID(),
        name: input.name,
        url: input.url,
        description: input.description,
        updateTime: '',
      }

      // 同步 fetch:成功才落盘。失败直接抛错,不写 config。
      await syncItemDocument(item)
      config.llms.push(item)
      await writeConfig(config)
      return item
    })
  },
  edit(input: { id: string; name?: string; url?: string; description?: string }) {
    return withLock(async () => {
      const config = await readConfig()
      const index = findItemIndex(config, input.id)
      const item = config.llms[index]

      assertUnique(config.llms, {
        name: input.name,
        url: input.url,
        excludeId: input.id,
      })

      // Validate the new URL by fetching first; only commit on success so a
      // bad URL never gets persisted. Other fields are applied only after
      // the fetch resolves so the metadata edit is one atomic change.
      if (input.url !== undefined && input.url !== item.url) {
        const previousUrl = item.url
        item.url = input.url
        try {
          await syncItemDocument(item)
        } catch (error) {
          item.url = previousUrl
          throw error
        }
      }

      if (input.name !== undefined) item.name = input.name
      if (input.description !== undefined) item.description = input.description
      await writeConfig(config)
      return item
    })
  },
  refreshOne(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      return refreshItemById(config, id)
    })
  },
  remove(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      const index = findItemIndex(config, id)
      const [removed] = config.llms.splice(index, 1)
      // Cache files are shared across items by URL, so we deliberately
      // leave them in place; another entry pointing at the same URL still
      // needs them, and stale entries are bounded by the 3-day TTL.
      await writeConfig(config)
      return removed
    })
  },
  list() {
    return withLock(async () => {
      const config = await readConfig()
      return config.llms.map((item) => ({
        id: item.id,
        name: item.name,
        url: item.url,
        description: item.description,
      }))
    })
  },
  get(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      const index = findItemIndex(config, id)
      return config.llms[index]
    })
  },
  getDoc(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      const item = config.llms[findItemIndex(config, id)]

      // view 层做过期判断:过期则刷新 url 数据,失败抛错(不返回旧内容)
      if (isStale(item, getRefreshTtlMs(config), Date.now())) {
        await refreshItem(config, item)
      }

      const text = await fetchDocTextCached(item.url)
      return {
        item,
        content: resolveDocLinks(text, item.url),
      }
    })
  },
}
