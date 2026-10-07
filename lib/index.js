// dsh-preset-plus-vanta 宿主端插件入口
//
// 功能（纯插件空间，不修改 DSH 源码）：
//   1. 多预设编辑器后端：读取/保存多套预设（system/user/assistant 条目 + postPrompt），
//      持久化到 <dshHome>/vanta-presets.json（{ version, activePresetId, modelRoutes, presets }）。
//   2. 模式固定、预设动态：模式（agentPreset id）= "vanta"，作用域门禁用
//      scopedPresets（默认 ["vanta"]）。会话挂在该模式下，就用"当前激活预设
//      （activePresetId）"的 entries 注入。
//   3. system 段改用 systemPrompt.section() 注册（与 billion 一致），text 用函数在每次
//      组装时从预设动态读取，可在轨迹中查看。
//   4. user / assistant 条目（fake 消息）在 llm/stream 前置，不写入会话历史。
//   5. AB 双模式：auto（自动，可关）+ /prefill（手动强制，即使 autoMode 关闭）。
//   6. 按模型路由：modelRoutes 命中时，llm/stream 层的 user/assistant 条目改用
//      命中的预设；system 段拿不到 model，仍走 active 预设（/vanta status 会说明）。
//   7. /vanta 命令 + 模型工具 + HTTP API（设置页）。
//
// 注入策略：
//   - system 段用 systemPrompt.section() 注册（轨迹可见，每次组装时动态读取）；
//     user/assistant 段（fake 消息）在 llm/stream 前置。两个渠道各自独立，轨迹完整。
//   - 不能用 agent/request（其文档明确"cannot mutate messages"）。
//   - 用 ctx.agents.get(options.sessionId) 找回 Agent，再 agentPresets.composedPreset(agent.ctx)
//     做作用域判断。
//
// ★ 作用域门（strictScope，默认 true）
//   作用域与 autoMode 的判定统一在 system-prompt/assemble 钩子里做，而不是塞进
//   section 的 text 回调 —— assemble 能拿到 context.agent（拿得到 sessionId），
//   text 回调拿不到。因此：
//     - 命中作用域 → 保留 vanta / vanta-post 段，并顺带移除内置 context 段
//     - 未命中     → 把 vanta / vanta-post 两段整个摘掉
//   strictScope: false 可退回「全域注入」的旧行为（见 cordis.patch.yml）。

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as core from "./core.js";

export const name = "@moxisuki/dsh-preset-plus-vanta";

// agentPresets 必须声明为依赖：本插件的每一处作用域判定都要调它的 composedPreset，
// 而它决定 composedPreset(agent.ctx) 返回哪个模式 id。未声明时加载顺序不保证，
// 早期调用拿到 undefined。
export const inject = ["systemPrompt", "tools", "llm", "agents", "agentPresets"];

const DEFAULTS = {
  enabled: true,
  // 模式 id 固定为 vanta。
  scopedPresets: ["vanta"],
  // true  = system/post 段也受 scopedPresets + autoMode 约束（正确行为）
  // false = 恢复旧行为：段无条件注入到所有模式
  strictScope: true,
  // assistant 预填充种子是否注入消息数组。默认 false。
  // 该条目是合成的 assistant 轮，不带 thinking；放在末尾会被思考模式 provider
  // 以 400 INVALID_REQUEST 拒绝（"content[].thinking must be passed back"），
  // 放在开头则预填充不生效且会被读成越狱注入。两个位置都不可用。
  injectAssistantSeed: false,
  verbose: false,
};

/** 本插件注册的两个 section 名。作用域不命中时按名摘除。 */
const VANTA_SECTIONS = ["vanta", "vanta-post"];

/** vanta 模式下要移除的内置 context 段 —— 破限模式不需要它们占篇幅。 */
const BUILTIN_SECTION_NAMES = ["harness:identity", "harness:source", "app:web-surface"];

// ═══════════════════════════════════════════════════════════════════
//  注入引擎
// ═══════════════════════════════════════════════════════════════════

/**
 * 该 session 命中的 agent 模式是否在作用域内。
 * fail-closed：agentPresets 未就绪 / 取不到 Agent 一律判 false —— 作用域门的语义
 * 就是「没证据就别放行」，不能因为服务没加载就把人格泄进所有模式。
 */
function enabledForAgent(agentPresets, agents, sessionId, cfg) {
  if (!cfg.enabled) return false;
  const scopes = Array.isArray(cfg.scopedPresets) ? cfg.scopedPresets : [];
  if (scopes.length === 0) return false;
  if (!agentPresets || typeof agentPresets.composedPreset !== "function") return false;
  if (!sessionId) return false;
  let agent;
  try {
    agent = agents?.get?.(sessionId);
  } catch {
    return false;
  }
  if (agent === undefined || agent === null) return false;
  let current;
  try {
    current = agentPresets.composedPreset(agent.ctx);
  } catch {
    return false;
  }
  return scopes.includes(current);
}

/** 把预设条目的 entries 合成为 [role:user/assistant, ...] fake 消息列表。system 段由
 * systemPrompt.section() 负责，此处只提取 text 供日志显示。 */
function buildInjection(entries, makeUserMessage, makeAssistantMessage, provider, model, cfg) {
  // 第一条固定为 system 主提示词，不受 enabled 影响（模型层已强制 enabled）。
  // 其余条目按 enabled === false 跳过（与酒馆一致：每条提示词可单独开启/关闭）。
  const head = entries[0];
  const system = head?.role === "system" ? head.text : undefined;
  const inject = [];
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.enabled === false) continue;
    if (e.role === "user") inject.push(makeUserMessage({ text: e.text }));
    else if (e.role === "assistant") {
      // ★ assistant 预填充种子默认不注入（cfg.injectAssistantSeed 默认 false）。
      //
      // 它是合成的 assistant 轮，content 里只有 text、没有 thinking。放在数组末尾
      // （预填充的正确语义位置）就成了「待续写的最后一条 assistant 轮」——思考模式下
      // provider 会校验这一轮必须带回 content[].thinking，合成消息没有，直接 400
      // INVALID_REQUEST（实测：DSH 重启载入本插件后 30 秒内即复现）。
      // 放在数组开头（旧行为）provider 不校验，但那样预填充根本不生效，
      // 还会凭空造出一段「用户指令 + 助手已作答」的开场，被模型读成越狱注入。
      // 两个位置都不可用，所以默认关闭；确需时用配置开启，并自行确认目标模型
      // 不是思考模式。
      if (cfg?.injectAssistantSeed === true) {
        inject.push(makeAssistantMessage({ text: e.text, provider, model }));
      }
    }
  }
  return { system, inject };
}

function installInjector(ctx, cfg) {
  const injected = new Set();
  const force = new Set();
  const injectedMessageIds = new Map();
  const inFlight = new WeakSet();

  // ★ system 用 systemPrompt.section() 注册，在组装阶段（system-prompt/assemble）
  //    就加入 system，轨迹可见。text 用函数每次从预设动态读取，最新文本自动生效。
  //    text 回调不判作用域 —— 那件事由下面的 assemble 钩子按 section 名摘除。
  ctx.systemPrompt.section({
    name: "vanta",
    order: 100,
    text: () => {
      const active = core.loadActivePreset();
      if (!active) return "";
      return active.entries.length > 0 && active.entries[0].role === "system"
        ? active.entries[0].text
        : "";
    },
  });

  // ★ 尾部锚定段。dsh-purge 用 postPromptOrder: 5100 做同一件事：模型对 system
  //    末尾的指令服从度显著高于开头。主提示词在 order 100，这里在 5100。
  //    postPrompt 缺省为空串 → 文本为空，宿主不会渲染出内容。
  ctx.systemPrompt.section({
    name: "vanta-post",
    order: 5100,
    text: () => {
      const active = core.loadActivePreset();
      return typeof active?.postPrompt === "string" ? active.postPrompt : "";
    },
  });

  // ★ 作用域门 + 内置段过滤，都在这里做（唯一能拿到 context.agent 的地方）。
  ctx.on("system-prompt/assemble", (assembly, context, next) => {
    try {
      const agent = context?.agent;
      const sessionId = agent?.id;
      const agentPresets = ctx.get("agentPresets");

      let inScope;
      if (cfg.strictScope) {
        inScope = enabledForAgent(agentPresets, ctx.agents, sessionId, cfg);
      } else {
        // 退回旧行为：只要插件开着就全域注入。
        inScope = cfg.enabled;
      }

      let autoOn = true;
      if (inScope) {
        try { autoOn = core.loadActivePreset()?.autoMode !== false; } catch { autoOn = true; }
      }
      const wantsForce = sessionId ? force.has(sessionId) : false;

      if (inScope && (autoOn || wantsForce)) {
        // 命中：保留本插件段，顺带移除内置 context 段
        // （由 session-reference、web-server 等插件注入，破限模式下不需要）。
        assembly.sections = assembly.sections.filter(
          (s) => !BUILTIN_SECTION_NAMES.includes(s.name),
        );
      } else {
        // 未命中 / 已关闭：把本插件的段整个摘掉，别让人格泄进别的模式。
        assembly.sections = assembly.sections.filter(
          (s) => !VANTA_SECTIONS.includes(s.name),
        );
      }
    } catch {
      // 判定失败时保守处理：摘掉本插件段，而不是放行。
      try {
        assembly.sections = assembly.sections.filter(
          (s) => !VANTA_SECTIONS.includes(s.name),
        );
      } catch { /* assembly 结构异常，无能为力 */ }
    }
    return next();
  }, { global: true });

  ctx.on("llm/stream", (options, next) => {
    if (inFlight.has(options)) return next();

    const sessionId = options.sessionId;
    const agentPresets = ctx.get("agentPresets");

    const isMain = options.purpose === undefined;

    // ★ 按模型路由：命中 modelRoutes 则用命中的预设，否则用 active 预设。
    //   注意 system 段走 active（本钩子拿不到 model 就能改，已在 status 里说明）。
    const { route, preset: routedPreset } = core.loadPresetForModel(options.model);
    const preset = route ? routedPreset : core.loadActivePreset();
    const entries = preset?.entries ?? [];
    const autoModeOn = preset?.autoMode !== false;
    const wantsForce = force.has(sessionId);

    const shouldInject = (
      isMain
      && enabledForAgent(agentPresets, ctx.agents, sessionId, cfg)
      && (autoModeOn || wantsForce)
    );
    if (!shouldInject) return next();
    if (entries.length === 0) return next();

    const { system, inject } = buildInjection(
      entries,
      (t) => makeUser(ctx, t.text),
      (t) => makeAssistant(ctx, t.text, t.provider, t.model),
      options.provider,
      options.model,
      cfg,
    );

    injected.add(sessionId);
    force.delete(sessionId);

    const oldIds = injectedMessageIds.get(sessionId) || new Set();
    const sourceMessages = (options.messages || []).filter((message) => !oldIds.has(message?.id));
    injectedMessageIds.set(sessionId, new Set(inject.map((message) => message.id)));

    if (cfg.verbose) {
      console.log("[vanta] injected → session=" + sessionId
        + ", preset=" + (preset?.id ?? "?")
        + (route ? ` (route ${route.pattern})` : "")
        + ", model=" + (options.model ?? "?")
        + ", inject=" + inject.length
        + ", system=[" + (system ?? "").slice(0, 100).replace(/\n/g, "↵")
        + (String(system ?? "").length > 100 ? "…]" : "]"));
    }

    // ★ 注入的 fake 消息放在**末尾**，不是开头。
    //
    // 放在开头（旧行为 [...inject, ...sourceMessages]）会制造出一段凭空出现的开场：
    // 一条"用户"指令（模型当成操作者的开场要求）+ 一条"助手"回答"好，以下是结果："
    // （模型当成自己说过的话，但没有任何问题被问）。这段前缀正好是越狱注入的形状，
    // 模型据此判定整份人格是 injected —— 实测两个会话的推理里它明确这么写了
    // （"m00001–m00002 are the user's instruction and my 好，以下是结果："）。
    //
    // 放末尾同时修好了语义：assistant 预填充种子的定义就是"紧贴响应位置，模型接着
    // 它继续写"。放在对话最前面的预填充不生效，只会留下一个解释不通的残迹。
    const mutableOptions = {
      ...options,
      ...(inject.length > 0 ? { messages: [...sourceMessages, ...inject] } : { messages: sourceMessages }),
    };
    inFlight.add(mutableOptions);
    return ctx.llm.stream(mutableOptions);
  });

  return {
    prefill(sessionId) {
      if (!enabledForAgent(ctx.get("agentPresets"), ctx.agents, sessionId, cfg)) {
        return { ok: false, reason: "not-in-scope" };
      }
      force.add(sessionId);
      return { ok: true, sessionId };
    },
    isInjected(sessionId) { return injected.has(sessionId); },
    reset(sessionId) {
      injected.delete(sessionId);
      force.delete(sessionId);
      injectedMessageIds.delete(sessionId);
    },
    isInjectedSystem(sessionId) {
      if (!cfg.strictScope) return cfg.enabled;
      if (!enabledForAgent(ctx.get("agentPresets"), ctx.agents, sessionId, cfg)) return false;
      let autoOn = true;
      try { autoOn = core.loadActivePreset()?.autoMode !== false; } catch { autoOn = true; }
      return autoOn || force.has(sessionId);
    },
  };
}

/** 创建 user 消息（fake user）。 */
function makeUser(ctx, text) {
  return messageFactory().createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name },
  });
}

/** 创建 assistant 消息（source 指向真实模型，pi-ai 以 foreignAssistant 序列化）。 */
function makeAssistant(ctx, text, provider, model) {
  return messageFactory().createAssistantMessage({
    content: [{ type: "text", text }],
    source: { kind: "model", provider: provider || "dsh-foreign", model: model || "dsh-foreign" },
  });
}

function messageFactory() {
  const freeze = (o) => Object.freeze(structuredClone(o));
  return {
    createUserMessage(input) {
      return freeze({ ...input, id: randomUUID(), role: "user" });
    },
    createAssistantMessage(input) {
      return freeze({ id: randomUUID(), role: "assistant", content: input.content, source: { kind: "model", ...input.source } });
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
//  HTTP API（设置页）
// ═══════════════════════════════════════════════════════════════════

function installWebServer(ctx, cfg, injector) {
  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      const json = (res, status, payload) => {
        res.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      };
      const readBody = async (req) => {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buf.length;
          if (size > 512 * 1024) throw new Error("body too large");
          chunks.push(buf);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      };

      // GET: 多预设 doc + 作用域状态 + 运行时诊断
      host.webServer.register({
        kind: "exact",
        path: "/dsh-preset-plus-vanta/state",
        handler: async (req, res) => {
          if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return; }
          try {
            const doc = core.loadMultiPreset();
            json(res, 200, {
              ok: true,
              doc,
              scopedPresets: cfg.scopedPresets,
              strictScope: cfg.strictScope,
              verbose: cfg.verbose,
              dshHome: core.findDshHome(),
              storePath: core.storePath(),
              backupPath: core.backupPath(),
              snapshotDir: core.snapshotDir(),
              runtime: core.getRuntimeState(),
            });
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      }, "dsh-preset-plus-vanta: state");

      // POST: 保存整份多预设 doc（设置页用它持久化当前编辑态）
      host.webServer.register({
        kind: "exact",
        path: "/dsh-preset-plus-vanta/save",
        handler: async (req, res) => {
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
          try {
            const body = await readBody(req);
            const doc = body?.doc && typeof body.doc === "object" ? body.doc : {};
            const saved = await core.saveMultiPreset(doc);
            json(res, 200, { ok: true, doc: saved });
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      }, "dsh-preset-plus-vanta: save");

      // GET: 导出单个预设 / 导出全部（?all=1 导出全部）
      host.webServer.register({
        kind: "exact",
        path: "/dsh-preset-plus-vanta/export",
        handler: async (req, res) => {
          if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return; }
          try {
            const doc = core.loadMultiPreset();
            const url = req.url || "";
            const params = new URL(url, "http://x").searchParams;
            const isAll = params.get("all") === "1";
            if (isAll) {
              const raw = JSON.stringify(core.exportMultiPreset(doc), null, 2);
              res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="vanta-all.json"` });
              res.end(raw);
              return;
            }
            const id = params.get("id") || doc.activePresetId;
            const single = core.exportSinglePreset(doc, id);
            if (!single) { json(res, 404, { ok: false, error: "预设不存在: " + id }); return; }
            const raw = JSON.stringify(single, null, 2);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="vanta-${encodeURIComponent(single.name || id)}.json"` });
            res.end(raw);
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      }, "dsh-preset-plus-vanta: export");

      // POST: 导入（单条结构 或 多条结构，自动判断）
      host.webServer.register({
        kind: "exact",
        path: "/dsh-preset-plus-vanta/import",
        handler: async (req, res) => {
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
          try {
            const body = await readBody(req);
            let parsed;
            if (typeof body?.raw === "string") parsed = JSON.parse(body.raw);
            else if (body?.preset && typeof body.preset === "object") parsed = body.preset;
            else { json(res, 400, { ok: false, error: "需要 raw(JSON 文本) 或 preset(对象)" }); return; }
            const doc = core.loadMultiPreset();
            const updated = core.importPresetJson(doc, parsed);
            const saved = await core.saveMultiPreset(updated);
            json(res, 200, { ok: true, doc: saved });
          } catch (e) { json(res, 500, { ok: false, error: "导入失败: " + String(e) }); }
        },
      }, "dsh-preset-plus-vanta: import");

      // POST: 手动 /prefill
      host.webServer.register({
        kind: "exact",
        path: "/dsh-preset-plus-vanta/prefill",
        handler: async (req, res) => {
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
          try {
            const body = await readBody(req);
            const sessionId = body?.sessionId;
            if (typeof sessionId !== "string" || sessionId === "") { json(res, 400, { ok: false, error: "sessionId required" }); return; }
            const r = injector.prefill(sessionId);
            json(res, r.ok ? 200 : 409, r);
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      }, "dsh-preset-plus-vanta: prefill");

      // GET: 打一份带时间戳的快照
      host.webServer.register({
        kind: "exact",
        path: "/dsh-preset-plus-vanta/backup",
        handler: async (req, res) => {
          if (req.method !== "POST" && req.method !== "GET") { res.writeHead(405, { allow: "POST, GET" }); res.end(); return; }
          try {
            const snap = await core.createSnapshot();
            const snapshots = await core.listSnapshots();
            json(res, 200, { ok: true, snapshot: snap, snapshots });
          } catch (e) { json(res, 500, { ok: false, error: "备份失败: " + String(e) }); }
        },
      }, "dsh-preset-plus-vanta: backup");

      // GET: 列出快照
      host.webServer.register({
        kind: "exact",
        path: "/dsh-preset-plus-vanta/snapshots",
        handler: async (req, res) => {
          if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return; }
          try {
            json(res, 200, { ok: true, snapshots: await core.listSnapshots() });
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      }, "dsh-preset-plus-vanta: snapshots");

      // POST: 从快照还原
      host.webServer.register({
        kind: "exact",
        path: "/dsh-preset-plus-vanta/restore",
        handler: async (req, res) => {
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
          try {
            const body = await readBody(req);
            const doc = await core.restoreSnapshot(body?.id);
            json(res, 200, { ok: true, doc });
          } catch (e) { json(res, 500, { ok: false, error: "还原失败: " + String(e) }); }
        },
      }, "dsh-preset-plus-vanta: restore");
    }, "dsh-preset-plus-vanta: http routes");
  });
}

// ═══════════════════════════════════════════════════════════════════
//  命令 + 模型工具
// ═══════════════════════════════════════════════════════════════════

function renderPresetText(preset) {
  if (!preset) return "(无激活预设)";
  const lines = [];
  lines.push(`预设: ${preset.name}  (${preset.entries.length} 条)`);
  lines.push(`自动注入: ${preset.autoMode ? "开" : "关"}`);
  lines.push(`尾部锚定段: ${preset.postPrompt ? `有 (${preset.postPrompt.length} 字)` : "无"}`);
  for (const [i, e] of preset.entries.entries()) {
    const flag = e.enabled === false ? "off" : "on";
    lines.push(`[${i + 1}] ${flag} ${e.role.toUpperCase()} · ${e.text.slice(0, 60)}${e.text.length > 60 ? "…" : ""}`);
  }
  return lines.join("\n");
}

/** 诊断块 —— 对齐 dsh-purge 的 /purge status。 */
function renderDiagnostics(cfg) {
  const doc = core.loadMultiPreset();
  const rt = core.getRuntimeState();
  const routes = (doc.modelRoutes || []).length
    ? doc.modelRoutes
      .map((r) => `  ${r.pattern} → ${doc.presets[r.presetId] ? r.presetId : r.presetId + " (目标缺失)"}`)
      .join("\n")
    : "  (无路由)";
  return [
    `DSH_HOME     : ${core.findDshHome()}`,
    `存储文件     : ${core.storePath()} (${fs.existsSync(core.storePath()) ? "存在" : "不存在"})`,
    `备份文件     : ${core.backupPath()} (${fs.existsSync(core.backupPath()) ? "存在" : "不存在"})`,
    `快照目录     : ${core.snapshotDir()}`,
    `存储健康     : ${rt.degraded ? "⚠ " + rt.degraded : "正常"}`,
    `strictScope  : ${cfg.strictScope ? "开（段受作用域门约束）" : "关（段全域注入）"}`,
    `作用域       : ${(cfg.scopedPresets || []).join(", ") || "(空=关闭)"}`,
    `verbose      : ${cfg.verbose ? "开" : "关"}`,
    `模型路由:\n${routes}`,
  ].join("\n");
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!cfg.enabled) return;

  const injector = installInjector(ctx, cfg);
  installWebServer(ctx, cfg, injector);

  const commands = ctx.get?.("commands");
  if (commands) {
    commands.register({
      name: "vanta",
      description: "预设增强（status/prefill/on/off/save/list/activate/backup/restore）",
      input: { hint: "status | prefill | on | off | save | list | activate <id> | backup | restore <id>" },
      handler: async (invocation) => {
        const args = (invocation.rawInput ?? "").trim().split(/\s+/).filter(Boolean);
        const sub = (args[0] || "status").toLowerCase();
        const sessionId = invocation.agent?.id;
        switch (sub) {
          case "status":
          case "s": {
            const active = core.loadActivePreset();
            const doc = core.loadMultiPreset();
            const inSys = injector.isInjectedSystem(sessionId);
            return {
              kind: "success",
              text: renderPresetText(active)
                + `\n\n激活预设: ${doc.activePresetId}`
                + `\n可预设: ${Object.keys(doc.presets).join(", ") || "(无)"}`
                + `\n模型路由:\n${(doc.modelRoutes || []).length
                  ? doc.modelRoutes.map((r) => `  ${r.pattern} → ${doc.presets[r.presetId] ? r.presetId : r.presetId + " (目标缺失)"}`).join("\n")
                  : "  (无路由)"}`
                + `\n\n⚠ 路由只作用于 user/assistant 条目；system 与尾部段拿不到 model，始终取激活预设。`
                + `\n本会话 user/assistant 已注入: ${injector.isInjected(sessionId) ? "是" : "否"}`
                + `\n本会话 system 段生效: ${inSys ? "是" : "否"}`
                + `\n\n${renderDiagnostics(cfg)}`,
            };
          }
          case "prefill":
          case "p": {
            const r = injector.prefill(sessionId);
            return r.ok
              ? { kind: "success", text: "已标记本会话待注入破限伪装上下文（下一条消息生效）。" }
              : { kind: "error", text: "无法预填充: " + r.reason + "（当前会话未命中作用域，或 agentPresets 未就绪）" };
          }
          case "on": {
            const doc = core.loadMultiPreset();
            const preset = doc.presets[doc.activePresetId];
            if (preset) { await core.saveMultiPreset({ ...doc, presets: { ...doc.presets, [preset.id]: { ...preset, autoMode: true } } }); return { kind: "success", text: "已开启自动注入。" }; }
            return { kind: "error", text: "无激活预设。" };
          }
          case "off": {
            const doc = core.loadMultiPreset();
            const preset = doc.presets[doc.activePresetId];
            if (preset) { await core.saveMultiPreset({ ...doc, presets: { ...doc.presets, [preset.id]: { ...preset, autoMode: false } } }); return { kind: "success", text: "已关闭自动注入（system 段与尾部段同时关闭；手动 /prefill 仍可用）。" }; }
            return { kind: "error", text: "无激活预设。" };
          }
          case "save": {
            const active = core.loadActivePreset();
            return { kind: "success", text: "当前预设:\n" + renderPresetText(active) };
          }
          case "list":
          case "l": {
            const doc = core.loadMultiPreset();
            const lines = Object.entries(doc.presets).map(([id, p]) => `  ${id === doc.activePresetId ? "●" : "○"} ${id} — ${p.name}`);
            return { kind: "success", text: "预设列表:\n" + lines.join("\n") + "\n激活: " + doc.activePresetId + "\n用法: /vanta activate <id>" };
          }
          case "activate":
          case "a": {
            const id = args[1];
            if (!id) return { kind: "error", text: "用法: /vanta activate <id>" };
            const doc = core.loadMultiPreset();
            if (!doc.presets[id]) return { kind: "error", text: "预设不存在: " + id };
            await core.saveMultiPreset(core.activatePreset(doc, id));
            injector.reset(sessionId);
            return { kind: "success", text: "已激活预设: " + id + "（下一条消息生效）" };
          }
          case "backup": {
            const snap = await core.createSnapshot();
            return { kind: "success", text: "已打快照: " + snap.id + "\n" + snap.path };
          }
          case "restore": {
            const id = args[1];
            if (!id) {
              const snaps = await core.listSnapshots();
              return {
                kind: "success",
                text: "用法: /vanta restore <快照id>\n现有快照:\n"
                  + (snaps.length ? snaps.map((s) => `  ${s.id}  (${s.size} B, ${s.mtime})`).join("\n") : "  (无)"),
              };
            }
            const doc = await core.restoreSnapshot(id);
            injector.reset(sessionId);
            return { kind: "success", text: "已从快照还原: " + id + "\n激活预设: " + doc.activePresetId };
          }
          default:
            return { kind: "success", text: "dsh-preset-plus-vanta 命令: status | prefill | on | off | save | list | activate <id> | backup | restore <id>" };
        }
      },
    });
  }

  if (ctx.tools) {
    ctx.tools.register({
      name: "vanta_status",
      description: "查看 dsh-preset-plus-vanta 预设列表、激活预设、作用域、模型路由与存储健康状态。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      output: { schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } }, render: (_a, v) => [{ type: "text", text: String(v?.text ?? "") }] },
      async execute() {
        const doc = core.loadMultiPreset();
        const list = Object.entries(doc.presets).map(([id, p]) => `  ${id === doc.activePresetId ? "●" : "○"} ${id} — ${p.name}`).join("\n");
        const routes = (doc.modelRoutes || []).map((r) => `  ${r.pattern} → ${r.presetId}`).join("\n") || "  (无)";
        const rt = core.getRuntimeState();
        return {
          text: `激活预设: ${doc.activePresetId}\n预设列表:\n${list}\n模型路由:\n${routes}\n`
            + `作用域: ${(cfg.scopedPresets || []).join(", ") || "(空)"}\n`
            + `strictScope: ${cfg.strictScope ? "开" : "关"}\n`
            + `存储健康: ${rt.degraded ? "⚠ " + rt.degraded : "正常"}\n`
            + `DSH_HOME: ${core.findDshHome()}`,
        };
      },
    });
  }
}
