# ⛔ 临时彩蛋:月亮(中秋兑换码)

> **这不是产品功能,是临时彩蛋,迟早要删干净。**
> 全部实现只落在一个目录 + 两处带 `⛔` 标记的接线,按下面的步骤删完即可。

## 它是什么

从独立小应用 `moon`(three.js + cannon-es)整体移植的月亮物理玩具,**藏在兑换码后面**:

- 在「设置 → 关于 → 兑换码」输入 **`中秋快乐`** 兑换成功后,月亮才出现(且**从这一刻起**才开始下载资源)
- 拖动月亮甩出去 → 弹性撞墙/落地(物理引擎跑真实碰撞)
- 滚轮 / 双指捏合 → 缩放光标下的那个月亮
- 右键 / 移动端长按 → 菜单:复制(最多 20 个)· 删除 · 清空
- **手机陀螺仪默认开启、没有任何开关**:出场即接管重力 —— 竖持 = 正常下落、
  左右侧倾 = 往低的一侧滚、平放 ≈ 失重飘着(`deviceorientation` /
  `deviceorientationabsolute` / `devicemotion` 三路任一到手即生效;
  接口要求 HTTPS 安全上下文,iOS 那种必须手势授权的会在出场后的第一次点击补一次授权)
- 操作提示不是画在月亮上的,而是兑换成功后显示在关于页输入框下方的那行**绿色小字**
- 整层是"点得穿"的浮层(`pointer-events: none`),只有真的点在月亮上才接管手势,不挡网站操作

### 三条行为约定

1. **不预下载**:兑换之前,`three` / `cannon-es` / `moon_small.glb` / `draco` **一个字节都不请求**。
   已实测:生产构建下从加载到开屏结束、进设置、进关于页,全程 0 条月亮相关请求;
   点「兑换」之后约 30ms 才开始下载(共 5 个请求)。
2. **不持久化**:兑换状态只是一个模块级 `ref`(见 `redeem.ts`),不写 localStorage、不进 pinia。
   刷新页面 = 没兑换过:月亮消失、绿色小字也没了,要重新输码。
3. **不碰产品逻辑**:彩蛋自己盯 `.splash-overlay` 从 DOM 消失来判断开屏结束,
   `SplashOverlay` / `App.vue` 没有为它加过任何回调。

## 文件清单(删除时照着删)

| 位置 | 内容 |
| --- | --- |
| `src/easteregg/moon/` | `redeem.ts`(兑换状态 + 文案)· `MoonEgg.vue`(门控壳)· `MoonViewer.vue`(玩具本体)· 本文件 |
| `public/easteregg/moon/` | `moon_small.glb`(模型)· `draco/`(draco 解码器,3 个文件) |
| `src/App.vue` | 两行 `⛔` 接线:一行 `import MoonEgg`,一行 `<MoonEgg />` |
| `src/components/layout/SettingsDialog.vue` | 三处 `⛔` 块:关于页的兑换码区块(模板)、`redeem` 的 import(脚本)、兑换处理函数与 `.egg-redeem*` 样式 |
| `package.json` | 依赖 `three` 与 `cannon-es`(只有彩蛋用) |

## 彻底删除步骤

1. 删目录:
   - `src/easteregg/`(整个删掉)
   - `public/easteregg/`(整个删掉)
2. `src/App.vue`:删掉 `⛔` 那两行(`import MoonEgg ...` 与 `<MoonEgg />`,连同注释)
3. `src/components/layout/SettingsDialog.vue`:搜 `⛔` 与 `egg-redeem`,删掉这四小块 ——
   关于页里的兑换码 `div`、脚本里的 `import { MOON_HINT, moonRedeemed, redeemMoon }`、
   `eggCode` / `eggWrong` / `onRedeemEgg` 那一段、以及样式表末尾的 `.egg-redeem {}` 整块
4. 卸依赖:`npm uninstall three cannon-es`
5. 收尾检查(应无任何命中):
   - 全局搜 `MoonEgg`、`easteregg`、`egg-redeem`、`redeemMoon`、`moon_small`、`cannon-es`
   - `npm run build` 通过,且产物里不再有 `MoonViewer-*` chunk 与 `dist/easteregg/`

## 设计上为了"好删"做的取舍

- **状态与文案收在一处**:兑换码、提示文案、是否已兑换都在 `redeem.ts`,
  产品代码里只 `import` 三个符号,删除时不会有散落的字面量。
- **不污染主包也不预下载**:`MoonViewer.vue` 是异步组件(`defineAsyncComponent`),
  且只在"已兑换 + 开屏结束"时才渲染 —— `three` / `cannon-es` 因此被切成独立 chunk,
  动态 import 的时机就是兑换成功的瞬间。删掉彩蛋后主包体积不变。
- **资源自带目录**:模型与 draco 解码器都在 `public/easteregg/moon/` 下,删目录即可。
- **样式全 scoped**:没有往全局样式表里加任何选择器;`SettingsDialog` 里那几行兑换码样式
  也刻意写成独立顶层选择器(不塞进 `.sd` 嵌套),为的就是整块可删。
