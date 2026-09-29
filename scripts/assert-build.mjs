#!/usr/bin/env node
// dsh-preset-plus-vanta 是手写纯 JS，无编译步骤。"build" 因此在发布/安装前校验
// 发布入口确实存在且可解析——防止误发布一个缺文件的包。
// 注意：包内不再放 prepare/postinstall（pnpm 10 默认拦截依赖构建脚本，会破坏
// 一行安装）。本脚本在 CI 里作为显式步骤运行。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 发布入口：host 端 + client bundle + 核心 + 打包清单
const REQUIRED = [
  'lib/index.js',
  'lib/core.js',
  'client.js',
  'cordis.patch.yml',
  'presets/jailbreak.json',
  'presets/vanta.json',
];

let failed = false;

for (const rel of REQUIRED) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    console.error(`[assert-build] 缺少文件: ${rel}`);
    failed = true;
  }
}

// host 入口单独做语法解析
for (const rel of ['lib/index.js', 'lib/core.js', 'client.js', 'presets/jailbreak.json', 'presets/vanta.json']) {
  const abs = join(root, rel);
  try {
    readFileSync(abs, 'utf8'); // 能读即可；完整语法由 `lint` 的 node --check 做
  } catch (e) {
    console.error(`[assert-build] 读不了 ${rel}: ${e.message}`);
    failed = true;
  }
}

if (failed) {
  console.error('[assert-build] 发布校验失败：请补齐缺失的发布入口。');
  process.exit(1);
}

// vanta 的 agent preset 在 cordis.patch.yml 里声明，插件列表内联在声明行的
// `plugins:` 之下，且必须承载至少一个插件行（否则以该模式启动的会话没有任何
// 模型可用的工具）。读文本做宽松的启发式检查：声明行存在，且其之后至少出现
// 一个 `- id:` 行。完整语义校验由 CI 的 mount-validate 兜底。
try {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  const parts = patch.split(/^[ \t]*- id: preset-vanta[ \t]*$/m);
  if (parts.length < 2) {
    console.error('[assert-build] cordis.patch.yml 缺少 agent preset 声明行 `- id: preset-vanta`。');
    process.exit(1);
  }
  const pluginRows = (parts[1].match(/^\s*- id:/gm) || []).length;
  if (pluginRows === 0) {
    console.error('[assert-build] preset-vanta 的 plugins 列表为空（声明之后没有任何 `- id:` 行）；请先补齐插件行。');
    process.exit(1);
  }
} catch (e) {
  console.error(`[assert-build] 读不了 cordis.patch.yml: ${e.message}`);
  process.exit(1);
}

// 用 import() 动态加载 host 核心，确认模块可加载（捕获顶层语法/导入错误）。
try {
  await import(pathToFileURL(join(root, 'lib/core.js')).href);
} catch (e) {
  console.error(`[assert-build] lib/core.js 无法加载: ${e.message}`);
  process.exit(1);
}

console.log('[assert-build] 就绪：发布入口完整，core 可加载。');
