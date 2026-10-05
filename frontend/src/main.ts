import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { bootstrapLocalData } from '@/api/local-service'
import { retryStuckJobs } from '@/api/calibration-service'
import './styles/global.css'

// 部署前初始化：幂等播种示例数据；旧版本地数据按新结构迁移兼容。
bootstrapLocalData()
// 上次会话中断的跨模块联动任务，从断点继续重试（已完成步骤幂等跳过）。
retryStuckJobs()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
