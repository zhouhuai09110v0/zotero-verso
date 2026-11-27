<p align="center">
  <img src="assets/banner.png" alt="Verso for Zotero：从一个词到一整篇，在 Zotero 里把外文文献读透" width="100%">
</p>

<h1 align="center">Verso for Zotero</h1>

<p align="center">
  <b>从一个词到一整篇，在 Zotero 里把外文文献读透。</b><br>
  划词、段落、整篇三种翻译；公式、图表、排版原样保留；用你已有的 GPT / Claude / Gemini 订阅，或国内直连的 DeepSeek。
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.9.2-D8432E">
  <img alt="zotero" src="https://img.shields.io/badge/Zotero-7%20%E2%80%93%2010-0F6E6E">
  <img alt="platform" src="https://img.shields.io/badge/Windows%20%C2%B7%20macOS-supported-1C1B19">
  <img alt="license" src="https://img.shields.io/badge/license-AGPL--3.0-blue">
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#功能">功能</a> ·
  <a href="#翻译引擎">引擎</a> ·
  <a href="#整篇翻译的运行环境">运行环境</a> ·
  <a href="#设置项说明">设置</a> ·
  <a href="#常见问题">常见问题</a> ·
  <a href="#更新日志">更新日志</a>
</p>

---

## 为什么用 Verso

读外文文献时，翻译需求其实有三种粒度，Verso 把它们都放进了 Zotero 阅读器：

| | 你想做的事 | Verso 的做法 |
|:-:|---|---|
| 🔤 | 这个词、这句话是什么意思？ | **划词翻译**：选中即出译文 |
| 📄 | 这一段没看懂 | **段落翻译**：`Alt` + 点击，译文出现在原文下方 |
| 💬 | 看了译文还是不懂 | **段落问答**：在段落卡片上点「问 AI」，向大模型提问、追问 |
| 📚 | 整篇都想对照着读 | **整篇翻译**：生成保留排版的双语 PDF，公式、图、表都在原位 |

在这之上，它还解决了几件长期让人头疼的事：

- **不用再买一份 API**：GPT、Claude 直接调用你本机已登录的命令行工具，走已有的订阅额度；
- **公式不再变乱码**：译文里的公式用 LaTeX 重排，复杂公式由 AI 引擎看图识别；
- **术语前后一致**：一张术语表对所有引擎生效；
- **不重复花钱**：译文缓存在本机，换排版、重新生成都不再消耗额度；
- **译文能留下来**：一键把原文和译文存进条目笔记，还能通过 MCP 让 Claude / Codex 读取你的文献库。

支持 **Zotero 7 / 8 / 9 / 10**，**Windows 和 macOS** 通用。

> 名字的由来：*verso* 是书页的「对页」。原文在一页，译文在它的对页。本插件原名「智译 CLI Translate」，自 0.7.0 起更名。

---

## 安装

1. 在本仓库文件列表中点开最新的 [`verso-0.9.2.xpi`](verso-0.9.2.xpi)，再点 **Download raw file** 下载。
   > 用 Firefox 下载时请右键链接选「另存为」，否则浏览器会尝试把它当作自己的扩展安装。
2. 打开 Zotero → **工具 → 插件**（Tools → Plugins）→ 右上角齿轮 → **从文件安装插件…**（Install Plugin From File…），选中刚下载的 `.xpi`。
3. 安装完成后无需重启。

### 更新

以后**不需要卸载重装**。打开 **Zotero 设置 → Verso**，最上面「版本与更新」里点 **检查更新**，有新版本就点 **立即更新**，直接覆盖安装，设置、术语表和翻译缓存都会保留。

- 插件每天会在后台检查一次，有新版本时右下角弹出提醒（只提醒，不会自己安装；可在同一处关闭）；
- GitHub 连不上时，自动改用国内可访问的 jsDelivr 镜像下载；
- 下载的文件会核对 `update.json` 里记录的 sha256，不一致会拒绝安装；
- 手动更新也一样：下载新的 `.xpi`，按上面第 2 步再装一次即可覆盖。

> **使用 VPN / 代理的话，请在代理软件里打开 TUN 模式**（也叫「虚拟网卡」「增强模式」）。只开「系统代理」时，GPT、Claude、Gemini 等命令行引擎可能连不上服务器。

装好后，**划词翻译和段落翻译立即可用**；整篇翻译需要先[配置一次运行环境](#整篇翻译的运行环境)。

> 文中的配图是按实际界面绘制的示意图，文献内容为虚构示例。

---

## 功能

### 1. 划词翻译

<p align="center"><img src="assets/feat-selection.png" alt="划词翻译示意图：选中文字后弹出深色译文卡片" width="100%"></p>

1. 在 Zotero 里打开任意 PDF。
2. 用鼠标选中一段文字。
3. 选区弹窗底部会出现一张深色卡片，自动用默认引擎翻译。

卡片上可以：

- 点 **Google / GPT / Claude / Gemini / DeepSeek** 换一个引擎重新翻译；
- 点 **复制** 把译文放进剪贴板；
- 点 **存入笔记**，原文和译文会追加到该条目下名为「划词翻译笔记」的笔记里（标题可在设置中修改）。

> 如果不想每次选中都自动翻译，在设置里关掉「选中文字后自动用默认引擎翻译」，之后手动点引擎按钮即可。

### 2. 段落翻译

<p align="center"><img src="assets/feat-paragraph.png" alt="段落翻译示意图：圈出原文段落，译文卡片显示在下方" width="100%"></p>

1. 在 PDF 阅读器里**按住 `Alt`（macOS：`⌥ Option`）点击任意一段**。
2. 这一段会被圈出，译文卡片从它正下方滑出。
3. 再点一次同一段，或点卡片右下角的 **✕**，即可收起。

卡片同样支持换引擎、复制、存入笔记。

**含公式的段落**：PDF 提取出来的文字常常丢掉分式和上下标（例如把 $L<\frac{c_1}{2a}$ 变成「L < c1」）。用 GPT / Claude / Gemini / deepseek-flash 时，插件会把这一段在 PDF 里的样子截图交给模型翻译，译文里的公式按排版显示；普通段落仍按文字翻译，速度不受影响。可在设置里关闭；Google 引擎始终按文字翻译。可以同时展开多个段落。缩放页面时卡片会跟着段落移动。

快捷键可以在设置里换成 `Ctrl`、`⌘ / Win`、`Shift`，或者关闭这个功能。段落翻译也可以单独指定引擎（例如划词用 Google，段落用 GPT）。

### 段落问答（问 AI）

读到看不懂的地方，直接在段落译文卡片里向大模型提问：

1. 按住 `Alt`（macOS：`⌥ Option`）点击段落，出现译文卡片；
2. 点卡片上的 **问 AI**，下方展开问答区；
3. 点快捷问题 **解释这一段 / 公式·符号 / 图表解读 / 说得通俗点 / 在全文的作用 / 局限与疑问**，或自己输入问题（Enter 发送，Shift+Enter 换行），可以连续追问；
4. 每条回答都可以 **复制** 或 **存入笔记**（追加到条目下的「划词翻译笔记」，带原文和页码）。

模型会参考：论文标题和摘要、这一段原文和译文、这一页的全文（可在设置里关闭），以及之前的问答。

- **公式**：回答里的公式会排版成真正的数学公式（分式、上下标、希腊字母），不再显示 `$` 符号；重要的式子单独居中显示。
- **看图**：问「公式 / 符号」或段落里有公式时，插件会把这一段在 PDF 里的样子截图发给模型；问「图表解读」时发送整页截图。这样模型读到的是印刷出来的公式和图表，而不是 PDF 提取出来、可能丢了分式和上下标的文字。需要能看图的引擎：GPT、Claude、Gemini、deepseek-flash（可在设置里关闭）。
- **表格**：模型给出的对比、数据可以显示为表格。
- 存入笔记时公式以 `$…$` 保存，Zotero 笔记编辑器会自动显示为公式。回答引擎可选 GPT / Claude / Gemini / DeepSeek（Google 不能用于问答），卡片上可以临时切换。

### 3. 整篇翻译（保留排版）

<p align="center"><img src="assets/feat-document.png" alt="整篇翻译示意图：逐段对照、左右对照、交替页、仅译文四种排版" width="100%"></p>

> 首次使用前请先完成[运行环境配置](#整篇翻译的运行环境)（只需一次）。

1. 在文库里**右键条目 →「Verso：整篇翻译（保留排版）」→ 选一个引擎**。
2. 等几分钟，Zotero 右下角会显示进度（识别段落 → 翻译段落 → 排版）。
3. 完成后，双语 PDF 会作为附件出现在条目下并自动打开。

四种排版：

| 排版 | 效果 | 适合 |
|---|---|---|
| **逐段对照**（推荐） | 每段原文下面紧接译文 | 精读，逐段核对 |
| **左右对照** | 左页原文、右页译文 | 宽屏并排阅读 |
| **交替页** | 一页原文、一页译文 | 打印或翻页阅读 |
| **仅译文** | 只保留译文，版式不变 | 快速通读 |

切换排版的两个入口：

- 文库右键 →「Verso：排版」：选择默认排版，或「按当前排版重新生成」；
- 阅读器工具栏的 **排版** 按钮：为当前文献直接生成另一种排版。

**换排版不会重新翻译**——已翻译的段落直接从本机缓存读取，不再消耗额度。

公式、图、表的处理：

- 译文里的公式用 LaTeX 重新排版，不会变成乱码；
- 图表中的文字也会翻译；
- 使用 GPT / Claude / Gemini / DeepSeek（deepseek-flash）时，复杂公式会「看图识别」，上下标、分式都能正确还原；
- 不需要翻译图片里的文字时，在设置中关闭「翻译图片中的文字」：图片保持原样，图注照常翻译，速度更快、更省额度；
- 默认跳过参考文献列表（可在设置中修改）。

---

## 翻译引擎

<p align="center"><img src="assets/feat-engines.png" alt="四种翻译引擎：Google、GPT、Claude、Gemini" width="100%"></p>

| 引擎 | 费用 | 需要什么 | 特点 |
|---|---|---|---|
| **Google** | 免费 | 无需配置 | 速度快；部分网络下会被限流（见[常见问题](#常见问题)） |
| **GPT** | 走 ChatGPT 订阅额度 | 本机已登录的 [Codex CLI](https://github.com/openai/codex) | 译文质量高，支持看图识别公式 |
| **Claude** | 走 Claude 订阅额度 | 本机已登录的 [Claude Code](https://claude.com/claude-code) | 译文质量高，支持看图识别公式 |
| **Gemini** | 走订阅或 API 额度 | [Antigravity](https://antigravity.google/)（`agy`）或 Gemini API Key | 填 API Key 时没有命令行启动延迟 |
| **DeepSeek** | 按用量付费，价格低 | [DeepSeek API Key](https://platform.deepseek.com/) | **国内可直连，不需要 VPN**；deepseek-flash 支持看图识别公式，deepseek-v4-pro 质量更好但不能看图 |

GPT、Claude 用的是你**本机已经登录的命令行工具**，走你自己的订阅额度，**不需要 API Key**。

DeepSeek 用官方 API：在 [platform.deepseek.com](https://platform.deepseek.com/) 申请 API Key，填到 **Zotero 设置 → Verso → DeepSeek** 即可，点「测试 DeepSeek」检查是否可用。插件会关闭 DeepSeek 的「思考模式」，翻译更快、更省钱。

### 安装命令行工具

| 引擎 | Windows | macOS |
|---|---|---|
| **GPT**（Codex CLI） | 先装 [Node.js](https://nodejs.org/)，然后在 PowerShell 运行 `npm install -g @openai/codex`，再运行 `codex login` | 安装 ChatGPT 桌面版（自带 Codex），或 `npm install -g @openai/codex` 后 `codex login` |
| **Claude**（Claude Code） | 先装 [Git for Windows](https://git-scm.com/download/win)，然后在 PowerShell 运行 `irm https://claude.ai/install.ps1 \| iex`，再运行 `claude` 登录 | 终端运行 `curl -fsSL https://claude.ai/install.sh \| bash`，再运行 `claude` 登录 |
| **Gemini** | 安装并登录 [Antigravity](https://antigravity.google/)，或在设置页填写 Gemini API Key | 同左 |

装好后，打开 **Zotero 设置 → Verso**，点 **「检测环境」**：找到的工具显示 ✓，没找到的会直接给出安装命令。每个引擎都有「测试」按钮。

- GPT 的模型可以点「读取我的模型」，从你账号可用的模型里选。
- 找不到命令行工具时，可以手动填写完整路径。例如 Windows 下 npm 安装的 Codex 一般在 `C:\Users\你的用户名\AppData\Roaming\npm\codex.cmd`。
- 命令行引擎每次调用需要几秒启动时间，所以划词翻译想要即时响应的话，建议默认引擎用 Google 或填了 API Key 的 Gemini。

---

## 整篇翻译的运行环境

<p align="center"><img src="assets/feat-setup.png" alt="一键配置翻译环境示意图" width="100%"></p>

整篇翻译需要一个本地 Python 环境（PDF 解析、版面识别模型、公式排版、文字识别）。插件可以一键装好，只需做一次，大约 5–15 分钟。

1. 打开 Zotero **设置**（Windows：编辑 → 设置；macOS：Zotero → 设置）→ 左侧 **Verso**。
2. 在最上面的「快速开始」里：
   - 国内网络保持勾选「使用国内镜像下载」（默认已勾选）；
   - 点 **「一键配置翻译环境」**。
3. 下方会实时显示进度。插件依次完成：
   1. 安装 [uv](https://docs.astral.sh/uv/)（Python 包管理器）；
   2. 用 uv 安装 [pdf2zh_next / BabelDOC](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（自带 Python 3.12，不影响你电脑上已有的 Python）；
   3. 安装公式排版（matplotlib）、模糊匹配（rapidfuzz）、文字识别（RapidOCR）；
   4. 下载中文字体（思源宋体）和版面识别模型。
4. 看到「全部完成」就可以用了。中途断网或失败，再点一次即可，已装好的部分会跳过。

---

## 设置项说明

位置：**Zotero 设置 → Verso**。

| 分组 | 设置项 | 说明 |
|---|---|---|
| 快速开始 | 检测环境 / 一键配置翻译环境 | 查看和安装整篇翻译所需组件 |
| 划词翻译 | 目标语言 | Google 用语言代码（如 `zh-CN`），大模型用语言名称（如「简体中文」） |
| | 默认引擎 | 划词时自动使用的引擎 |
| | 选中文字后自动翻译 | 关闭后需手动点引擎按钮 |
| | 笔记标题 | 「存入笔记」写入的笔记名称 |
| 段落翻译 | 快捷键 | `Alt` / `Ctrl` / `⌘·Win` / `Shift` + 点击，或关闭 |
| | 段落翻译引擎 | 可跟随默认引擎，也可单独指定 |
| GPT / Claude | CLI 路径、模型、推理强度 | 留空自动检测 |
| Gemini | API Key、模型、CLI 路径 | 二选一：API Key 或本机命令行 |
| 整篇翻译 | 默认排版 | 四种排版之一 |
| | 跳过参考文献 / 翻译图片中的文字 / 翻译表格 / 看图识别公式 | 按需开关 |
| | 并行数、超时 | 命令行引擎的并发和单次超时 |
| 术语表 | 每行一条 `原文=译文` | 对所有引擎生效 |
| MCP | 开关与令牌 | 供 Claude / Codex 等读取文献库 |

---

## 更多功能

<p align="center"><img src="assets/feat-more.png" alt="术语表、翻译缓存、存入笔记、MCP 接口" width="100%"></p>

### 术语表

在设置页的术语表里每行写一条，例如：

```
supply chain finance=供应链金融
tokenization=代币化
```

翻译时会要求引擎遵守这些译法，并在译后再做一次替换，保证全文一致。

### 翻译缓存

每个段落的译文按「原文 + 引擎 + 目标语言 + 术语表」缓存在本机：

- Windows：`%LOCALAPPDATA%\clitrans\Cache`
- macOS：`~/Library/Caches/clitrans`

同一篇文献换排版、重新生成、中断后重跑，都只翻译没翻过的部分。想强制重新翻译，删除上述文件夹即可。

### 存入笔记

划词卡片和段落卡片上都有「存入笔记」。点一下，原文（引用块）、译文、所用引擎和页码会追加到该条目下的同一篇笔记里，方便之后整理成读书笔记。笔记标题可在设置中修改。

### MCP 接口

开启后，插件在 Zotero 本地端口提供一个 [MCP](https://modelcontextprotocol.io/) 服务，Claude Code、Codex 等工具可以通过它检索你的文献库、读取条目信息和全文。地址和令牌显示在设置页，按页面提示复制到对应工具的配置里即可。接口只监听本机（`127.0.0.1`）。

---

## 常见问题

**划词后一直「翻译中」，然后提示 Google 超时或被拒绝？**
Google 的免费接口会对部分网络限流（返回人机验证页）。插件会在 10 秒后明确提示。解决办法：点卡片上的 GPT / Claude / Gemini，或在设置里把默认引擎换成其他引擎。

**Alt + 点击没有反应？**
- 确认是在 PDF 正文的文字上点击（扫描版 PDF 没有文字层，无法识别段落）；
- 页面刚打开时文字还在加载，插件会提示「这一页的文字还在加载」，稍等再点；
- 用命令行引擎（GPT / Claude）时需要等几秒，卡片上会有加载动画；
- 检查设置里的段落翻译快捷键是否被改过或关闭。

**GPT / Claude 翻译报「Reconnecting… 5/5」「Falling back from WebSockets」或超时？**
Codex / Claude Code 连不上自己的服务器。常见于代理软件开的是「系统代理」模式：从程序坞或开始菜单打开的 Zotero 没有代理环境变量，而这些命令行工具不读取系统代理。0.7.3 起插件会自动把 Zotero 使用的系统代理交给它们，一般无需处理；报错里会写明插件使用的代理地址。仍失败时请确认代理软件在运行、节点可用，或改用代理软件的 TUN 模式。

**一键配置报「tunnel error」「积极拒绝」「os error 10061」「ProxyError」？**
这是电脑上设置了代理，但代理软件（Clash、v2rayN、加速器、抓包工具等）没有在运行：开过「系统代理」后把软件关了，Windows 里的代理设置还留着。0.7.1 起插件会自动识别，并改为不经代理直接连接重试，一般无需处理。如果直连也失败：
- 网络必须走代理才能上网的，先打开代理软件再点「一键配置」；
- 不需要代理的，在 Windows 设置 → 网络和 Internet → 代理中关闭「使用代理服务器」，并删除环境变量 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，然后重启 Zotero。

**一键配置失败 / 很慢？**
保持勾选「使用国内镜像下载」后再试。如果卡在第 1 步（安装 uv），可以按 [uv 官方说明](https://docs.astral.sh/uv/getting-started/installation/)手动安装，再回来点「一键配置」。也可以在终端里手动执行（Windows 用 PowerShell）：

```bash
uv tool install --python 3.12 pdf2zh_next
```

执行完再点一次「一键配置翻译环境」，插件会补齐剩余组件。

**整篇翻译提示「运行环境还没有安装」？**
按上面的步骤点「一键配置翻译环境」。如果你用其他方式装了 pdf2zh_next，可以在设置页「Python 路径」里填它的 Python：
- Windows：`…\uv\tools\pdf2zh-next\Scripts\python.exe`
- macOS：`~/.local/share/uv/tools/pdf2zh-next/bin/python`

**图里的文字没翻译 / 编号位置不对？**
图中文字优先从 PDF 里提取。提取不到时用文字识别：macOS 用系统自带 OCR，Windows 用 RapidOCR。用 GPT / Claude / Gemini 引擎时，模型会直接看图读出文字和符号，效果最好。

**选区弹窗里还有别的文本框和按钮？**
那是你安装的其他 Zotero 插件添加的。Verso 只添加底部那张深色卡片。

---

## 隐私

- 只有你选择的引擎会收到要翻译的文字（以及使用 AI 引擎时的段落 / 图片截图），这和你平时直接使用这些服务一样。
- 插件本身不收集、不上传任何数据。
- 翻译缓存只保存在本机。
- MCP 接口只监听本机，并可设置访问令牌。

---

## 从「智译 CLI Translate」升级

Verso 就是原来的「智译 CLI Translate」，0.7.0 起更名并更换了图标：

- 已安装旧版的，直接安装最新的 `verso-0.7.x.xpi` 即可**覆盖升级**，不需要先卸载；
- 所有设置、术语表、翻译缓存都会保留；
- 设置页的名称从「智译 CLI」变为「Verso」，右键菜单从「智译：…」变为「Verso：…」；
- 仓库地址从 `zotero-clitrans` 变为 `zotero-verso`，旧链接会自动跳转。

---

## 更新日志

**0.9.2**
- 段落翻译：含公式的段落改为看图翻译，译文里的公式（分式、上下标、希腊字母）按排版显示，不再丢失；普通段落不受影响；
- 设置页「段落翻译」新增对应开关。

**0.9.1**
- 段落问答里的公式正确排版（基于 KaTeX，输出 MathML），不再出现 `$` 等符号；支持独立公式、表格；
- 问公式时把这一段的截图、问「图表解读」时把整页截图发给能看图的模型，公式和图表按印刷内容解读；
- 新增快捷问题「图表解读」和设置项「问公式和图表时让模型看图」。

**0.9.0**
- 新增 **段落问答**（参考 llm-for-zotero 的设计）：段落译文卡片上点「问 AI」，用快捷问题或自己输入，就这一段向大模型提问并追问；模型参考论文标题、摘要、本页全文和这一段的原文与译文；回答可复制、存入笔记；
- 设置页新增「段落问答」分组：开关、回答引擎、是否附带本页全文。

**0.8.0**
- 新增 **DeepSeek** 引擎：填 API Key 即可用，国内直连不需要 VPN；支持划词、段落、整篇翻译和术语表，deepseek-flash 还能看图识别公式和图中文字；
- 新增选项「翻译图片中的文字」：关闭后图片保持原样（不做文字识别、不翻译图中文字），图注照常翻译，整篇翻译更快、更省额度。

**0.7.5**
- 中文 Windows 上的报错不再是乱码：命令行工具和系统的输出按 UTF-8 / GBK 自动识别（例如「系统找不到指定的路径」）；
- 设置页新增开关「GPT / Claude / Gemini 命令行引擎自动使用 Zotero 的系统代理」，引擎启动异常时可关闭排查；
- Windows 上传给命令行工具的代理变量只设置一次（Windows 不区分变量名大小写）。

**0.7.4**
- 设置页「检查更新」旁注明：使用 VPN 时请打开 TUN 模式；
- 引擎报错更准确：需要重新登录（如 agy 未登录）、地区不受支持（如 Gemini「User location is not supported」、Claude 不支持香港节点）时给出对应办法，不再误报为网络问题。

**0.7.3**
- 修复：代理软件为「系统代理」模式时，GPT / Claude / Gemini 命令行引擎连不上服务器（Reconnecting… 5/5）。插件现在会把 Zotero 使用的系统代理自动交给它们；
- 引擎因网络失败时，提示里写明使用的代理地址和处理办法。

**0.7.2**
- 设置页新增「版本与更新」：一键检查并安装新版本，不用卸载重装；
- 每天后台检查一次，有新版本时提醒；
- GitHub 不可达时自动改用 jsDelivr 镜像，安装前校验文件 sha256。

**0.7.1**
- 一键配置遇到失效的代理（代理软件已关闭但系统代理仍开着）时，自动改为直接连接重试，覆盖 uv 安装、Python 组件安装、字体与版面模型下载；
- 代理类报错给出针对性的处理办法，不再笼统提示「勾选国内镜像」。

**0.7.0**
- 更名为 **Verso**，新图标；
- 划词翻译改为深色译文卡片，段落翻译改为「圈出原文 + 下方译文卡片」，带加载动画；
- 修复：段落靠近页面底部时译文框被截断；
- 修复：Google 被限流时无限等待，现在 10 秒内给出明确提示；
- Alt + 点击没有识别到段落时给出提示，不再静默。

**0.6.0**
- Windows 与 macOS 通用，一键配置运行环境，环境检测；
- Windows 使用 RapidOCR 识别图中文字。

更早的版本见提交历史。

---

## 致谢与许可

- 版面识别和 PDF 处理基于 [BabelDOC / pdf2zh_next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（AGPL-3.0）和 [PyMuPDF](https://pymupdf.readthedocs.io/)（AGPL-3.0）。
- 文字识别使用 [RapidOCR](https://github.com/RapidAI/RapidOCR)。
- 公式排版使用 [KaTeX](https://katex.org/)（MIT 许可，见 `content/lib/KATEX-LICENSE`）。

本项目以 **AGPL-3.0** 许可开源，与上述依赖保持一致，详见 [LICENSE](LICENSE)。

Verso 是独立的第三方插件，与 Zotero 官方无关。
