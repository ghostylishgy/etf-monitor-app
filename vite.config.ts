import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path' // <-- 新增：导入 path 模块

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  /* --- 我们新添加的配置在这里 --- */
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  /* --- 添加结束 --- */
})