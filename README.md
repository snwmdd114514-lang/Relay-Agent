# Relay Agent v0.7.0

**Relay Agent** 是一个把 DeepSeek 网页和本机工具运行时连接起来的轻量 Agent。

品牌已经从旧名称迁移为 Relay Agent；为兼容现有提示词与工具循环，AI 的工具代码块语言标记暂时仍使用：

```text
```cuckoo
...
```
```

这只是协议标记，不再是产品名称。














## License & Upstream

Relay Agent is licensed under the GNU General Public License v3.0 or later
(GPL-3.0-or-later).

This project is based on and modifies:

[Cuckoo Code](https://github.com/wangyongpeng90/cuckoo-code)

Copyright in the original portions remains with the original authors.

Modifications made as part of Relay Agent are copyright © 2026 snwmdd114514-lang.

Relay Agent is an independently maintained modified version of the upstream project.
It is not an official release of Cuckoo Code.

Major modifications include, but are not limited to:

* Relay Agent runtime and local tool execution bridge
* DeepSeek web integration
* Message queue and 2–4 second randomized send throttling
* Web tools such as `webSearch`, `webLooking`, `webHtml`, and `webDownload`
* XML / DSML compatibility handling
* Agent configuration, local project management, skills, MCP, and session handling
* Branding, directory structure, startup logic, and other implementation changes

The original project and its authors are not responsible for bugs, behavior, or changes introduced in Relay Agent.

---

## 许可证与上游项目

Relay Agent 采用 GNU General Public License v3.0 或更高版本
（GPL-3.0-or-later）进行许可。

本项目基于并修改自：

[Cuckoo Code](https://github.com/wangyongpeng90/cuckoo-code)

原始代码部分的版权仍归原作者所有。

Relay Agent 中新增和修改部分的版权 © 2026 snwmdd114514-lang 所有。

Relay Agent 是基于上游项目独立维护的修改版本，
并非 Cuckoo Code 的官方版本。

主要修改内容包括但不限于：

* Relay Agent 本地运行时与工具执行桥
* DeepSeek 网页端集成
* 消息发送队列与随机 2～4 秒发送节流
* `webSearch`、`webLooking`、`webHtml`、`webDownload` 等 Web 工具
* XML / DSML 工具调用兼容处理
* Agent 配置、项目目录、Skill、MCP 与 Session 管理
* 品牌名称、目录结构、启动逻辑及其他实现层面的修改

Relay Agent 中新增的功能、修改以及由此产生的问题，不代表原项目作者的行为或责任。


## v0.7.0 主要变化

- 全面改名为 **Relay Agent / 中继智能体**。
- 新数据目录：`~/.relay-agent`。
- 首次运行自动从旧 `~/.cuckoo-agent` 复制 Key、项目配置、插件、MCP 配置和 Session。
- 新 launchd label：`com.relay.agent`；升级时会停止旧 `com.cuckoo.agent`。
- 所有发往 DeepSeek 的自动消息统一进入一个发送队列。
- **每条消息发送前随机等待 2～4 秒**，避免工具结果、纠正提示、初始化提示和终端桥消息前后抢发。
- 发送队列严格串行：上一条没有真正发送完成，下一条不会提交。
- GUI 状态卡会显示 `发送节流：随机 2～4 秒 · 队列 N`。
- 保留 XML/DSML 检测、JSON 降级兼容、`auto_all` 自动执行模式和 Web 工具。

## 架构

```text
用户
 ↓
DeepSeek 网页
 ↓
AI 输出 ```cuckoo JavaScript
 ↓
Relay Tampermonkey 前端
 ↓
2～4 秒发送节流 / 串行队列
 ↓
127.0.0.1:8899
 ↓
Relay Agent
 ↓
JS Runner → Tool Registry → 文件 / Shell / Git / MCP / Skill / Web
 ↓
真实执行结果
 ↓
Relay 前端
 ↓
2～4 秒随机等待
 ↓
结果自动回给 DeepSeek
```

网页端不直接获得 Node.js、`fs`、`process` 或 `require`。电脑权限集中在本地 Relay Agent。

## 安装 / 升级

保持目录结构：

```text
relay-agent-v0.7.0/
├── agent.command
├── relay-agent.user.js
├── systemPrompt.md
└── agent/
    ├── server.js
    ├── chat-client.js
    └── systemPrompt.md
```

macOS：

1. 双击 `agent.command`。
2. 如果之前安装过旧版本，选择 `12) 强制修复 / 升级后台`。
3. 选择 `9) 测试 API`，确认：

```json
{
  "service": "relay-agent",
  "version": "0.7.0-agent"
}
```

4. 选择 `10) 设置 Agent 项目目录`。
5. 选择 `4) 显示并复制 API Key`。
6. 在 Tampermonkey 安装 `relay-agent.user.js`。
7. 打开 DeepSeek，Relay Agent → 设置 → 粘贴本机 Key → 保存并连接。
8. 状态应至少显示：后台可达、API 已认证、DeepSeek 网页桥在线。
9. 点击“初始化 Relay”。

新安装生成的 Key 以 `relaykey-` 开头。旧版本已有的 `cckey-` 会继续兼容，不必重新生成。

## 发送节流

所有 `sendDeepSeek()` 调用现在统一经过一个 Promise 队列：

```text
初始化提示词 ─┐
工具结果      ├→ Relay Send Queue → 随机等待 2～4 秒 → DeepSeek
DSML/XML 提示 ┤
终端 11 消息  ┘
```

延迟范围固定：

```text
最小 2000 ms
最大 4000 ms
```

这样可以减少这些问题：

- 工具结果刚回灌，下一条纠正提示又立刻覆盖输入框；
- 终端 11 和网页工具循环同时发消息导致串线；
- DeepSeek 页面还没完成上一轮 DOM 更新就收到下一条自动消息；
- 多个工具块连续执行后结果消息顺序错乱。

## 工具调用协议

需要工具时，AI 应只输出：

```cuckoo
const files = await glob("src/**/*.js");
log(files);
```

Relay Agent 会等 DeepSeek 回复稳定后再解析，不会执行流式输出中的半截 JavaScript。

## XML / DSML 检测

这些会触发自动纠正：

```text
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke>
<invoke name="...">...</invoke>
<antml:invoke name="...">
```

普通解释文字中的 `<invoke>` 不触发。

触发后前端会自动告诉 AI 改用 `cuckoo` JavaScript 代码块。连续 3 次后熔断，防止无限循环。

## 自动执行模式

网页“设置 → 执行策略”或 `agent.command` 菜单 `13`：

```text
ask      = 高风险 / 未知操作按需确认
auto_all = 普通审批全部自动通过
```

`auto_all` 不会关闭系统破坏级硬拒绝。例如明显破坏系统的命令仍直接拒绝。

## Web API

```cuckoo
log(await webSearch("DeepSeek Harness", 8));
log(await webLooking("https://example.com"));
log(await webHtml("https://example.com"));
log(await webDownload("https://example.com/file.zip", "downloads/file.zip"));
```

- `webSearch(query, maxResults?)`：网页搜索。
- `webLooking(url)`：提取适合 AI 阅读的网页正文。
- `webHtml(url)`：获取原始 HTML。
- `webDownload(url, path?)`：下载文件到 `projectDir` 内。
- 兼容别名：`webFetch()` → `webLooking()`，`webPreview()` → `webHtml()`。

## 终端菜单 11

`11) 通过 DeepSeek 网页对话` 不调用模型 API：

```text
终端 → Relay Agent → Tampermonkey → 已登录 DeepSeek 网页
                                  ↓
                            工具闭环继续运行
                                  ↓
终端 ← Relay Agent ← 最终网页回答
```

因此不需要 DeepSeek/OpenAI API Key。

## 文件

- `agent.command`：macOS 后台管理器。
- `agent/server.js`：Relay Agent Runtime。
- `agent/chat-client.js`：菜单 11 的网页桥终端客户端。
- `relay-agent.user.js`：DeepSeek Tampermonkey 前端。
- `systemPrompt.md`：初始化提示词。
- `test-agent.py`：端到端回归测试。
