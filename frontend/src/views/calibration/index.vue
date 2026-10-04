<template>
  <section class="page" data-module="calibration">
    <header class="page-head">
      <div>
        <h2>仪器检定管理</h2>
        <p class="page-desc">维护仪器检定记录，围绕记录编号、仪器编号、仪器名称、检定单位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记仪器检定记录</button>
        <button class="btn" type="button" @click="exportRows">导出仪器检定清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="board-row">
      <section class="board-panel">
        <h3>临期视图</h3>
        <p class="panel-desc">有效期已过或 {{ expiringDays }} 天内到期的在用仪器</p>
        <ul class="panel-list">
          <li v-for="item in board.expiring" :key="String(item.row.id)">
            <span class="panel-main">
              {{ item.row['仪器编号'] }} · {{ item.row['仪器名称'] }}（有效期至 {{ item.row['有效期至'] }}）
            </span>
            <span class="panel-side">
              <em :class="['due-tag', item.state === '已到期' ? 'overdue' : 'soon']">
                {{ item.state === '已到期' ? `已超期 ${Math.abs(item.daysLeft ?? 0)} 天` : `剩 ${item.daysLeft ?? 0} 天` }}
              </em>
              <button class="link" type="button" @click="runAction('送出检定', item.row)">送出检定</button>
            </span>
          </li>
          <li v-if="!board.expiring.length" class="panel-empty">暂无临期或到期仪器</li>
        </ul>
      </section>

      <section class="board-panel">
        <h3>送检待办</h3>
        <p class="panel-desc">待送检新仪器与到期需复检仪器</p>
        <ul class="panel-list">
          <li v-for="row in board.todos" :key="String(row.id)">
            <span class="panel-main">
              {{ row['仪器编号'] }} · {{ row['仪器名称'] }}
              <small>{{ row.status === '待送检' ? '新仪器待首次送检' : `有效期至 ${row['有效期至'] || '未登记'}` }}</small>
            </span>
            <span class="panel-side">
              <button class="link" type="button" @click="runAction('送出检定', row)">送出检定</button>
            </span>
          </li>
          <li v-if="!board.todos.length" class="panel-empty">送检待办已清空</li>
        </ul>
      </section>

      <section class="board-panel">
        <h3>检定验收</h3>
        <p class="panel-desc">已送出待验收结论的记录，验收后进入合格或不合格</p>
        <ul class="panel-list">
          <li v-for="row in board.accepting" :key="String(row.id)">
            <span class="panel-main">
              {{ row['仪器编号'] }} · {{ row['仪器名称'] }}
              <small>{{ row['检定单位'] || '检定单位未登记' }} · 送出 {{ row['检定日期'] || '—' }}</small>
            </span>
            <span class="panel-side">
              <button class="link" type="button" @click="runAction('确认合格', row)">验收合格</button>
              <button class="link danger" type="button" @click="runAction('标记不合格', row)">验收不合格</button>
            </span>
          </li>
          <li v-if="!board.accepting.length" class="panel-empty">暂无待验收的送检记录</li>
        </ul>
      </section>
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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无仪器检定数据，可先登记仪器检定记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条仪器检定记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  calibrationBoard,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { CALIBRATION_EXPIRING_DAYS } from '@/data/calibration'
import type { CalibrationBoard } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('calibration')
const columns = ["记录编号", "仪器编号", "仪器名称", "检定单位", "检定日期", "有效期至", "检定结论", "检定状态"]
const actions = ["送出检定", "确认合格", "标记不合格"]
const statuses = ["待送检", "送检中", "已合格", "不合格", "已停用"]
const stats = [{"label": "待送检仪器", "value": 0}, {"label": "已合格仪器", "value": 0}, {"label": "不合格仪器", "value": 0}]
const expiringDays = CALIBRATION_EXPIRING_DAYS

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const board = ref<CalibrationBoard>({ expiring: [], todos: [], accepting: [] })
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '仪器检定记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    board.value = calibrationBoard()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '仪器检定列表读取失败'
  }
}

onMounted(reload)
</script>
