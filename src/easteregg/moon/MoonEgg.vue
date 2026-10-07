<script setup lang="ts">
// =============================================================================
// ⛔ 临时彩蛋:月亮(门控壳)
// -----------------------------------------------------------------------------
// 这不是产品功能,是一颗**临时彩蛋**,日后要能一锅端掉。所以它只存在于三处:
//   1. src/easteregg/moon/        —— 本文件 + MoonViewer.vue + redeem.ts + README.md
//   2. public/easteregg/moon/     —— 模型 moon_small.glb + draco 解码器
//   3. 产品代码里两处带 ⛔ 标记的接线:
//        · App.vue            —— 一行 import + 一行 <MoonEgg />
//        · SettingsDialog.vue —— 关于页那个"兑换码"区块(输入框 + 绿色小字)
// 删除步骤照抄同目录 README.md,不牵连任何其它文件。
//
// 出场条件(两个都满足才渲染):
//   1. 在关于页输入兑换码「中秋快乐」兑换成功(状态在 redeem.ts,只在内存里,
//      刷新即失效 —— 刷新后月亮消失,要重新兑换);
//   2. 开屏动画已经放完(判据是开屏遮罩 .splash-overlay 从 DOM 里消失;
//      2.1 的 <SplashOverlay> 是自管理的,App 里没接它的 complete 事件,
//      为了不在产品代码上多开一刀,这里直接盯 DOM)。
//
// **下载时机**:月亮本体(three + cannon-es + glb + draco)是异步组件,而且只在
// 上面两个条件都成立后才被渲染 —— 动态 import 因此发生在兑换成功的瞬间。
// 光进页面、光打开关于页都不会请求这些资源(见 redeem.ts 的约定 2)。
//
// 形态:**融进网站的一层浮层** —— 整层 `pointer-events: none`,鼠标/手指照常穿到
// 下面的网站上,只有真点在月亮上时那一串手势才被月亮接管(命中测试在 MoonViewer 里)。
// 所以它不挡操作、不需要关闭按钮、也没有背景与文字。
// =============================================================================
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { moonRedeemed } from './redeem'

/** 月亮本体(异步:three / cannon-es 独立 chunk,兑换成功那一刻才下载) */
const MoonViewer = defineAsyncComponent(() => import('./MoonViewer.vue'))

/** 开屏动画是否已放完 */
const splashDone = ref(false)

/** 是否该显示:兑换成功 + 开屏结束 */
const visible = computed(() => moonRedeemed.value && splashDone.value)

// ---- 开屏动画结束的判定 ----------------------------------------------------

/** 开屏遮罩的类名(见 components/splash/SplashOverlay.vue) */
const SPLASH_SELECTOR = '.splash-overlay'

/**
 * 兜底时长(ms)
 *
 * 开屏自己有多重兜底(2.2s 起 +1.3s / +5s),正常最迟约 7.2s 收尾。
 * 万一它因为异常没能移除遮罩,也不能把彩蛋永久扣着 —— 到点直接出场。
 */
const FALLBACK_MS = 12000

let observer: MutationObserver | null = null
let fallbackTimer: number | undefined

/** 记下"开屏已结束"并收掉监听(与兑换状态无关,只负责这一件事) */
function markSplashDone(): void {
  if (splashDone.value) return
  splashDone.value = true
  observer?.disconnect()
  observer = null
  if (fallbackTimer !== undefined) {
    window.clearTimeout(fallbackTimer)
    fallbackTimer = undefined
  }
}

onMounted(() => {
  // 开屏已经放完(或这个构建里根本没有开屏)→ 直接放行
  if (!document.querySelector(SPLASH_SELECTOR)) {
    markSplashDone()
    return
  }
  observer = new MutationObserver(() => {
    if (!document.querySelector(SPLASH_SELECTOR)) markSplashDone()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  fallbackTimer = window.setTimeout(markSplashDone, FALLBACK_MS)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
})
</script>

<template>
  <!-- 整层铺满窗口但点得穿(pointer-events: none;月亮自己那条命中路径在 MoonViewer 里)。
       条件不满足时这里**什么都不渲染** —— MoonViewer 是异步组件,不渲染就不会
       触发动态 import,three / cannon-es / glb / draco 一个字节都不下载。 -->
  <div v-if="visible" class="moon-egg" aria-hidden="true">
    <MoonViewer />
  </div>
</template>

<style scoped>
.moon-egg {
  position: fixed;
  inset: 0;
  /* 压在网站内容之上(能看到月亮),但低于设置等弹窗(200)与底部浮条(180):
     开弹窗时月亮自动退到后面去,不跟界面抢注意力 */
  z-index: 150;
  /* 关键:整层不吃事件 —— 点击/滚动/长按照常落到下面的网站上。
     只有指针真的压在月亮上时,那一串手势才会被月亮接管(见 MoonViewer 的命中测试) */
  pointer-events: none;
}
</style>
