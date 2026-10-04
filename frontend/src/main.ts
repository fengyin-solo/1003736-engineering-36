import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { bootstrapLocalData } from './data/bootstrap'
import './styles/global.css'

// 部署前初始化：迁移/补录本地数据并同步生成巡检核查项。
// 失败时数据已整批回退，下次启动会从断点步骤自动重试。
const boot = bootstrapLocalData()
if (!boot.ok) {
  console.error(`本地数据初始化未完成：${boot.message ?? ''}`)
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
