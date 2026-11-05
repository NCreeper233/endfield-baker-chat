import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    // 语法目标取三端 WebView/Electron 的最低公共集:esnext 产物在旧安卓
    // WebView 上会直接语法报错(白屏),es2019 由构建期降级、运行时零成本。
    target: 'es2019',
    // 体积告警阈值:主包本就接近 1MB,默认 500KB 的告警形同虚设;
    // 收到 350KB 后任何新增大依赖都会在构建日志里立刻显形。
    chunkSizeWarningLimit: 350,
    // 生产包不带 sourcemap:三端都以包体积/安装包大小为先,调试走 dev 构建。
    sourcemap: false,
  },
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
