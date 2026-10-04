// 初始化管线自检：不依赖浏览器，用内存 localStorage 跑四个场景——
// 1. 全新初始化：种子+迁移+巡检核查项生成；
// 2. 重复初始化只生效一次；
// 3. 旧结构本地数据兼容（占位符/缺失字段补录）；
// 4. 步骤失败整批回退，修复后从断点步骤重试。
// 构建前（prebuild）会自动跑一遍，也可手动执行：npm run check:bootstrap
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.tmp', 'bootstrap-check')
const DATA_FILES = ['types', 'seed', 'calibration', 'local-store', 'bootstrap']

function compileDataLayer() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const name of DATA_FILES) {
    const source = readFileSync(join(root, 'src', 'data', `${name}.ts`), 'utf8')
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: `${name}.ts`,
    })
    writeFileSync(join(outDir, `${name}.js`), output.outputText)
  }
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }))
}

function createMemoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const isDate = (value) => typeof value === 'string' && DATE_PATTERN.test(value)

let failures = 0
function check(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}

compileDataLayer()
const localStore = require(join(outDir, 'local-store.js'))
const bootstrap = require(join(outDir, 'bootstrap.js'))

const ENTRIES_KEY = localStore.storageKey()

function resetEnv(preset) {
  const storage = createMemoryStorage()
  if (preset) {
    storage.setItem(ENTRIES_KEY, JSON.stringify(preset))
  }
  globalThis.window = { localStorage: storage }
  localStore.__resetCacheForTest()
  return storage
}

const listCalibration = () => localStore.listRows('calibration')
const listInspection = () => localStore.listRows('inspection')
const checkItemNos = () => new Set(listInspection().map((row) => String(row['记录编号'])).filter((no) => no.startsWith('INSP-INST')))

// ---------- 场景 1：全新初始化 ----------
console.log('场景 1：清空数据库后全新初始化')
resetEnv()
const first = bootstrap.bootstrapLocalData()
check('初始化成功', first.ok && !first.alreadyDone)
const calibration = listCalibration()
check('检定记录 7 条（覆盖正常/临期/到期/送检中/不合格/停用/缺有效期）', calibration.length === 7)
check(
  '有效期至均可回放（合法日期或明确留空）',
  calibration.every((row) => row['有效期至'] === '' || isDate(row['有效期至'])),
)
check(
  '仪器编号/检定单位/检定结论无占位符',
  calibration.every(
    (row) =>
      String(row['仪器编号']).startsWith('INST-') &&
      !String(row['检定单位']).includes('样例') &&
      !String(row['检定结论']).includes('样例'),
  ),
)
check('覆盖到期场景', calibration.some((row) => isDate(row['有效期至']) && row['有效期至'] < '2026-10-04' && row.status === '已合格'))
check('覆盖不合格场景', calibration.some((row) => row.status === '不合格' && row['检定结论'] === '不合格'))
check('覆盖停用场景', calibration.some((row) => row.status === '已停用'))
check('覆盖缺有效期场景', calibration.some((row) => row['有效期至'] === ''))
const expectedChecks = ['INSP-INST-SW-002', 'INSP-INST-LS-003', 'INSP-INST-YP-004', 'INSP-INST-SZ-005', 'INSP-INST-ZL-007']
const generated = checkItemNos()
check('巡检模块同步生成 5 条核查项（临期/到期/缺有效期/不合格）', expectedChecks.every((no) => generated.has(no)))
check('停用与有效期内仪器不生成核查项', !generated.has('INSP-INST-NI-006') && !generated.has('INSP-INST-LS-001'))
check('初始化状态已记录版本与步骤检查点', bootstrap.bootstrapState().version === bootstrap.SCHEMA_VERSION && Boolean(bootstrap.bootstrapState().steps.calibration) && Boolean(bootstrap.bootstrapState().steps.inspection))

// ---------- 场景 2：重复初始化只生效一次 ----------
console.log('场景 2：重复初始化只生效一次')
const inspectionCount = listInspection().length
const second = bootstrap.bootstrapLocalData()
check('第二次初始化报告已生效', second.ok && second.alreadyDone)
check('检定记录数不变', listCalibration().length === 7)
check('核查项不重复生成', listInspection().length === inspectionCount)

// ---------- 场景 3：旧结构本地数据兼容 ----------
console.log('场景 3：旧本地数据按新结构兼容（占位符补录）')
const oldRow = (id, status) => ({
  id,
  status,
  pending: true,
  abnormal: false,
  记录编号: `CALI-${String(id).padStart(4, '0')}`,
  仪器编号: `CALI-${String(id).padStart(4, '0')}`,
  仪器名称: `仪器检定样例${id}`,
  检定单位: `仪器检定样例${id}`,
  检定日期: '2026-09-01',
  有效期至: `仪器检定样例${id}`,
  检定结论: `仪器检定样例${id}`,
  检定状态: `仪器检定样例${id}`,
})
resetEnv({
  calibration: [oldRow(1, '待送检'), oldRow(2, '送检中'), oldRow(3, '已合格')],
  inspection: [],
})
const third = bootstrap.bootstrapLocalData()
check('旧数据初始化成功', third.ok)
const migrated = listCalibration()
check('旧记录保留 3 条且不丢状态', migrated.length === 3 && migrated[2].status === '已合格')
check('仪器编号补录为 INST- 序列', migrated.every((row) => /^INST-\d{4}$/.test(String(row['仪器编号']))))
check('检定单位占位符已补录', migrated.every((row) => !String(row['检定单位']).includes('样例') && String(row['检定单位']).length > 0))
check('已合格记录补录合法有效期', isDate(migrated[2]['有效期至']) && migrated[2]['检定结论'] === '合格')
check('待送检记录保留缺有效期（不虚构日期）', migrated[0]['有效期至'] === '' && migrated[0]['检定结论'] === '待检')
check('检定状态字段与当前状态对齐', migrated.every((row) => row['检定状态'] === row.status))
const migratedChecks = checkItemNos()
check('旧数据同步生成缺有效期核查项', migratedChecks.has('INSP-INST-0001') && migratedChecks.has('INSP-INST-0002'))
check('补录后有效的仪器不生成核查项', !migratedChecks.has('INSP-INST-0003'))

// ---------- 场景 4：失败整批回退 + 断点重试 ----------
console.log('场景 4：巡检生成失败整批回退，修复后从断点重试')
resetEnv()
const failed = bootstrap.bootstrapLocalData({ failStep: 'inspection' })
check('注入失败被捕获并报告失败步骤', !failed.ok && failed.failedStep === 'inspection')
check('失败步骤整批回退（无残留核查项）', checkItemNos().size === 0)
check('已完成的检定迁移检查点保留', Boolean(bootstrap.bootstrapState().steps.calibration))
check('失败的巡检步骤未提交检查点', !bootstrap.bootstrapState().steps.inspection)
const retried = bootstrap.bootstrapLocalData()
check('重试成功且从断点步骤续跑', retried.ok)
check('重试后核查项生成且未重复', checkItemNos().size === 5 && listInspection().filter((row) => String(row['记录编号']).startsWith('INSP-INST')).length === 5)
check('重试后状态记录为最新版本', bootstrap.bootstrapState().version === bootstrap.SCHEMA_VERSION && !bootstrap.bootstrapState().failedStep)

if (failures > 0) {
  console.error(`\n初始化自检未通过：${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n初始化自检通过：4 个场景全部符合预期')
