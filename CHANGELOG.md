# Changelog

本文件记录 dsh-preset-plus 的显著变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)；
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复
- **DSH 重启后即 400：`The content[].thinking in the thinking mode must be passed back to the API`**。
  上一版把注入的 fake 消息从消息数组开头挪到末尾（修「假开场」问题），但没意识到
  **末尾正是思考模式 provider 强校验的那一轮**：合成的 assistant 预填充种子 content 里
  只有 text、没有 thinking，作为「待续写的最后一条 assistant 轮」被直接拒绝。
  实测证据：DSH 于 04:40:11 重启载入该版本，04:41:57 出现首次该错误（此前连续 12 小时
  零该错），04:45 新会话第一轮即 400。
  现已把 assistant 预填充种子的注入默认关闭（新增配置 `injectAssistantSeed`，默认
  false），并把内置 vanta 预设的 assistant 条目置为 `enabled: false`（否则 UI 显示
  「启用」而实际不跑，界面在说谎）。该条目的两个可用位置都不可用：末尾被 provider 拒，
  开头则预填充不生效且会被读成越狱注入 —— 故默认关闭，确需时两处同时开启并确认目标
  模型非思考模式。
- **注入顺序反了：fake 消息此前拼在消息数组最前面**（`[...inject, ...sourceMessages]`），
  应为末尾。放在开头会凭空造出一段对话开场——一条"用户"指令（模型读作操作者的开场
  要求）加一条"助手"回答「好，以下是结果：」（模型读作自己说过的话），而两者都不成立：
  没有任何问题被问过。这段前缀正是越狱注入的标准形状，实测两个会话的推理里模型明确
  据此判定整份人格是 injected（"m00001–m00002 are the user's instruction and my
  好，以下是结果："）。
- 新增注入位置回归测试：断言 fake 消息位于真实历史之后、**默认不注入 assistant 种子**、
  默认数组不以 assistant 轮结尾（思考模式校验位）、数组不以假 user 开场、二次注入不
  累积；另有 `injectAssistantSeed: true` 下种子恢复注入并落在最末的对照。已验证对旧
  顺序报错（输出直接显示 `["USER-VANTA","ASST-VANTA","REAL-TURN-1",…]`），不是空过。
  此前的测试只断言"包含"，查不出位置，因此该 bug 一路绿灯。
- **设置页整页空白**：客户端引用了 `snapshots` / `patchRoute` / `addRoute` / `removeRoute` / `makeBackup` / `refreshSnapshots` / `restoreFrom`，但这批回调与状态从未声明，render 时抛 `ReferenceError`，整个「预设增强」面板渲染为空白。原因是这三张卡片与它们的支撑逻辑分两次改动落地，第二次只带了卡片本身。现已补齐声明。
- system 段改用 `systemPrompt.section()` 注册（text 为函数，每次组装时从预设动态读取），与 billion 机制一致。system 在组装阶段（`system-prompt/assemble`）即加入，轨迹可见。`llm/stream` handler 不再碰 `options.system`，仅负责前置 fake 消息。
- **system 段此前完全绕过作用域门**：`systemPrompt.section()` 的 text 回调不查 `scopedPresets` / `autoMode`，作用域判定只作用于 `llm/stream` 的 fake 消息层。实际影响是主提示词被无条件注入到宿主里每一个 agent 模式——当预设只启用 system 段时（user/assistant 关闭），`scopedPresets` 对唯一生效的那一层形同虚设。作用域判定已移入 `system-prompt/assemble`（唯一能拿到 `context.agent` 的位置），未命中时按段名摘除本插件的段。新增 `strictScope` 配置（默认 `true`），置 `false` 可退回旧的全局注入行为。
- `enabledForAgent` 未对 `agentPresets` 做空值保护，且该服务不在 `inject` 声明中，加载顺序不保证时就绪——`/vanta prefill` 会抛 TypeError。已改为 fail-closed（未就绪判为不命中）并补入 `inject` 声明。
- `verbose` 配置项此前无效：`llm/stream` 的注入日志无条件输出。已挂到该开关下，日志附带 preset、model 与命中的路由。
- `saveMultiPreset` 的注释声称原子写入，实现是裸 `writeFile`，写到一半中断会丢失全部预设。改为临时文件 + `rename` 原子替换；覆盖前把**当前可解析的**主文件轮转为 `.bak`（主文件已损坏时不轮转，否则会用坏文件盖掉唯一的好备份）；读取时若主文件解析失败则回落 `.bak` 并在诊断中标注降级，而非静默重置。
- 首次初始化原先在读路径上异步写盘，web 与 desktop 双宿主首启会交错。落盘统一由 `saveMultiPreset` 串行负责（单飞链），读路径不再写盘。
- 导入/导出此前丢弃 `postPrompt` 与 `modelRoutes` 字段，导出后重新导入会静默丢失这些数据。

### 新增
- **按模型路由**（schema v2）：`modelRoutes: [{ pattern, presetId }]`，按声明顺序首个匹配者胜出，pattern 为大小写不敏感 glob（`*` / `?`），未命中回落 `activePresetId`。命中时改用对应预设的 user / assistant 条目。纯增量字段，v1 文档归一化后自动获得 `modelRoutes: []`，无需迁移脚本。目标预设缺失的路由会保留（匹配时跳过），事后导入该预设即刻生效。
- **尾部锚定段**：预设新增可选 `postPrompt` 字段，注册为 `order: 5100` 的独立 section（主提示词为 `order: 100`）。模型对 system 末尾的指令服从度显著高于开头。留空则不注册该段。
- 诊断与快照：`/vanta status` 新增 DSH_HOME、存储/备份文件存在性、降级状态、`strictScope`、模型路由与命中情况；新增 `/vanta backup` / `restore` 命令、`/dsh-preset-plus-vanta/backup` / `snapshots` / `restore` 路由，以及带时间戳的快照目录。
- 设置页新增三张卡片：尾部锚定段编辑区、按模型路由编辑区、快照备份/还原；存储降级状态会在页面上直接告警。
- 新增 `test/inject.test.mjs` 回归测试（32 项），覆盖作用域门命中/未命中、`agentPresets` 未就绪/取不到 Agent/抛异常三种 fail-closed 路径、`strictScope` 退路、`autoMode` 双向、路由命中/回落/顺序优先、verbose 双向。
- 新增 `test/client-render.test.mjs` 渲染冒烟测试（12 项）：用 mock react 真正执行一次设置页 render，`node --check` 查不出的 `ReferenceError` 在这里会当场暴露。覆盖正常数据、`doc=null`、v1 文档（无 `modelRoutes`）、预设缺 `postPrompt` 四种输入，并断言子树不含 `render-error` 标记。`pnpm test` 依次运行两个测试。

### 说明
- `modelRoutes` 只作用于 user / assistant 条目。system 段与尾部锚定段在组装阶段拿不到 model 信息，始终取当前激活预设；`/vanta status` 会明示这一点。
- 存储 schema 由 1 升至 2。旧文档向前兼容，无需迁移脚本。

## 0.1.5 - 2026-08-27
### 修复
- 破限注入不再按「一个会话只注入一次」：每个新的主请求都会重新合并 system 并前置 fake 消息，避免第二轮及后续请求丢失破限。同一请求内部重入仍跳过，防止重复叠加。
- `preset/agent.cordis.yml` 变更后，`ensureAgentPresetMode` 改为每次启动都从包内覆盖（而不是「目标已存在则跳过」），保证开发迭代时模式文件始终同步。
- 注入日志改为打印合并后 system 文本的前 100 字符，可直接在控制台看到实际注入的提示词。

## 0.1.4 - 2026-08-25

### 新增
- 预设的每条提示词（system/user/assistant）增加独立的启用/禁用开关，与酒馆一致。
- 关闭的 `system` 条目不再覆盖主提示词；关闭的 `user`/`assistant` 条目不再插入对应伪造消息。
- 导入/导出随条目保存 `enabled` 字段；旧数据缺省视为启用。
- 补全 PresetPlus 模式的 agent 组合：默认不再为空，随包附带完整工具集（含委派、规划、压缩、系统等），避免以该模式启动的会话无任何可用工具。
- 构建守卫（`assert-build`）新增检查：组合至少携带一个工具行，防止组合回退为空。

## 0.1.3 - 2026-08-24

### 新增
- 安装插件时自动写入 `preset-plus` Agent Preset 及其 `PresetPlus` 显示描述。
- 用户无需手动创建模式，设置页只负责管理该模式下的多套预设。

## 0.1.2 - 发布修复

### 修复
- 修正 npm 首次发布流程与 CI 锁文件校验。
- 修正发布工作流对内置预设的健康检查。

## 0.1.1 - 多预设与界面修复

### 修复
- 修复同一会话切换预设后执行 `/preset-plus prefill` 仍沿用旧 fake user / fake assistant 消息的问题。
- 修复设置页重复显示预设管理操作的问题。
- 优化预设设置页的布局、卡片和控件样式。

### 新增
- 固定 `preset-plus` 模式支持多套可选预设。
- 内置预设改为随包发布的 `presets/jailbreak.json`。

## 0.1.0 - 初始发行

### 新增
- **破限模式（jailbreak）预设注入**：仅在 `agentPresets.composedPreset ∈ scopedPresets`（默认 `["preset-plus"]`）时，向 `llm/stream` 请求注入破限上下文；其他模式一律不注入（作用域隔离）。
- **多轮对话式注入**：`[system 主提示词][fake user][fake assistant][real user][real assistant]`，不依赖"续写"语义。
- **通用能力破限**：去创作化，非评判、无条件响应用户任何要求（漏洞利用 / 软件逆向 / 网络工具 / 代码生成 / 文字创作均可），"一切跟随用户要求"。
- **AB 双模式**：自动注入（`autoMode`，可关）+ 手动 `/prefill`。
- **预设编辑器**（设置页「预设增强」）：新增/删除/调整顺序/逐条配置 `system`/`user`/`assistant` 角色，第一条强制 system。
- **导入 / 导出预设**：导出为 JSON 文件、粘贴 JSON 导入覆盖保存（`GET /export`、`POST /import`）。
- **持久化**：预设存于 `~/.dsh/preset-plus.json`。
- **终端提示**：注入发生时打印 `[preset-plus] 预设已注入`。

### 说明
- 使用方式与安装见 [README](README.md)。
