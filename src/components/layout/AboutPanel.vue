<script setup lang="ts">
// AboutPanel —— 设置里的「关于」页（原「免责声明」页重做）
//
// 版式参考 ZMDMAP 的关于页：头图（圆角矩形背景 + 应用名）→ 版本信息 →
// 分节标记（标题 + 斜纹短条 + 圆点）→ 社区二维码 → 开源仓库 → 更新日志 → 版权与免责。
// 版权与免责只给入口：点开的是与开屏公告同一份 DisclaimerDialog，条款文案不在这里复制。
// 配色沿用本应用的深色面板：黄色只做点缀，不做大面积底色。
import { computed, onBeforeUnmount, ref } from 'vue'

import { MATERIALS } from '../../constants/materials'
import { GITHUB_URL, QQ_GROUPS, type QqGroup } from '../../constants/contact'
import { CHANGELOG } from '../../constants/changelog'
import { APP_VERSION } from '../../constants/popups'
import { copyText } from '../../utils/clipboard'
import { openQqGroup } from '../../utils/qqGroup'
import DisclaimerDialog from './DisclaimerDialog.vue'

/** 最近更新日期 = 更新日志第一条 */
const latestDate = computed(() => CHANGELOG[0]?.date ?? '')

/** 刚复制过的群号（按钮上的文字反馈，1.6s 后复位） */
const copiedCode = ref('')
let copiedTimer: number | null = null

function onCopy(code: string): void {
  void copyText(code)
  copiedCode.value = code
  if (copiedTimer !== null) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copiedCode.value = ''
    copiedTimer = null
  }, 1600)
}

/**
 * 点二维码 / 「加群」→ 直接唤起手机 QQ 打开群名片（安卓本地插件），
 * 没装 QQ 或非安卓时退回群分享页（见 utils/qqGroup.ts）。
 */
function onJoin(group: QqGroup): void {
  void openQqGroup(group)
}

onBeforeUnmount(() => {
  if (copiedTimer !== null) window.clearTimeout(copiedTimer)
})

// ---- 免责声明弹窗 ------------------------------------------------------
// 与开屏公告里点开的那一份是**同一个组件**（DisclaimerDialog），条款只维护一处；
// 层级用组件默认的 560，正好压过设置面板（500）。
const disclaimerOpen = ref(false)

function openDisclaimer(): void {
  disclaimerOpen.value = true
}

function closeDisclaimer(): void {
  disclaimerOpen.value = false
}

// ---- 更新日志正文分块 ------------------------------------------------
// 与原公告页同一套约定：空行分段、「· 」开头成列表、「【…】」成小标题。
interface LogBlock {
  kind: 'p' | 'ul' | 'sub'
  text?: string
  items?: string[]
}

function parseBlocks(raw: string): LogBlock[] {
  const out: LogBlock[] = []
  for (const chunk of raw.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    let bullets: string[] = []
    const flush = (): void => {
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
}

/** 预解析一次即可（数据是常量） */
const logs = computed(() => CHANGELOG.map((entry) => ({ entry, blocks: parseBlocks(entry.content) })))
</script>

<template>
  <div class="ab">
    <!-- ============ 头部：整张图（不裁切）+ 应用名 + 元信息 ============ -->
    <!-- 结构对齐参考站：图在上、名字压在斜纹条上、版本信息紧随其下，整体居中 -->
    <header class="ab__hero">
      <div class="ab__portrait">
        <img :src="MATERIALS.aboutHero" alt="Baker AI" />
      </div>

      <h2 class="ab__name"><span>Baker AI</span></h2>
      <p class="ab__tagline">与干员自由对话的《明日方舟：终末地》AI 聊天</p>

      <!-- 头图下面：版本 / 更新日期 -->
      <div class="ab__meta">
        <span class="ab__ver">v{{ APP_VERSION }}</span>
        <span v-if="latestDate" class="ab__meta-text">更新于 {{ latestDate }}</span>
      </div>

      <p class="ab__lead">
        非官方同人作品 · 与鹰角网络无任何关联 · MIT 协议开源
      </p>
    </header>

    <!-- ============ 社区：两张群二维码 ============ -->
    <section class="ab__sec">
      <h3 class="ab__h">
        <span class="ab__h-text">加入QQ群</span>
        <span class="ab__h-bar" aria-hidden="true"></span>
        <span class="ab__h-dot" aria-hidden="true"></span>
      </h3>

      <div class="ab__qrs">
        <div v-for="g in QQ_GROUPS" :key="g.code" class="ab__qr">
          <!-- 整张二维码就是入口：点一下直接唤起 QQ 群名片 -->
          <button
            class="ab__qr-imgbtn"
            type="button"
            :aria-label="`加入 ${g.label}`"
            @click="onJoin(g)"
          >
            <img class="ab__qr-img" :src="g.qr" :alt="`${g.label} 二维码`" loading="lazy" decoding="async" />
          </button>
          <div class="ab__qr-foot">
            <button class="ab__qr-btn" type="button" @click="onCopy(g.code)">
              {{ copiedCode === g.code ? '已复制' : `复制群号 ${g.code}` }}
            </button>
            <a class="ab__qr-link" :href="g.url" rel="noopener" @click.prevent="onJoin(g)">
              加群 <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ 开源仓库（单独一块，不和上面混在一起） ============ -->
    <section class="ab__sec">
      <h3 class="ab__h">
        <span class="ab__h-text">开源仓库</span>
        <span class="ab__h-bar" aria-hidden="true"></span>
        <span class="ab__h-dot" aria-hidden="true"></span>
      </h3>

      <div class="ab__rows">
        <a class="ab__row" :href="GITHUB_URL" target="_blank" rel="noopener">
          <span class="ab__row-label">GitHub · endfield-baker-chat</span>
          <span class="ab__row-act">打开 ↗</span>
        </a>
      </div>
    </section>

    <!-- ============ 更新日志 ============ -->
    <section class="ab__sec">
      <h3 class="ab__h">
        <span class="ab__h-text">更新日志</span>
        <span class="ab__h-bar" aria-hidden="true"></span>
        <span class="ab__h-dot" aria-hidden="true"></span>
      </h3>

      <div class="ab__logs">
        <article v-for="log in logs" :key="log.entry.id" class="ab__log">
          <div class="ab__log-head">
            <span v-if="log.entry.version" class="ab__log-ver">{{ log.entry.version }}</span>
            <span class="ab__log-date">{{ log.entry.date }}</span>
          </div>
          <h4 class="ab__log-title">{{ log.entry.title }}</h4>
          <div class="ab__log-body">
            <template v-for="(b, i) in log.blocks" :key="i">
              <p v-if="b.kind === 'sub'" class="ab__log-sub">{{ b.text }}</p>
              <ul v-else-if="b.kind === 'ul'" class="ab__log-ul">
                <li v-for="(it, j) in b.items" :key="j">{{ it }}</li>
              </ul>
              <p v-else class="ab__log-p">{{ b.text }}</p>
            </template>
          </div>
        </article>
      </div>
    </section>

    <!-- ============ 版权与免责 ============ -->
    <section class="ab__sec">
      <h3 class="ab__h">
        <span class="ab__h-text">版权与免责</span>
        <span class="ab__h-bar" aria-hidden="true"></span>
        <span class="ab__h-dot" aria-hidden="true"></span>
      </h3>

      <!-- 条款正文不进这一页：整块就是一个入口，点开与开屏同一份《免责声明》，文案只维护一处 -->
      <div class="ab__rows ab__rows--legal">
        <button class="ab__row ab__row--btn" type="button" @click="openDisclaimer">
          <span class="ab__row-label">《免责声明》完整条款</span>
          <span class="ab__row-act">查看 ↗</span>
        </button>
      </div>

      <p class="ab__legal-note">继续使用即代表你已阅读并同意以上条款。</p>
    </section>

    <!-- 免责声明：与开屏公告共用同一个组件；默认层级 560，压过设置面板（500） -->
    <DisclaimerDialog :open="disclaimerOpen" @close="closeDisclaimer" />
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

$ab-yellow: #ffee34;

.ab {
  // 与其它标签页同一条栅格：居中、限宽，长文本不拉成一整行
  // border-box 必须有：padding 也算进这 900，否则内容会比视口宽 88px（手机上横向溢出）
  box-sizing: border-box;
  width: min(100%, 900px);
  margin: 0 auto;
  padding: 2px 44px 44px;
  color: rgba(255, 255, 255, 0.78);
  font-family: $font-harmony;
  font-size: 13.5px;
  line-height: 1.85;
}

// ---- 头部：整张图 + 名字 + 元信息 -----------------------------------------
// 参考站是「头像在上、名字居中、元信息在下」的竖排，且头像不裁切；这里照搬结构。
.ab__hero {
  // 用 block + text-align 居中，不要用 column flex：
  // flex 的 align-items:center 会把子项压成 max-content 宽，长句不换行、直接横向溢出
  padding: 12px 0 26px;
  text-align: center;
}

// 圆角矩形头像框：整张图完整显示（contain，不裁切）
.ab__portrait {
  width: clamp(108px, 16vw, 148px);
  aspect-ratio: 1;
  overflow: hidden;
  margin: 0 auto;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.38);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
}

// 名字：压在一条 45° 斜纹带上（参考站的 ownerName 就是这么做的）
.ab__name {
  margin: 14px 0 0;
  color: #fff;
  font-size: clamp(21px, 2.8vw, 26px);
  font-weight: 800;
  letter-spacing: -0.4px;
  line-height: 1.2;

  span {
    display: inline-block;
    padding: 3px 14px;
    background-image: repeating-linear-gradient(
      -45deg,
      rgba(255, 255, 255, 0.14) 0 2px,
      transparent 2px 9px
    );
  }
}

.ab__tagline {
  margin: 10px 0 0;
  color: rgba(255, 255, 255, 0.55);
  font-size: 12.5px;
}

// ---- 头图下面那行信息 ----------------------------------------------------
.ab__meta {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}

.ab__ver {
  padding: 2px 9px;
  border-radius: 3px;
  background: $ab-yellow;
  color: #241d00;
  font-family: ui-monospace, SFMono-Regular, 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.6;
  letter-spacing: 0;
}

.ab__meta-text {
  color: rgba(255, 255, 255, 0.52);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.ab__lead {
  margin: 10px 0 0;
  color: rgba(255, 255, 255, 0.42);
  font-size: 12px;
}

// ---- 分节标记：标题 + 斜纹短条 + 圆点（参考站的分节符号）----------------
.ab__sec {
  margin: 0 0 30px;
}

.ab__h {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin: 0 0 16px;
}

.ab__h-text {
  color: #fff;
  font-size: 17px;
  font-weight: 800;
  letter-spacing: 0.01em;
  line-height: 1.2;
}

.ab__h-bar {
  position: relative;
  display: block;
  width: 58px;
  height: 6px;
  background-image: repeating-linear-gradient(
    -45deg,
    $ab-yellow 0 2px,
    transparent 2px 6px
  );
  opacity: 0.9;

  // 中间一道实心线，斜纹就有了"轴"
  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 2px;
    transform: translateX(-50%);
    background: $ab-yellow;
  }
}

.ab__h-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: $ab-yellow;
}

// ---- 二维码 ------------------------------------------------------------
.ab__qrs {
  display: grid;
  // 卡片别铺满整行：二维码只是"扫一下"，不需要占满版面
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 14px;
  max-width: 430px;
  margin: 0 auto;
}

.ab__qr {
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
  transition: border-color 0.15s ease, background-color 0.15s ease;

  &:hover {
    border-color: rgba(255, 238, 52, 0.42);
    background: rgba(255, 238, 52, 0.05);
  }
}

.ab__qr-imgbtn {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  // 二维码本身是深色卡片：去掉上下那点纯黑边，和卡片底色接住
  background: #0b0b0c;

  &:focus-visible {
    outline: 1px dashed rgba(255, 238, 52, 0.6);
    outline-offset: -3px;
  }
}

.ab__qr-img {
  display: block;
  width: 100%;
  height: auto;
}

.ab__qr-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.ab__qr-btn,
.ab__qr-link {
  padding: 0;
  border: 0;
  background: none;
  color: rgba(255, 255, 255, 0.66);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s ease;
}

.ab__qr-btn {
  font-variant-numeric: tabular-nums;

  &:hover {
    color: $ab-yellow;
  }
}

.ab__qr-link {
  color: $ab-yellow;
  text-decoration: none;

  &:hover {
    color: #fff;
  }
}

// ---- 链接行 ------------------------------------------------------------
.ab__rows {
  overflow: hidden;
  max-width: 640px;
  margin: 0 auto;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}

.ab__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  color: rgba(255, 255, 255, 0.86);
  text-decoration: none;
  transition: background-color 0.15s ease, color 0.15s ease;

  & + & {
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  &:hover {
    background: rgba(255, 238, 52, 0.07);
    color: #fff;

    .ab__row-act {
      color: $ab-yellow;
    }
  }
}

// 按钮行（版权与免责的几个入口）：只是"长得像链接行"，
// 需要把原生 button 的默认外观全部清掉，否则会带系统底色与内边距
.ab__row--btn {
  width: 100%;
  border: 0;
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;

  // .ab__row 的 & + & 分隔线对 button 同样成立，这里只补键盘可达的焦点环
  &:focus-visible {
    outline: 1px dashed rgba(255, 238, 52, 0.6);
    outline-offset: -3px;
  }
}

.ab__row-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}

.ab__row-act {
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.34);
  font-size: 11.5px;
  transition: color 0.15s ease;
}

// ---- 更新日志 ----------------------------------------------------------
.ab__logs {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 760px;
  margin: 0 auto;
}

.ab__log {
  position: relative;
  padding-left: 16px;
  border-left: 1px solid rgba(255, 255, 255, 0.14);

  // 时间轴上的黄点
  &::before {
    content: '';
    position: absolute;
    top: 6px;
    left: -3px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: $ab-yellow;
  }
}

.ab__log-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 3px;
}

.ab__log-ver {
  padding: 0 6px;
  border-radius: 2px;
  background: rgba(255, 238, 52, 0.16);
  color: $ab-yellow;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.6;
}

.ab__log-date {
  color: rgba(255, 255, 255, 0.4);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.ab__log-title {
  margin: 0 0 6px;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
}

.ab__log-body {
  color: rgba(255, 255, 255, 0.62);
  font-size: 12.5px;
  line-height: 1.9;
}

.ab__log-p {
  margin: 0 0 5px;

  &:last-child {
    margin-bottom: 0;
  }
}

.ab__log-sub {
  margin: 12px 0 4px;
  color: rgba(255, 255, 255, 0.86);
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.02em;

  &:first-child {
    margin-top: 0;
  }
}

.ab__log-ul {
  margin: 0 0 6px;
  padding-left: 1.1em;

  li {
    margin-bottom: 2px;

    &::marker {
      color: $ab-yellow;
    }
  }
}

// ---- 版权 --------------------------------------------------------------
// 条款正文已移进《免责声明》弹窗，这里只留一行说明，不能再有 .ab__legal 段落样式
// （页脚那行版权声明也已去掉：免责弹窗里「知识产权与同人声明」已覆盖同样内容）
.ab__legal-note {
  max-width: 640px;
  margin: 10px auto 0;
  color: rgba(255, 255, 255, 0.34);
  font-size: 11.5px;
  line-height: 1.7;
  text-align: center;
}

// ---- 移动端 ------------------------------------------------------------
@media (max-width: 768px) {
  .ab {
    padding: 2px 16px 36px;
  }

  .ab__portrait {
    width: 104px;
  }

  .ab__qrs {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .ab__qr-foot {
    padding: 6px 8px;
  }

  .ab__qr-btn,
  .ab__qr-link {
    font-size: 10.5px;
  }

  .ab__sec {
    margin-bottom: 24px;
  }
}
</style>
