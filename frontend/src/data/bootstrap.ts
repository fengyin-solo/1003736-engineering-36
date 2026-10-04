import { calibrationIssueAction, calibrationIssues, parseCalibrationDate, shiftDays, formatCalibrationDate } from './calibration'
import { allRows, listRows, replaceAllRows, saveRows } from './local-store'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 部署前初始化：应用挂载前把本地数据整理成当前结构。
// 特性：
// - 版本化 + 幂等：同一结构版本只完整生效一次，重复调用直接跳过；
// - 旧数据兼容：占位符/缺失字段按新结构补录（补录口径见 normalizeCalibrationRow）；
// - 断点续跑：每个步骤提交后写入检查点，失败时整批回滚该步骤，下次从失败的步骤继续。

export const SCHEMA_VERSION = 2

const INIT_KEY = 'hydrology-monitor-station:init'

export type BootstrapStepName = 'calibration' | 'inspection'

export type BootstrapState = {
  version: number
  steps: Partial<Record<BootstrapStepName, string>>
  failedStep?: BootstrapStepName
  lastError?: string
}

export type BootstrapResult = {
  ok: boolean
  /** 本次是否跳过了全部步骤（之前已初始化完成） */
  alreadyDone: boolean
  failedStep?: BootstrapStepName
  message?: string
  state: BootstrapState
}

/** 测试/演示用：指定在某个步骤注入一次失败，验证整批回退与断点重试 */
export type BootstrapOptions = {
  failStep?: BootstrapStepName
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function readState(): BootstrapState {
  const empty: BootstrapState = { version: 0, steps: {} }
  if (!storageAvailable()) {
    return empty
  }
  const raw = window.localStorage.getItem(INIT_KEY)
  if (!raw) {
    return empty
  }
  try {
    const parsed = JSON.parse(raw) as BootstrapState
    return { version: Number(parsed.version) || 0, steps: parsed.steps ?? {}, failedStep: parsed.failedStep, lastError: parsed.lastError }
  } catch {
    return empty
  }
}

function writeState(state: BootstrapState): void {
  if (storageAvailable()) {
    window.localStorage.setItem(INIT_KEY, JSON.stringify(state))
  }
}

// ---------- 步骤一：仪器检定记录迁移/补录 ----------

const CALIBRATION_UNITS = ['省水文仪器检定中心', '流域计量测试站', '市计量科学研究院']

function isPlaceholder(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text === '' || text.includes('样例')
}

function pad(num: number): string {
  return String(num).padStart(4, '0')
}

/** 把一条检定记录整理成新结构；已合法的字段原样保留，重复执行是恒等变换 */
function normalizeCalibrationRow(row: EntryRow, index: number, today: Date): EntryRow {
  const id = Number(row.id) || index + 1
  const status = String(row.status ?? '') || '待送检'
  const recordNo = isPlaceholder(row['记录编号']) ? `CALI-${pad(id)}` : String(row['记录编号'])
  // 旧种子把仪器编号抄成记录编号，这种也按缺失补录
  const instrumentNo =
    isPlaceholder(row['仪器编号']) || String(row['仪器编号']) === recordNo
      ? `INST-${pad(id)}`
      : String(row['仪器编号'])
  const name = isPlaceholder(row['仪器名称']) ? `监测仪器-${instrumentNo}` : String(row['仪器名称'])
  const unit = isPlaceholder(row['检定单位'])
    ? CALIBRATION_UNITS[index % CALIBRATION_UNITS.length]
    : String(row['检定单位'])

  let calibratedAt = parseCalibrationDate(row['检定日期'])
  let validUntil = parseCalibrationDate(row['有效期至'])
  let conclusion = isPlaceholder(row['检定结论']) ? '' : String(row['检定结论'])

  // 存量缺失按状态补录：没检过的留空（保留「缺有效期」场景），检过的按周期推算
  switch (status) {
    case '已合格':
      calibratedAt = calibratedAt ?? shiftDays(today, -200)
      validUntil = validUntil ?? shiftDays(calibratedAt, 365)
      conclusion = conclusion || '合格'
      break
    case '不合格':
      calibratedAt = calibratedAt ?? shiftDays(today, -10)
      validUntil = validUntil ?? calibratedAt
      conclusion = conclusion || '不合格'
      break
    case '送检中':
      calibratedAt = calibratedAt ?? shiftDays(today, -10)
      conclusion = conclusion || '待定'
      break
    case '已停用':
      calibratedAt = calibratedAt ?? shiftDays(today, -400)
      validUntil = validUntil ?? shiftDays(calibratedAt, 365)
      conclusion = conclusion || '合格'
      break
    default: // 待送检：尚未检定，日期留空
      conclusion = conclusion || '待检'
      break
  }

  return {
    ...row,
    id,
    status,
    pending: status !== '已停用',
    abnormal: status === '不合格' || status === '已停用',
    记录编号: recordNo,
    仪器编号: instrumentNo,
    仪器名称: name,
    检定单位: unit,
    检定日期: calibratedAt ? formatCalibrationDate(calibratedAt) : '',
    有效期至: validUntil ? formatCalibrationDate(validUntil) : '',
    检定结论: conclusion,
    检定状态: status,
  }
}

function migrateCalibration(options: BootstrapOptions): void {
  if (options.failStep === 'calibration') {
    throw new Error('注入失败：仪器检定迁移步骤')
  }
  const existing = listRows('calibration')
  const source = existing.length > 0 ? existing : clone(SEED_ROWS['calibration'] ?? [])
  const today = new Date()
  const migrated = source.map((row, index) => normalizeCalibrationRow(row, index, today))
  saveRows('calibration', migrated)
}

// ---------- 步骤二：巡检模块同步生成核查项 ----------

function syncInspectionCheckItems(options: BootstrapOptions): void {
  if (options.failStep === 'inspection') {
    throw new Error('注入失败：巡检核查项生成步骤')
  }
  const today = new Date()
  const inspections = listRows('inspection')
  const existingKeys = new Set(inspections.map((row) => String(row['记录编号'] ?? '')))
  let nextId = inspections.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const created: EntryRow[] = []
  for (const row of listRows('calibration')) {
    const issues = calibrationIssues(row, today)
    if (issues.length === 0) {
      continue
    }
    // 一台仪器一条核查项，编号确定，重复初始化不会重复生成
    const checkNo = `INSP-${String(row['仪器编号'])}`
    if (existingKeys.has(checkNo)) {
      continue
    }
    existingKeys.add(checkNo)
    const needsAttention = issues.some((text) => text.includes('不合格') || text.includes('超期'))
    created.push({
      id: nextId++,
      status: '待巡检',
      pending: true,
      abnormal: needsAttention,
      记录编号: checkNo,
      站点编号: String(row['仪器编号']),
      巡检日期: formatCalibrationDate(today),
      巡检人员: '系统初始化',
      检查项目: '仪器检定核查',
      发现问题: issues.join('；'),
      处理措施: calibrationIssueAction(row, today),
      巡检状态: '待巡检',
    })
  }
  if (created.length > 0) {
    saveRows('inspection', [...inspections, ...created])
  }
}

// ---------- 编排：顺序执行、逐步提交、失败回滚 ----------

const STEPS: { name: BootstrapStepName; run: (options: BootstrapOptions) => void }[] = [
  { name: 'calibration', run: migrateCalibration },
  { name: 'inspection', run: syncInspectionCheckItems },
]

export function bootstrapLocalData(options: BootstrapOptions = {}): BootstrapResult {
  if (!storageAvailable()) {
    return { ok: true, alreadyDone: true, state: readState(), message: '无本地存储，跳过初始化' }
  }
  // 确保各模块至少有种子数据（首次打开或清空 localStorage 之后）
  allRows()
  const state = readState()
  const allDone = STEPS.every((step) => Boolean(state.steps[step.name]))
  if (state.version === SCHEMA_VERSION && allDone) {
    return { ok: true, alreadyDone: true, state }
  }
  for (const step of STEPS) {
    if (state.steps[step.name]) {
      continue // 已提交的步骤跳过，实现断点续跑
    }
    const snapshot = clone(allRows())
    try {
      step.run(options)
      state.steps[step.name] = new Date().toISOString()
      delete state.failedStep
      delete state.lastError
      writeState(state)
    } catch (error) {
      // 整批回退：该步骤写出的内容全部撤销，数据回到步骤开始前
      replaceAllRows(snapshot)
      state.failedStep = step.name
      state.lastError = error instanceof Error ? error.message : String(error)
      writeState(state)
      return {
        ok: false,
        alreadyDone: false,
        failedStep: step.name,
        message: `初始化步骤「${step.name}」失败，已整批回退，下次启动将从该步骤重试：${state.lastError}`,
        state,
      }
    }
  }
  state.version = SCHEMA_VERSION
  writeState(state)
  return { ok: true, alreadyDone: false, state }
}

export function bootstrapState(): BootstrapState {
  return readState()
}
