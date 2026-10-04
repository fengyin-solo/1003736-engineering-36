import type { EntryRow } from './types'

// 仪器检定的共享领域逻辑：初始化迁移、页面看板、巡检核查项生成都用这一份判定，避免各处口径不一致。

/** 有效期剩余多少天算「临期」 */
export const CALIBRATION_EXPIRING_DAYS = 30

export const CALIBRATION_STATUSES = ['待送检', '送检中', '已合格', '不合格', '已停用'] as const

/** 效期判定结果：停用/不合格不参与效期判定，缺日期单列，其余按剩余天数分档 */
export type CalibrationDueState = '已停用' | '不合格' | '缺有效期' | '已到期' | '临期' | '有效'

export type CalibrationDue = {
  row: EntryRow
  state: CalibrationDueState
  /** 剩余天数：已到期为负数，缺有效期/停用/不合格为 null */
  daysLeft: number | null
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 只接受 YYYY-MM-DD，且必须能落成真实日期；「仪器检定样例1」这类占位串一律视为缺失 */
export function parseCalibrationDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value.trim())) {
    return null
  }
  const date = new Date(`${value.trim()}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatCalibrationDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function shiftDays(base: Date, days: number): Date {
  const next = new Date(base.getTime())
  next.setDate(next.getDate() + days)
  return next
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 判定单条检定记录的效期状态；today 可注入，方便测试与定时任务对齐口径 */
export function calibrationDueState(row: EntryRow, today: Date = new Date()): CalibrationDueState {
  const status = String(row.status ?? '')
  if (status === '已停用') {
    return '已停用'
  }
  if (status === '不合格') {
    return '不合格'
  }
  const validUntil = parseCalibrationDate(row['有效期至'])
  if (!validUntil) {
    return '缺有效期'
  }
  const diffMs = startOfDay(validUntil).getTime() - startOfDay(today).getTime()
  const daysLeft = Math.round(diffMs / 86_400_000)
  if (daysLeft < 0) {
    return '已到期'
  }
  return daysLeft <= CALIBRATION_EXPIRING_DAYS ? '临期' : '有效'
}

export function calibrationDue(row: EntryRow, today: Date = new Date()): CalibrationDue {
  const state = calibrationDueState(row, today)
  const validUntil = parseCalibrationDate(row['有效期至'])
  const daysLeft =
    validUntil && (state === '已到期' || state === '临期' || state === '有效')
      ? Math.round((startOfDay(validUntil).getTime() - startOfDay(today).getTime()) / 86_400_000)
      : null
  return { row, state, daysLeft }
}

/** 需要巡检模块跟进的核查问题：返回空数组表示这台仪器不用生成核查项 */
export function calibrationIssues(row: EntryRow, today: Date = new Date()): string[] {
  const due = calibrationDue(row, today)
  const code = String(row['仪器编号'] ?? row['记录编号'] ?? row.id)
  switch (due.state) {
    case '已停用':
    case '有效':
      return []
    case '不合格':
      return [`仪器 ${code} 检定结论不合格，需停用处置并重新送检`]
    case '缺有效期':
      return [`仪器 ${code} 缺少检定有效期，需补录检定证书信息`]
    case '已到期':
      return [
        `仪器 ${code} 检定有效期已于 ${String(row['有效期至'])} 到期（超期 ${Math.abs(due.daysLeft ?? 0)} 天），需安排复检`,
      ]
    case '临期':
      return [
        `仪器 ${code} 检定有效期至 ${String(row['有效期至'])}（剩 ${due.daysLeft ?? 0} 天），需提前安排送检`,
      ]
  }
}

/** 核查项建议处理措施：取问题里最严重的一档 */
export function calibrationIssueAction(row: EntryRow, today: Date = new Date()): string {
  const state = calibrationDueState(row, today)
  switch (state) {
    case '不合格':
      return '停用该仪器，重新送检并复核'
    case '缺有效期':
      return '补录检定证书与有效期'
    case '已到期':
      return '立即安排送检，复检合格前暂停使用'
    case '临期':
      return '纳入送检计划，到期前完成复检'
    default:
      return '例行核查'
  }
}
