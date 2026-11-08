import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    // 取三端 WebView / Electron 的最低公共集：esnext 在旧安卓 WebView 上直接语法报错白屏
    target: 'es2019',
    // 主包本就接近 1MB，默认 500KB 告警形同虚设；收到 350KB 让新增大依赖立刻显形
    chunkSizeWarningLimit: 350,
    // 三端都以包体积为先，调试走 dev 构建
    sourcemap: false,
  },
  // Worker 用 ESM：ZIP Worker 间接引用导出层（含 Capacitor 插件），iife 不支持代码分割
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
