import { commitBatch, listJobs, listRows, saveJobs } from '@/data/local-store'
import type { ActionResult, EntryRow, LinkedJob } from '@/data/types'
import { daysUntilExpiry, expiryState, isExpiryWatched, todayIso, addYears } from '@/data/calibration'

// 仪器检定验收联动：验收（合格 / 不合格）落库的同时，巡检模块同步生成核查项。
// 多步操作走 commitBatch 整批原子提交——任一步失败，草稿整体丢弃即整批回退；
// 任务记录保留失败断点，重试时已完成的步骤幂等跳过，从未完成的断点继续。

const CALIBRATION_KEY = 'calibration'
const INSPECTION_KEY = 'inspection'
const JOB_TYPE = 'calibration-acceptance'

export type AcceptOutcome = 'qualified' | 'rejected'

type JobContext = {
  job: LinkedJob
  outcome: AcceptOutcome
  instrument: { code: string; name: string; recordNo: string; unit: string }
  today: string
}

type JobStep = {
  name: string
  isDone: (draft: { calibration: EntryRow[]; inspection: EntryRow[] }, ctx: JobContext) => boolean
  apply: (draft: { calibration: EntryRow[]; inspection: EntryRow[] }, ctx: JobContext) => void
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function checkItemsFor(outcome: AcceptOutcome): { name: string; problem: string; abnormal: boolean }[] {
  if (outcome === 'qualified') {
    return [
      { name: '仪器外观及密封性核查', problem: '新验收合格，待首次外观核查确认', abnormal: false },
      { name: '零点稳定性核查', problem: '新验收合格，待零点稳定性复核', abnormal: false },
      { name: '首月比测核查', problem: '新验收合格，首月需完成三次比测', abnormal: false },
    ]
  }
  return [
    { name: '不合格仪器隔离与维修跟踪核查', problem: '检定不合格，需隔离停用并跟踪返修', abnormal: true },
  ]
}

function itemRecordNo(base: string, index: number): string {
  // CALI-2026-0002 -> INSP-2026-0002-A
  const matched = base.match(/^[A-Z]+-(.+)$/)
  const suffix = matched ? matched[1] : base
  return `INSP-${suffix}-${String.fromCharCode(65 + index)}`
}

// 第一步：检定结论落库。
const acceptStep: JobStep = {
  name: '登记检定验收结论',
  isDone: (draft, ctx) =>
    draft.calibration.some((row) => Number(row.id) === ctx.job.refId && row['关联任务'] === ctx.job.id),
  apply: (draft, ctx) => {
    const index = draft.calibration.findIndex((row) => Number(row.id) === ctx.job.refId)
    if (index < 0) {
      throw new Error(`验收中断：检定记录 ${ctx.job.refId} 在流程中丢失`)
    }
    const current = draft.calibration[index]
    if (ctx.outcome === 'qualified') {
      draft.calibration[index] = {
        ...current,
        status: '已合格',
        pending: false,
        abnormal: false,
        检定日期: ctx.today,
        有效期至: addYears(ctx.today, 1),
        检定结论: '合格',
        检定状态: '已合格',
        关联任务: ctx.job.id,
      }
    } else {
      draft.calibration[index] = {
        ...current,
        status: '不合格',
        pending: false,
        abnormal: true,
        检定日期: ctx.today,
        有效期至: '',
        检定结论: '不合格，已退回检修',
        检定状态: '不合格',
        关联任务: ctx.job.id,
      }
    }
  },
}

// 第二步：巡检模块同步生成核查项。
const inspectionStep: JobStep = {
  name: '同步生成巡检核查项',
  isDone: (draft, ctx) => {
    const templates = checkItemsFor(ctx.outcome)
    return templates.every((template, index) =>
      draft.inspection.some(
        (row) =>
          row['关联任务'] === ctx.job.id &&
          row['记录编号'] === itemRecordNo(ctx.instrument.recordNo, index) &&
          String(row['检查项目'] ?? '').includes(template.name),
      ),
    )
  },
  apply: (draft, ctx) => {
    if (draft.calibration.every((row) => row['关联任务'] !== ctx.job.id)) {
      // 断点保护：验收结论没落库前不允许生成核查项。
      throw new Error('验收结论尚未落库，不能提前生成巡检核查项')
    }
    const templates = checkItemsFor(ctx.outcome)
    templates.forEach((template, index) => {
      const recordNo = itemRecordNo(ctx.instrument.recordNo, index)
      if (draft.inspection.some((row) => row['记录编号'] === recordNo)) {
        // 编号被占用且不属于本任务，视为同步冲突，整批回退。
        throw new Error(`巡检记录编号 ${recordNo} 已被占用，核查项同步失败`)
      }
      const exists = draft.inspection.some(
        (row) => row['关联任务'] === ctx.job.id && String(row['检查项目'] ?? '').includes(template.name),
      )
      if (exists) {
        return
      }
      draft.inspection.push({
        id: nextId(draft.inspection),
        status: '待巡检',
        pending: true,
        abnormal: template.abnormal,
        记录编号: recordNo,
        站点编号: '中心站仪器室',
        巡检日期: ctx.today,
        巡检人员: '检定验收联动（待分配）',
        检查项目: `[核查项] ${ctx.instrument.name}（${ctx.instrument.code}）· ${template.name}（检定记录 ${ctx.instrument.recordNo}）`,
        发现问题: template.problem,
        处理措施: template.abnormal ? '已通知隔离并安排返修跟踪' : '待巡检核查',
        巡检状态: '待巡检',
        关联任务: ctx.job.id,
        关联记录: ctx.instrument.recordNo,
      })
    })
  },
}

const STEPS: JobStep[] = [acceptStep, inspectionStep]

function makeJobId(refId: number): string {
  return `cal-accept-${refId}-${Date.now()}`
}

function buildContext(job: LinkedJob, today: string): JobContext {
  return {
    job,
    outcome: job.payload.outcome === 'rejected' ? 'rejected' : 'qualified',
    instrument: {
      code: String(job.payload.instrumentCode ?? ''),
      name: String(job.payload.instrumentName ?? ''),
      recordNo: String(job.payload.recordNo ?? ''),
      unit: String(job.payload.unit ?? ''),
    },
    today,
  }
}

/**
 * 执行（或从断点续跑）一条联动任务。
 * 整批改在 commitBatch 的草稿上，任一步抛错则草稿丢弃——业务数据整批回退；
 * 任务本身按失败断点持久化，重试时 isDone 命中的步骤跳过，从断点继续。
 */
export function runLinkedJob(job: LinkedJob): ActionResult {
  const target = listRows(CALIBRATION_KEY).find((row) => Number(row.id) === job.refId)
  if (!target) {
    return { ok: false, message: `联动任务 ${job.id} 找不到检定记录 ${job.refId}` }
  }
  const ctx = buildContext(job, todayIso())
  try {
    commitBatch((draft) => {
      const bundle = {
        calibration: draft.rows[CALIBRATION_KEY],
        inspection: draft.rows[INSPECTION_KEY],
      }
      for (let index = Number(job.stage) || 0; index < STEPS.length; index += 1) {
        const step = STEPS[index]
        if (step.isDone(bundle, ctx)) {
          continue
        }
        step.apply(bundle, ctx)
        // 记录断点：提交成功后该步骤即完成；失败时保留在这一步的索引。
        job.stage = index + 1
      }
      job.status = 'done'
      job.lastError = ''
      job.attempts += 1
      job.updatedAt = new Date().toISOString()
      upsertJob(draft.jobs, job)
    })
    return { ok: true, message: `检定验收完成，巡检模块已同步生成 ${checkItemsFor(ctx.outcome).length} 个核查项` }
  } catch (error) {
    // 整批回退：commitBatch 抛错时业务数据未落库；仅持久化任务断点，供下次重试。
    const failedStage = STEPS.findIndex((step) => {
      const draft = {
        calibration: listRows(CALIBRATION_KEY),
        inspection: listRows(INSPECTION_KEY),
      }
      return !step.isDone(draft, ctx)
    })
    job.status = 'failed'
    job.stage = failedStage >= 0 ? failedStage : STEPS.length - 1
    job.attempts += 1
    job.lastError = error instanceof Error ? error.message : '联动流程执行失败'
    job.updatedAt = new Date().toISOString()
    persistJob(job)
    return { ok: false, message: `验收联动在「${STEPS[job.stage]?.name ?? '未知步骤'}」失败，已整批回退：${job.lastError}` }
  }
}

function upsertJob(jobs: LinkedJob[], job: LinkedJob): void {
  const index = jobs.findIndex((item) => item.id === job.id)
  if (index >= 0) {
    jobs[index] = job
  } else {
    jobs.push(job)
  }
}

function persistJob(job: LinkedJob): void {
  const jobs = [...listJobs()]
  upsertJob(jobs, job)
  saveJobs(jobs)
}

/** 检定验收：只有「送检中」的记录可以验收；先建任务，再跑联动流程。 */
export function acceptCalibration(id: number, outcome: AcceptOutcome): ActionResult {
  const rows = listRows(CALIBRATION_KEY)
  const target = rows.find((row) => Number(row.id) === id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的仪器检定记录` }
  }
  if (String(target.status) !== '送检中') {
    return { ok: false, message: `当前状态为「${target.status}」，只有送检中的仪器可以登记验收结论` }
  }
  const running = listJobs().some(
    (job) => job.type === JOB_TYPE && job.refId === id && job.status !== 'done',
  )
  if (running) {
    return { ok: false, message: '该仪器已有未完成的验收联动任务，请先处理断点任务' }
  }

  const now = new Date().toISOString()
  const job: LinkedJob = {
    id: makeJobId(id),
    type: JOB_TYPE,
    refId: id,
    status: 'running',
    stage: 0,
    attempts: 0,
    lastError: '',
    createdAt: now,
    updatedAt: now,
    payload: {
      outcome,
      instrumentCode: String(target['仪器编号'] ?? ''),
      instrumentName: String(target['仪器名称'] ?? ''),
      recordNo: String(target['记录编号'] ?? ''),
      unit: String(target['检定单位'] ?? ''),
    },
  }
  persistJob(job)
  return runLinkedJob(job)
}

/** 断点重试：失败 / 上次会话未跑完的任务逐条续跑；返回每条结果。 */
export function retryStuckJobs(): { job: LinkedJob; result: ActionResult }[] {
  return listJobs()
    .filter((job) => job.type === JOB_TYPE && job.status !== 'done')
    .map((job) => ({ job, result: runLinkedJob(job) }))
}

export function linkedJobs(): LinkedJob[] {
  return listJobs().filter((job) => job.type === JOB_TYPE)
}

// ---- 临期视图 / 送检待办查询 ----

export type ExpiringRow = EntryRow & { 剩余天数: number; 到期状态: string }

export function listExpiringCalibrations(now: Date = new Date()): ExpiringRow[] {
  return listRows(CALIBRATION_KEY)
    .filter((row) => isExpiryWatched(row, now))
    .map((row) => {
      const days = daysUntilExpiry(row, now)
      return {
        ...row,
        剩余天数: days ?? Number.POSITIVE_INFINITY,
        到期状态:
          days === null
            ? '缺有效期'
            : days < 0
              ? `已过期 ${Math.abs(days)} 天`
              : days === 0
                ? '今日到期'
                : `剩余 ${days} 天`,
      }
    })
    .sort((a, b) => a.剩余天数 - b.剩余天数)
}

export function listShipmentTodos(now: Date = new Date()): EntryRow[] {
  return listRows(CALIBRATION_KEY)
    .filter((row) => {
      const status = String(row.status)
      if (status === '待送检' || status === '送检中') {
        return true
      }
      return status !== '已停用' && expiryState(row, now) !== 'valid'
    })
    .sort((a, b) => (daysUntilExpiry(a, now) ?? Number.POSITIVE_INFINITY) - (daysUntilExpiry(b, now) ?? Number.POSITIVE_INFINITY))
}

export { JOB_TYPE }
