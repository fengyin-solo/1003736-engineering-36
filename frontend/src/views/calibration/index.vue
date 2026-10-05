<template>
  <section class="page" data-module="calibration">
    <header class="page-head">
      <div>
        <h2>仪器检定管理</h2>
        <p class="page-desc">维护仪器检定记录，围绕记录编号、仪器编号、仪器名称、检定单位做登记、筛选、临期提醒与验收流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记仪器检定记录</button>
        <button class="btn" type="button" @click="exportRows">导出仪器检定清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ warn: item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="stuckJobs.length" class="job-banner">
      <span>
        有 {{ stuckJobs.length }} 条验收联动任务停在断点（{{ stuckJobs.map((job) => job.lastError || '等待重试').join('；') }}）
      </span>
      <button class="btn primary" type="button" @click="retryJobs">从断点重试</button>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="todo-panel">
      <h3>送检待办</h3>
      <table class="data-table">
        <thead>
          <tr><th>记录编号</th><th>仪器编号</th><th>仪器名称</th><th>检定单位</th><th>当前状态</th><th>有效期</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in shipmentTodos" :key="`todo-${String(row.id)}`">
            <td>{{ row['记录编号'] ?? '—' }}</td>
            <td>{{ row['仪器编号'] ?? '—' }}</td>
            <td>{{ row['仪器名称'] ?? '—' }}</td>
            <td>{{ row['检定单位'] ?? '—' }}</td>
            <td>{{ row.status }}</td>
            <td>
              <span :class="['expiry-badge', badgeClass(row)]">{{ expiryLabel(row) }}</span>
            </td>
            <td class="row-actions">
              <button
                v-for="action in actionsFor(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!shipmentTodos.length">
            <td colspan="7" class="empty-state">暂无送检待办，仪器都在有效期内</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div class="view-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        :class="['btn', { primary: activeTab === tab.key }]"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}（{{ tab.count }}）
      </button>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>到期提醒</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visibleRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '有效期至'">
              <span :class="['expiry-badge', badgeClass(row)]">{{ expiryLabel(row) }}</span>
            </template>
            <template v-else>{{ row[column] === '' ? '—' : (row[column] ?? '—') }}</template>
          </td>
          <td>
            <span :class="['expiry-badge', badgeClass(row)]">{{ watchLabel(row) }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!visibleRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无符合条件的仪器检定数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条仪器检定记录</span>
      <span v-if="successMessage" class="success-text">{{ successMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  linkedJobs,
  listExpiringCalibrations,
  listShipmentTodos,
  retryStuckJobs,
} from '@/api/calibration-service'
import { EXPIRY_LABELS, daysUntilExpiry, expiryState, isExpiryWatched } from '@/data/calibration'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('calibration')
const columns = ["记录编号", "仪器编号", "仪器名称", "检定单位", "检定日期", "有效期至", "检定结论", "检定状态"]
const allActions = ["送出检定", "确认合格", "标记不合格", "停用仪器"]
const statuses = ["待送检", "送检中", "已合格", "不合格", "已停用"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 4)
const activeTab = ref<'all' | 'expiring'>('all')

const expiringRows = computed(() => listExpiringCalibrations())
const shipmentTodos = computed(() => listShipmentTodos())
const stuckJobs = computed(() => linkedJobs().filter((job) => job.status !== 'done'))

const tabs = computed(() => [
  { key: 'all' as const, label: '全部记录', count: rows.value.length },
  { key: 'expiring' as const, label: '临期视图', count: expiringRows.value.length },
])

const visibleRows = computed(() =>
  activeTab.value === 'expiring'
    ? rows.value.filter((row) => isExpiryWatched(row))
    : rows.value,
)

const stats = computed(() => [
  {
    label: '待送检仪器',
    value: rows.value.filter((row) => String(row.status) === '待送检').length,
    warn: false,
  },
  {
    label: '检定中待验收',
    value: rows.value.filter((row) => String(row.status) === '送检中').length,
    warn: false,
  },
  {
    label: '已合格仪器',
    value: rows.value.filter((row) => String(row.status) === '已合格').length,
    warn: false,
  },
  {
    label: '不合格仪器',
    value: rows.value.filter((row) => String(row.status) === '不合格').length,
    warn: rows.value.some((row) => String(row.status) === '不合格'),
  },
  {
    label: '临期缺证仪器',
    value: expiringRows.value.length,
    warn: expiringRows.value.length > 0,
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function actionsFor(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === '待送检') {
    return ['送出检定']
  }
  if (status === '送检中') {
    return ['确认合格', '标记不合格']
  }
  if (status === '已合格' || status === '不合格') {
    return ['停用仪器']
  }
  return []
}

function badgeClass(row: EntryRow): string {
  return `expiry-${expiryState(row)}`
}

function expiryLabel(row: EntryRow): string {
  const value = row['有效期至']
  if (value === '' || value === undefined || value === null) {
    return '缺有效期'
  }
  const days = daysUntilExpiry(row)
  if (days === null) {
    return String(value)
  }
  if (days < 0) {
    return `${value}（已过期 ${Math.abs(days)} 天）`
  }
  if (days === 0) {
    return `${value}（今日到期）`
  }
  return `${value}（剩 ${days} 天）`
}

function watchLabel(row: EntryRow): string {
  if (String(row.status) === '已停用') {
    return '停用，不提醒'
  }
  return EXPIRY_LABELS[expiryState(row)]
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '仪器检定记录登记入口尚未接入审批流'
  successMessage.value = ''
}

function retryJobs() {
  errorMessage.value = ''
  const results = retryStuckJobs()
  const failed = results.filter((item) => !item.result.ok)
  if (failed.length === 0) {
    successMessage.value = results.length
      ? `断点任务已全部续跑完成，巡检核查项同步生成`
      : '没有待重试的任务'
  } else {
    errorMessage.value = failed.map((item) => item.result.message).join('；')
    successMessage.value = ''
  }
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '仪器检定列表读取失败'
  }
}

onMounted(reload)
</script>
