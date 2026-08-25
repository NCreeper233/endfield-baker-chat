<script setup lang="ts">
// =============================================================================
// 设置弹窗(SettingsDialog)
// -----------------------------------------------------------------------------
// AI API 配置 + 提示词编辑,全部持久化到 localStorage(settings store)
// 打开/关闭状态由父组件 App 持有
// =============================================================================
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { testApiConnection } from '../../utils/llm'
import { testBackendConnection } from '../../utils/backend'
import { useChatStore } from '../../stores/chat'
import { CHARACTER_PROMPTS } from '../../constants/prompts'
import DataManagerDialog from './DataManagerDialog.vue'

const props = defineProps<{
  /** 是否展开 */
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const settingsStore = useSettingsStore()
const chatStore = useChatStore()

/** 当前标签页:api / data / about（提示词与背景已并入 api 页的"自定义 API"分支） */
const activeTab = ref<'api' | 'experimental' | 'data' | 'about'>('api')

/** 标签页配置(用于 v-for 渲染 + 滑动指示条) */
const tabs = [
  { key: 'api', label: 'API 配置' },
  { key: 'experimental', label: '实验性功能' },
  { key: 'data', label: '数据管理' },
  { key: 'about', label: '关于' },
] as const

// ---- 标签页滑动指示条 -------------------------------------------------------
/** 标签栏容器(ref) */
const tabsEl = ref<HTMLElement | null>(null)
/** 各标签按钮 DOM(按键名缓存,供指示条测量) */
const tabEls = new Map<string, HTMLElement>()
/** 就绪信号:递增即强制指示条重算(首次挂载时用于定位) */
const tabsReady = ref(0)
/** 指示条过渡开关:定位完成后的下一帧才启用动画 */
const tabAnim = ref(false)

/** 记录标签按钮 DOM(Vue ref 回调:卸载时传 null) */
function setTabEl(key: string, el: unknown) {
  if (el) tabEls.set(key, el as HTMLElement)
}

/**
 * 指示条样式:宽度 = 激活标签宽度,位移 = 激活标签相对标签栏左边的距离。
 * tabsReady 必须无条件读取(在提前返回之前),否则首次挂载时不会建立依赖,
 * 标签 DOM 就绪后无法触发重算,横条会一直不可见。
 */
const tabIndicatorStyle = computed(() => {
  void tabsReady.value // 无条件建立响应依赖
  const container = tabsEl.value
  const el = tabEls.get(activeTab.value)
  if (!container || !el) return {}
  const cr = container.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  return {
    width: `${er.width}px`,
    transform: `translateX(${er.left - cr.left}px)`,
  }
})

// 挂载完成:先让指示条直接定位到当前标签(此时 transition 未开,无动画),
// 下一帧再开启过渡,之后手动切换标签才有滑动动画。
onMounted(async () => {
  await nextTick() // 等首帧渲染、标签 ref 全部填充
  tabsReady.value++ // 强制重算 → 横条出现在当前标签下方
  await nextTick() // 等定位渲染完成
  tabAnim.value = true // 开启过渡动画
})

// ---- API 配置本地缓存(打开时同步,保存时写入 store) -------------------------
const apiDraft = ref({
  apiMode: 'custom' as 'custom' | 'backend',
  baseUrl: '',
  apiKey: '',
  model: '',
  backendUrl: '',
  temperature: 1.0,
  maxTokens: 2048,
})

/** 是否为自定义 API 模式(需要显示 baseUrl/apiKey/model 输入框) */
const isCustomMode = computed(() => apiDraft.value.apiMode === 'custom')

/** 是否为后端模式(地址内置,无需填写) */
const isBackendMode = computed(() => apiDraft.value.apiMode === 'backend')

/** 当前对话的角色名(后端模式连接测试用它解析该角色的固定地址) */
const currentCharName = computed(() =>
  chatStore.activeSub !== null
    ? chatStore.conversations[chatStore.activeSub]?.name ?? ''
    : '',
)

// ---- 提示词编辑 ---------------------------------------------------------
/** 所有可编辑提示词的角色名列表(内置角色) */
const characterNames = computed(() => Object.keys(CHARACTER_PROMPTS))

/**
 * 当前提示词绑定的角色(跟随当前对话,不可手动切换)
 *
 * 无选中对话 / 角色不在内置表 → 空串(草稿为空,编辑区禁用)。
 */
const selectedCharacter = computed<string>(() =>
  currentCharName.value && characterNames.value.includes(currentCharName.value)
    ? currentCharName.value
    : '',
)
/** 当前角色的提示词草稿 */
const characterPromptDraft = ref('')

/** 当前角色是否为内置角色(有默认提示词可恢复) */
const isBuiltinCharacter = computed(() =>
  selectedCharacter.value ? selectedCharacter.value in CHARACTER_PROMPTS : false,
)

// 打开弹窗时同步本地缓存
watch(
  () => props.open,
  (open) => {
    if (open) {
      apiDraft.value = { ...settingsStore.apiConfig }
      // 智能总结草稿(打开时从 store 同步)
      summaryDraft.value = { ...settingsStore.summaryConfig }
      // 提示词草稿跟随当前对话角色(角色由 currentCharName 派生,无需手动同步)
      characterPromptDraft.value = settingsStore.getCharacterPrompt(selectedCharacter.value)
    }
  },
)

// ---- 实验性功能:智能总结配置草稿 -----------------------------------------
/** 智能总结配置草稿(打开时从 store 同步,保存时写回) */
const summaryDraft = ref({ ...settingsStore.summaryConfig })

/** 智能总结是否为默认模式(内置 Agnes API) */
const isSummaryDefaultMode = computed(() => summaryDraft.value.apiMode === 'default')

/** 智能总结是否为自定义模式(用户自填 Base URL/Key/模型) */
const isSummaryCustomMode = computed(() => summaryDraft.value.apiMode === 'custom')

/** 切换智能总结 API 模式(默认/自定义),同步草稿 */
function switchSummaryApiMode(mode: 'default' | 'custom') {
  summaryDraft.value.apiMode = mode
}

/** 保存智能总结配置到 store(持久化) */
function saveSummaryConfig() {
  settingsStore.updateSummaryConfig({ ...summaryDraft.value })
}

// 当前对话角色变化时同步提示词草稿(空角色 → 空提示词)
watch(selectedCharacter, (name) => {
  if (name) {
    characterPromptDraft.value = settingsStore.getCharacterPrompt(name)
  } else {
    characterPromptDraft.value = ''
  }
})

/** 保存 API 配置 */
function saveApiConfig() {
  settingsStore.updateApiConfig(apiDraft.value)
}

/**
 * 切换 API 模式(默认 API / 自定义 API):立即持久化,无需点保存。
 * 切换时同步草稿与 store,关闭弹窗再打开仍是新模式。
 */
function switchApiMode(mode: 'custom' | 'backend') {
  apiDraft.value.apiMode = mode
  settingsStore.updateApiConfig({ apiMode: mode })
}

/** 连接测试状态 */
const testState = ref<'idle' | 'testing' | 'success' | 'fail'>('idle')
const testMessage = ref('')

/** 测试 API 连接 */
async function onTestConnection() {
  testState.value = 'testing'
  testMessage.value = ''
  try {
    const result = isBackendMode.value
      ? await testBackendConnection({ ...apiDraft.value }, currentCharName.value)
      : await testApiConnection({ ...apiDraft.value })
    testState.value = result.ok ? 'success' : 'fail'
    testMessage.value = result.message
  } catch {
    testState.value = 'fail'
    testMessage.value = '连接失败: 未知错误'
  }
}

/** 保存角色提示词 */
function saveCharacterPrompt() {
  if (!selectedCharacter.value) return
  settingsStore.setPromptOverride(selectedCharacter.value, characterPromptDraft.value)
}

/** 重置角色提示词为内置默认 */
function resetCharacterPrompt() {
  if (!selectedCharacter.value) return
  settingsStore.resetPromptOverride(selectedCharacter.value)
  characterPromptDraft.value = settingsStore.getCharacterPrompt(selectedCharacter.value)
}

/** 重置全部设置 */
function resetAll() {
  settingsStore.resetAll()
  apiDraft.value = { ...settingsStore.apiConfig }
  if (selectedCharacter.value) {
    characterPromptDraft.value = settingsStore.getCharacterPrompt(selectedCharacter.value)
  }
}

</script>

<template>
  <Transition name="ab">
    <div v-if="open" class="sd" @click.self="emit('close')">
      <div class="sd__panel">
        <!-- 关闭按钮 -->
        <button class="sd__close" type="button" aria-label="关闭" @click="emit('close')">×</button>

        <h2 class="sd__title">设置</h2>

        <!-- 标签页切换 -->
        <div class="sd__tabs" ref="tabsEl">
          <button
            v-for="t in tabs"
            :key="t.key"
            class="sd__tab"
            :class="{ 'sd__tab--active': activeTab === t.key }"
            :ref="(el) => setTabEl(t.key, el)"
            type="button"
            @click="activeTab = t.key"
          >{{ t.label }}</button>
          <!-- 黄色滑动指示条(跟随激活标签;就绪后才开动画) -->
          <div
            class="sd__tab-indicator"
            :class="{ 'sd__tab-indicator--anim': tabAnim }"
            :style="tabIndicatorStyle"
          ></div>
        </div>

        <div class="sd__body">
          <!-- API 配置 -->
          <div v-if="activeTab === 'api'" class="sd__section">
            <!-- 模式切换 -->
            <div class="sd__field">
              <span class="sd__label">API 模式</span>
              <div class="sd__mode-toggle">
                <!-- 黄色滑动指示条(跟随当前模式) -->
                <div class="sd__mode-indicator" :class="{ 'sd__mode-indicator--right': isCustomMode }"></div>
                <button
                  class="sd__mode-btn"
                  :class="{ 'sd__mode-btn--active': isBackendMode }"
                  type="button"
                  @click="switchApiMode('backend')"
                >默认 API</button>
                <button
                  class="sd__mode-btn"
                  :class="{ 'sd__mode-btn--active': isCustomMode }"
                  type="button"
                  @click="switchApiMode('custom')"
                >自定义 API</button>
              </div>
            </div>

            <!-- 自定义模式:baseUrl + apiKey + model -->
            <template v-if="isCustomMode">
              <label class="sd__field">
                <span class="sd__label">Base URL</span>
                <input
                  v-model="apiDraft.baseUrl"
                  class="sd__input"
                  type="text"
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label class="sd__field">
                <span class="sd__label">API Key</span>
                <input
                  v-model="apiDraft.apiKey"
                  class="sd__input"
                  type="password"
                  placeholder="sk-..."
                />
              </label>
              <label class="sd__field">
                <span class="sd__label">模型名</span>
                <input
                  v-model="apiDraft.model"
                  class="sd__input"
                  type="text"
                  placeholder="deepseek-v4-flash / glm-5.2 / kimi-k3 / ..."
                />
              </label>
            </template>

            <template v-if="isBackendMode">
              <p class="sd__desc">当前干员：{{ currentCharName || '未选中' }}</p>
              <p class="sd__desc">服务方免费 API 模式下无法自定义提示词与世界观背景，请切换到「自定义 API」以启用。</p>
            </template>

            <!-- 温度 + 最大 Token(自定义 API 模式显示,默认 API 模式由脚本决定,不显示) -->
            <template v-if="!isBackendMode">
              <label class="sd__field">
                <span class="sd__label">温度 ({{ apiDraft.temperature.toFixed(1) }})</span>
                <input
                  v-model.number="apiDraft.temperature"
                  class="sd__slider"
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                />
              </label>
              <label class="sd__field">
                <span class="sd__label">最大 Token 数</span>
                <input
                  v-model.number="apiDraft.maxTokens"
                  class="sd__input"
                  type="number"
                  min="1"
                  max="32768"
                />
              </label>

              <!-- 自定义提示词(仅自定义 API 模式) -->
              <div class="sd__divider"></div>
              <p class="sd__desc">自定义提示词（当前干员：{{ selectedCharacter || '未选中' }}）</p>
              <div class="sd__char-textarea-wrap">
                <textarea
                  v-model="characterPromptDraft"
                  class="sd__textarea sd__textarea--tall"
                  rows="10"
                  :placeholder="selectedCharacter ? '输入提示词…' : '请先选择一个对话'"
                  :disabled="!selectedCharacter"
                ></textarea>
              </div>
              <div class="sd__actions">
                <button class="sd__btn sd__btn--primary" type="button" :disabled="!selectedCharacter" @click="saveCharacterPrompt">保存</button>
                <button v-if="isBuiltinCharacter" class="sd__btn" type="button" @click="resetCharacterPrompt">恢复默认</button>
              </div>

              <!-- 全局世界观背景(文本,仅自定义 API 模式) -->
              <div class="sd__divider"></div>
              <p class="sd__desc">世界观背景（全局世界观设定，将注入角色对话上下文）</p>
              <textarea
                v-model="settingsStore.worldView"
                class="sd__textarea sd__textarea--tall"
                rows="6"
                placeholder="输入全局世界观，例如：这是终末地工业时代，源石技艺与科技并存…"
              ></textarea>
            </template>
            <div class="sd__actions">
              <button class="sd__btn sd__btn--primary" type="button" @click="saveApiConfig">保存</button>
              <button
                class="sd__btn"
                type="button"
                :disabled="testState === 'testing'"
                @click="onTestConnection"
              >{{ testState === 'testing' ? '测试中...' : '连接测试' }}</button>
              <button class="sd__btn" type="button" @click="resetAll">重置全部</button>
            </div>
            <p v-if="testState === 'success'" class="sd__hint sd__hint--ok">{{ testMessage }}</p>
            <p v-else-if="testState === 'fail'" class="sd__hint sd__hint--warn">{{ testMessage }}</p>
            <p v-else-if="settingsStore.isApiConfigured" class="sd__hint sd__hint--ok">API 已配置</p>
            <p v-else class="sd__hint sd__hint--warn">API 未配置,请填写以上信息后保存</p>
          </div>

          <!-- 实验性功能 -->
          <div v-if="activeTab === 'experimental'" class="sd__section">
            <!-- 思考模式开关(原 API 页移入;全局,实时持久化,随请求体传给后端) -->
            <div class="sd__field">
              <span class="sd__label">思考模式</span>
              <button
                type="button"
                class="sd__btn"
                :class="{ 'sd__btn--primary': settingsStore.thinkEnabled }"
                @click="settingsStore.thinkEnabled = !settingsStore.thinkEnabled"
              >{{ settingsStore.thinkEnabled ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="settingsStore.thinkEnabled ? 'sd__hint--ok' : 'sd__hint--warn'">
                {{ settingsStore.thinkEnabled ? '已开启：角色会先深度思考再回答' : '已关闭：角色直接回答' }}
              </p>
            </div>

            <div class="sd__divider"></div>

            <!-- 强制每条搜索开关(全局,实时持久化,随请求体传 force_search) -->
            <div class="sd__field">
              <span class="sd__label">强制每条搜索</span>
              <button
                type="button"
                class="sd__btn"
                :class="{ 'sd__btn--primary': settingsStore.forceSearch }"
                @click="settingsStore.forceSearch = !settingsStore.forceSearch"
              >{{ settingsStore.forceSearch ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="settingsStore.forceSearch ? 'sd__hint--ok' : 'sd__hint--warn'">
                {{ settingsStore.forceSearch ? '已开启：每条消息都强制触发联网搜索' : '已关闭：仅按需触发搜索' }}
              </p>
            </div>

            <div class="sd__divider"></div>

            <!-- 沉浸式对话模式开关(全局,实时持久化,随请求体传 immersive_mode) -->
            <div class="sd__field">
              <span class="sd__label">沉浸式对话模式</span>
              <button
                type="button"
                class="sd__btn"
                :class="{ 'sd__btn--primary': settingsStore.immersiveMode }"
                @click="settingsStore.immersiveMode = !settingsStore.immersiveMode"
              >{{ settingsStore.immersiveMode ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="settingsStore.immersiveMode ? 'sd__hint--ok' : 'sd__hint--warn'">
                {{ settingsStore.immersiveMode ? '已开启：角色回复保留括号内动作/神态/情景描写' : '已关闭：角色只输出对话语句，禁止括号描写' }}
              </p>
            </div>

            <div class="sd__divider"></div>

            <!-- 智能总结 -->
            <div class="sd__field">
              <span class="sd__label">智能总结</span>
              <button
                type="button"
                class="sd__btn"
                :class="{ 'sd__btn--primary': summaryDraft.enabled }"
                @click="summaryDraft.enabled = !summaryDraft.enabled"
              >{{ summaryDraft.enabled ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="summaryDraft.enabled ? 'sd__hint--ok' : 'sd__hint--warn'">
                {{ summaryDraft.enabled ? '已开启：历史超过 50 条时自动总结前段对话' : '已关闭：仅发送最近 50 条消息' }}
              </p>
            </div>

            <!-- 智能总结 API 模式切换(默认 Agnes API / 自定义) -->
            <div v-if="summaryDraft.enabled" class="sd__field">
              <span class="sd__label">总结 API 模式</span>
              <div class="sd__mode-toggle">
                <div
                  class="sd__mode-indicator"
                  :class="{ 'sd__mode-indicator--right': isSummaryCustomMode }"
                ></div>
                <button
                  class="sd__mode-btn"
                  :class="{ 'sd__mode-btn--active': isSummaryDefaultMode }"
                  type="button"
                  @click="switchSummaryApiMode('default')"
                >默认 Agnes API</button>
                <button
                  class="sd__mode-btn"
                  :class="{ 'sd__mode-btn--active': isSummaryCustomMode }"
                  type="button"
                  @click="switchSummaryApiMode('custom')"
                >自定义 API</button>
              </div>
              <p class="sd__hint" v-if="isSummaryDefaultMode">
                使用项目内置 Agnes API(无需填写密钥),模型 agnes-2.5-flash。
              </p>
            </div>

            <!-- 自定义总结 API 配置 -->
            <template v-if="summaryDraft.enabled && isSummaryCustomMode">
              <label class="sd__field">
                <span class="sd__label">Base URL</span>
                <input
                  v-model="summaryDraft.baseUrl"
                  class="sd__input"
                  type="text"
                  placeholder="https://api.agnes-ai.cn/v1"
                />
              </label>
              <label class="sd__field">
                <span class="sd__label">API Key</span>
                <input
                  v-model="summaryDraft.apiKey"
                  class="sd__input"
                  type="password"
                  placeholder="sk-..."
                  autocomplete="off"
                />
              </label>
              <label class="sd__field">
                <span class="sd__label">模型名</span>
                <input
                  v-model="summaryDraft.model"
                  class="sd__input"
                  type="text"
                  placeholder="agnes-2.5-flash"
                />
              </label>
            </template>

            <!-- 智能总结保存按钮 -->
            <div v-if="summaryDraft.enabled" class="sd__actions">
              <button class="sd__btn sd__btn--primary" type="button" @click="saveSummaryConfig">保存总结设置</button>
            </div>
          </div>

          <!-- 数据管理(内嵌 DataManagerDialog 功能:统计/导出/导入/清空) -->
          <div v-if="activeTab === 'data'" class="sd__section">
            <DataManagerDialog :open="open" embedded />
          </div>

          <!-- 关于 -->
          <div v-if="activeTab === 'about'" class="sd__section sd__about">
            <h3 class="sd__about-title">明日方舟：终末地 Baker AI 聊天模拟器</h3>

            <div class="sd__about-block">
              <h4 class="sd__about-heading">更新日志</h4>
              <div class="sd__about-log">
                <p class="sd__about-log-date">2026-08-16</p>
                <p class="sd__about-log-desc">优化移动端界面操作体验</p>
                <p class="sd__about-log-desc">修复了移动端界面消失的Bug</p>
                <p class="sd__about-log-date">2026-08-14</p>
                <p class="sd__about-log-desc">修复了数据导入导致干员消失的问题</p>
                <p class="sd__about-log-desc">预设模型换为agnes-2.5-flash</p>
                <p class="sd__about-log-date">2026-08-13</p>
                <p class="sd__about-log-desc">预览版上线</p>
              </div>
            </div>

            <div class="sd__about-block">
              <h4 class="sd__about-heading">相关链接</h4>
              <ul class="sd__about-links">
                <li><a href="https://github.com/NCreeper233/endfield-baker-chat" target="_blank" rel="noopener">GitHub</a></li>
                <li><a href="https://space.bilibili.com/1143315127" target="_blank" rel="noopener">哔哩哔哩</a></li>
              </ul>
            </div>

            <div class="sd__about-block">
              <h4 class="sd__about-heading">相关项目</h4>
              <ul class="sd__about-links">
                <li><a href="https://ark.ncreeper.top/" target="_blank" rel="noopener">明日方舟：终末地风格LOGO生成器</a></li>
                <li><a href="https://baker.ncreeper.top/" target="_blank" rel="noopener">明日方舟：终末地 Baker 模拟器</a></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

.sd {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.75);

  &__panel {
    position: relative;
    width: 560px;
    max-width: calc(100vw - 24px); // 移动端窄屏适配
    max-height: 80vh;
    padding: 28px 32px 20px;
    border-radius: 0;
    background-color: $color-dialog-bg;
    // 灰色正方形网格纹理(菜单背景):横竖 1px 细线交叉成 24px 格子
    background-image:
      linear-gradient(to right, rgba(134, 134, 133, 0.12) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(134, 134, 133, 0.12) 1px, transparent 1px);
    background-size: 24px 24px;
    border: 1px solid $color-dialog-border;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;

    // 菜单内所有元素一律直角(含伪元素,如滑块圆点)
    *,
    *::before,
    *::after {
      border-radius: 0 !important;
    }

    > *:not(.sd__close) {
      position: relative;
      z-index: 1;
    }
  }

  &__close {
    position: absolute;
    top: 12px;
    right: 16px;
    z-index: 2;
    background: none;
    border: none;
    color: $color-text-primary;
    font-size: 24px;
    cursor: pointer;
    opacity: 0.5;
    line-height: 1;
    &:hover { opacity: 1; }
  }

  &__title {
    margin: 0 0 16px;
    font-family: $font-harmony;
    font-size: 20px;
    font-weight: 600;
    color: $color-text-primary;
  }

  &__tabs {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  &__tab {
    padding: 8px 16px;
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    font-family: $font-harmony;
    font-size: 14px;
    cursor: pointer;
    transition: color 0.2s;

    &:hover { color: rgba(255, 255, 255, 0.8); }

    &--active {
      color: $color-text-primary;
    }
  }

  // 黄色滑动指示条:紧贴标签栏下边框,平滑滑到激活标签下方
  &__tab-indicator {
    position: absolute;
    bottom: -1px;
    left: 0;
    height: 2px;
    background: #ffef00;
    pointer-events: none;
    transition: none; // 默认无过渡(首次定位/重开弹窗直接到位)

    &--anim {
      transition: transform 0.25s ease, width 0.25s ease;
    }
  }

  &__body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  &__section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  &__label {
    font-family: $font-harmony;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
  }

  &__input {
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    color: $color-text-primary;
    font-family: $font-harmony;
    font-size: 14px;
    outline: none;
    transition: border-color 0.2s;

    &:focus { border-color: rgba(255, 255, 255, 0.3); }
    &::placeholder { color: rgba(255, 255, 255, 0.25); }
  }

  // 隐藏的背景图文件选择框(由"上传背景"按钮触发)
  &__file {
    display: none;
  }

  &__slider {
    width: 100%;
    accent-color: #ffef00;
  }

  &__textarea {
    width: 100%;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    color: $color-text-primary;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.6;
    resize: vertical;
    outline: none;
    transition: border-color 0.2s;

    &:focus { border-color: rgba(255, 255, 255, 0.3); }
    &::placeholder { color: rgba(255, 255, 255, 0.25); }
    &:disabled { opacity: 0.4; cursor: not-allowed; }

    &--tall { min-height: 320px; }
  }

  &__select {
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    color: $color-text-primary;
    font-family: $font-harmony;
    font-size: 14px;
    outline: none;
    cursor: pointer;

    option { background: $color-dialog-bg; }
  }

  &__mode-toggle {
    position: relative;
    display: flex;
    gap: 0;
    border-radius: 0;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }

  // 黄色滑动指示条:占一半宽度,随模式左右滑动
  &__mode-indicator {
    position: absolute;
    top: 0;
    left: 0;
    width: 50%;
    height: 100%;
    background: #ffef00;
    pointer-events: none;
    transition: transform 0.25s ease;

    &--right {
      transform: translateX(100%);
    }
  }

  &__mode-btn {
    position: relative;
    z-index: 1;
    flex: 1;
    padding: 8px 12px;
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    font-family: $font-harmony;
    font-size: 13px;
    cursor: pointer;
    transition: color 0.2s;

    &:hover { color: rgba(255, 255, 255, 0.8); }

    // 激活态(黄底上)悬停时保持深色文字,不被 hover 变白
    &--active,
    &--active:hover {
      color: #1a1a1a;
    }
  }

  &__char-textarea-wrap {
    position: relative;
  }

  // 分区分隔线(自定义 API 分支内的提示词/世界观区块)
  &__divider {
    height: 1px;
    margin: 12px 0;
    background: rgba(255, 255, 255, 0.12);
  }

  &__desc {
    margin: 0 0 4px;
    font-family: $font-harmony;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
    line-height: 1.5;
  }

  &__actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  &__btn {
    padding: 8px 20px;
    border: 1px solid #f0eeee;
    border-radius: 0;
    background: #f0eeee; // 不透明亮灰(次要操作按钮)
    color: #1a1a1a;
    font-family: $font-harmony;
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;

    &:hover { background: #dcdcdc; }
    &:disabled { opacity: 0.4; cursor: not-allowed; }

    &--primary {
      background: #ffef00;
      border-color: #ffef00;
      color: #1a1a1a;

      &:hover { background: #e6d936; }
    }
  }

  &__hint {
    margin: 0;
    font-family: $font-harmony;
    font-size: 13px;

    &--ok { color: rgba(100, 255, 100, 0.7); }
    &--warn { color: rgba(255, 180, 80, 0.8); }
  }

  // ---- 关于样式 -------------------------------------------------------------
  &__about {
    gap: 16px;
  }

  &__about-title {
    margin: 0 0 4px;
    font-family: $font-harmony;
    font-size: 18px;
    font-weight: 600;
    color: $color-text-primary;
    text-align: center;
  }

  &__about-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__about-heading {
    margin: 0;
    font-family: $font-harmony;
    font-size: 15px;
    font-weight: 500;
    color: $color-text-primary;
  }

  &__about-log {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__about-log-date {
    margin: 8px 0 2px;
    font-family: $font-harmony;
    font-size: 16px;
    font-weight: 600;
    color: $color-text-primary;

    &:first-child {
      margin-top: 0;
    }
  }

  &__about-log-desc {
    margin: 0;
    padding-left: 10px;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.65);
  }

  &__about-links {
    margin: 0;
    padding: 0;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.65);
    list-style: none;

    a {
      color: #ffef00;
      text-decoration: none;

      &:hover {
        color: #fff983;
      }
    }
  }
}
</style>
