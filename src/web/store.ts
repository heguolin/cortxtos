import { reactive } from 'vue'

/** 跨页轻量总线：仪表盘快捷提问 → 对话页自动发送 */
export const bus = reactive<{ ask: string }>({ ask: '' })
