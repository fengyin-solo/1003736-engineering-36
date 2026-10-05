# 水文监测站网管理系统

面向水文监测站点运行、水位流量雨量数据采集、遥测设备维护与数据整编发布的水文站网管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：应用启动时执行一次幂等的部署前初始化（`bootstrapLocalData`），
首次打开用示例数据播种，之后的登记、筛选与状态流转结果都持久化在浏览器 `localStorage` 里，
刷新或重开浏览器都还在。本地数据带结构版本号（当前 v2），旧版本地数据会自动按新结构迁移：
缺失模块补示例、存量行缺失或占位字段补录、真实数据不覆盖，迁移只执行一次。dev server 已关掉
自动打开页面，启动后按终端打印的地址手工打开。

跨平台构建：esbuild/rollup 的 linux arm64/x64（gnu/musl）原生二进制已登记在
`frontend/package.json` 的 `optionalDependencies` 并写入 lockfile，在 macOS 上装过依赖再拿到
Linux（含 `node:20-alpine` 容器）构建也不会缺平台包。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 监测站点 | `station` | 水文监测站 | 站点编号、站点名称、站点类型 |
| 水位监测 | `waterlevel` | 水位记录 | 记录编号、站点编号、观测时间 |
| 流量监测 | `discharge` | 流量记录 | 记录编号、站点编号、测量方法 |
| 雨量观测 | `rainfall` | 雨量记录 | 记录编号、站点编号、观测时段 |
| 水质检测 | `waterquality` | 水质检测报告 | 报告编号、采样站点、采样时间 |
| 断面测量 | `crosssection` | 断面测量记录 | 记录编号、站点编号、断面名称 |
| 遥测设备 | `telemetry` | 遥测设备 | 设备编号、设备类型、所属站点 |
| 数据整编 | `compilation` | 整编成果 | 成果编号、整编年份、站点编号 |
| 预警阈值 | `warning` | 预警阈值配置 | 配置编号、站点编号、监测类型 |
| 地下水观测 | `groundwater` | 地下水观测记录 | 记录编号、井点编号、观测日期 |
| 蒸发观测 | `evaporation` | 蒸发观测记录 | 记录编号、站点编号、观测日期 |
| 测流缆道 | `cableway` | 测流缆道 | 缆道编号、所属站点、跨度米数 |
| 泥沙监测 | `sediment` | 泥沙监测记录 | 记录编号、站点编号、采样时间 |
| 通讯系统 | `communication` | 通讯设备 | 设备编号、设备类型、所属站点 |
| 站房维护 | `stationhouse` | 站房维护记录 | 记录编号、站点编号、维护类型 |
| 仪器检定 | `calibration` | 仪器检定记录 | 记录编号、仪器编号、仪器名称 |
| 巡检记录 | `inspection` | 巡检记录 | 记录编号、站点编号、巡检日期 |
| 测报方案 | `plan` | 测报方案 | 方案编号、方案名称、适用范围 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `hydrology-monitor-station:entries` 这一项，或调用 `resetModule(模块)`。

## 仪器检定与巡检联动

仪器检定示例数据（`seed.ts`）按相对今天的日期动态生成，覆盖五种必须可重放的场景：
已过期待送检、30 天内临期、缺有效期、不合格、已停用（停用不进临期视图）。

- 临期视图 / 送检待办：`src/data/calibration.ts` 做到期判定（30 天窗口），
  `src/api/calibration-service.ts` 提供 `listExpiringCalibrations` 与 `listShipmentTodos`。
- 验收流程：`送出检定 → 送检中 → 确认合格/标记不合格`。只有「送检中」能验收；
  合格时自动写入新的检定日期、一年后有效期与「合格」结论；不合格清空有效期并标记异常。
- 验收与巡检联动：验收动作通过 `src/api/calibration-service.ts` 的断点任务执行——
  检定结论落库与巡检模块生成核查项（合格生成外观/零点/首月比测 3 项，不合格生成隔离返修 1 项）
  在同一笔 `commitBatch` 整批提交，任一步失败草稿整体丢弃（整批回退），任务断点（stage/attempts/lastError）
  持久化在本地数据的 `jobs` 中；应用启动与页面上的「从断点重试」会续跑，已完成步骤幂等跳过，
  不产生重复核查项。同步生成的核查项在巡检记录页「检定联动核查项」视图里查看。

数据层自检（幂等初始化、旧数据迁移补录、验收联动、失败回退与断点重试）：

```bash
cd frontend
npm run check:data
```
