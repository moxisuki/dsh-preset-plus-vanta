# dsh-preset-plus-vanta

DeepSeek Harness（DSH）的预设增强插件：编辑多套预设，并在 **VANTA** 模式下注入模型请求。

预设条目分三类：

- `system` —— 主提示词（第 1 条，作为请求的 system 段）
- `user` —— 以 user 角色前置的触发条目
- `assistant` —— 伪装成模型输出（预填充种子）

同一时刻只有一套预设生效，可以保存多套随时切换（参考 SillyTavern 的预设机制）。

## 安装

```bash
dsh plugin --profile <profile> add github:moxisuki/dsh-preset-plus-vanta
```

装完重启 Host，模式选择器里会出现 **VANTA**。

## 使用

- 设置 → **预设增强**：新增 / 删除 / 切换预设，编辑条目，导入导出 JSON
- 命令：`/vanta status | prefill | on | off | save | list | activate <id>`
- 模型工具：`vanta_status`

## 命名说明

包名与模式 id 使用独立命名（`dsh-preset-plus-vanta` / `vanta`），以避免与 `@rain-kl/dsh-preset-plus` 同时安装时冲突：两者各自注册自己的模式与作用域，互不覆盖。

数据文件：`$DSH_HOME/vanta-presets.json`（不存在时从包内 `presets/*.json` 初始化）。

## 注入顺序

```
[system 主提示词] → [user 触发] → [assistant 伪装输出] → [真实 user 输入] → [真实模型输出]
```

伪造的 user / assistant 条目不写入会话历史；控制台会打印 `[vanta] injected → session=…`，可据此确认是否注入。

## License

MIT
