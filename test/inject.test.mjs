// dsh-preset-plus-vanta 注入逻辑验证（不开宿主，纯 mock ctx）
// 覆盖：B1 作用域门 / autoMode / strictScope、B2 fail-closed、B3 verbose、F1 模型路由、F2 尾部段
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = path.join(os.tmpdir(), "ppv-idx-test-" + process.pid);
process.env.DSH_HOME = HOME;
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const core = await import("../lib/core.js");
const mod = await import("../lib/index.js");

let PASS = 0, FAIL = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name} ${extra}`); }
};

// ── 建一个够用的 mock ctx ────────────────────────────────────────────
// sessions[id] 是 agent 的 ctx 对象；agentPresets.composedPreset(ctx) 按 ctx.mode 返回模式 id。
function makeCtx({ cfg, sessions, composed }) {
  const sections = [];
  const handlers = {};
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(" ")); };

  const ctx = {
    systemPrompt: {
      section(def) { sections.push(def); },
    },
    agents: {
      get(id) { return sessions[id] ? { id, ctx: sessions[id] } : undefined; },
    },
    get(name) {
      if (name === "agentPresets") {
        // composed 为 null 表示该服务未就绪 —— 用于验 fail-closed。
        if (!composed) return undefined;
        return { composedPreset: (a) => a?.mode };
      }
      if (name === "commands") return undefined;
      return undefined;
    },
    on(evt, fn) { (handlers[evt] ||= []).push(fn); },
    llm: { stream: (o) => Promise.resolve({ echo: true }) },
    tools: undefined,
    inject() {},
  };

  try { mod.apply(ctx, cfg); } finally { console.log = origLog; }
  return { ctx, sections, handlers, logs };
}

const opts = (over = {}) => ({ sessionId: "s1", model: "deepseek-chat", messages: [], ...over });

async function assemble(h, assembly, context) {
  const list = (h.handlers["system-prompt/assemble"] || []);
  for (const fn of list) {
    const r = await fn(assembly, context, () => Promise.resolve());
    if (r && typeof r.then === "function") await r;
  }
  return assembly.sections.map((s) => s.name);
}

const sect = (sections, name) => sections.find((s) => s.name === name);

// ── 准备存储 ────────────────────────────────────────────────────────
const doc = {
  activePresetId: "vanta",
  modelRoutes: [{ pattern: "gpt-*", presetId: "alt" }],
  presets: {
    vanta: {
      id: "vanta", name: "VANTA", autoMode: true,
      postPrompt: "TAIL-ANCHOR",
      entries: [
        { role: "system", text: "SYSTEM-VANTA" },
        { role: "user", text: "USER-VANTA" },
        { role: "assistant", text: "ASST-VANTA" },
      ],
    },
    alt: {
      id: "alt", name: "ALT", autoMode: true, postPrompt: "",
      entries: [
        { role: "system", text: "SYSTEM-ALT" },
        { role: "user", text: "USER-ALT" },
      ],
    },
  },
};
await core.saveMultiPreset(doc);

console.log("\n【1】注册的两个 section");
{
  const { sections } = makeCtx({ cfg: {}, sessions: {}, composed: {} });
  const v = sect(sections, "vanta"), p = sect(sections, "vanta-post");
  ok("注册 vanta (order 100)", !!v && v.order === 100);
  ok("注册 vanta-post (order 5100)", !!p && p.order === 5100, p ? "order=" + p.order : "缺失");
  ok("vanta-post 排在 vanta 之后", !!v && !!p && p.order > v.order);
  ok("system 回调返回激活预设的 system 文本", v.text() === "SYSTEM-VANTA", v.text());
  ok("尾部回调返回 postPrompt", p.text() === "TAIL-ANCHOR", p.text());
}

console.log("\n【2】B1 作用域门 —— 命中 vs 未命中");
{
  const h = makeCtx({
    cfg: {},
    sessions: { s1: { id: "s1", mode: "vanta" } },
    composed: { x: 1 },
  });
  const base = () => [
    { name: "harness:identity" }, { name: "harness:source" },
    { name: "app:web-surface" }, { name: "other:keep" },
    { name: "vanta" }, { name: "vanta-post" },
  ];
  const hit = await assemble(h, { sections: base() }, { agent: { id: "s1" } });
  ok("命中作用域 → 保留 vanta", hit.includes("vanta"));
  ok("命中作用域 → 保留 vanta-post", hit.includes("vanta-post"));
  ok("命中作用域 → 摘除 harness:identity", !hit.includes("harness:identity"));
  ok("命中作用域 → 摘除 harness:source", !hit.includes("harness:source"));
  ok("命中作用域 → 摘除 app:web-surface", !hit.includes("app:web-surface"));
  ok("命中作用域 → 不动其他段", hit.includes("other:keep"));

  const miss = await assemble(h, { sections: base() }, { agent: { id: "sX" } });
  ok("未命中作用域 → 摘掉 vanta", !miss.includes("vanta"), miss.join(","));
  ok("未命中作用域 → 摘掉 vanta-post", !miss.includes("vanta-post"));
  ok("未命中作用域 → 内置段保留(不误伤)", miss.includes("harness:identity"));
}

console.log("\n【3】B2 fail-closed —— agentPresets 未就绪");
{
  const h = makeCtx({ cfg: {}, sessions: { s1: {} }, composed: null });
  const r = await assemble(h, { sections: [{ name: "vanta" }, { name: "vanta-post" }] }, { agent: { id: "s1" } });
  ok("agentPresets 未就绪 → 摘掉 vanta（不泄人格）", !r.includes("vanta"));
  ok("agentPresets 未就绪 → 摘掉 vanta-post", !r.includes("vanta-post"));
}
{
  const h = makeCtx({ cfg: {}, sessions: {}, composed: { s1: "vanta" } });
  const r = await assemble(h, { sections: [{ name: "vanta" }] }, { agent: { id: "s1" } });
  ok("取不到 Agent → 摘掉 vanta（fail-closed）", !r.includes("vanta"));
}
{
  // composedPreset 抛异常也不能放行
  const h = makeCtx({ cfg: {}, sessions: { s1: {} }, composed: { s1: "vanta" } });
  h.ctx.get = (n) => n === "agentPresets"
    ? { composedPreset() { throw new Error("boom"); } } : undefined;
  // apply 已跑完，替换 ctx.get 后重跑 assemble
  const r = await assemble(h, { sections: [{ name: "vanta" }] }, { agent: { id: "s1" } });
  ok("composedPreset 抛异常 → 摘掉 vanta（不崩不泄）", !r.includes("vanta"));
}

console.log("\n【4】strictScope 退路");
{
  const h = makeCtx({ cfg: { strictScope: false }, sessions: {}, composed: {} });
  const r = await assemble(h, { sections: [{ name: "vanta" }, { name: "vanta-post" }] }, { agent: { id: "nope" } });
  ok("strictScope:false → vanta 全域注入(旧行为)", r.includes("vanta"));
  ok("strictScope:false → vanta-post 全域注入", r.includes("vanta-post"));
}

console.log("\n【5】autoMode=false 关闭注入（system 段也应关）");
{
  // 正向对照：autoMode=true 时段必须还在，否则下面的"摘掉"是空过。
  const on = makeCtx({ cfg: {}, sessions: { s1: { id: "s1", mode: "vanta" } }, composed: { x: 1 } });
  const keep = await assemble(on, { sections: [{ name: "vanta" }, { name: "vanta-post" }] }, { agent: { id: "s1" } });
  ok("autoMode:true → 保留 vanta（正向对照）", keep.includes("vanta"), keep.join(","));
  ok("autoMode:true → 保留 vanta-post（正向对照）", keep.includes("vanta-post"));

  await core.saveMultiPreset({ ...core.loadMultiPreset(), presets: { ...core.loadMultiPreset().presets, vanta: { ...core.loadMultiPreset().presets.vanta, autoMode: false } } });
  const h = makeCtx({ cfg: {}, sessions: { s1: { id: "s1", mode: "vanta" } }, composed: { x: 1 } });
  const r = await assemble(h, { sections: [{ name: "vanta" }, { name: "vanta-post" }] }, { agent: { id: "s1" } });
  ok("autoMode:false → 摘掉 vanta", !r.includes("vanta"));
  ok("autoMode:false → 摘掉 vanta-post", !r.includes("vanta-post"));
  await core.saveMultiPreset({ ...core.loadMultiPreset(), presets: { ...core.loadMultiPreset().presets, vanta: { ...core.loadMultiPreset().presets.vanta, autoMode: true } } });
}

console.log("\n【6】F1 按模型路由（llm/stream 层）");
// 路由决定用哪套预设的 user/assistant 条目；伪造轮默认关闭，故此处显式开启
// injectUserTrigger 才能观察到路由结果。路由在默认配置下不产生可见影响。
{
  const h = makeCtx({ cfg: { injectUserTrigger: true }, sessions: { s1: { id: "s1", mode: "vanta" } }, composed: { x: 1 } });
  const call = async (model) => {
    let captured = null;
    h.ctx.llm.stream = (o) => { captured = o; return Promise.resolve(); };
    for (const fn of h.handlers["llm/stream"] || []) {
      await fn(opts({ model }), () => Promise.resolve());
    }
    return captured;
  };
  const hit = await call("gpt-4o");
  const hitTexts = (hit?.messages || []).map((m) => m.content?.[0]?.text);
  ok("gpt-4o 命中路由 → 用 alt 的 user 条目", hitTexts.includes("USER-ALT"), JSON.stringify(hitTexts));
  ok("gpt-4o 路由命中 → 不用 vanta 的 user 条目", !hitTexts.includes("USER-VANTA"));

  const noHit = await call("deepseek-chat");
  const noTexts = (noHit?.messages || []).map((m) => m.content?.[0]?.text);
  ok("deepseek-chat 未命中 → 回落 vanta 的 user 条目", noTexts.includes("USER-VANTA"), JSON.stringify(noTexts));
  ok("deepseek-chat 未命中 → 不用 alt", !noTexts.includes("USER-ALT"));
}

console.log("\n【7】B3 verbose 门控");
{
  // makeCtx 在返回前就恢复了 console.log，所以 handler 真正执行时的输出要
  // 单独包一层捕获 —— 捕获窗口必须覆盖「调用 handler」而不只是「注册」。
  const capture = async (fn) => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try { await fn(); } finally { console.log = orig; }
    return lines;
  };

  const h = makeCtx({ cfg: { verbose: false }, sessions: { s1: { id: "s1", mode: "vanta" } }, composed: { x: 1 } });
  const quiet = await capture(async () => {
    for (const fn of h.handlers["llm/stream"] || []) await fn(opts(), () => Promise.resolve());
  });
  ok("verbose:false → 无 console 输出", quiet.length === 0, JSON.stringify(quiet));

  const h2 = makeCtx({ cfg: { verbose: true }, sessions: { s1: { id: "s1", mode: "vanta" } }, composed: { x: 1 } });
  const loud = await capture(async () => {
    for (const fn of h2.handlers["llm/stream"] || []) await fn(opts(), () => Promise.resolve());
  });
  ok("verbose:true → 有 console 输出", loud.length > 0, JSON.stringify(loud));
  ok("verbose:true → 日志含 preset/model 便于排查", loud.some((l) => l.includes("preset=vanta") && l.includes("model=deepseek-chat")), JSON.stringify(loud));
}

console.log("\n【8】system 段与路由无关（设计约束，status 已注明）");
{
  const { sections } = makeCtx({ cfg: {}, sessions: {}, composed: {} });
  ok("section.text() 始终取激活预设，不受 modelRoutes 影响",
    sect(sections, "vanta").text() === "SYSTEM-VANTA");
}

// 注入位置：fake 消息必须落在**末尾**。
// 放在开头会凭空造出一段开场（假 user 指令 + 假 assistant「好，以下是结果：」），
// 模型会把它读成"操作者的开场要求 + 我自己说过的话"，而两者都不成立 —— 这段前缀
// 正是越狱注入的形状，实测模型据此判定整份人格是 injected。此前测试只查"包含"，
// 查不出位置，所以这个 bug 一路绿灯。
console.log("\n【9】默认不伪造对话轮");
{
  const h = makeCtx({ cfg: {}, sessions: { s1: { id: "s1", mode: "vanta" } }, composed: { x: 1 } });
  let captured = null;
  h.ctx.llm.stream = (o) => { captured = o; return Promise.resolve(); };

  const history = [
    { id: "h1", role: "user", content: [{ type: "text", text: "REAL-TURN-1" }] },
    { id: "h2", role: "assistant", content: [{ type: "text", text: "REAL-TURN-2" }] },
    { id: "h3", role: "user", content: [{ type: "text", text: "REAL-TURN-3" }] },
  ];
  for (const fn of h.handlers["llm/stream"] || []) {
    await fn({ sessionId: "s1", model: "deepseek-chat", messages: history }, () => Promise.resolve());
  }

  const msgs = captured?.messages || [];
  const texts = msgs.map((m) => m.content?.[0]?.text);
  ok("默认不注入假 user 触发条目", !texts.includes("USER-VANTA"), JSON.stringify(texts));
  ok("默认不注入 assistant 预填充种子", !texts.includes("ASST-VANTA"), JSON.stringify(texts));
  ok("默认不改动消息数组（长度与真实历史一致）", msgs.length === 3, "len=" + msgs.length);
  ok("真实历史原样保留且顺序不变",
    JSON.stringify(texts) === JSON.stringify(["REAL-TURN-1", "REAL-TURN-2", "REAL-TURN-3"]),
    JSON.stringify(texts));
  ok("默认数组不以 assistant 轮结尾（思考模式校验位）",
    msgs[msgs.length - 1]?.role !== "assistant", JSON.stringify(msgs[msgs.length - 1]?.role));

  for (const fn of h.handlers["llm/stream"] || []) {
    await fn({ sessionId: "s1", model: "deepseek-chat", messages: captured.messages }, () => Promise.resolve());
  }
  ok("二次调用仍不注入", (captured?.messages || []).length === 3, "len=" + (captured?.messages || []).length);
}

// 两个开关显式开启时才恢复伪造轮，且都落在末尾。
console.log("\n【10】injectUserTrigger / injectAssistantSeed 显式开启");
{
  const mk = (cfg) => {
    const h = makeCtx({ cfg, sessions: { s1: { id: "s1", mode: "vanta" } }, composed: { x: 1 } });
    let cap = null;
    h.ctx.llm.stream = (o) => { cap = o; return Promise.resolve(); };
    return { h, get: () => cap };
  };
  const run = async (o) => {
    for (const fn of o.h.handlers["llm/stream"] || []) {
      await fn({
        sessionId: "s1", model: "deepseek-chat",
        messages: [{ id: "h1", role: "user", content: [{ type: "text", text: "REAL-TURN-1" }] }],
      }, () => Promise.resolve());
    }
    return o.get();
  };
  const textsOf = (m) => (m?.messages || []).map((x) => x.content?.[0]?.text);

  const u = mk({ injectUserTrigger: true });
  const um = await run(u);
  ok("仅开 user：注入假 user 且落在最末", textsOf(um).pop() === "USER-VANTA", JSON.stringify(textsOf(um)));
  ok("仅开 user：不注入 assistant", !textsOf(um).includes("ASST-VANTA"));

  const a = mk({ injectAssistantSeed: true });
  const am = await run(a);
  ok("仅开 assistant：注入种子且落在最末", textsOf(am).pop() === "ASST-VANTA", JSON.stringify(textsOf(am)));
  ok("仅开 assistant：不注入假 user", !textsOf(am).includes("USER-VANTA"));

  const b = mk({ injectUserTrigger: true, injectAssistantSeed: true });
  const bm = textsOf(await run(b));
  ok("两个都开：user 在前 assistant 在后（预填充语义）",
    bm[bm.length - 2] === "USER-VANTA" && bm[bm.length - 1] === "ASST-VANTA", JSON.stringify(bm));
}

console.log(`\n════ ${PASS} 通过 / ${FAIL} 失败 ════`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(FAIL ? 1 : 0);
