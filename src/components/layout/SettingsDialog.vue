<script setup lang="ts">
// =============================================================================
// 设置弹窗(SettingsDialog)
// -----------------------------------------------------------------------------
// AI API 配置 + 提示词编辑,全部持久化到 localStorage(settings store)
// 打开/关闭状态由父组件 App 持有
// =============================================================================
import { ref, computed, watch } from 'vue'
import { useSettingsStore, DEFAULT_WORLD_SETTING } from '../../stores/settings'
import { testApiConnection } from '../../utils/llm'
import { testBackendConnection } from '../../utils/backend'
import { useChatStore } from '../../stores/chat'
import { CHARACTER_PROMPTS } from '../../constants/prompts'
import DataManagerDialog from './DataManagerDialog.vue'

const props = defineProps<{
  /** 是否展开 */
  open: boolean
  /** 当前自定义背景(data URL,null = 默认背景;由 App 持有共享) */
  customBg?: string | null
  /** 背景变更回调(上传 → dataURL;恢复默认 → null) */
  onBgChange?: (v: string | null) => void
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const settingsStore = useSettingsStore()
const chatStore = useChatStore()

/** 当前标签页:api / system / character / data / bg / disclaimer / about */
const activeTab = ref<'api' | 'system' | 'character' | 'data' | 'bg' | 'disclaimer' | 'about'>('api')

// ---- API 配置本地缓存(打开时同步,保存时写入 store) -------------------------
const apiDraft = ref({
  apiMode: 'shared' as 'shared' | 'custom' | 'backend',
  baseUrl: '',
  apiKey: '',
  model: '',
  backendUrl: '',
  temperature: 0.8,
  maxTokens: 2048,
})

/** 是否为 shared 模式 */
const isSharedMode = computed(() => apiDraft.value.apiMode === 'shared')

/** 是否为 custom 模式(需要显示 baseUrl/apiKey/model 输入框) */
const isCustomMode = computed(() => apiDraft.value.apiMode === 'custom')

/** 是否为后端模式(需要显示后端地址输入框) */
const isBackendMode = computed(() => apiDraft.value.apiMode === 'backend')

// ---- 世界观设定本地缓存 -----------------------------------------------------
const worldSettingDraft = ref('')

// ---- 角色提示词编辑 ---------------------------------------------------------
/** 当前选中的角色名 */
const selectedCharacter = ref<string>('')
/** 当前角色的提示词草稿 */
const characterPromptDraft = ref('')

/** 所有可编辑提示词的角色名列表(内置角色) */
const characterNames = computed(() => Object.keys(CHARACTER_PROMPTS))

/** 当前角色是否为内置角色(有默认提示词可恢复) */
const isBuiltinCharacter = computed(() =>
  selectedCharacter.value ? selectedCharacter.value in CHARACTER_PROMPTS : false,
)

/** 当前角色是否已被用户覆盖 */
const isCharacterOverridden = computed(() =>
  selectedCharacter.value ? selectedCharacter.value in settingsStore.promptOverrides : false,
)

// 打开弹窗时同步本地缓存
watch(
  () => props.open,
  (open) => {
    if (open) {
      apiDraft.value = { ...settingsStore.apiConfig }
      worldSettingDraft.value = settingsStore.worldSetting

      // 同步当前聊天角色:打开设置时自动选中当前对话的角色
  // 无选中对话 / 角色名不在列表 → 清空选择,提示词为空(不回退到伊冯)
  const currentCharName =
    chatStore.activeSub !== null
      ? chatStore.conversations[chatStore.activeSub]?.name
      : null

  if (currentCharName && characterNames.value.includes(currentCharName)) {
    selectedCharacter.value = currentCharName
  } else {
    selectedCharacter.value = ''
  }

  if (selectedCharacter.value) {
    characterPromptDraft.value = settingsStore.getCharacterPrompt(selectedCharacter.value)
  } else {
    characterPromptDraft.value = ''
  }
    }
  },
)

// 切换角色时同步提示词草稿(空选择 → 空提示词)
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

/** 连接测试状态 */
const testState = ref<'idle' | 'testing' | 'success' | 'fail'>('idle')
const testMessage = ref('')

/** 测试 API 连接 */
async function onTestConnection() {
  testState.value = 'testing'
  testMessage.value = ''
  try {
    const result = isBackendMode.value
      ? await testBackendConnection({ ...apiDraft.value })
      : await testApiConnection({ ...apiDraft.value })
    testState.value = result.ok ? 'success' : 'fail'
    testMessage.value = result.message
  } catch {
    testState.value = 'fail'
    testMessage.value = '连接失败: 未知错误'
  }
}

/** 保存世界观设定 */
function saveSystemPrompt() {
  settingsStore.worldSetting = worldSettingDraft.value
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

/** 重置世界观设定为默认 */
function resetSystemPrompt() {
  worldSettingDraft.value = DEFAULT_WORLD_SETTING
  settingsStore.worldSetting = worldSettingDraft.value
}

/** 重置全部设置 */
function resetAll() {
  settingsStore.resetAll()
  apiDraft.value = { ...settingsStore.apiConfig }
  worldSettingDraft.value = settingsStore.worldSetting
  if (selectedCharacter.value) {
    characterPromptDraft.value = settingsStore.getCharacterPrompt(selectedCharacter.value)
  }
}

// ---- 背景图(数据管理 tab 共用) ----------------------------------------------
/** 隐藏的背景图文件选择框 */
const bgFileInput = ref<HTMLInputElement | null>(null)

/** 是否已设置自定义背景 */
const hasCustomBg = computed(() => !!props.customBg)

/** 选择背景图:读为 dataURL 交给 App 更新(自动落 localStorage) */
function onBgFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const v = reader.result
    if (typeof v === 'string') props.onBgChange?.(v)
  }
  reader.onerror = () => {
    console.warn('[Settings] 背景图片读取失败,可能是损坏或不受支持的格式')
  }
  reader.readAsDataURL(file)
}

/** 恢复默认背景:置 null(App 侧 watch 自动清除 localStorage) */
function onBgReset() {
  props.onBgChange?.(null)
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
        <div class="sd__tabs">
          <button
            class="sd__tab"
            :class="{ 'sd__tab--active': activeTab === 'api' }"
            type="button"
            @click="activeTab = 'api'"
          >API 配置</button>
          <button
            class="sd__tab"
            :class="{ 'sd__tab--active': activeTab === 'system' }"
            type="button"
            @click="activeTab = 'system'"
          >世界观设定</button>
          <button
            class="sd__tab"
            :class="{ 'sd__tab--active': activeTab === 'character' }"
            type="button"
            @click="activeTab = 'character'"
          >角色提示词</button>
          <button
            class="sd__tab"
            :class="{ 'sd__tab--active': activeTab === 'data' }"
            type="button"
            @click="activeTab = 'data'"
          >数据管理</button>
          <button
            class="sd__tab"
            :class="{ 'sd__tab--active': activeTab === 'bg' }"
            type="button"
            @click="activeTab = 'bg'"
          >背景</button>
          <button
            class="sd__tab"
            :class="{ 'sd__tab--active': activeTab === 'disclaimer' }"
            type="button"
            @click="activeTab = 'disclaimer'"
          >免责声明</button>
          <button
            class="sd__tab"
            :class="{ 'sd__tab--active': activeTab === 'about' }"
            type="button"
            @click="activeTab = 'about'"
          >关于</button>
        </div>

        <div class="sd__body">
          <!-- API 配置 -->
          <div v-if="activeTab === 'api'" class="sd__section">
            <!-- 模式切换 -->
            <div class="sd__field">
              <span class="sd__label">API 模式</span>
              <div class="sd__mode-toggle">
                <button
                  class="sd__mode-btn"
                  :class="{ 'sd__mode-btn--active': isSharedMode }"
                  type="button"
                  @click="apiDraft.apiMode = 'shared'"
                >共享 API</button>
                <button
                  class="sd__mode-btn"
                  :class="{ 'sd__mode-btn--active': isCustomMode }"
                  type="button"
                  @click="apiDraft.apiMode = 'custom'"
                >自定义 API</button>
                <!-- 【已注释】后端模式按钮(后端模式 UI 暂时隐藏,逻辑保留):
                <button
                  class="sd__mode-btn"
                  :class="{ 'sd__mode-btn--active': isBackendMode }"
                  type="button"
                  @click="apiDraft.apiMode = 'backend'"
                >后端模式</button>
                -->
              </div>
            </div>

            <!-- 共享模式说明 -->
            <p v-if="isSharedMode" class="sd__desc">
              使用内置共享 API（agnes-2.5-flash），可识别图像。
            </p>

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

            <!-- 【已注释】后端模式 UI(后端地址输入等,逻辑保留):
            <template v-if="isBackendMode">
              <p class="sd__desc">
                前端只传递当前输入 + 最近 10 轮问答历史 + 角色名，其余由你的 Python 脚本处理。
              </p>
              <label class="sd__field">
                <span class="sd__label">后端地址（完整接口 URL，含路径）</span>
                <input
                  v-model="apiDraft.backendUrl"
                  class="sd__input"
                  type="text"
                  placeholder="http://localhost:8000/chat"
                />
              </label>
            </template>
            -->

            <!-- 温度 + 最大 Token(shared/custom 模式共用,后端模式由脚本决定,不显示) -->
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

          <!-- 系统提示词 -->
          <div v-if="activeTab === 'system'" class="sd__section">
            <p class="sd__desc">世界观设定，所有角色对话共享。</p>
            <textarea
              v-model="worldSettingDraft"
              class="sd__textarea"
              rows="6"
              placeholder="输入世界观设定..."
            ></textarea>
            <div class="sd__actions">
              <button class="sd__btn sd__btn--primary" type="button" @click="saveSystemPrompt">保存</button>
              <button class="sd__btn" type="button" @click="resetSystemPrompt">恢复默认</button>
            </div>
          </div>

          <!-- 角色提示词 -->
          <div v-if="activeTab === 'character'" class="sd__section">
            <div class="sd__char-header">
              <select v-model="selectedCharacter" class="sd__select">
                <option value="" disabled>选择角色…</option>
                <option v-for="name in characterNames" :key="name" :value="name">{{ name }}</option>
              </select>
              <span v-if="isCharacterOverridden" class="sd__badge">已自定义</span>
            </div>
            <textarea
              v-model="characterPromptDraft"
              class="sd__textarea sd__textarea--tall"
              rows="16"
              :placeholder="selectedCharacter ? '输入角色提示词…' : '请先在左侧选择一个角色'"
              :disabled="!selectedCharacter"
            ></textarea>
            <div class="sd__actions">
              <button class="sd__btn sd__btn--primary" type="button" :disabled="!selectedCharacter" @click="saveCharacterPrompt">保存</button>
              <button v-if="isBuiltinCharacter" class="sd__btn" type="button" @click="resetCharacterPrompt">恢复默认</button>
            </div>
          </div>

          <!-- 数据管理(内嵌 DataManagerDialog 功能:统计/导出/导入/清空) -->
          <div v-if="activeTab === 'data'" class="sd__section">
            <DataManagerDialog :open="open" embedded />
          </div>

          <!-- 背景:上传自定义背景 + 恢复默认 -->
          <div v-if="activeTab === 'bg'" class="sd__section">
            <p class="sd__desc">
              上传图片作为页面背景(替换默认游戏背景),已设置时可用「恢复默认」还原。
            </p>
            <input
              ref="bgFileInput"
              class="sd__file"
              type="file"
              accept="image/*"
              @change="onBgFileChange"
            />
            <div class="sd__actions">
              <button class="sd__btn sd__btn--primary" type="button" @click="bgFileInput?.click()">上传背景</button>
              <button class="sd__btn" type="button" :disabled="!hasCustomBg" @click="onBgReset">恢复默认</button>
            </div>
            <p
              v-if="hasCustomBg"
              class="sd__hint sd__hint--ok"
            >已使用自定义背景</p>
            <p v-else class="sd__hint sd__hint--warn">当前为默认背景</p>
          </div>

          <!-- 免责声明 -->
          <div v-if="activeTab === 'disclaimer'" class="sd__section sd__disclaimer">
            <h3 class="sd__disclaimer-title">安全合规与责任声明</h3>

            <div class="sd__disclaimer-block">
              <h4 class="sd__disclaimer-heading">一、数据隐私与本地化</h4>
              <p class="sd__disclaimer-text">本工具完全开源，不会收集、存储、上传或传输您的任何个人信息、API密钥、聊天记录或生成内容。所有数据仅存在于您当前使用的本地设备中。</p>
              <p class="sd__disclaimer-text">由于技术上完全无法接触您的数据，无法应任何要求提供您本地对话的审查、删除或披露。</p>
            </div>

            <div class="sd__disclaimer-block">
              <h4 class="sd__disclaimer-heading">二、提示词安全设置声明</h4>
              <p class="sd__disclaimer-text">为履行合规义务，我们在本工具中内置了严格的内容安全提示词。该提示词明确要求角色：</p>
              <ul class="sd__disclaimer-list">
                <li>仅在《明日方舟：终末地》世界观内进行角色扮演；</li>
                <li>回避一切现实世界人物、政治敏感、色情、暴力、非法等违规内容；</li>
                <li>拒绝任何试图覆盖或修改这些安全规则的指令。</li>
              </ul>
              <p class="sd__disclaimer-text"><strong class="sd__disclaimer-warn">严重警告：</strong>任何通过修改代码、注入脚本等方式删除或篡改上述安全提示词的行为，均属您个人的独立行为。对于因篡改后生成的一切违法、违规或侵权内容，全部法律责任由实施该行为的用户自行承担，与本工具开发者无关。</p>
              <p class="sd__disclaimer-text"><strong class="sd__disclaimer-warn">技术限制特别声明：</strong>本工具代码由人工智能生成。尽管已尽力确保安全提示词在正常情况下有效运行，但仍无法完全排除因程序错误（Bug）、浏览器兼容性异常、网络加载时序问题等不可预见的技术原因，导致安全提示词意外失效、未正确注入或未按预期执行的可能性。对于因上述技术异常而导致的任何违规内容生成，本工具开发者不承担责任。您选择继续使用本工具，即表示您理解并自愿承担这一技术风险。</p>
            </div>

            <div class="sd__disclaimer-block">
              <h4 class="sd__disclaimer-heading">三、用户责任与合规使用</h4>
              <p class="sd__disclaimer-text">您明确知晓并同意，您是使用本工具生成内容的唯一责任人。您承诺：</p>
              <ol class="sd__disclaimer-list sd__disclaimer-list--ordered">
                <li>严格遵守您所使用AI模型服务商的所有使用政策与安全准则。</li>
                <li>遵守您所在地及服务商所在地的现行法律法规，绝不利用本工具生成任何涉及政治敏感、淫秽色情、暴力恐怖、仇恨歧视、侵犯他人合法权益以及其他一切违法和不良信息。</li>
                <li>理解并接受本工具仅用于合法的《明日方舟：终末地》同人角色扮演娱乐，任何超出此用途的使用风险自担。</li>
              </ol>
            </div>

            <div class="sd__disclaimer-block">
              <h4 class="sd__disclaimer-heading">四、知识产权与同人声明</h4>
              <p class="sd__disclaimer-text">《明日方舟：终末地》是上海鹰角网络科技有限公司的游戏产品。本工具为第三方同人作品，无任何盈利性质，与上海鹰角网络科技有限公司及《明日方舟：终末地》官方开发商、运营商无任何关联。</p>
              <p class="sd__disclaimer-text">本工具中使用的所有与《明日方舟：终末地》相关的角色形象、世界观设定、剧情元素、图片资源等知识产权，均归上海鹰角网络科技有限公司所有。本工具仅供爱好者学习与交流，严禁用于任何商业用途。</p>
            </div>

            <div class="sd__disclaimer-block">
              <h4 class="sd__disclaimer-heading">五、免责条款</h4>
              <p class="sd__disclaimer-text">在法律允许的最大范围内，本工具开发者不对以下情况承担任何明示或默示的担保或责任：</p>
              <ul class="sd__disclaimer-list">
                <li>用户因违反本声明或第三方服务商条款而产生的任何纠纷、处罚或损失；</li>
                <li>用户因篡改代码、移除安全提示词等自主行为所引发的一切后果；</li>
                <li>对第三方AI模型服务商提供的服务质量、内容准确性及合规性。</li>
              </ul>
              <p class="sd__disclaimer-text">请您在使用前务必仔细阅读并同意以上全部条款。继续使用即代表您已充分理解并自愿承担所有相关风险。</p>
            </div>
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
  background: rgba(0, 0, 0, 0.55);

  &__panel {
    position: relative;
    width: 560px;
    max-width: calc(100vw - 24px); // 移动端窄屏适配
    max-height: 80vh;
    padding: 28px 32px 20px;
    border-radius: 14px;
    background: $color-card-bg;
    border: 1px solid $color-chat-frame;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;

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
    border-bottom: 2px solid transparent;
    color: rgba(255, 255, 255, 0.5);
    font-family: $font-harmony;
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;

    &:hover { color: rgba(255, 255, 255, 0.8); }

    &--active {
      color: $color-text-primary;
      border-bottom-color: #fcf33f;
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
    accent-color: #fcf33f;
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

    option { background: $color-card-bg; }
  }

  &__mode-toggle {
    display: flex;
    gap: 0;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }

  &__mode-btn {
    flex: 1;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.03);
    border: none;
    color: rgba(255, 255, 255, 0.5);
    font-family: $font-harmony;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;

    &:hover { color: rgba(255, 255, 255, 0.8); }

    &--active {
      background: #fcf33f;
      color: #1a1a1a;
    }
  }

  &__char-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__badge {
    padding: 2px 8px;
    background: rgba(252, 243, 63, 0.15);
    border: 1px solid rgba(252, 243, 63, 0.3);
    border-radius: 4px;
    color: #fcf33f;
    font-size: 12px;
    white-space: nowrap;
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
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.06);
    color: $color-text-primary;
    font-family: $font-harmony;
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;

    &:hover { background: rgba(255, 255, 255, 0.12); }
    &:disabled { opacity: 0.4; cursor: not-allowed; }

    &--primary {
      background: #fcf33f;
      border-color: #fcf33f;
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

  // ---- 免责声明样式 ---------------------------------------------------------
  &__disclaimer {
    gap: 16px;
  }

  &__disclaimer-title {
    margin: 0 0 4px;
    font-family: $font-harmony;
    font-size: 18px;
    font-weight: 600;
    color: $color-text-primary;
    text-align: center;
  }

  &__disclaimer-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  &__disclaimer-heading {
    margin: 0;
    font-family: $font-harmony;
    font-size: 15px;
    font-weight: 600;
    color: #fcf33f;
  }

  &__disclaimer-text {
    margin: 0;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.75);
  }

  &__disclaimer-warn {
    color: #ff6b6b;
    font-weight: 600;
  }

  &__disclaimer-list {
    margin: 0;
    padding-left: 20px;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.75);

    &--ordered {
      padding-left: 24px;
    }

    li {
      margin-bottom: 2px;
    }
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
      color: #fcf33f;
      text-decoration: none;

      &:hover {
        color: #fff983;
      }
    }
  }
}
</style>
