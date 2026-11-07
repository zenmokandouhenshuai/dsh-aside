# 旁问 · dsh-aside

> 给 DeepSeek Harness 的旁问卡片：主线在推进时，突然卡在一个术语上，就地提问、就地看答案，**主对话一行都不多**。

## 它解决什么

写论文或写代码的时候，主线正在推进，你突然卡在一个词上 —— NZSP 到底是什么？固-固界面阻抗指什么？

三条路各有代价：

| 做法 | 代价 |
|---|---|
| 在主线里直接问 | 主对话被塞进一堆名词解释，翻记录时找不到刚才那段正经事 |
| 另开一个会话 | 上下文全丢，你得重新交代背景 |
| 切到浏览器搜 | 更慢，而且搜到的不是"在这段话里"的意思 |

旁问走第四条：**问在浮卡里，答案也留在浮卡里**。答案不进 session log，所以不进 prompt，主线上下文一个字都不涨。

## 它做什么

- 输入框右侧一个 `? 问` 按钮，或 `Alt+Q` 呼出浮卡
- 选中一段文字再点，选中的内容作为上下文一起发过去，问法自动预填成「什么是 XXX？」
- `Enter` 问、`Shift+Enter` 换行、`Esc` 关闭
- 每条问答自动存档，侧栏「旁问存档」是一整页：本地搜索、按天分组、复制、删除
- 回答用哪条模型路由是可切的，见下文

## 安装

需要 DeepSeek Harness（profile 方式启动）。这是一个 bundle，Host 半和 Client 半在同一个包里。

**方式一，让 Agent 装**（推荐）：把仓库目录指给它，它会调用 `plugin_manager` 的 `install_bundle`：

```
target: <这个仓库的绝对路径>
```

**方式二，命令行**：

```bash
dsh plugin --profile <你的 profile> add <这个仓库的绝对路径>
```

装完**必须重启一次**：Host 半的模块在启动时装载，改完不重启不会生效。

包名是 `@local/dsh-aside`，这是本机 profile 里的安装标识，不需要为了公开仓库改名。如果要改名，记得同时改 `package.json` 的 `name` 和 `cordis.patch.yml` 里的 `name`，否则 profile 解析不到。

## 回答走哪条路由

路由是**存下来的偏好**，不是写死的常量，存在 `~/.dsh/dsh-aside/config.json`：

```json
{
  "mode": "dp",
  "provider": "dp",
  "model": "deepseek-v4.1-flash-1017"
}
```

- `mode: "dp"` —— 走你在 `cordis.patch.yml` 里配的那条路由（便宜的中转、自建网关都行）
- `mode: "auto"` —— 跟着应用的默认模型走（`agent-default-model`），通常是官方账号

界面上有对应的两个按钮，卡片顶部和存档页顶部都有，点一下即时生效、不用重启。分两种模式是为了省钱：中转有额度就用中转，额度用完了点一下换官方账号。

首次启动如果配置文件不存在，插件会按内置的 `dp` 路由写一份，之后以文件为准。

## 数据

```
~/.dsh/dsh-aside/config.json    路由偏好
~/.dsh/dsh-aside/asides.json    问答存档（纯文本 JSON，可读可编辑可备份）
```

两条设计上的取舍：

1. **存档不进 session log。** 进来的话每次请求都要跟着 prompt 重算，等于为了一句名词解释反复付费；放在磁盘上，只在你要看的时候取一条。
2. **卸载插件不删数据。** 目录是独立的，删包不删档。

## 实现

Host 半注册五条 JSON 路由，全部挂在应用自己的 Origin 下，和页面共用登录态：

| 路由 | 作用 |
|---|---|
| `GET  /dsh-aside/list` | 存档 + 当前生效的路由 |
| `POST /dsh-aside/ask` | 一个问题，返回一条新存档 |
| `POST /dsh-aside/delete` | 删一条 |
| `GET  /dsh-aside/health` | 装了什么、路由解析成什么 |
| `POST /dsh-aside/route` | 切换 `dp` / `auto` |

回答通过 `ctx.llm.stream()` 直接调用 profile 自己的模型路由，所以计费和主对话同源，不需要另外配 key。存档写入用「临时文件 + rename」的原子写，进程被杀不会留下半个文件。

Client 半占四个 slot：

| Slot | 内容 |
|---|---|
| `conversation.input.right` | 输入框右侧的 `? 问` 按钮 |
| `shell.overlay` | 浮卡本体 |
| `sidebar.panellist` | 侧栏「旁问存档」入口 |
| `main` | 存档整页 |

样式只用 `--dsw-alias-*` 主题 token，所以跟随深色/浅色主题，没有硬编码颜色。

## 已知限制

- **不是流式**：等整段答案回来才显示，一个短定义约 2~4 秒（实测 2.4 秒）。
- **没有锚点**：存档里没有记录对话位置，所以点不回"当时那句话"。目前只存了选中的文本和 session id。
- **不能插回主线**：旁问和主线是两条独立的路，没有"把这条升格成正式一问"的功能。
- **只在 Windows + desktop profile 上验证过**：代码本身不依赖平台，但没有别的环境实测记录。

## License

MIT