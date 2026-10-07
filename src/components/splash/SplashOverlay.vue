<script setup lang="ts">
// =============================================================================
// SplashOverlay.vue —— 开屏动画(移植自 evercall-main1 LoadingCover)
// Endfield 风格:左侧垂直进度条 + 中央 Logo + 状态文字,完成时黄屏扫过淡出
// 进度在 minDuration(默认 2.2s)内平滑推进到 100%,随后自动淡出移除。
// =============================================================================
import { ref, onMounted, onUnmounted } from 'vue'
import splashLogo from '../../assets/splash/logo.webp'

const props = withDefaults(
  defineProps<{
    /** 最短展示时长(毫秒),进度到达 100% 前至少播放这么久 */
    minDuration?: number
  }>(),
  { minDuration: 2200 },
)

const emit = defineEmits<{ (e: 'complete'): void }>()

const isVisible = ref(true)
const phase = ref<'init' | 'loading' | 'complete' | 'sweeping' | 'fadeout'>('init')
const displayProgress = ref(0)

let rafId = 0
let timers: ReturnType<typeof setTimeout>[] = []
let completed = false
let visibilityHandler: (() => void) | null = null

function clearTimers() {
  timers.forEach((t) => clearTimeout(t))
  timers = []
}

onMounted(() => {
  // 锁定页面滚动
  document.body.style.overflow = 'hidden'

  // init → loading(短暂延迟后)
  timers.push(
    setTimeout(() => {
      phase.value = 'loading'
    }, 100),
  )

  const startTime = performance.now()

  /**
   * 统一完成序列:置满进度 → complete → sweeping → fadeout → 移除遮罩。
   *
   * 关键:正常(rAF)路径与兜底路径必须共用本函数。
   * 旧实现中兜底分支只设置 phase='complete',不执行后续扫过/淡出,
   * 一旦 rAF 因"切后台被暂停/网络卡顿"未走到 100%,动画就永久卡在 100%。
   */
  const finishSequence = () => {
    if (completed) return
    completed = true
    displayProgress.value = 100
    emit('complete')
    phase.value = 'complete'
    timers.push(
      setTimeout(() => {
        phase.value = 'sweeping'
        timers.push(
          setTimeout(() => {
            phase.value = 'fadeout'
            timers.push(setTimeout(() => {
              isVisible.value = false
              document.body.style.overflow = ''
            }, 300))
          }, 400),
        )
      }, 100),
    )
  }

  // rAF 平滑进度:在 minDuration 内推进到 100%
  const animate = () => {
    const elapsed = performance.now() - startTime
    const ratio = Math.min(1, elapsed / props.minDuration)
    // easeOutCubic 缓动,开头快结尾慢
    const eased = 1 - Math.pow(1 - ratio, 3)
    displayProgress.value = Math.round(eased * 100)
    if (displayProgress.value >= 100) {
      finishSequence()
      return
    }
    rafId = requestAnimationFrame(animate)
  }
  rafId = requestAnimationFrame(animate)

  // 兜底一:minDuration + 1.3s 仍未完成(rAF 被后台暂停等)→ 走完整完成序列
  timers.push(setTimeout(finishSequence, props.minDuration + 1300))
  // 兜底二:更长的绝对保险,避免任何异常导致遮罩残留
  timers.push(setTimeout(finishSequence, props.minDuration + 5000))

  // 回到前台时补检:后台期间 rAF 被暂停,若已超时立即完成(移动端/WebView 关键)
  const onVisibility = () => {
    if (document.visibilityState === 'visible' && !completed) {
      if (performance.now() - startTime >= props.minDuration) finishSequence()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)
  visibilityHandler = onVisibility
})

onUnmounted(() => {
  cancelAnimationFrame(rafId)
  clearTimers()
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
  document.body.style.overflow = ''
})
</script>

<template>
  <div
    v-if="isVisible"
    class="splash-overlay"
    :class="{
      'splash-sweeping': phase === 'sweeping',
      'splash-fadeout': phase === 'fadeout',
    }"
    :style="{
      '--progress': `${displayProgress}%`,
      '--progress-num': displayProgress,
    }"
  >
    <!-- 左侧垂直进度条 -->
    <div class="splash-progress-container">
      <div class="splash-progress-fill" />
    </div>

    <!-- 中央 Logo -->
    <div class="splash-center">
      <img :src="splashLogo" alt="Loading" class="splash-logo" />
      <div class="splash-site-name">//BAKER/</div>
    </div>

    <!-- 进度信息 -->
    <div class="splash-progress-info">
      <div class="splash-percent">{{ displayProgress }}%</div>
      <div class="splash-status-line">
        <span class="splash-status-dot" />
        <span class="splash-status-text">
          {{ phase === 'init' ? 'INITIALIZING' : '' }}
          {{ phase === 'loading' ? 'LOADING' : '' }}
          {{ phase === 'complete' ? 'READY' : '' }}
          {{ phase === 'sweeping' ? 'LAUNCHING' : '' }}
          {{ phase === 'fadeout' ? 'WELCOME' : '' }}
        </span>
      </div>
    </div>

    <!-- 扫屏覆盖层 -->
    <div class="splash-sweep" />
  </div>
</template>
