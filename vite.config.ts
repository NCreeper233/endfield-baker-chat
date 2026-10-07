import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  // Worker 用 ESM 输出：ZIP 打包 Worker 会间接引用导出层（含 Capacitor 插件），
  // 而 iife（Vite 旧默认）不支持代码分割构建 —— 2026-09-29 构建报
  // "Invalid value iife for option worker.format" 就是这么来的。
  worker: {
    format: 'es',
  },
  server: {
    watch: {
      // 忽略编辑器/工具原子保存产生的临时目录与临时文件
      // (如 .App.vue.2424.xxx.tmpdir/App.vue.tmp),避免 chokidar
      // 在 Windows 上 watch 到被锁/瞬时的文件触发 EBUSY 崩溃
      ignored: [
        '**/.*.tmpdir/**',
        '**/.*.tmp',
        '**/*.tmp',
        '**/node_modules/**',
        '**/.git/**',
      ],
    },
  },
})
