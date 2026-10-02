// dsh-preset-plus-vanta client bundle: 多预设编辑器设置页（酒馆式）。
// 预设列表（选择/激活/新增/删除） + 当前预设条目编辑（system/user/assistant）。
// 支持：导出单个预设、导出全部、导入（单条结构自动并入，多条结构合并）。
// Hand-written __ModuleLoader__ factory (no build step), mirroring dsh-purge/client.js.
window.__ModuleLoader__.load({ id: "@moxisuki/dsh-preset-plus-vanta", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	let react = require("react");
	const h = react.createElement;
	const { useState, useEffect, useCallback, useRef } = react;

	const name = "@moxisuki/dsh-preset-plus-vanta";
	const inject = ["slots"];

	const TOKENS = { ink: "var(--dsw-alias-label-primary, #e5e7eb)", muted: "var(--dsw-alias-label-tertiary, #9ca3af)", dim: "var(--dsw-alias-label-dimmed, #6b7280)", border: "var(--dsw-alias-border-l2, rgba(128,128,128,.25))", panel: "var(--dsw-alias-bg-layer-3, rgba(255,255,255,.035))", panel2: "var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06))", accent: "var(--dsw-alias-brand-primary, #4d9cff)", danger: "var(--dsw-alias-state-error-primary, #ef6b73)" };
	const PACKET_STYLE = { width: "100%", maxWidth: "920px", display: "flex", flexDirection: "column", gap: "18px", color: TOKENS.ink, fontFamily: "inherit" };
	const ROW_STYLE = { display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" };
	const BTN = (bg) => ({ padding: "8px 15px", borderRadius: "8px", border: "1px solid transparent", cursor: "pointer", fontSize: "13px", fontWeight: 600, background: bg, color: "#fff", transition: "opacity .15s, transform .15s" });
	const BTN_GHOST = { padding: "7px 11px", borderRadius: "8px", border: "1px solid " + TOKENS.border, cursor: "pointer", fontSize: "12px", fontWeight: 500, background: "transparent", color: TOKENS.ink };
	const INPUT_STYLE = { width: "100%", padding: "9px 11px", fontSize: "13px", boxSizing: "border-box", background: TOKENS.panel, color: TOKENS.ink, border: "1px solid " + TOKENS.border, borderRadius: "8px", outline: "none" };
	const TEXTAREA_STYLE = { width: "100%", minHeight: "120px", boxSizing: "border-box", fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace", fontSize: "12px", lineHeight: 1.6, padding: "11px", resize: "vertical", background: TOKENS.panel, color: TOKENS.ink, border: "1px solid " + TOKENS.border, borderRadius: "8px", outline: "none" };
	const CARD_STYLE = { border: "1px solid " + TOKENS.border, borderRadius: "12px", padding: "15px", display: "flex", flexDirection: "column", gap: "11px", background: TOKENS.panel, boxShadow: "0 2px 10px rgba(0,0,0,.06)" };
	const SELECT_STYLE = { padding: "8px 10px", fontSize: "12px", borderRadius: "8px", border: "1px solid " + TOKENS.border, background: TOKENS.panel2, color: TOKENS.ink };
	const LIST_STYLE = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "10px", fontSize: "13px" };
	const LIST_ITEM = { display: "flex", alignItems: "center", gap: "8px", padding: "12px 13px", borderRadius: "10px", border: "1px solid " + TOKENS.border, cursor: "pointer", background: TOKENS.panel };

	const ROLES = ["system", "user", "assistant"];

	// ── 三个附加卡片 ──────────────────────────────────────────────────────
	// 提成独立组件而不是塞进 render 的 JSX 里：嵌套层数浅、可读，
	// 也不会把主 render 撑成一坨。

	/** 尾部锚定段：注册在 system 末尾（order 5100），权重高于开头的主提示词。 */
	function PostPromptCard(props) {
		const { current, patchPreset } = props;
		return h("div", { style: Object.assign({}, CARD_STYLE, { marginTop: "4px" }) },
			h("div", { style: ROW_STYLE },
				h("span", { style: { fontSize: "13px", fontWeight: 600 } }, "尾部锚定段"),
				h("span", { style: { fontSize: "11px", color: TOKENS.dim } }, "system 末尾 · order 5100"),
				current.postPrompt
					? h("span", { style: { fontSize: "11px", color: TOKENS.muted } }, current.postPrompt.length + " 字")
					: h("span", { style: { fontSize: "11px", color: TOKENS.dim } }, "未启用")),
			h("textarea", {
				style: Object.assign({}, TEXTAREA_STYLE, { minHeight: "88px" }),
				value: current.postPrompt || "",
				onChange: (e) => patchPreset({ postPrompt: e.target.value }),
				spellCheck: false,
				placeholder: "留空则不注册尾部段。它出现在整个 system 的末尾，模型对这里的服从度最高 —— 放最简短的强指令。",
			}),
		);
	}

	/** 按模型路由：命中的模型改用对应预设的 user / assistant 条目。 */
	function ModelRoutesCard(props) {
		const { doc, addRoute, patchRoute, removeRoute, persist, busy } = props;
		const routes = (doc && doc.modelRoutes) || [];
		const presetIds = doc ? Object.keys(doc.presets) : [];
		return h("div", { style: Object.assign({}, CARD_STYLE, { marginTop: "2px" }) },
			h("div", { style: ROW_STYLE },
				h("span", { style: { fontSize: "13px", fontWeight: 600 } }, "按模型路由"),
				h("span", { style: { fontSize: "11px", color: TOKENS.dim } }, "首个匹配者胜出 · * 与 ? 为通配"),
				h("div", { style: Object.assign({}, ROW_STYLE, { marginLeft: "auto" }) },
					h("button", { style: BTN_GHOST, onClick: addRoute }, "+ 新增路由"))),
			h("p", { style: { margin: 0, fontSize: "11px", color: TOKENS.muted, lineHeight: 1.5 } },
				"命中的模型改用对应预设的 user / assistant 条目。system 与尾部段拿不到模型信息，始终取当前激活预设。"),
			routes.length === 0
				? h("div", { style: { fontSize: "12px", color: TOKENS.dim } }, "（无路由，全部走激活预设）")
				: h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
					routes.map(function (r, i) {
						return h("div", { key: i, style: ROW_STYLE },
							h("span", { style: { fontSize: "11px", color: TOKENS.dim, minWidth: "38px" } }, "模型"),
							h("input", {
								style: Object.assign({}, INPUT_STYLE, { maxWidth: "180px" }),
								value: r.pattern,
								spellCheck: false,
								placeholder: "gpt-* / deepseek-*",
								onChange: (e) => patchRoute(i, { pattern: e.target.value }),
							}),
							h("span", { style: { fontSize: "11px", color: TOKENS.dim } }, "→"),
							h("select", {
								style: SELECT_STYLE,
								value: r.presetId,
								onChange: (e) => patchRoute(i, { presetId: e.target.value }),
							}, presetIds.map(function (id) {
								const p = doc.presets[id];
								const label = p.name && p.name !== id ? id + "（" + p.name + "）" : id;
								return h("option", { key: id, value: id }, label);
							})),
							h("button", {
								style: Object.assign({}, BTN_GHOST, { color: TOKENS.danger, borderColor: "rgba(239,107,115,.35)", padding: "4px 9px", fontSize: "11px" }),
								onClick: () => removeRoute(i),
							}, "删除"));
					})),
			h("div", { style: ROW_STYLE },
				h("button", {
					style: Object.assign({ opacity: busy ? 0.6 : 1 }, BTN("var(--accent, #2f81f7)")),
					disabled: busy,
					onClick: () => persist(doc, "已保存。新会话生效。"),
				}, "保存路由")),
		);
	}

	/** 快照：手动打点 + 从历史快照还原。每次写入前的自动 .bak 由宿主侧负责。 */
	function SnapshotsCard(props) {
		const { snapshots, makeBackup, refreshSnapshots, restoreFrom, busy, meta } = props;
		const degraded = meta && meta.runtime ? meta.runtime.degraded : null;
		return h("div", { style: Object.assign({}, CARD_STYLE, { marginTop: "2px" }) },
			h("div", { style: ROW_STYLE },
				h("span", { style: { fontSize: "13px", fontWeight: 600 } }, "快照"),
				h("span", { style: { fontSize: "11px", color: TOKENS.dim } },
					"每次写入前另存 " + (meta && meta.backupPath ? meta.backupPath.replace(/^.*[\\/]/, "") : "vanta-presets.json.bak")),
				h("div", { style: Object.assign({}, ROW_STYLE, { marginLeft: "auto" }) },
					h("button", { style: Object.assign({}, BTN_GHOST, { opacity: busy ? 0.6 : 1 }), disabled: busy, onClick: makeBackup }, "立即备份"),
					h("button", { style: BTN_GHOST, onClick: refreshSnapshots }, "刷新"))),
			degraded
				? h("div", { style: { fontSize: "12px", color: "#e5a50a" } }, "⚠ " + degraded)
				: null,
			snapshots.length === 0
				? h("div", { style: { fontSize: "12px", color: TOKENS.dim } }, "（暂无快照）")
				: h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", maxHeight: "190px", overflowY: "auto" } },
					snapshots.slice(0, 20).map(function (s) {
						const when = String(s.mtime).replace("T", " ").split(".")[0];
						return h("div", { key: s.id, style: ROW_STYLE },
							h("span", { style: { fontSize: "11px", color: TOKENS.muted, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, when + "  (" + s.size + " B)"),
							h("button", { style: Object.assign({}, BTN_GHOST, { padding: "4px 9px", fontSize: "11px" }), disabled: busy, onClick: () => restoreFrom(s.id) }, "还原"));
					})),
		);
	}

	function PresetEditor() {
		const [doc, setDoc] = useState(null);
		const [meta, setMeta] = useState(null);
		const [selectedId, setSelectedId] = useState(null);
		const [notice, setNotice] = useState({ kind: "idle", text: "" });
		const [busy, setBusy] = useState(false);
		const [addingPreset, setAddingPreset] = useState(false);
		const [newPresetId, setNewPresetId] = useState("");
		const [deleteConfirmId, setDeleteConfirmId] = useState(null);

		const loadState = useCallback(() => {
			fetch("/dsh-preset-plus-vanta/state", { cache: "no-store" }).then((r) => r.json()).then((d) => {
				if (d.ok) {
					setDoc(d.doc);
					setMeta(d);
					setSelectedId(d.doc.presets[selectedId] ? selectedId : d.doc.activePresetId);
				} else {
					setNotice({ kind: "error", text: "读取失败: " + (d.error || "") });
				}
			}).catch((e) => setNotice({ kind: "error", text: "读取失败: " + e.message }));
		}, [selectedId]);

		useEffect(() => { loadState(); }, []);

		const persist = useCallback((nextDoc, okText) => {
			setBusy(true);
			setNotice({ kind: "idle", text: "" });
			fetch("/dsh-preset-plus-vanta/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: nextDoc }) })
				.then((r) => r.json()).then((d) => {
					if (d.ok) { setDoc(d.doc); setNotice({ kind: "ok", text: okText || "已保存。新会话生效。" }); }
					else { setNotice({ kind: "error", text: "保存失败: " + (d.error || "") }); }
				}).catch((e) => setNotice({ kind: "error", text: "保存失败: " + e.message })).finally(() => setBusy(false));
		}, []);

		const current = doc && doc.presets[selectedId];

		const patchPreset = useCallback((patch) => {
			setDoc((d) => {
				const p = d.presets[selectedId];
				if (!p) return d;
				return { ...d, presets: { ...d.presets, [selectedId]: { ...p, ...patch } } };
			});
		}, [selectedId]);

		const patchEntry = useCallback((idx, patch) => {
			setDoc((d) => {
				const p = d.presets[selectedId];
				if (!p) return d;
				const entries = p.entries.map((e, i) => i === idx ? { ...e, ...patch } : e);
				return { ...d, presets: { ...d.presets, [selectedId]: { ...p, entries } } };
			});
		}, [selectedId]);

		const addEntry = useCallback(() => {
			setDoc((d) => {
				const p = d.presets[selectedId];
				if (!p) return d;
				const role = p.entries.length === 0 ? "system" : "assistant";
				return { ...d, presets: { ...d.presets, [selectedId]: { ...p, entries: [...p.entries, { role, text: "" }] } } };
			});
		}, [selectedId]);

		const removeEntry = useCallback((idx) => {
			setDoc((d) => {
				const p = d.presets[selectedId];
				if (!p) return d;
				return { ...d, presets: { ...d.presets, [selectedId]: { ...p, entries: p.entries.filter((x, i) => i !== idx) } } };
			});
		}, [selectedId]);

		const moveEntry = useCallback((idx, dir) => {
			setDoc((d) => {
				const p = d.presets[selectedId];
				if (!p) return d;
				const j = idx + dir;
				if (j < 0 || j >= p.entries.length) return d;
				const entries = [...p.entries];
				const t = entries[idx];
				entries[idx] = entries[j];
				entries[j] = t;
				return { ...d, presets: { ...d.presets, [selectedId]: { ...p, entries } } };
			});
		}, [selectedId]);

		const addPreset = useCallback(() => {
			setAddingPreset(true);
			setNewPresetId("");
			setDeleteConfirmId(null);
		}, []);

		const confirmAddPreset = useCallback(() => {
			const key = newPresetId.trim().replace(/\s+/g, "-").toLowerCase();
			if (!key) { setNotice({ kind: "error", text: "请输入预设 id。" }); return; }
			if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) { setNotice({ kind: "error", text: "id 只能用小写字母/数字/连字符，且以字母数字开头。" }); return; }
			setDoc((d) => {
				if (d.presets[key]) { setNotice({ kind: "error", text: "预设已存在: " + key }); return d; }
				setSelectedId(key);
				return { ...d, presets: { ...d.presets, [key]: { id: key, name: key, autoMode: true, entries: [{ role: "system", text: "" }, { role: "user", text: "" }, { role: "assistant", text: "" }] } } };
			});
			setAddingPreset(false);
			setNewPresetId("");
		}, [newPresetId]);

		const cancelAddPreset = useCallback(() => {
			setAddingPreset(false);
			setNewPresetId("");
		}, []);

		const activate = useCallback((id) => {
			setDoc((d) => ({ ...d, activePresetId: id }));
			setSelectedId(id);
		}, []);

		const requestDeletePreset = useCallback((id) => {
			setDeleteConfirmId(id);
		}, []);

		const removePreset = useCallback((id) => {
			setDoc((d) => {
				const presets = { ...d.presets };
				delete presets[id];
				let active = d.activePresetId;
				if (active === id || !presets[active]) active = Object.keys(presets)[0] || "";
				if (selectedId === id) setSelectedId(active || "");
				return { ...d, activePresetId: active, presets };
			});
			setDeleteConfirmId(null);
		}, [selectedId]);

		const exportSingle = useCallback(() => {
			if (!current) return;
			// postPrompt 必须带上：漏了它，导出→导入往返一次就把尾部锚定段丢了。
			const raw = JSON.stringify({ id: current.id, name: current.name, autoMode: current.autoMode, postPrompt: current.postPrompt || "", entries: current.entries }, null, 2);
			downloadJson(raw, "vanta-" + (current.name || current.id) + ".json", setNotice);
		}, [current]);

		const exportAll = useCallback(() => {
			// modelRoutes 同理：漏了就等于把路由表清空。
			const raw = JSON.stringify({ version: (doc && doc.version) || 2, activePresetId: doc && doc.activePresetId, modelRoutes: (doc && doc.modelRoutes) || [], presets: doc && doc.presets }, null, 2);
			downloadJson(raw, "vanta-all.json", setNotice);
		}, [doc]);

		// ── 模型路由 ──────────────────────────────────────────────────────────
		const patchRoute = useCallback((idx, patch) => {
			setDoc((d) => {
				const routes = (d.modelRoutes || []).map((r, i) => (i === idx ? { ...r, ...patch } : r));
				return { ...d, modelRoutes: routes };
			});
		}, []);

		const addRoute = useCallback(() => {
			setDoc((d) => ({ ...d, modelRoutes: [...(d.modelRoutes || []), { pattern: "", presetId: d.activePresetId }] }));
		}, []);

		const removeRoute = useCallback((idx) => {
			setDoc((d) => ({ ...d, modelRoutes: (d.modelRoutes || []).filter((_, i) => i !== idx) }));
		}, []);

		// ── 备份 / 还原 ───────────────────────────────────────────────────────
		const [snapshots, setSnapshots] = useState([]);

		const refreshSnapshots = useCallback(() => {
			fetch("/dsh-preset-plus-vanta/snapshots", { cache: "no-store" })
				.then((r) => (r.ok ? r.json() : null))
				.then((d) => { if (d && d.ok) setSnapshots(d.snapshots || []); })
				.catch(() => { /* 旧宿主没有该路由：静默，留空列表 */ });
		}, []);

		useEffect(() => { refreshSnapshots(); }, []);

		const makeBackup = useCallback(() => {
			setBusy(true);
			fetch("/dsh-preset-plus-vanta/backup", { method: "POST" })
				.then((r) => (r.ok ? r.json() : null))
				.then((d) => {
					if (d && d.ok) { setSnapshots(d.snapshots || []); setNotice({ kind: "ok", text: "已打快照: " + d.snapshot.id }); }
					else { setNotice({ kind: "error", text: "备份失败: 宿主未提供该接口（可能需要重启 DSH）" }); }
				})
				.catch((e) => setNotice({ kind: "error", text: "备份失败: " + e.message }))
				.finally(() => setBusy(false));
		}, []);

		const restoreFrom = useCallback((id) => {
			setBusy(true);
			fetch("/dsh-preset-plus-vanta/restore", {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
			}).then((r) => (r.ok ? r.json() : null)).then((d) => {
				if (d && d.ok) {
					setDoc(d.doc);
					setSelectedId(d.doc.activePresetId);
					setNotice({ kind: "ok", text: "已从快照还原: " + id });
				} else { setNotice({ kind: "error", text: "还原失败: 宿主未提供该接口（可能需要重启 DSH）" }); }
			}).catch((e) => setNotice({ kind: "error", text: "还原失败: " + e.message })).finally(() => setBusy(false));
		}, []);

		const fileInputRef = useRef(null);

		const importPreset = useCallback(() => {
			// 触发隐藏的文件选择器，而不是弹窗粘贴 JSON。
			if (fileInputRef.current) fileInputRef.current.click();
		}, []);

		const handleImportFile = useCallback((event) => {
			const file = event.target.files && event.target.files[0];
			// 清空 input 以便再次选择同一文件时仍能触发 change。
			event.target.value = "";
			if (!file) return;
			const reader = new FileReader();
			reader.onload = () => {
				const text = String(reader.result || "");
				if (text.trim() === "") { setNotice({ kind: "error", text: "文件内容为空。" }); return; }
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				fetch("/dsh-preset-plus-vanta/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: text }) })
					.then((r) => r.json()).then((d) => {
						if (d.ok) { setDoc(d.doc); setSelectedId(d.doc.activePresetId); setNotice({ kind: "ok", text: "已导入并保存。" }); }
						else { setNotice({ kind: "error", text: "导入失败: " + (d.error || "") }); }
					}).catch((e) => setNotice({ kind: "error", text: "导入失败: " + e.message })).finally(() => setBusy(false));
			};
			reader.onerror = () => setNotice({ kind: "error", text: "读取文件失败。" });
			reader.readAsText(file);
		}, []);

		const inputFileStyle = { display: "none" };

		// render
		const listed = doc ? Object.values(doc.presets) : [];
		const isActive = (id) => id === (doc && doc.activePresetId);

		return h("div", { style: PACKET_STYLE },
			h("input", { type: "file", accept: "application/json,.json", style: inputFileStyle, ref: fileInputRef, onChange: handleImportFile }),
			h("div", { style: { paddingBottom: "2px", borderBottom: "1px solid " + TOKENS.border } },
				h("h2", { style: { margin: 0, fontSize: "20px", lineHeight: 1.35, fontWeight: 650, letterSpacing: "-.01em" } }, "预设增强"),
				h("p", { style: { margin: "6px 0 15px", color: TOKENS.muted, fontSize: "13px", lineHeight: 1.55 } }, "管理 vanta 模式使用的提示词。选择一个预设并保存后，新会话即可生效。")),
			!doc ? h("p", { style: { color: TOKENS.muted } }, "加载中…")
				: h("div", { style: { display: "flex", flexDirection: "column", gap: "16px" } },
					h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "end", gap: "12px", flexWrap: "wrap" } },
						h("div", null, h("div", { style: { fontSize: "12px", color: TOKENS.muted, marginBottom: "6px" } }, "选择预设"), h("div", { style: { fontSize: "14px", fontWeight: 600 } }, listed.length + " 套可用预设")),
						h("div", { style: ROW_STYLE }, h("button", { style: BTN_GHOST, onClick: addPreset }, "+ 新增"), h("button", { style: BTN_GHOST, onClick: importPreset }, "导入"), h("button", { style: BTN_GHOST, onClick: exportAll }, "导出全部"))),
					addingPreset ? h("div", { style: Object.assign({}, CARD_STYLE, { gap: "10px" }) },
						h("div", { style: { fontSize: "13px", fontWeight: 600 } }, "新增预设"),
						h("div", { style: ROW_STYLE },
							h("input", { style: Object.assign({}, INPUT_STYLE, { maxWidth: "240px" }), placeholder: "id（小写/数字/连字符）", value: newPresetId, onChange: (e) => setNewPresetId(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") confirmAddPreset(); } }),
							h("button", { style: BTN("var(--dsw-alias-brand-primary, #4d9cff)"), onClick: confirmAddPreset }, "创建"),
							h("button", { style: BTN_GHOST, onClick: cancelAddPreset }, "取消")),
					) : null,
				h("div", { style: LIST_STYLE },
						listed.map((p) =>
							h("div", { key: p.id, style: Object.assign({}, LIST_ITEM, { borderColor: isActive(p.id) ? TOKENS.accent : TOKENS.border, background: isActive(p.id) ? TOKENS.panel2 : TOKENS.panel }), onClick: () => activate(p.id) },
								h("span", { style: { color: isActive(p.id) ? TOKENS.accent : TOKENS.dim, fontSize: "16px" } }, isActive(p.id) ? "●" : "○"),
								h("span", { style: { flex: 1, minWidth: 0 } }, h("div", { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.name || p.id), h("div", { style: { color: TOKENS.muted, fontSize: "11px", marginTop: "3px" } }, p.id + " · " + p.entries.length + " 条")),
								h("span", { style: { color: isActive(p.id) ? TOKENS.accent : TOKENS.dim, fontSize: "11px" } }, isActive(p.id) ? "已激活" : "选择"),
								deleteConfirmId === p.id
									? h("div", { style: { display: "flex", gap: "6px", alignItems: "center" }, onClick: (e) => e.stopPropagation() },
										h("button", { style: Object.assign({}, BTN_GHOST, { color: TOKENS.danger, borderColor: "rgba(239,107,115,.35)" }), onClick: (e) => { e.stopPropagation(); removePreset(p.id); } }, "确认"),
										h("button", { style: BTN_GHOST, onClick: (e) => { e.stopPropagation(); setDeleteConfirmId(null); } }, "取消"))
									: h("button", { style: Object.assign({}, BTN_GHOST, { color: TOKENS.danger, borderColor: "rgba(239,107,115,.35)", padding: "3px 8px", fontSize: "11px" }), onClick: (e) => { e.stopPropagation(); requestDeletePreset(p.id); } }, "删除"),
							)),
						h("div", { style: ROW_STYLE },




							notice.kind === "ok" ? h("span", { style: { fontSize: "13px", opacity: 0.85 } }, notice.text)
								: notice.kind === "error" ? h("span", { style: { fontSize: "13px", color: "#e5484d" } }, notice.text)
								: null,
						),
					),

					!current ? h("p", { style: { opacity: 0.6 } }, "无选中预设")
						: h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
							h("div", { style: ROW_STYLE },
								h("span", { style: { fontSize: "13px", opacity: 0.8 } }, "名称:"),
								h("input", { style: Object.assign({ maxWidth: "160px" }, INPUT_STYLE), value: current.name, onChange: (e) => patchPreset({ name: e.target.value }) }),
								h("label", { style: { fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" } },
									h("input", { type: "checkbox", checked: current.autoMode, onChange: (e) => patchPreset({ autoMode: e.target.checked }) }),
									"自动注入"),
								h("span", { style: { fontSize: "12px", opacity: 0.7 } }, "作用域: " + ((meta && meta.scopedPresets) ? meta.scopedPresets.join(", ") : "(空=关闭)")),
								h("button", { style: Object.assign({ opacity: busy ? 0.6 : 1 }, BTN("var(--accent, #2f81f7)")), disabled: busy, onClick: () => persist(doc, "已保存。新会话生效。") }, "保存"),
								h("button", { style: BTN_GHOST, onClick: exportSingle }, "导出当前"),
							),

							current.entries[0] && current.entries[0].role !== "system"
								? h("div", { style: { fontSize: "12px", color: "#e5a50a" } }, "⚠ 第一条必须是 system（主提示词）。")
								: null,

							current.entries.map((entry, i) => {
								const isHead = i === 0;
								const entryOn = isHead ? true : entry.enabled !== false;
								const tagStyle = { fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "999px", border: "1px solid " + TOKENS.border, color: entryOn ? TOKENS.muted : TOKENS.dim };
								const switchStyle = {
									position: "relative", width: "36px", height: "20px", flexShrink: 0, cursor: isHead ? "default" : "pointer",
									background: entryOn ? "var(--dsw-alias-brand-primary, #4d9cff)" : TOKENS.border,
									border: "none", borderRadius: "999px", transition: "background .16s", padding: 0,
								};
								const knobStyle = {
									position: "absolute", top: "2px", left: entryOn ? "18px" : "2px", width: "16px", height: "16px",
									background: "#fff", borderRadius: "50%", transition: "left .16s",
								};
								return h("div", { key: i, title: isHead ? "第一条固定为 system 主提示词，不允许禁用" : undefined, style: Object.assign({}, CARD_STYLE, entryOn ? {} : { opacity: 0.6 }) },
									h("div", { style: ROW_STYLE },
										h("span", { style: { fontSize: "12px", opacity: 0.7 } }, "#" + (i + 1)),
										h("select", { style: SELECT_STYLE, value: entry.role, disabled: isHead, title: isHead ? "第一条固定为 system" : undefined, onChange: (e) => patchEntry(i, { role: e.target.value }) },
											ROLES.map((r) => h("option", { key: r, value: r }, r === "system" ? "system（主提示词）" : r))),
										h("span", { style: tagStyle }, isHead ? "主提示词" : (entryOn ? "启用" : "停用")),
										h("div", { style: Object.assign({}, ROW_STYLE, { marginLeft: "auto" }) },
											h("button", { style: switchStyle, disabled: isHead, title: isHead ? "第一条不允许禁用" : (entryOn ? "点击关闭" : "点击开启"), onClick: () => patchEntry(i, { enabled: !entryOn }) },
												h("span", { style: knobStyle })),
											h("button", { style: BTN_GHOST, disabled: isHead, title: isHead ? "第一条固定为 system" : undefined, onClick: () => moveEntry(i, -1) }, "↑"),
											h("button", { style: BTN_GHOST, onClick: () => moveEntry(i, 1) }, "↓"),
											h("button", { style: Object.assign({ padding: "5px 10px", borderRadius: "6px", border: "1px solid rgba(229,72,77,0.5)", cursor: "pointer", fontSize: "12px", background: "transparent", color: "#e5484d" }, isHead ? { opacity: 0.4, cursor: "default" } : {}), disabled: isHead, title: isHead ? "第一条固定为 system，不允许删除" : undefined, onClick: () => removeEntry(i) }, "删除"),
										),
									),
									h("textarea", { style: TEXTAREA_STYLE, value: entry.text, onChange: (e) => patchEntry(i, { text: e.target.value }), spellCheck: false, disabled: !entryOn, placeholder: entry.role === "system" ? "主提示词（例如 JailbreakPrompt）" : entry.role === "user" ? "破限增强/触发（以 user 注入）" : "伪装模型输出（assistant 预填充种子）" }),
								);
							}),
							h("button", { style: BTN_GHOST, onClick: addEntry }, "+ 新增条目"),

						h(PostPromptCard, { current, patchPreset }),
						h(ModelRoutesCard, { doc, addRoute, patchRoute, removeRoute, persist, busy }),
						h(SnapshotsCard, { snapshots, makeBackup, refreshSnapshots, restoreFrom, busy, meta }),
						),
				),
		);
	}

	function downloadJson(raw, filename, setNotice) {
		try {
			const blob = new Blob([raw], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
			setNotice({ kind: "ok", text: "已导出。" });
		} catch (e) {
			setNotice({ kind: "error", text: "导出失败: " + (e.message || String(e)) });
		}
	}

	function apply(ctx) {
		ctx.slots.inject("settings.section", () => ctx.slots.register({
			name: "settings.section",
			id: "@moxisuki/dsh-preset-plus-vanta",
			order: 42,
			label: () => "预设增强",
		}, () => h(PresetEditor, null)));
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
	}
});
