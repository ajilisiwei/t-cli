# 开发文档：音标展示 & 语音朗读（TTS）

- 分支：`feature/phonetic-tts`（切自 `dev` @ `71b0331`）
- 状态：设计评审中
- 涉及模块：`src/prompts.js`、`src/repl.js`、新增 `src/tts.js`、新增 `src/utils/`

---

## 需求 1：查单词时展示音标（IPA）

### 需求定义

当输入属于"查单词"场景时，在英文结果旁展示美式 IPA 音标：

| 输入 | 场景 | 期望输出 |
|---|---|---|
| `苹果` | 中文单词 → 英文 | `apple /ˈæp.əl/` + 释义 |
| `ephemeral` | 英文单词 → 中文 | 译文 + 原词音标 `/ɪˈfem.ər.əl/` |
| 整句/长文本 | 非查词场景 | 不展示音标（保持现状） |

"查单词"的判定标准：英文输入为单个 token（允许连字符/撇号）；中文输入 ≤ 4 个汉字且无标点。

### 方案对比

**方案 A（推荐）：Prompt 驱动，由 DeepSeek 直接输出音标**

- 做法：客户端用轻量规则预判"疑似查词"，命中时在 system prompt 中追加指令：
  "If the source is a single word or short term, include the American IPA transcription
  (e.g. /ˈæp.əl/) right after the English word."
- 优点：
  - 零新增依赖、零额外网络往返，流式输出体验不变；
  - 中译英场景天然覆盖——目标英文词是模型自己生成的，只有模型知道该给哪个词标音；
  - simple / detail 两种模式均可用。
- 缺点：LLM 对低频词的音标偶有误差（可接受，学习场景非词典场景）。

**方案 B：调用免费词典 API（dictionaryapi.dev）**

- 做法：翻译完成后，对结果中的英文单词二次请求 `api.dictionaryapi.dev/api/v2/entries/en/<word>` 获取权威 IPA（响应中还含真人发音 mp3 链接）。
- 优点：音标权威；mp3 可与需求 2 联动（单词级真人发音）。
- 缺点：额外一次网络请求且该服务稳定性一般（无 SLA）；只覆盖英文单词；
  中译英时需先从流式输出中可靠抽取目标词，时序复杂。

**结论：v1 落地方案 A；方案 B 作为后续增强（可给单词追加真人发音，见需求 2 的演进路线）。**

### 实现要点

1. 新增 `src/utils/detect.js`：
   - `isWordLookup(text)` — 英文 `/^[a-zA-Z][a-zA-Z'-]*$/`；中文 `/^[一-鿿]{1,4}$/`。
2. `src/prompts.js`：
   - `getTranslatePrompt(lang, isSimpleMode, isWordLookup)` 增加第三个参数；
   - 命中查词时追加 IPA 指令段，并要求 simple 模式输出格式固定为 `word /IPA/`（一行）。
3. `src/repl.js`：
   - `runTranslate` 调用 `isWordLookup(text)` 并透传给 prompt 构造。
4. 注意与现有防注入结构（`buildSourceMessage` / `<source>` 标签）兼容：IPA 指令加在 system prompt，不动 user 消息结构。

---

## 需求 2：语音朗读（🔊 图标 + 点读）

### 关键技术约束：终端里"点击"不可行

原始需求是"译文前加一个小喇叭图标，点击后朗读"。必须先明确：

- Ink 没有鼠标事件模型，`<Text>` 不存在 onClick；
- 终端鼠标支持需手动开启 xterm mouse reporting（`\x1b[?1000h`）并自行解析坐标流，
  再把屏幕坐标反推到 Ink 动态布局中某个图标的位置——布局随消息滚动而变化，坐标映射极脆弱；
- 开启 mouse reporting 还会劫持终端原生的选择/复制，伤害"翻译后复制译文"这一核心工作流。

**结论：保留 🔊 图标作为"可朗读"的视觉标识，交互改为键盘触发。**

### 交互设计（v1：仅 `/say` 命令）

1. 每条翻译/查词结果的消息前缀展示 `🔊`（不可点击，纯提示"此条可朗读"）；
2. `/say` — 朗读最近一次翻译/查词结果；`/say stop` — 停止当前朗读；
3. 朗读中状态栏显示 `Speaking... (/say stop to cancel)`；朗读期间再次 `/say` 先停旧后播新；
4. 帮助文案（`buildWelcomeMessages`）同步新增 `/say` 说明；
5. 快捷键（Ctrl+S）留作 v2，先验证命令式交互。

### TTS 引擎选型：edge-tts（微软 Edge 朗读服务）+ 本地兜底

选用 npm 包 **`msedge-tts`**（Edge Read Aloud API 的 Node 封装）。2026-07-05 调研结论：

**候选对比**

| 包 | 版本 | 最近更新 | 结论 |
|---|---|---|---|
| `msedge-tts` | 2.0.6 | 2026-06（活跃） | ✅ 选用，纯 Node、WebSocket 流式 |
| `@andresaya/edge-tts` | 1.8.0 | 2025-12 | 备选 |
| `edge-tts`(npm) | 1.0.1 | 2024-04（停更） | ❌ |
| `edge-tts`(Python 原版) | — | 活跃 | ❌ 需 Python + mpv，跨语言依赖不值得 |

**PoC 实测（已验证，脚本在 scratchpad/edge-tts-poc/）**

- `en-US-AriaNeural` / `zh-CN-XiaoxiaoNeural` 合成均成功，端到端约 1.4s；
- 输出 48kbps/24kHz MP3，macOS 内置 `afplay` 直接播放通过；
- 神经网络音色，质量显著优于 macOS `say` 的本地机械音。

**架构**

```
/say → tts.speak(text)
        ├── 1. msedge-tts 合成 → 临时 mp3（os.tmpdir()/t-cli-tts/）
        ├── 2. spawn 播放器: afplay (macOS) / ffplay|mpv (Linux) / PowerShell (Windows)
        └── 3. edge-tts 失败（断网/端点变更）→ 降级 macOS `say`，再失败则黄色提示
```

- 合成与播放均异步，不阻塞 Ink 渲染循环；
- 播放器经 `spawn` 参数数组调用（不拼 shell 字符串），杜绝命令注入；
- 临时 mp3 播完即删；同一文本可按 hash 缓存（v2 优化，先不做）。

**必须写进代码注释的风险**：Edge Read Aloud 是非官方免费端点，微软历史上收紧过鉴权
（Sec-MS-GEC token 事件），存在再次变更导致 403 的可能——这正是保留本地 `say` 兜底的原因。

### 朗读内容的抽取

难点：detail 模式输出含多版本译文 + 解释，不能整段朗读。

- 在 App state 新增 `lastSpeakable`：
  - simple 模式 / 查词模式：整段输出（本就只有一行译文）；
  - detail 模式：抽取第一个译文版本。为让抽取可靠，在 detail prompt 中追加一条输出约定：
    "Put the best translation alone on the FIRST line, then the alternatives and explanations."
    首行即朗读文本，同时也顺手改善了"复制第一行即可用"的体验；
- 朗读语言判定：文本含 CJK 字符 → 中文 voice，否则英文 voice。

### 新增文件 `src/tts.js`（约 120 行）

```
speak(text)        -> detectVoice → edge-tts 合成临时 mp3 → spawn 播放器；失败降级 `say`
stop()             -> kill 播放进程 + 中断进行中的合成（幂等）
isSpeaking()       -> 是否有活动合成/播放
detectVoice(text)  -> CJK 检测 → 'zh-CN-XiaoxiaoNeural' | 'en-US-AriaNeural'
```

错误处理：合成失败、播放器缺失、spawn 失败均向消息流输出一条 yellow 提示
（含降级说明或安装建议），不抛异常、不中断主流程。

新增依赖：`msedge-tts`（间接引入 axios/ws 等 5 个包，可接受）。

---

## 任务拆分

| # | 任务 | 文件 | 验收标准 |
|---|---|---|---|
| 1 | 查词检测 util + 单测 | `src/utils/detect.js` | 英/中单词、句子、混合输入判定正确 |
| 2 | IPA prompt 改造 | `src/prompts.js` | `苹果` → 含 `/ˈæp.əl/`；整句无音标 |
| 3 | detail 首行译文约定 | `src/prompts.js` | detail 输出首行为纯译文 |
| 4 | TTS 模块 + 单测（mock 合成与 spawn） | `src/tts.js`、`package.json` | 中英文实测发声；断网降级 `say`；stop 幂等 |
| 5 | REPL 集成：🔊 前缀、`/say`/`/say stop`、Speaking 状态 | `src/repl.js` | 全流程手测通过 |
| 6 | 防注入回归 | scratchpad `injection-test.mjs` | 全部 PASS（prompt 改动不削弱防御） |
| 7 | 文档更新 | `CLAUDE.md`、`README.md` | 新命令与快捷键有记录 |

依赖关系：1 → 2；3 → 5；4 → 5；2/3 完成后必须跑 6。

## 风险与遗留

- **LLM 音标误差**：低频词 IPA 可能不准；演进路线是方案 B 用 dictionaryapi.dev 校准并带真人发音。
- **edge-tts 非官方端点**：免费但无 SLA，微软变更鉴权会导致合成失败；已设计 `say` 本地兜底，
  且 `tts.js` 做了引擎抽象，未来可低成本切换到官方 Azure Speech（付费）或其他引擎。
- **网络依赖**：`/say` 需要联网（兜底 `say` 除外）；翻译本身也依赖网络，可接受。
- **`package.json` 自引用依赖**：`"t-cli-translator": "file:t-cli-translator-1.0.0.tgz"` 仍在
  依赖里（`71b0331` 一并提交了），属误操作产物，建议在本分支顺手清理。
- **Windows TTS 未实测**：v1 仅保证 macOS 路径实测，Linux/Windows 为尽力支持。
- **测试基建缺失**：项目尚无测试框架，任务 1/4 需要先引入 `node:test`（Node 内置，零依赖）。
