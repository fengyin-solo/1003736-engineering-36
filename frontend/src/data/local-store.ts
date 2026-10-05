import { MODULES } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow, LinkedJob, StoredData } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
// 当前数据结构版本：结构变更时 +1，旧版本数据走 migrateStoredData 兼容升级。
const SCHEMA_VERSION = 2

const PLACEHOLDER_PATTERN = /.+样例\d+$/

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshData(): StoredData {
  return {
    version: SCHEMA_VERSION,
    initializedAt: new Date().toISOString(),
    rows: clone(SEED_ROWS),
    jobs: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && PLACEHOLDER_PATTERN.test(value)
}

function isIdLike(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 旧版本地数据兼容：
 * - v1（裸 Record<模块, 行[]>）包进带版本的新结构；
 * - 新结构里缺失的模块补整份示例；存量模块保留原行，缺字段 / 占位字段按新结构补录，不覆盖真实数据；
 * - 检定模块状态字段与 pending/abnormal 标志按状态机重新对齐。
 */
export function migrateStoredData(parsed: unknown): StoredData {
  let legacy: Record<string, EntryRow[]>
  if (isRecord(parsed) && isRecord(parsed.rows)) {
    legacy = parsed.rows as Record<string, EntryRow[]>
  } else if (isRecord(parsed)) {
    legacy = parsed as unknown as Record<string, EntryRow[]>
  } else {
    return freshData()
  }

  const rows: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    const stored = Array.isArray(legacy[meta.key]) ? (legacy[meta.key] as EntryRow[]) : null
    if (!stored) {
      rows[meta.key] = clone(SEED_ROWS[meta.key] ?? [])
      continue
    }

    // 存量缺失字段补录：以同 id 的新示例行为蓝本，再退回按字段语义兜底，绝不覆盖已填的真实值。
    const seedById = new Map(
      (SEED_ROWS[meta.key] ?? []).map((seed) => [Number(seed.id), seed]),
    )
    rows[meta.key] = stored.map((raw) => {
      const row: EntryRow = (isRecord(raw) ? { ...raw } : {}) as EntryRow
      if (!isIdLike(row.id)) {
        row.id = 0
      }
      row.status = typeof row.status === 'string' && row.status ? row.status : meta.statuses[0]
      const seed = seedById.get(Number(row.id))
      const migrated: EntryRow = { ...row }
      for (const field of meta.fields) {
        const current = migrated[field]
        if (current === undefined || current === null || current === '' || looksPlaceholder(current)) {
          if (seed && !looksPlaceholder(seed[field]) && seed[field] !== '') {
            migrated[field] = seed[field]
          } else if (field === meta.fields[meta.fields.length - 1]) {
            migrated[field] = migrated.status
          } else {
            migrated[field] = '待补录'
          }
        }
      }
      const lastStatus = meta.statuses[meta.statuses.length - 1]
      migrated.status = meta.statuses.includes(String(migrated.status))
        ? migrated.status
        : (seed?.status ?? meta.statuses[0])
      migrated.pending = typeof migrated.pending === 'boolean' ? migrated.pending : migrated.status !== lastStatus
      migrated.abnormal =
        typeof migrated.abnormal === 'boolean'
          ? migrated.abnormal
          : migrated.status === '不合格' || migrated.status === '已停用'
      return migrated
    })

    // 示例里新增的行（旧库没有的 id）追加进去，覆盖到期 / 不合格 / 停用 / 缺有效期等场景。
    const existingIds = new Set(rows[meta.key].map((row) => Number(row.id)))
    for (const seed of SEED_ROWS[meta.key] ?? []) {
      if (!existingIds.has(Number(seed.id))) {
        rows[meta.key].push(clone(seed))
      }
    }
  }

  const jobs = isRecord(parsed) && Array.isArray(parsed.jobs) ? (parsed.jobs as LinkedJob[]) : []
  return {
    version: SCHEMA_VERSION,
    initializedAt:
      isRecord(parsed) && typeof parsed.initializedAt === 'string'
        ? parsed.initializedAt
        : new Date().toISOString(),
    rows,
    jobs,
  }
}

function writeStorage(data: StoredData): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }
}

/**
 * 部署前初始化：清空 localStorage 后第一次进入时播种示例数据。
 * 幂等——已有当前版本数据时原样返回，重复初始化只生效一次。
 */
export function initLocalData(force = false): StoredData {
  if (cache && !force) {
    // 存储被外部清空（部署后清库 / 用户清缓存）时，以存储为准重新播种，不能再用旧缓存。
    if (typeof window === 'undefined' || !window.localStorage || window.localStorage.getItem(STORAGE_KEY)) {
      return cache
    }
    cache = null
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    const data = freshData()
    cache = data
    return data
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const data = freshData()
    writeStorage(data)
    cache = data
    return data
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const data = freshData()
    writeStorage(data)
    cache = data
    return data
  }

  const data = migrateStoredData(parsed)
  const sameVersion = isRecord(parsed) && Number(parsed.version) === SCHEMA_VERSION
  if (!sameVersion || force) {
    writeStorage(data)
  }
  cache = data
  return data
}

let cache: StoredData | null = null

export function allRows(): Record<string, EntryRow[]> {
  return initLocalData().rows
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const data = initLocalData()
  const next: StoredData = {
    ...data,
    rows: { ...data.rows, [key]: rows },
  }
  commitData(next)
}

/** 整批原子写入：多个模块一起落库，中途任一步失败都不会留下半截数据（失败整批回退）。 */
export function commitBatch(mutate: (draft: StoredData) => void): StoredData {
  const current = initLocalData()
  const draft: StoredData = {
    ...current,
    rows: clone(current.rows),
    jobs: clone(current.jobs),
  }
  mutate(draft)
  commitData(draft)
  return draft
}

function commitData(next: StoredData): void {
  const serialized = JSON.stringify(next)
  writeStorage(next)
  cache = JSON.parse(serialized) as StoredData
}

export function listJobs(): LinkedJob[] {
  return initLocalData().jobs
}

export function saveJobs(jobs: LinkedJob[]): void {
  const data = initLocalData()
  commitData({ ...data, jobs })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 清空并重新播种（含断点任务），等价于部署后首次初始化。 */
export function reinitializeData(): StoredData {
  const data = freshData()
  writeStorage(data)
  cache = data
  return data
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function schemaVersion(): number {
  return SCHEMA_VERSION
}
