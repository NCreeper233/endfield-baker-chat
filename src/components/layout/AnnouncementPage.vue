<script setup lang="ts">
// AnnouncementPage —— 全屏公告页：「公告」左日期列表 + 右正文，「关于」铺满正文区
// 移动端退化为列表 → 详情两级。条目来自 constants/announcements，群与链接来自 constants/contact。
// 只做展示，打开/关闭由 App 持有。
import { computed, ref, watch } from 'vue'

import { ANNOUNCEMENTS, type AnnouncementEntry } from '../../constants/announcements'
import { QQ_GROUPS, PROJECT_LINKS } from '../../constants/contact'
import { MATERIALS } from '../../constants/materials'
import { copyText } from '../../utils/clipboard'
import { useAnnouncementRead } from '../../composables/useAnnouncementRead'
import { isMobileView } from '../../composables/useMobile'

const props = withDefaults(
  defineProps<{
    /** 是否显示 */
    open: boolean
    /** 公告条目(默认取内置常量;留出 prop 便于将来接服务端数据) */
    entries?: AnnouncementEntry[]
  }>(),
  { entries: () => ANNOUNCEMENTS },
)

const emit = defineEmits<{
  (e: 'close'): void
}>()

/** 当前分类页签 */
type PageTab = 'log' | 'about'
const tab = ref<PageTab>('log')

// 未读提醒
// 规则:没点开过的公告挂 NEW 角标;只要还有未读,「公告」页签右上角挂橙点。
const { isRead, markRead, hasUnreadOf } = useAnnouncementRead()

/** 展示顺序:置顶条目永远排在最前,其余保持常量里的原顺序 */
const sortedEntries = computed<AnnouncementEntry[]>(() => {
  const list = props.entries
  return [...list.filter((e) => e.pinned), ...list.filter((e) => !e.pinned)]
})

/** 当前所有公告 id(判断"还有没有未读"用) */
const entryIds = computed(() => sortedEntries.value.map((e) => e.id))

/** 是否还有未读公告(页签橙点) */
const tabHasUnread = computed(() => hasUnreadOf(entryIds.value))

/** 当前选中的公告 id */
const activeId = ref<string>(sortedEntries.value[0]?.id ?? '')

/** 移动端:是否已进入详情(桌面端两栏同时显示,不参与判断) */
const mobileDetail = ref(false)

// 每次打开都回到"列表 + 第一条"
watch(
  () => props.open,
  (open) => {
    if (!open) return
    tab.value = 'log'
    mobileDetail.value = false
    if (!sortedEntries.value.some((e) => e.id === activeId.value)) {
      activeId.value = sortedEntries.value[0]?.id ?? ''
    }
  },
)

// 条目被替换(将来接服务端)时,把选中项收敛到合法范围
watch(
  () => props.entries,
  () => {
    if (!sortedEntries.value.some((e) => e.id === activeId.value)) {
      activeId.value = sortedEntries.value[0]?.id ?? ''
    }
  },
)

/** 当前公告 */
const active = computed<AnnouncementEntry | undefined>(
  () => sortedEntries.value.find((e) => e.id === activeId.value) ?? sortedEntries.value[0],
)

/**
 * 选中一条公告
 *
 * 点开即视为"已读":该条 NEW 角标消失;全部点过之后页签橙点也会消失。
 * (自动选中的第一条不算已读 —— 规则是"点过才消失")
 */
function pick(id: string): void {
  activeId.value = id
  mobileDetail.value = true
  markRead(id)
}

/** 日期里的「日」 */
function dayOf(date: string): string {
  return date.slice(8, 10) || '--'
}

/** 日期里的「月」 */
function monthOf(date: string): string {
  const m = Number(date.slice(5, 7))
  return Number.isFinite(m) && m > 0 ? `${m}月` : ''
}

/** 正文分块:空行分段,「· 」开头的连续行成列表,「【…】」成小标题 */
interface ContentBlock {
  kind: 'p' | 'ul' | 'sub'
  text?: string
  items?: string[]
}

const blocks = computed<ContentBlock[]>(() => {
  const raw = active.value?.content ?? ''
  const out: ContentBlock[] = []
  for (const chunk of raw.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    let bullets: string[] = []
    const flush = () => {
      if (bullets.length) {
        out.push({ kind: 'ul', items: bullets })
        bullets = []
      }
    }
    for (const line of lines) {
      if (line.startsWith('· ') || line.startsWith('・') || line.startsWith('- ')) {
        bullets.push(line.replace(/^(?:[·・]\s*|-\s+)/u, ''))
        continue
      }
      flush()
      if (line.startsWith('【') && line.endsWith('】')) out.push({ kind: 'sub', text: line.slice(1, -1) })
      else out.push({ kind: 'p', text: line })
    }
    flush()
  }
  return out
})

// 关于（设置里的「关于」迁到这里）
</script>

<template>
  <Transition name="an-fade">
    <div v-if="open" class="an">
      <div class="pn-scrim" @click="emit('close')"></div>

      <div class="an__card" role="dialog" aria-modal="true" aria-label="公告">
        <!-- ================= 顶部:深色横幅 + 分类页签 ================= -->
        <header class="an__head">
          <span class="an__head-deco" aria-hidden="true"></span>

          <div class="an__tabs" role="tablist" aria-label="公告分类">
            <button
              class="an__tab"
              :class="{ 'is-on': tab === 'log' }"
              type="button"
              role="tab"
              :aria-selected="tab === 'log'"
              @click="tab = 'log'"
            >
              <!-- 选中底图:比按钮大一圈,向上溢出,两侧自带自然曲线 -->
              <span class="an__tab-bg" aria-hidden="true"></span>
              <span v-if="tabHasUnread" class="an__tab-dot" aria-label="有未读公告"></span>
              <span class="an__tab-inner">
                <span class="an__tab-icon">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M4 5h16v11H9l-5 4z"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linejoin="round"
                    />
                    <path d="M8 9h8M8 12.5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                  </svg>
                </span>
                <span class="an__tab-text">公告</span>
              </span>
            </button>

            <button
              class="an__tab"
              :class="{ 'is-on': tab === 'about' }"
              type="button"
              role="tab"
              :aria-selected="tab === 'about'"
              @click="tab = 'about'"
            >
              <span class="an__tab-bg" aria-hidden="true"></span>
              <span class="an__tab-inner">
                <span class="an__tab-icon">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
                    <path d="M12 10.5V17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                    <circle cx="12" cy="7.2" r="1.2" fill="currentColor" />
                  </svg>
                </span>
                <span class="an__tab-text">关于</span>
              </span>
            </button>
          </div>
        </header>

        <!-- ================= 正文 ================= -->
        <div class="an__body">
          <!-- 左:日期列表(仅「公告」) -->
          <aside v-if="tab === 'log'" class="an__listcol" :class="{ 'is-hidden-m': mobileDetail }">
            <div class="an__list">
              <div v-for="e in sortedEntries" :key="e.id" class="an__item-wrap">
                <button
                  class="an__item"
                  :class="{ 'is-on': e.id === activeId }"
                  type="button"
                  @click="pick(e.id)"
                >
                  <img
                    v-if="!isRead(e.id)"
                    class="an__item-new"
                    :src="MATERIALS.announceUnread"
                    alt=""
                    aria-hidden="true"
                  />
                  <span class="an__item-inner">
                    <span class="an__item-date">
                      <span class="an__item-day">{{ dayOf(e.date) }}</span>
                      <span class="an__item-slash" aria-hidden="true"></span>
                      <span class="an__item-month">{{ monthOf(e.date) }}</span>
                    </span>
                    <span class="an__item-divider" aria-hidden="true"></span>
                    <span class="an__item-title">{{ e.title }}</span>
                    <span v-if="e.pinned" class="an__item-pin">置顶</span>
                  </span>
                </button>
              </div>
            </div>
          </aside>

          <!-- 右:正文 -->
          <section class="an__detail" :class="{ 'is-hidden-m': tab === 'log' && !mobileDetail }">
            <button
              v-if="isMobileView && tab === 'log' && mobileDetail"
              class="an__back"
              type="button"
              @click="mobileDetail = false"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M15 5L8 12l7 7"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              返回列表
            </button>

            <!-- 公告:标题条 + 正文 -->
            <div v-if="tab === 'log' && active" class="an__panel">
              <div class="an__panel-head">
                <h2 class="an__panel-title">{{ active.title }}</h2>
                <span class="an__panel-deco" aria-hidden="true"></span>
              </div>

              <div class="an__scroll">
                <div class="an__meta">
                  <span v-if="active.version" class="an__badge">{{ active.version }}</span>
                  <span class="an__date">{{ active.date }}</span>
                </div>

                <div class="an__article">
                  <template v-for="(b, i) in blocks" :key="i">
                    <p v-if="b.kind === 'sub'" class="an__sub">{{ b.text }}</p>
                    <ul v-else-if="b.kind === 'ul'" class="an__ul">
                      <li v-for="(it, j) in b.items" :key="j">{{ it }}</li>
                    </ul>
                    <p v-else class="an__p">{{ b.text }}</p>
                  </template>
                </div>
              </div>
            </div>

            <!-- 关于 -->
            <div v-else class="an__panel">
              <div class="an__panel-head">
                <h2 class="an__panel-title">关于 Baker AI</h2>
                <span class="an__panel-deco" aria-hidden="true"></span>
              </div>

              <div class="an__scroll an__scroll--about">
                <!-- 顶部:应用名 + 一句话介绍 -->
                <div class="an__about-hero">
                  <p class="an__about-hero-kicker">明日方舟：终末地 · 同人 AI 聊天</p>
                  <h3 class="an__about-hero-title">
                    Baker AI
                    <span class="an__about-hero-ver">v3.2</span>
                  </h3>
                  <p class="an__about-hero-desc">
                    与干员自由对话，体验真实的角色性格与世界观。
                  </p>
                  <p class="an__about-hero-note">
                    非官方同人作品 · 与鹰角网络无任何关联 · 仅供学习交流，禁止商用
                  </p>
                </div>

                <section class="an__about-sec">
                  <h3 class="an__about-heading">交流群</h3>
                  <div class="an__about-card">
                    <a
                      v-for="g in QQ_GROUPS"
                      :key="g.code"
                      class="an__about-item"
                      :href="g.url"
                      target="_blank"
                      rel="noopener"
                      @click="copyText(g.code)"
                    >
                      <span class="an__about-item-label">{{ g.label }}</span>
                      <span class="an__about-item-value">{{ g.code }}</span>
                      <span class="an__about-item-act">复制并加入</span>
                    </a>
                  </div>
                  <p class="an__about-tip">点击任意一行即可复制群号并跳转到加群页面</p>
                </section>

                <section class="an__about-sec">
                  <h3 class="an__about-heading">相关链接</h3>
                  <div class="an__about-card">
                    <a
                      v-for="l in PROJECT_LINKS"
                      :key="l.url"
                      class="an__about-item"
                      :href="l.url"
                      target="_blank"
                      rel="noopener"
                    >
                      <span class="an__about-item-label">{{ l.label }}</span>
                      <span class="an__about-item-act">打开 ↗</span>
                    </a>
                  </div>
                </section>

                <section class="an__about-sec">
                  <h3 class="an__about-heading">相关项目</h3>
                  <div class="an__about-card">
                    <a
                      class="an__about-item"
                      href="https://ark.ncreeper.top/"
                      target="_blank"
                      rel="noopener"
                    >
                      <span class="an__about-item-label">终末地风格 LOGO 生成器</span>
                      <span class="an__about-item-act">打开 ↗</span>
                    </a>
                    <a
                      class="an__about-item"
                      href="https://baker.ncreeper.top/"
                      target="_blank"
                      rel="noopener"
                    >
                      <span class="an__about-item-label">终末地 Baker 模拟器</span>
                      <span class="an__about-item-act">打开 ↗</span>
                    </a>
                  </div>
                </section>
              </div>
            </div>
          </section>
        </div>

        <!-- 关闭:压在卡片右上角(圆底 + 白叉) -->
        <button class="an__close" type="button" aria-label="关闭公告" @click="emit('close')">
          <svg viewBox="0 0 205 205" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
            <path d="M0 25L25 0L205 180L180 205ZM25 205L0 180L180 0L205 25Z"></path>
          </svg>
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 公告页样式：卡片固定 16:9，按视口等比缩小（62vw 与 84vh 取小）。
// 内部尺寸按 1500×844 设计稿乘 0.8 给值；页签底图用 aspect-ratio 保持原比例。

$an-body-top: #7e8185;

.an {
  position: fixed;
  inset: 0;
  z-index: 520;
}

// 卡片（16:9）
.an__card {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 301;
  display: flex;
  flex-direction: column;
  // 16:9:宽度取 62vw,再被 84vh 反算出的宽度压住,保证不超出屏幕高度
  width: min(1200px, 62vw, 149vh);
  aspect-ratio: 16 / 9;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 8px;
  background: #1a1a1a;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
  color: #fff;
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
}

// 开合:遮罩淡入 + 卡片轻微缩放
.an-fade-enter-active {
  transition: opacity 0.18s ease-out;

  .an__card {
    animation: an-card-in 0.2s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }
}

.an-fade-leave-active {
  transition: opacity 0.2s ease-in;

  .an__card {
    animation: an-card-out 0.2s ease-in both;
  }
}

.an-fade-enter-from,
.an-fade-leave-to {
  opacity: 0;
}

@keyframes an-card-in {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.95);
  }

  to {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}

@keyframes an-card-out {
  from {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }

  to {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.97);
  }
}

// 关闭:收在头部内部右上角
.an__close {
  position: absolute;
  top: 18px;
  right: 17px;
  z-index: 10;
  display: grid;
  place-content: center;
  width: 52px;
  height: 52px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.45);
  border-radius: 50%;
  background: #232323;
  color: #fff;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
  transition: background-color 0.15s ease, transform 0.15s ease;

  svg {
    display: block;
    width: 18px;
    height: 18px;
  }

  &:hover {
    background: #2c2c2c;
  }

  &:active {
    transform: scale(0.95);
  }
}

// 顶部深色横幅 + 页签
.an__head {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: flex-end;
  justify-content: center;
  height: 108px;
  overflow-x: clip;
  overflow-y: visible;
  border-radius: 7px 7px 0 0;
  background: linear-gradient(180deg, #1c1c1c 0%, #242424 100%);
}

.an__tabs {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 8px;
  width: 100%;
}

// 页签:选中 / 未选中**同一个盒子、同一张底图**,只是未选中把底图压暗。
// 这样两者尺寸完全一致、圆角也一致,底图按 100% 完整显示不裁切。
.an__tab {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  // 按高度定尺寸:宽度由 390:100 的比例算出来,底图始终不拉伸
  height: clamp(48px, 3.6vw, 68px);
  width: auto;
  aspect-ratio: 390 / 100;
  padding: 0 clamp(11px, 1vw, 18px);
  border: 0;
  background: none;
  color: #9f9f9f;
  font-family: inherit;
  font-size: clamp(13px, 1.09vw, 19px);
  font-weight: 700;
  cursor: pointer;
  transition: color 0.15s ease;

  &:hover {
    color: #d8d8d8;
  }

  // 页签底图层:铺满按钮,按 contain 完整显示(与按钮同比例,正好填满)
  &-bg {
    position: absolute;
    inset: 0;
    background: url('../../assets/materials/announce_tab_on.webp') center / 100% 100% no-repeat;
    // 未选中:压暗成深色页签(和原图里那张深色页签同一个观感)
    filter: brightness(0.46);
    pointer-events: none;
    transition: filter 0.15s ease;
  }

  // 内容层:铺在页签"可见部分"的中间。
  // 底图上方有 16% 的透明边(可见形状只占 16%~100%),所以这里也从 16% 起排,
  // 让图标和文字落在页签形状的视觉中心,而不是整张图的几何中心
  &-inner {
    position: absolute;
    top: 16%;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: clamp(5px, 0.45vw, 8px);
    padding: 0 clamp(11px, 1vw, 18px);
  }

  // 图标块:白底方块 + 底部小尾巴
  &-icon {
    position: relative;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: clamp(22px, 1.85vw, 32px);
    height: clamp(22px, 1.85vw, 32px);
    border-radius: 2px;
    background: #9f9f9f;
    color: #414141;

    svg {
      display: block;
      width: 64%;
      height: 64%;
    }

    &::after {
      content: '';
      position: absolute;
      right: 5px;
      bottom: -3px;
      width: 6px;
      height: 6px;
      background: inherit;
      transform: rotate(45deg);
    }
  }

  &-text {
    position: relative;
    white-space: nowrap;
  }

  // 未读橙点:菱形 + 呼吸圈
  // 贴图上方有 16% 透明边,所以点位按比例压在"可见页签"的右上角上
  &-dot {
    position: absolute;
    top: 17%;
    right: 8%;
    z-index: 2;
    width: 10px;
    height: 10px;
    transform: rotate(45deg);
    background: #ee7e31;
    box-shadow: 0 0 4px rgba(0, 0, 0, 0.8);
    pointer-events: none;

    &::after {
      content: '';
      position: absolute;
      inset: -1px;
      border: 1px solid #ee7e31;
      animation: an-dot-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
    }
  }

  // 选中:底图恢复原亮度(就是正文顶部那一档灰),字变白、图标块变白
  &.is-on {
    z-index: 2;
    color: #fff;

    .an__tab-bg {
      filter: none;
    }

    .an__tab-icon {
      background: #fff;
      color: #848589;
    }
  }
}

@keyframes an-dot-ping {
  0% {
    transform: scale(1);
    opacity: 0.85;
  }

  80%,
  100% {
    transform: scale(1.9);
    opacity: 0;
  }
}

// 主体：左日期列表 + 右正文
.an__body {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 0;
  padding: 24px 52px 30px 24px;
  overflow: hidden;
  border-radius: 0 0 7px 7px;
  background: linear-gradient(180deg, $an-body-top 0%, #6f7276 24%, #4c4e50 58%, #383a3b 100%);
}

// 左：日期列表
.an__listcol {
  position: relative;
  z-index: 2;
  display: flex;
  flex: 0 0 30%;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  // 空白区(尖角伸出的那一段)不拦截点击,交给下层正文面板
  pointer-events: none;
}

.an__list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  overflow-y: auto;
  // 顶部留白给第一条的 NEW 角标;右侧 34px 给选中卡的尖角伸出去
  padding: 10px 34px 18px 3px;
  scrollbar-width: none;
  pointer-events: auto;

  &::-webkit-scrollbar {
    display: none;
  }
}

.an__item-wrap {
  position: relative;
  flex: none;
  width: 100%;
  height: 62px;
}

.an__item {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 1.2px solid rgba(245, 245, 245, 0.72);
  border-radius: 6px;
  background: #3a3a3a;
  color: #fff;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s ease, border-color 0.15s ease;

  &:hover {
    background: #4a4a4a;
  }

  // 选中:底图(白卡 + 尖角,自带渐变与弧线)
  // 白卡本体只占图片的 0..88.6% 宽、0..81.5% 高,按这个比例放大图层
  &.is-on {
    border-color: transparent;
    background: transparent;

    &::after {
      content: '';
      position: absolute;
      top: -1.2px;
      left: -1.9%;
      width: 111%;
      height: 127%;
      background: url('../../assets/materials/announce_item_on.webp') left top / 100% 100% no-repeat;
      pointer-events: none;
    }

    .an__item-title {
      color: #1d1d1d;
      font-weight: 700;
    }

    .an__item-date {
      color: #7d7d7d;
    }

    .an__item-slash {
      background: #b5b5b5;
    }

    .an__item-divider {
      background: #c4c4c4;
    }
  }

  // 未读角标
  &-new {
    position: absolute;
    top: -10px;
    right: 13px;
    z-index: 4;
    height: 21px;
    pointer-events: none;
  }

  &-inner {
    position: relative;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 11px;
    height: 100%;
    padding: 0 18px 0 12px;
    pointer-events: none;
  }

  // 日期块:日(左上) + 斜线 + 月(右下)
  &-date {
    position: relative;
    flex: 0 0 46px;
    height: 100%;
    color: #b9b9b9;
  }

  &-day {
    position: absolute;
    top: 12px;
    left: 0;
    font-size: 23px;
    line-height: 1;
  }

  &-slash {
    position: absolute;
    top: 50%;
    left: 29px;
    width: 1.2px;
    height: 43px;
    transform: translateY(-50%) rotate(28deg);
    background: #8d8d8d;
  }

  &-month {
    position: absolute;
    right: 0;
    bottom: 11px;
    font-size: 10.5px;
  }

  // 日期与标题之间的竖线
  &-divider {
    flex: 0 0 1.2px;
    align-self: stretch;
    margin: 8px 0;
    background: rgba(200, 200, 200, 0.8);
  }

  &-title {
    flex: 1;
    display: -webkit-box;
    overflow: hidden;
    font-size: clamp(12px, 0.98vw, 18px);
    line-height: 1.3;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  // 置顶标:标题右侧的小黄牌
  &-pin {
    flex: 0 0 auto;
    align-self: center;
    padding: 1px 5px;
    border-radius: 2px;
    background: #fcf33f;
    color: #241d00;
    font-size: 10px;
    font-weight: 700;
    line-height: 1.5;
    letter-spacing: 0.02em;
  }
}

// 右：正文面板
.an__detail {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  margin-left: -6px;
}

.an__back {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  padding: 4px 12px;
  border: 0;
  border-radius: 999px;
  background: #e9e9e9;
  color: #1d1d1d;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;

  svg {
    width: 14px;
    height: 14px;
  }
}

.an__panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  // 标题条与正文都内缩,四周露出灰底(标题是"灰底上的黑矩形")
  padding: 14px 18px 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 4px;
  background: linear-gradient(180deg, #e2e2e2 0%, #c9c9c9 100%);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}

.an__panel-head {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  min-height: 46px;
  padding: 0 17px;
  overflow: hidden;
  border-radius: 2px;
  background: #131313;
}

.an__panel-title {
  position: relative;
  z-index: 1;
  margin: 0;
  color: #fff;
  font-family: $font-harmony;
  font-size: clamp(17px, 1.34vw, 24px);
  font-weight: 700;
  line-height: 1.25;
}

.an__panel-deco {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 46%;
  opacity: 0.5;
  background-image: repeating-linear-gradient(
    -45deg,
    rgba(255, 255, 255, 0.18) 0 1px,
    transparent 1px 6px
  );
  -webkit-mask-image: linear-gradient(to left, #000, transparent 85%);
  mask-image: linear-gradient(to left, #000, transparent 85%);
  pointer-events: none;
}

.an__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 3px 22px;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.3) transparent;
}

.an__meta {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 9px;
}

.an__badge {
  padding: 1px 10px;
  background: rgba(255, 255, 255, 0.72);
  color: #6f6f6f;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 12.5px;
  line-height: 19px;
}

.an__date {
  color: #8a8a8a;
  font-size: 12.5px;
}

.an__article {
  color: #1b1b1b;
  font-family: $font-harmony;
  font-size: clamp(12px, 0.94vw, 17px);
  line-height: 1.85;
}

.an__p {
  margin: 0 0 8px;
}

.an__sub {
  margin: 18px 0 6px;
  color: #111;
  font-size: 1.1em;
  font-weight: 700;

  &:first-child {
    margin-top: 0;
  }
}

.an__ul {
  margin: 0 0 9px;
  padding-left: 1.15em;

  li {
    margin-bottom: 3px;

    // 行前圆点:正黄色
    &::marker {
      color: #faff48;
    }
  }
}

// 关于页
.an__scroll--about {
  color: #1b1b1b;
  padding-right: 12px;
  font-family: $font-harmony;
  font-size: 14px;
  line-height: 1.85;
}

// 顶部介绍:浅灰底 + 左侧黄条
.an__about-hero {
  position: relative;
  margin: 0 0 22px;
  padding: 16px 20px 16px 22px;
  border-left: 3px solid #fcf33f;
  border-radius: 0 4px 4px 0;
  background: rgba(0, 0, 0, 0.055);
}

.an__about-hero-kicker {
  margin: 0 0 4px;
  color: #5f5f5f;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.an__about-hero-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 6px;
  color: #111;
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.5px;
  line-height: 1.2;
}

.an__about-hero-ver {
  padding: 1px 7px;
  border-radius: 3px;
  background: #fcf33f;
  color: #241d00;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
}

.an__about-hero-desc {
  margin: 0 0 8px;
  color: #2a2a2a;
  font-size: 14px;
}

.an__about-hero-note {
  margin: 0;
  color: #8a8a8a;
  font-size: 12px;
}

// 分组
.an__about-sec {
  margin: 0 0 20px;
}

.an__about-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  color: #111;
  font-size: 15px;
  font-weight: 700;

  &::before {
    content: '';
    display: block;
    width: 3px;
    height: 14px;
    background: #fcf33f;
  }
}

// 条目卡片:一行一条,行间细线
.an__about-card {
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 4px;
  background: #f7f7f7;

  &--pad {
    padding: 14px 16px;
  }
}

.an__about-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 16px;
  color: #1b1b1b;
  text-decoration: none;
  transition: background-color 0.15s ease;

  & + & {
    border-top: 1px solid rgba(0, 0, 0, 0.08);
  }

  &:hover {
    background: rgba(252, 243, 63, 0.22);

    .an__about-item {
      &-label {
        color: #000;
      }

      &-act {
        color: #4a4300;
      }
    }
  }
}

.an__about-item-label {
  flex: 1;
  min-width: 0;
  font-weight: 600;
}

.an__about-item-value {
  color: #4a4a4a;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

.an__about-item-act {
  flex-shrink: 0;
  color: #8a8a8a;
  font-size: 12px;
  transition: color 0.15s ease;
}

.an__about-tip {
  margin: 8px 0 0;
  color: #8a8a8a;
  font-size: 12px;
}

// 移动端：列表 / 详情两级切换
@media (prefers-reduced-motion: reduce) {
  .an__tab-dot::after {
    animation: none !important;
  }
}

@media (max-width: 768px) {
  .an__card {
    width: calc(100% - 16px);
    height: calc(100% - 24px);
    aspect-ratio: auto;
  }

  .an__close {
    top: 8px;
    right: 8px;
    width: 34px;
    height: 34px;

    svg {
      width: 14px;
      height: 14px;
    }
  }

  .an__head {
    height: 94px;
  }

  .an__tabs {
    gap: 6px;
  }

  .an__tab {
    // 按原图比例撑满可用宽度,不再被 flex 拉扁
    flex: 1 1 0;
    width: auto;
    height: auto;
    max-width: 48%;
    font-size: 15px;
    padding: 0 10px;

    &-icon {
      width: 26px;
      height: 26px;
    }

    &-dot {
      top: 17%;
      right: 8%;
      width: 9px;
      height: 9px;
    }
  }

  .an__body {
    gap: 0;
    padding: 10px;
  }

  .an__listcol {
    flex: 1 1 auto;
    padding-right: 0;
  }

  .an__list {
    padding: 8px 16px 14px 2px;
  }

  .an__listcol.is-hidden-m,
  .an__detail.is-hidden-m {
    display: none;
  }

  .an__item-wrap {
    height: 62px;
  }

  .an__item-new {
    top: -9px;
    right: 10px;
    height: 19px;
  }

  .an__item-title {
    font-size: 15px;
  }

  .an__item-date {
    flex-basis: 48px;
  }

  .an__item-day {
    top: 11px;
    font-size: 22px;
  }

  .an__item-slash {
    left: 27px;
    height: 40px;
  }

  .an__item-month {
    bottom: 10px;
    font-size: 10px;
  }

  .an__panel {
    padding: 10px 12px 0;
  }

  .an__panel-head {
    min-height: 42px;
    padding: 0 12px;
  }

  .an__panel-title {
    font-size: 17px;
  }

  .an__scroll {
    padding: 12px 2px 16px;
  }

  .an__article {
    font-size: 13.5px;
  }

  .an__scroll--about {
    font-size: 13.5px;
  }

  .an__about-heading {
    font-size: 15px;
  }
}
</style>
