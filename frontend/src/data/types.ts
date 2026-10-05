/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 跨模块联动的断点任务（如检定验收后同步生成巡检核查项）。
export type LinkedJob = {
  id: string
  type: string
  refId: number
  status: 'running' | 'failed' | 'done'
  stage: number
  attempts: number
  lastError: string
  createdAt: string
  updatedAt: string
  payload: Record<string, string | number | boolean>
}

// 带版本号的本地持久化结构：rows 是各模块业务行，jobs 是联动断点任务。
export type StoredData = {
  version: number
  initializedAt: string
  rows: Record<string, EntryRow[]>
  jobs: LinkedJob[]
}
