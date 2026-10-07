# 明日方舟：终末地 Baker AI 聊天模拟器

基于《明日方舟：终末地》世界观的 AI 角色聊天应用（前端）。支持与干员一对一对话，也支持多角色群聊。

> 本仓库**只有前端**。默认 API 模式所依赖的后端服务（对话网关、群聊服务、角色提示词加载、RAG 语料库）不包含在本仓库内；如果不想依赖任何后端，可以使用「自定义 API 模式」直连你自己的 OpenAI 兼容端点。

## 功能

**对话**
- 单聊：35 名干员 + 管理员，角色卡可折叠、可增删子会话
- 群聊：自选成员成组，三种发言形式
  - 轮流模式：玩家发言后成员按顺序各回一条
  - 智能模式：由系统判断下一个该谁说话，可持续进行、玩家随时打断
  - 指定模式：点名某个成员单独回复
- 旁观模式：自己不参演，只给话题，角色们自行推进对话
- 图片消息（Vision）、心情表情、AI 推荐回复、消息重新生成 / 删除 / 导出截图

**动作 / 神态描写（括号内容）**
- 括号描写居中：把 `()` `（）` 内的动作、神态从气泡里抽出来，单独渲染成一条居中文本
- 彩色括号描写：居中描写按角色的**作战属性**上色（物理 / 灼热 / 电磁 / 寒冷 / 自然 / 超域）
- 居中我方括号内容：自己发出的消息里最前面那对括号同样居中显示
- 沉浸式对话模式：反方向开关 —— 让角色只输出台词，不再写括号描写

**其他**
- 智能消息分条：按换行、左括号前、句末标点后分条，且**成对的括号描写整体不拆开**
- 思考模式 / 联网搜索（替代 RAG 语料库）/ 强制每条搜索 / 使用新版提示词
- 智能总结：上下文达到设定窗口的 80% 时把前段历史压成"前情提要"
- SSE 流式回复、上下文 token 预算与压缩、用量（token / 缓存命中）统计面板
- 弹窗：公告 / 提醒 / 更新（读取服务端单一 JSON），首次进入的使用偏好询问
- 数据全部保存在本地（网页端 IndexedDB / 打包端 JSON 文件），支持导出、导入完整的 zip 或单文件 JSON

## API 模式

| 模式 | 说明 |
| --- | --- |
| 默认 API | 走官方后端：角色提示词、RAG 语料库、群聊调度都在服务端完成 |
| 自定义 API | 直连用户自填的 OpenAI 兼容端点（Base URL / Key / 模型名）；**单聊与群聊都在前端本地实现**，不经过任何后端 |
| 旧版 API | 早期直连方式，保留兼容 |

## 开发

要求 Node 20+。

```bash
npm install
npm run dev        # 本地开发服务器
npm run build      # vue-tsc 类型检查 + 构建到 dist/
npm run preview    # 预览构建产物
```

打包桌面端（Electron，Windows 免安装包）：

```bash
npm run electron:dir
```

移动端使用 Capacitor 配置（`capacitor.config.ts`）自行构建 APK。

## 目录结构

```
src/
  components/    界面组件（character 角色卡 / chat 聊天区 / layout 弹窗）
  composables/   聊天管线：useAiChat 单聊、useGroupChat 群聊、useChatRows 布局
  stores/        Pinia：chat（卡片树 / 消息）、settings（全部设置项）、usage
  utils/         llm / backend / customApi 请求层、aiText 分条、zipExport 导入导出
  constants/     角色表（含属性）、提示词、素材表、几何与配色
  types/         领域类型
public/          开屏素材、月亮彩蛋模型、字体
docs/            角色资料
```

## 数据与隐私

- 对话记录、设置、角色卡全部**本地存储**，不上传服务器。
- 导出包（zip / JSON）内含完整消息、图片与 API 配置，请自行妥善保管。
- 网页端请在浏览器（Edge / Chrome）中打开；从 QQ 等内置浏览器打开会导致无法导出数据。

## 素材来源

| 素材     | 来源                                                         | 备注                   |
| -------- | ------------------------------------------------------------ | ---------------------- |
| 角色头像 | [森空岛《明日方舟：终末地》WIKI](https://wiki.skland.com/endfield) | 素材版权为鹰角网络所有 |
| 干员资料 | [森空岛《明日方舟：终末地》WIKI](https://wiki.skland.com/endfield) | 素材版权为鹰角网络所有 |
| 表情     | 《明日方舟：终末地》游戏内                                   | 素材版权为鹰角网络所有 |
| 其他资源 | 《明日方舟：终末地》游戏内                                   | 素材版权为鹰角网络所有 |
| 字体     | [HarmonyOS Sans](https://developer.huawei.com/consumer/cn/design/resource-V1/) |                        |

> 本项目为第三方同人作品，与上海鹰角网络科技有限公司及《明日方舟：终末地》官方无任何关联，仅供学习与交流，禁止用于任何商业用途。

## 参考项目

- https://github.com/Wanye-7300/baker-dx
- https://github.com/blacktunes/sr-message-maker

## 相关项目

- 明日方舟：终末地风格LOGO生成器
  - https://ark.ncreeper.top/
  - https://github.com/NCreeper233/endfield-logo-maker/
- 明日方舟：终末地 Baker 模拟器
  - https://baker.ncreeper.top/
  - https://github.com/NCreeper233/endfield-baker-maker/
