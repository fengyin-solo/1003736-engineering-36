import type { EntryRow } from './types'

// 仪器检定领域逻辑：有效期判定、临期分组、验收联动都在这里，页面与本地服务共用。

export const CALIBRATION_KEY = 'calibration'

// 临期窗口：有效期不足 30 天算临期。
export const EXPIRING_SOON_DAYS = 30

export type ExpiryState = 'expiring' | 'expired' | 'missing' | 'valid'

export function todayIso(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null
  }
  const date = new Date(`${text}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 距有效期至的剩余天数：今天到期算 0，已过期为负数；缺有效期返回 null。 */
export function daysUntilExpiry(row: EntryRow, now: Date = new Date()): number | null {
  const expiry = parseDate(row['有效期至'])
  if (!expiry) {
    return null
  }
  const ms = startOfDay(expiry).getTime() - startOfDay(now).getTime()
  return Math.round(ms / 86_400_000)
}

export function expiryState(row: EntryRow, now: Date = new Date()): ExpiryState {
  const days = daysUntilExpiry(row, now)
  if (days === null) {
    return 'missing'
  }
  if (days < 0) {
    return 'expired'
  }
  if (days <= EXPIRING_SOON_DAYS) {
    return 'expiring'
  }
  return 'valid'
}

export const EXPIRY_LABELS: Record<ExpiryState, string> = {
  expiring: '临期',
  expired: '已过期',
  missing: '缺有效期',
  valid: '正常',
}

/** 临期视图：停用仪器不参与检定到期提醒，其余已过期 / 临期 / 缺有效期的都要挂出来。 */
export function isExpiryWatched(row: EntryRow, now: Date = new Date()): boolean {
  if (String(row.status) === '已停用') {
    return false
  }
  return expiryState(row, now) !== 'valid'
}

/** 送检待办：待送检（含漏检过期）与送检中（等验收结论）。 */
export function isShipmentTodo(row: EntryRow, now: Date = new Date()): boolean {
  const status = String(row.status)
  return status === '待送检' || status === '送检中' || isExpiryWatched(row, now) && status === '待送检'
}

export function addYears(iso: string, years: number): string {
  const date = parseDate(iso) ?? new Date()
  const next = new Date(date.getFullYear() + years, date.getMonth(), date.getDate())
  const month = String(next.getMonth() + 1).padStart(2, '0')
  const day = String(next.getDate()).padStart(2, '0')
  return `${next.getFullYear()}-${month}-${day}`
}
