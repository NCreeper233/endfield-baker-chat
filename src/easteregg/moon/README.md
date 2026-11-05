# ⛔ 临时彩蛋：月亮（中秋兑换码）

> 不是产品功能，是临时彩蛋。整块删掉的步骤在最后。

## 它是什么

从独立小应用 `moon`（three.js + cannon-es）移植的月亮物理玩具，藏在兑换码后面：

- **入口**：公告页 → 「关于」页签 → 兑换码，输入 `中秋快乐`。**兑换成功那一刻**才开始下载资源
- 拖动月亮甩出去 → 弹性撞墙 / 落地（真实物理碰撞）
- 滚轮 / 双指捏合 → 缩放光标下的那个月亮
- 右键 / 移动端长按 → 菜单：复制（上限 20 个）· 删除 · 清空
- **手机陀螺仪默认开启、没有开关**：竖持 = 正常下落，侧倾 = 往低的一侧滚，平放 ≈ 失重飘着
- 操作提示不画在月亮上，而是兑换成功后显示在关于页输入框下方那行**绿色小字**（文案见 `redeem.ts` 的 `MOON_HINT`）
- 整层是 `pointer-events: none` 的浮层，只有真的点在月亮上才接管手势，不挡网站操作

## 三条约定

1. **不预下载**：兑换之前 `three` / `cannon-es` / `moon_small.glb` / `draco` 一个字节都不请求。
2. **不持久化**：状态只是一个模块级 `ref`（`redeem.ts`），不写 localStorage、不进 pinia；刷新 = 没兑换过，要重新输码。
3. **不碰产品逻辑**：自己盯 `.splash-overlay` 从 DOM 消失来判断开屏结束，`App.vue` / `SplashOverlay` 没为它加过回调。

## 文件清单（删除时照着删）

| 位置 | 内容 |
| --- | --- |
| `src/easteregg/moon/` | `redeem.ts`（状态 + 文案）· `MoonEgg.vue`（门控壳）· `MoonViewer.vue`（玩具本体）· 本文件 |
| `public/easteregg/moon/` | `moon_small.glb`（模型）· `draco/`（解码器，3 个文件） |
| `src/App.vue` | `⛔` 两行：`import MoonEgg` 与 `<MoonEgg />` |
| `src/components/layout/AnnouncementPage.vue` | `⛔` 三处：关于页的兑换码区块（模板）、`redeem` 的 import、`eggCode` / `eggWrong` / `onRedeemEgg` 与相关样式 |
| `package.json` | `three` / `cannon-es`（只有彩蛋用） |

## 删除步骤

1. 删目录：`src/easteregg/`、`public/easteregg/`
2. `src/App.vue`：删掉 `⛔` 那两行（连同注释）
3. `src/components/layout/AnnouncementPage.vue`：删掉兑换码区块（模板里的 `⛔` 段）、`import { MOON_HINT, moonRedeemed, redeemMoon }`、`eggCode` / `eggWrong` / `onRedeemEgg` 那段，以及只被它用的 `.an__about-ok` / `.an__about-warn`
4. 卸依赖：`npm uninstall three cannon-es`
5. 收尾检查（应无任何命中）：全局搜 `MoonEgg`、`easteregg`、`redeemMoon`、`moon_small`、`cannon-es`；`npm run build` 通过且产物里不再有 `MoonViewer-*` chunk

## 为了「好删」做的取舍

- **状态与文案收在一处**：兑换码、提示文案、是否已兑换都在 `redeem.ts`。
- **不污染主包**：`MoonViewer.vue` 是异步组件，只在「已兑换 + 开屏结束」时渲染 → `three` / `cannon-es` 被切成独立 chunk，删掉彩蛋后主包体积不变。
- **资源自带目录**：模型与 draco 都在 `public/easteregg/moon/`，删目录即可。
- **样式全 scoped**：没有往全局样式表加选择器。
