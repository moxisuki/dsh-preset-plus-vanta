// client.js 渲染冒烟测试：真的把设置页组件跑一遍。
//
// 为什么需要它：`node --check` 只验语法，"snapshots is not defined" 这种
// ReferenceError 它一律放行 —— 而那正是把整个设置页渲染成空白的原因。
// 这里用 mock react 真正执行一次 render，让未定义标识符当场暴露。

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// 默认测本仓库的 client.js；PPV_PKG 可指向别处（例如 ~/.dsh 里的已安装副本）。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = process.env.PPV_PKG || REPO;
const CLIENT = path.join(PKG, "client.js");
if (!fs.existsSync(CLIENT)) throw new Error("找不到 client.js: " + CLIENT);

let PASS = 0, FAIL = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name} ${extra}`); }
};

// ── 预设数据 ────────────────────────────────────────────────────────
const DOC = {
  version: 2,
  activePresetId: "vanta",
  modelRoutes: [{ pattern: "gpt-*", presetId: "alt" }],
  presets: {
    vanta: {
      id: "vanta", name: "VANTA", autoMode: true, postPrompt: "TAIL",
      entries: [
        { role: "system", text: "S" },
        { role: "user", text: "U" },
        { role: "assistant", text: "A" },
      ],
    },
    alt: { id: "alt", name: "ALT", autoMode: true, postPrompt: "", entries: [{ role: "system", text: "s" }] },
  },
};
const META = {
  ok: true, doc: DOC, scopedPresets: ["vanta"], strictScope: true, verbose: false,
  dshHome: "C:/fake", storePath: "C:/fake/vanta-presets.json",
  backupPath: "C:/fake/vanta-presets.json.bak", snapshotDir: "C:/fake/backups",
  runtime: { degraded: null, lastWriteError: null },
};
const SNAPSHOTS = [{ id: "vanta-presets-x.json", path: "C:/fake/b", size: 128, mtime: "2026-10-02T09:17:01.000Z" }];

/**
 * 跑一次 render。
 * @param {object} overrides 按 useState 调用序（下标）覆盖初始值。
 *   useState 序：doc(0) meta(1) selectedId(2) notice(3) busy(4)
 *               addingPreset(5) newPresetId(6) deleteConfirmId(7) snapshots(8)
 */
function render(overrides = {}) {
  const stateQueue = [DOC, META, "vanta", { kind: "idle", text: "" }, false, false, "", null, SNAPSHOTS];
  let stateIdx = 0;
  const setState = () => {};

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: (initial) => {
      const i = stateIdx++;
      const value = Object.prototype.hasOwnProperty.call(overrides, i) ? overrides[i] : stateQueue[i] ?? initial;
      return [value, setState];
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: () => ({ current: null }),
  };

  let moduleExports = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { moduleExports = spec.factory(() => react); } } },
    console,
    document: { createElement: () => ({}), body: { appendChild() {}, removeChild() {} } },
    Blob: class {}, URL: { createObjectURL: () => "", revokeObjectURL() {} },
    FileReader: class {},
    fetch: () => Promise.resolve({ ok: false }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CLIENT, "utf8"), sandbox, { filename: CLIENT });

  // apply 的注册形式是 slots.register(def, renderFn) —— 组件在第二个参数。
  let Component = null;
  const ctx = {
    slots: {
      inject: (_slot, fn) => fn(),
      register: (_def, renderFn) => { Component = renderFn; },
    },
  };
  moduleExports.apply(ctx);
  if (typeof Component !== "function") throw new Error("未能取到 settings.section 组件");
  return { tree: Component(null), Component };
}

// ── 深度遍历渲染树，收集文案 ──────────────────────────────────────────
// 关键：h(Component, props) 返回的是**元素**而不是结果，函数组件必须被调用一次，
// 否则拿到的是空壳元素树，断言全部落空。
function texts(node, acc = [], depth = 0) {
  if (node == null || depth > 60) return acc;
  if (typeof node === "string" || typeof node === "number") { acc.push(String(node)); return acc; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, acc, depth + 1)); return acc; }
  if (typeof node === "object") {
    if (typeof node.type === "function") {
      // 函数组件：调用它，拿到子树再遍历。
      let out = null;
      try { out = node.type(node.props); } catch (e) { acc.push("<<render-error: " + e.message + ">>"); return acc; }
      return texts(out, acc, depth + 1);
    }
    // 表单控件的文案在 props.value / props.placeholder 上，不在 children 里。
    const p = node.props || {};
    if (typeof p.value === "string") acc.push(p.value);
    if (typeof p.placeholder === "string") acc.push(p.placeholder);
    if (node.children) texts(node.children, acc, depth + 1);
  }
  return acc;
}

console.log("【client.js 渲染冒烟】");

// 1) 正常数据 —— 这就是之前整页空白的那条路径
let tree = null, err = null;
try { tree = render().tree; } catch (e) { err = e; }
ok("render 不抛 ReferenceError", !err, err ? `${err.constructor.name}: ${err.message}` : "");
if (err) { console.log(`\n  首个失败堆栈:\n${err.stack.split("\n").slice(0, 4).join("\n")}`); }

if (tree) {
  const t = texts(tree).join(" ");
  // 子组件里的 ReferenceError 会被 texts() 记成 <<render-error: ...>> 标记。
  // 必须显式断言它不存在 —— 否则这类故障只会表现为"文本缺失"，不易定位。
  ok("子树渲染无 render-error 标记", !t.includes("<<render-error"), t.includes("<<render-error") ? t.match(/<<render-error[^>]*>>/)[0] : "");
  ok("渲染出标题「预设增强」", t.includes("预设增强"));
  ok("渲染出选中预设名 VANTA", t.includes("VANTA"));
  ok("渲染出尾部锚定段卡片", t.includes("尾部锚定段"));
  ok("渲染出按模型路由卡片", t.includes("按模型路由"));
  ok("渲染出快照卡片", t.includes("快照"));
  ok("路由 pattern 可见", t.includes("gpt-*"));
  ok("预设列表含 ALT", t.includes("ALT"));
}

// 2) 空数据（doc=null）—— 应显示加载中而不是崩
let err2 = null;
try { render({ 0: null, 1: null, 2: null }).tree; } catch (e) { err2 = e; }
ok("doc=null 时不崩", !err2, err2 ? err2.message : "");

// 3) 无 modelRoutes（旧文档，v1 形态）—— 必须是空态而不是崩
let err3 = null;
try {
  const oldDoc = { version: 1, activePresetId: "vanta", presets: { vanta: { ...DOC.presets.vanta, postPrompt: "" } } };
  render({ 0: oldDoc, 1: META, 2: "vanta" }).tree;
} catch (e) { err3 = e; }
ok("v1 文档（无 modelRoutes）不崩", !err3, err3 ? err3.message : "");

// 4) 无 postPrompt（字段缺失）
let err4 = null;
try {
  const noPost = { ...DOC, presets: { vanta: { id: "vanta", name: "V", autoMode: true, entries: [{ role: "system", text: "S" }] } } };
  render({ 0: noPost, 1: META, 2: "vanta" }).tree;
} catch (e) { err4 = e; }
ok("预设无 postPrompt 字段不崩", !err4, err4 ? err4.message : "");

console.log(`\n════ ${PASS} 通过 / ${FAIL} 失败 ════`);
process.exit(FAIL ? 1 : 0);
