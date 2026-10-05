// 本地数据层的运行时自检：用内存版 localStorage 模拟浏览器，
// 覆盖幂等初始化、旧结构迁移补录、检定验收联动巡检、失败整批回退与断点重试。
// 运行：node scripts/check-local-data.mjs
import { build } from 'esbuild'
import assert from 'node:assert'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = join(mkdtempSync(join(tmpdir(), 'hydrology-check-')), 'entry.ts')
writeFileSync(
  entry,
  `
export * from '@/data/local-store'
export * from '@/api/calibration-service'
export * from '@/data/calibration'
export { SEED_ROWS } from '@/data/seed'
export { MODULES } from '@/data/modules'
`,
)

function makeEnv() {
  const store = new Map()
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value))
      // 模拟真实浏览器写入可能失败（配额/序列化异常），测试里可通过 shouldFailWrite 打开。
      if (globalThis.__failNextWrite) {
        globalThis.__failNextWrite = false
        throw new Error('QuotaExceededError: 模拟 localStorage 写入失败')
      }
    },
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  }
  globalThis.window = { localStorage }
  globalThis.localStorage = localStorage
  return { store, localStorage }
}

async function freshImport() {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    alias: { '@': join(process.cwd(), 'src') },
  })
  const code = result.outputFiles[0].text
  const dataUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64") + "#" + Math.random()
  return import(dataUrl)
}

let passed = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  ✓ ${name}`)
    })
}

// 1. 首次初始化播种 + 幂等
await check('首次初始化播种示例，重复初始化只生效一次', async () => {
  makeEnv()
  const mod = await freshImport()
  const first = mod.initLocalData()
  assert.equal(first.version, 2)
  assert.equal(first.rows.calibration.length, 9)
  assert.equal(first.jobs.length, 0)
  // 手动改一条数据，再初始化：已有数据必须原样保留，不重新播种
  mod.saveRows('calibration', [])
  const second = mod.initLocalData()
  assert.equal(second.rows.calibration.length, 0)
  // 清空后重新初始化（模拟部署前清库），回到全新播种
  globalThis.localStorage.clear()
  const third = mod.initLocalData()
  assert.equal(third.rows.calibration.length, 9)
})

// 2. 四类场景示例数据
await check('示例数据覆盖到期 / 临期 / 不合格 / 停用 / 缺有效期', async () => {
  makeEnv()
  const mod = await freshImport()
  mod.initLocalData()
  const expiring = mod.listExpiringCalibrations()
  const states = expiring.map((row) => mod.expiryState(row))
  assert.ok(states.includes('expired'), '应包含已过期')
  assert.ok(states.includes('expiring'), '应包含临期')
  assert.ok(states.includes('missing'), '应包含缺有效期')
  const all = mod.listRows('calibration')
  assert.ok(all.some((row) => row.status === '不合格'), '应包含不合格')
  assert.ok(all.some((row) => row.status === '已停用'), '应包含停用')
  // 停用的过期仪器不出现在临期视图
  assert.ok(!expiring.some((row) => row.status === '已停用'), '停用仪器不进临期视图')
  // 关键字段都是真实值，不再是占位符
  for (const row of all) {
    assert.ok(!/样例/.test(String(row['仪器编号'])))
    assert.ok(['省水文仪器计量检定站', '市计量测试研究院', '水利部水文仪器质量检验中心'].includes(row['检定单位']))
  }
  assert.ok(mod.listShipmentTodos().length >= 4, '送检待办应覆盖待送检与送检中')
})

// 3. v1 裸结构旧数据迁移：占位字段补录、缺字段补齐、新增场景追加
await check('旧版本地数据按新结构兼容，存量缺失补录且不覆盖真实值', async () => {
  const { localStorage } = makeEnv()
  // 模拟 v1：裸 record，检定 3 行占位数据；inspection 一行自定义数据
  const v1 = {
    calibration: [
      {
        id: 1,
        status: '待送检',
        pending: true,
        abnormal: false,
        记录编号: 'CALI-MY-001',
        仪器编号: 'MY-YQ-1',
        仪器名称: '我自己的流速仪',
        检定单位: '仪器检定样例1',
        检定日期: '2026-01-01',
        有效期至: '仪器检定样例1',
        检定结论: '仪器检定样例1',
        检定状态: '仪器检定样例1',
      },
    ],
    inspection: [
      {
        id: 1,
        status: '待巡检',
        pending: true,
        abnormal: false,
        记录编号: 'INSP-MY-1',
        站点编号: 'STAT-01',
        巡检日期: '2026-10-01',
        巡检人员: '张三',
        检查项目: '人工核查',
        发现问题: '无',
        处理措施: '无',
        巡检状态: '待巡检',
      },
    ],
  }
  localStorage.setItem('hydrology-monitor-station:entries', JSON.stringify(v1))
  const mod = await freshImport()
  const data = mod.initLocalData()
  const cali = data.rows.calibration
  // 存量行保留真实值
  const mine = cali.find((row) => row.id === 1)
  assert.equal(mine['仪器名称'], '我自己的流速仪')
  assert.equal(mine['记录编号'], 'CALI-MY-001')
  // 占位字段被新结构补录
  assert.ok(!/样例/.test(String(mine['检定单位'])), '检定单位占位符应被补录')
  assert.ok(!/样例/.test(String(mine['有效期至'])), '有效期至占位符应被补录')
  assert.equal(mine['检定状态'], '待送检')
  // 新增示例场景追加（不覆盖存量）
  assert.ok(cali.length > 1, '应追加新示例行')
  assert.ok(cali.some((row) => row.status === '不合格'))
  // 其他存量模块自定义行保留、不追加重复
  const insp = data.rows.inspection
  assert.equal(insp.find((row) => row.id === 1)['记录编号'], 'INSP-MY-1')
  // 重复初始化不重复追加
  mod.initLocalData()
  const again = mod.listRows('calibration')
  const ids = again.map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length, '迁移只执行一次，不重复追加')
})

// 4. 合格验收联动
await check('确认合格：检定结论落库并同步生成 3 个巡检核查项', async () => {
  makeEnv()
  const mod = await freshImport()
  mod.initLocalData()
  // id=5 是送检中
  const result = mod.acceptCalibration(5, 'qualified')
  assert.equal(result.ok, true, result.message)
  const cali = mod.listRows('calibration').find((row) => row.id === 5)
  assert.equal(cali.status, '已合格')
  assert.equal(cali['检定结论'], '合格')
  assert.match(String(cali['有效期至']), /^\d{4}-\d{2}-\d{2}$/)
  const inspections = mod.listRows('inspection').filter((row) => row['关联记录'] === 'CALI-2026-0005')
  assert.equal(inspections.length, 3)
  assert.ok(inspections.every((row) => row.status === '待巡检' && row.pending))
  // 重复验收被拒绝
  const again = mod.acceptCalibration(5, 'qualified')
  assert.equal(again.ok, false)
})

// 5. 不合格验收联动
await check('标记不合格：结论落库并生成 1 个隔离核查项，有效期清空', async () => {
  makeEnv()
  const mod = await freshImport()
  mod.initLocalData()
  // 先把 id=2（已合格临期）送回送检中以便走验收；直接造一条送检中行
  mod.saveRows('calibration', [
    ...mod.listRows('calibration').filter((row) => row.id !== 5),
    {
      id: 5,
      status: '送检中',
      pending: true,
      abnormal: false,
      记录编号: 'CALI-2026-0005',
      仪器编号: 'YQ-SL-0015',
      仪器名称: 'ADCP声学多普勒流速剖面仪',
      检定单位: '水利部水文仪器质量检验中心',
      检定日期: '2026-09-01',
      有效期至: '',
      检定结论: '',
      检定状态: '送检中',
    },
  ])
  const result = mod.acceptCalibration(5, 'rejected')
  assert.equal(result.ok, true, result.message)
  const cali = mod.listRows('calibration').find((row) => row.id === 5)
  assert.equal(cali.status, '不合格')
  assert.equal(cali.abnormal, true)
  assert.equal(cali['有效期至'], '')
  const inspections = mod.listRows('inspection').filter((row) => row['关联记录'] === 'CALI-2026-0005')
  assert.equal(inspections.length, 1)
  assert.equal(inspections[0].abnormal, true)
  assert.match(String(inspections[0]['检查项目']), /隔离与维修跟踪/)
})

// 6. 失败整批回退 + 断点重试
await check('联动失败整批回退，修复后从断点重试成功且不产生重复核查项', async () => {
  makeEnv()
  const mod = await freshImport()
  mod.initLocalData()
  const beforeCali = mod.listRows('calibration').find((row) => row.id === 5)
  const beforeInspCount = mod.listRows('inspection').length
  // 让第二次写 storage（commitBatch 那次）失败：persistJob 已先写了一次
  globalThis.__failNextWrite = false
  // persistJob 是第一次写；打开"再下一次写失败"开关：先让 persistJob 成功，再让 commitBatch 失败
  const realSetItem = globalThis.localStorage.setItem
  let writes = 0
  globalThis.localStorage.setItem = (key, value) => {
    writes += 1
    if (writes === 2) {
      throw new Error('QuotaExceededError: 模拟整批提交写入失败')
    }
    return realSetItem.call(globalThis.localStorage, key, value)
  }
  const result = mod.acceptCalibration(5, 'qualified')
  globalThis.localStorage.setItem = realSetItem
  assert.equal(result.ok, false, '写入失败时应返回失败')
  // 内存 cache 也必须回退（commitData 未执行）
  const cali = mod.listRows('calibration').find((row) => row.id === 5)
  assert.equal(cali.status, '送检中', '业务数据整批回退：仍是送检中')
  assert.equal(mod.listRows('inspection').length, beforeInspCount, '巡检模块不得留下半截核查项')
  assert.equal(beforeCali['记录编号'], 'CALI-2026-0005')
  // 任务断点已持久化（第一次写成功）
  const jobs = mod.linkedJobs()
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].status, 'failed')
  // 重新加载模块模拟刷新：断点任务仍在
  const mod2 = await freshImport()
  const results = mod2.retryStuckJobs()
  assert.equal(results.length, 1)
  assert.equal(results[0].result.ok, true, results[0].result.message)
  const cali2 = mod2.listRows('calibration').find((row) => row.id === 5)
  assert.equal(cali2.status, '已合格')
  const inspections = mod2.listRows('inspection').filter((row) => row['关联记录'] === 'CALI-2026-0005')
  assert.equal(inspections.length, 3, '断点重试只补缺失步骤，不重复生成')
  assert.equal(mod2.retryStuckJobs().length, 0, '完成后不再有待续跑任务')
  assert.equal(mod2.linkedJobs()[0].status, 'done')
})

// 7. 校验阶段失败（编号冲突）也整批回退
await check('核查项编号冲突时整批回退，不落下验收结论', async () => {
  makeEnv()
  const mod = await freshImport()
  mod.initLocalData()
  // 占用将生成的核查项编号 INSP-2026-0005-A
  const inspections = mod.listRows('inspection')
  mod.saveRows('inspection', [
    ...inspections,
    {
      id: inspections.length + 1,
      status: '待巡检',
      pending: true,
      abnormal: false,
      记录编号: 'INSP-2026-0005-A',
      站点编号: 'STAT-X',
      巡检日期: '2026-10-01',
      巡检人员: '李四',
      检查项目: '历史占用记录',
      发现问题: '',
      处理措施: '',
      巡检状态: '待巡检',
    },
  ])
  const result = mod.acceptCalibration(5, 'qualified')
  assert.equal(result.ok, false)
  const cali = mod.listRows('calibration').find((row) => row.id === 5)
  assert.equal(cali.status, '送检中', '冲突时验收结论也要回退')
  // 冲突解除后断点重试成功
  mod.saveRows('inspection', mod.listRows('inspection').filter((row) => row['记录编号'] !== 'INSP-2026-0005-A'))
  const retried = mod.retryStuckJobs()
  assert.equal(retried.length, 1)
  assert.equal(retried[0].result.ok, true, retried[0]?.result.message)
  assert.equal(mod.listRows('calibration').find((row) => row.id === 5).status, '已合格')
})

console.log(`\n全部 ${passed} 项自检通过`)
