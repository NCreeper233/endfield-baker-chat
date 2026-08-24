<script setup lang="ts">
// =============================================================================
// 网站迁移公告弹窗(MigrationNoticeDialog)
// -----------------------------------------------------------------------------
// 进入网站时弹出,告知用户近期站点迁移更新并引导加入 QQ 群获取通知。
// 两个操作:
//   - 确定:仅关闭本次弹窗(下次进入仍显示)
//   - 不再显示:写入 localStorage 永久关闭(刷新/重开均不再弹出)
// =============================================================================
import { ref } from 'vue'

/** "不再显示"标记的 localStorage key */
const DISMISSED_KEY = 'endfield-baker-settings-migration-notice-dismissed'

/** 是否展示弹窗:进入时读取 localStorage,"不再显示"过则不弹 */
const open = ref(!localStorage.getItem(DISMISSED_KEY))

/** 仅关闭本次弹窗 */
function onConfirm() {
  open.value = false
}

/** 永久关闭:落库后关闭弹窗 */
function onDismissForever() {
  try {
    localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // 存储不可用(隐私模式等)时退化为仅本次关闭
  }
  open.value = false
}
</script>

<template>
  <Transition name="mn">
    <div v-if="open" class="mn">
      <div class="mn__panel">
        <h2 class="mn__title">公告</h2>
        <p class="mn__text">
          近期网站将进行迁移更新，请在使用本网站的用户加入QQ群：<strong class="mn__qq">1105542731</strong> 以获取相关通知公告，谢谢配合！<br>预计明天上正式更新，请提前保存好个人数据，新版本和旧版本的数据可以互相导入导出！<br>重要的事情说三遍：请一定尽快加入QQ群！<br>群号：1105542731<br>群号：1105542731<br>群号：1105542731
        </p>
        <div class="mn__actions">
          <button class="mn__btn mn__btn--primary" type="button" @click="onConfirm">确定</button>
          <button class="mn__btn" type="button" @click="onDismissForever">不再显示</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 遮罩 + 居中深色面板(与删除确认弹窗同款外壳)
@include dialog-shell(mn, 380px, 12px);

.mn {
  // 公告弹窗不允许点遮罩误关,确保用户看到内容
  &__qq {
    font-weight: 700;
    color: $color-text-primary;
    user-select: all;
  }

  &__actions {
    justify-content: center;
  }
}
</style>
