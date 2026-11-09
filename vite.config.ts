import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 构建期把 `inset` 简写展开成 top / right / bottom / left 四边。
 *
 * 为什么必须做：iQOO / vivo（OriginOS）的 WebView 被系统冻结在 Chromium 83
 * （实测 83.0.4103.106），而 `inset` 需要 Chrome 87 —— 引擎会判定整条声明
 * 非法并丢弃。`position: fixed` 的容器随即退回「静态位置 + 收缩包裹内容」，
 * 表现为：设置面板不铺满、遮罩 0×0 消失、列表底部露出聊天输入条。
 * 完整证据见《安卓UI错位-排查日志.md》。
 *
 * 安全性：展开后对新引擎输出等价（360×780 与 1920×1080 两种视口逐像素比对过），
 * 老引擎才算真正拿到四边定位，属于纯增量兼容。
 *
 * 实现说明：不用 `css.postcss.plugins`（Vite 7 下这个内联入口没有生效，
 * 产物里的 inset 一个没少），改为在 generateBundle 里改写最终 CSS 资产 ——
 * 位置确定、只看字符串，不依赖 PostCSS 的加载链路。
 */
const INSET_RE = /(?<![-\w])inset\s*:\s*([^;}]+)([;}])/g

function expandInsetCss(css: string): string {
  return css.replace(INSET_RE, (whole, value: string, tail: string) => {
    const parts = String(value).trim().split(/\s+/)
    if (parts.length === 0 || parts.length > 4) return whole
    // 1 值→四边同值；2 值→上下/左右；3 值→上/左右/下；4 值→上右下左
    const [top, right = top, bottom = top, left = right] = parts
    return `top:${top};right:${right};bottom:${bottom};left:${left}${tail}`
  })
}

/**
 * 注意：**不在这里处理 flex gap**。
 *
 * Chromium 83 同样不支持 flex 容器的 `gap`，但静态改写试过且被证伪：
 *   · `.pn-row` 的首个子元素是 `position:absolute` 的装饰层，`> * + *`
 *     会把真正的第一个内容块也加上 margin，整行内容位移 17px；
 *   · 桌面 `gap:17px` 与移动端 `@media` 里的 `gap:8px` 是两条规则，
 *     静态展开只能保留一条，另一条场景下数值就是错的。
 * 现在改由 src/utils/legacyGap.ts 在运行时读计算值补 margin
 * （跳过绝对定位子元素、媒体查询已生效），构建期只做 inset 展开。
 */
function bakerExpandInset() {
  return {
    name: 'baker:expand-inset',
    apply: 'build' as const,
    generateBundle(_options: unknown, bundle: Record<string, any>) {
      for (const asset of Object.values(bundle)) {
        if (asset?.type !== 'asset' || !String(asset.fileName).endsWith('.css')) continue
        const src = asset.source
        const text = typeof src === 'string' ? src : new TextDecoder().decode(src)
        asset.source = expandInsetCss(text)
      }
    },
  }
}

export default defineConfig({
  plugins: [bakerExpandInset(), vue()],
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
