import {
	Editor,
	MarkdownFileInfo,
	MarkdownView,
	Notice,
	Plugin,
	WorkspaceLeaf,
	normalizePath,
} from "obsidian";
import { VIEW_TYPE_USAGE_NORMS, UsageNormsView } from "./view";
import { UsageNormsData, UsageNormsSettingTab, normalizeData } from "./settings";
import { TemplateLibrary, PromptTemplate } from "./templates";
import { AssistStore } from "./store";
import { Strength, isStrength, requestSuggestions } from "./engine";
import { applyMarks, clearMarks, marksExtension } from "./decorations";
import type { EditorView, ViewUpdate } from "@codemirror/view";

/** 「已经算过的句子」最多留多少页，超了按最后使用时间丢最旧的。 */
const MAX_PAGES = 500;

export default class UsageNormsPlugin extends Plugin {
	data: UsageNormsData = { ...normalizeData(null), scans: {} };
	library!: TemplateLibrary;
	store!: AssistStore;

	private views = new Set<UsageNormsView>();
	private panels = new Set<UsageNormsView>();
	private markedView: EditorView | null = null;
	private repaintTimer: number | null = null;
	private saveTimer: number | null = null;
	private modeKeyAtLoad = "";
	/**
	 * 最近一次「真正在读的笔记」。
	 *
	 * 点侧栏按钮时 activeLeaf 是侧栏，`getActiveViewOfType(MarkdownView)` 会返回
	 * null —— 但这时 ✓ 仍然必须改到那篇笔记，所以记一份最近的 MarkdownView。
	 */
	private lastMarkdown: MarkdownView | null = null;

	async onload(): Promise<void> {
		this.data = normalizeData(await this.loadData());
		this.library = new TemplateLibrary(this.app);
		this.library.setFolder(this.data.templateFolder);
		await this.library.refresh();

		this.store = new AssistStore({
			data: this.data,
			template: () => this.selectedTemplate() ?? null,
			notify: () => this.onStoreChanged(),
			persist: () => this.schedulePersist(),
		});
		this.modeKeyAtLoad = this.modeKey();

		// 正文标记（CM6 decoration）+ 光标变化
		this.registerEditorExtension(marksExtension((update) => this.onViewUpdate(update)));

		this.registerView(VIEW_TYPE_USAGE_NORMS, (leaf: WorkspaceLeaf) => {
			const view = new UsageNormsView(leaf, this);
			this.views.add(view);
			return view;
		});

		this.addRibbonIcon("sparkles", "用语规范：打开左侧面板", () => void this.openPanel());

		this.addCommand({
			id: "open-panel",
			name: "打开 / 聚焦左侧面板",
			callback: () => void this.openPanel(),
		});
		this.addCommand({
			id: "scan-all",
			name: "全文扫描当前笔记",
			callback: () => void this.scanAll(),
		});
		this.addCommand({
			id: "ignore-all",
			name: "清空面板里的建议",
			callback: () => {
				this.store.items = [];
				this.store.activeIndex = null;
				this.onStoreChanged();
			},
		});

		this.addSettingTab(new UsageNormsSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on("editor-change", (editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				this.onEditorChange(editor, info);
			})
		);
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onActiveLeafChange()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.onActiveLeafChange()));

		// 模板文件被改 / 新增 / 删除 / 改名 → 重读模板；如果改的是当前模板就是换模式。
		const onVaultChange = (file: { path: string }) => {
			if (!this.isInTemplateFolder(file.path)) return;
			void this.reloadTemplates();
		};
		this.registerEvent(this.app.vault.on("modify", onVaultChange));
		this.registerEvent(this.app.vault.on("create", onVaultChange));
		this.registerEvent(this.app.vault.on("delete", onVaultChange));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const inFolder = this.isInTemplateFolder(file.path) || this.isInTemplateFolder(oldPath);
				if (this.data.templatePath === oldPath) {
					this.data.templatePath = file.path;
					void this.saveNow();
				}
				if (inFolder) void this.reloadTemplates();
			})
		);

		// 插件加载时如果面板本来就开着（工作区恢复），补一次激活。
		this.app.workspace.onLayoutReady(() => {
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_USAGE_NORMS);
			for (const leaf of leaves) {
				const view = leaf.view;
				if (view instanceof UsageNormsView) {
					this.panels.add(view);
				}
			}
			if (this.panels.size > 0) this.activateStoreForActiveFile();
		});

		console.log("[usage-norms] loaded");
	}

	onunload(): void {
		if (this.repaintTimer !== null) window.clearTimeout(this.repaintTimer);
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		void this.saveNow();
		clearMarks(this.markedView);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_USAGE_NORMS);
	}

	// ------------------------------------------------------------------ 面板

	async openPanel(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_USAGE_NORMS)[0];
		let leaf: WorkspaceLeaf | undefined = existing;
		if (!leaf) {
			leaf = this.app.workspace.getLeftLeaf(false) ?? this.app.workspace.getLeftLeaf(true) ?? undefined;
			if (!leaf) {
				new Notice("没能创建左侧边栏");
				return;
			}
			await leaf.setViewState({ type: VIEW_TYPE_USAGE_NORMS, active: true });
		}
		this.app.workspace.leftSplit.expand();
		this.app.workspace.revealLeaf(leaf);
	}

	closePanel(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_USAGE_NORMS);
		for (const leaf of leaves) leaf.detach();
	}

	async onPanelOpened(view: UsageNormsView): Promise<void> {
		this.panels.add(view);
		await this.library.refresh();
		this.activateStoreForActiveFile();
		view.render();
	}

	onPanelClosed(view: UsageNormsView): void {
		this.panels.delete(view);
		this.views.delete(view);
		if (this.panels.size === 0) {
			this.store.deactivate();
			clearMarks(this.markedView);
			this.markedView = null;
		}
	}

	private activateStoreForActiveFile(): void {
		const info = this.activeEditorInfo();
		if (!info) {
			this.store.activate("", "", 0);
			return;
		}
		this.store.activate(info.file.path, info.text, info.caret);
		this.scheduleRepaint();
	}

	/** 面板是不是开着（关着的时候不联网、不标记）。 */
	private get panelOpen(): boolean {
		return this.panels.size > 0;
	}

	// ------------------------------------------------------------------ 编辑

	private activeEditorInfo(): { file: { path: string }; text: string; caret: number } | null {
		const view = this.currentMarkdownView();
		if (!view || !view.file) return null;
		const editor = view.editor;
		return {
			file: view.file,
			text: editor.getValue(),
			caret: editor.posToOffset(editor.getCursor()),
		};
	}

	/** 当前该服务的笔记：优先 activeLeaf，其次最近一次看过的 MarkdownView。 */
	private currentMarkdownView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active && active.file) {
			this.lastMarkdown = active;
			return active;
		}
		const leaf = this.app.workspace.activeLeaf;
		if (leaf && leaf.view instanceof MarkdownView && leaf.view.file) {
			this.lastMarkdown = leaf.view;
			return leaf.view;
		}
		const last = this.lastMarkdown;
		if (last && last.file && last.leaf && last.leaf.view === last) return last;
		this.lastMarkdown = null;
		return null;
	}

	private activeCm(): EditorView | null {
		const cm = (this.currentMarkdownView()?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
		if (!cm || !cm.dom || cm.dom.isConnected === false) return null;
		return cm;
	}

	private onEditorChange(editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
		if (info instanceof MarkdownView && info.file) this.lastMarkdown = info;
		if (!this.panelOpen) return;
		const file = info.file;
		if (!file || file.extension !== "md") return;
		const text = editor.getValue();
		const caret = editor.posToOffset(editor.getCursor());
		if (this.store.fileKey !== file.path) {
			this.store.switchFile(file.path, text, caret);
		}
		this.store.onText(text, caret);
		this.scheduleRepaint();
	}

	private onActiveLeafChange(): void {
		if (!this.panelOpen) return;
		const info = this.activeEditorInfo();
		if (!info) return;
		if (this.store.fileKey !== info.file.path) {
			this.store.switchFile(info.file.path, info.text, info.caret);
			this.scheduleRepaint();
		}
	}

	/** CM6 只用来补光标位置（正文变化由 editor-change 管）。 */
	private onViewUpdate(update: ViewUpdate): void {
		if (!this.panelOpen) return;
		const cm = this.activeCm();
		if (!cm || update.view !== cm) return;
		if (update.docChanged) {
			// 让 editor-change 先跑，偏移全部对齐之后再重画。
			this.scheduleRepaint();
			return;
		}
		if (update.selectionSet) {
			const caret = update.state.selection.main.head;
			this.store.onText(update.state.doc.toString(), caret);
		}
	}

	// ------------------------------------------------------------------ 交互

	async select(index: number): Promise<void> {
		this.store.select(this.store.activeIndex === index ? null : index);
		this.scheduleRepaint();
	}

	ignore(index: number): void {
		this.store.ignore(index);
		this.scheduleRepaint();
	}

	/** 点 ✓：只替换 `quote` 那一段，光标落到改后文本末尾，焦点留在正文。 */
	accept(index: number): void {
		const view = this.currentMarkdownView();
		const suggestion = this.store.accept(index);
		if (!view || !suggestion) {
			this.scheduleRepaint();
			return;
		}
		const editor = view.editor;
		try {
			editor.replaceRange(
				suggestion.replacement,
				editor.offsetToPos(suggestion.start),
				editor.offsetToPos(suggestion.end)
			);
			editor.setCursor(editor.offsetToPos(suggestion.start + suggestion.replacement.length));
			editor.focus();
		} catch (error) {
			console.error("[usage-norms] 应用失败", error);
		}
		this.scheduleRepaint();
	}

	async scanAll(): Promise<void> {
		if (!this.panelOpen) await this.openPanel();
		this.activateStoreForActiveFile();
		// 栏里不显示任何提示：命令是显式动作，缺什么就在这里说清楚。
		if (!this.store.fileKey) {
			new Notice("先打开一篇笔记");
			return;
		}
		if (this.data.apiKey.trim().length === 0) {
			new Notice("先去设置里填 DeepSeek 密钥");
			this.openSettings();
			return;
		}
		if (!this.selectedTemplate()) {
			new Notice("先去设置里选一个提示词模板文件夹");
			this.openSettings();
			return;
		}
		this.store.scanAll();
		this.scheduleRepaint();
	}

	// ------------------------------------------------------------------ 设置

	async setTemplate(path: string): Promise<void> {
		if (this.data.templatePath === path) return;
		this.data.templatePath = path;
		await this.saveNow();
		this.applyModeChange();
	}

	async setTemplateFolder(folder: string): Promise<void> {
		const next = folder === "/" ? "/" : normalizePath(folder).replace(/^\/+|\/+$/g, "");
		if (this.data.templateFolder === next) return;
		this.data.templateFolder = next;
		this.library.setFolder(next);
		await this.library.refresh();
		const list = this.library.list();
		if (!list.some((t) => t.path === this.data.templatePath)) {
			this.data.templatePath = list.length > 0 ? list[0].path : "";
		}
		await this.saveNow();
		this.applyModeChange();
	}

	async setStrength(strength: Strength): Promise<void> {
		if (!isStrength(strength) || this.data.strength === strength) return;
		this.data.strength = strength;
		await this.saveNow();
		this.applyModeChange();
	}

	async setShowReason(value: boolean): Promise<void> {
		// 只影响显示，不进扫描模式：不重扫。
		this.data.showReason = value;
		await this.saveNow();
		this.refreshViews();
	}

	async setApiKey(key: string): Promise<void> {
		// 换密钥不重扫（已算过的句子不重复花钱）；输入框每个键都触发，落盘走合并写。
		this.data.apiKey = key;
		this.schedulePersist();
		this.refreshViews();
	}

	async reloadTemplates(): Promise<void> {
		await this.library.refresh();
		const list = this.library.list();
		if (this.data.templatePath && !list.some((t) => t.path === this.data.templatePath)) {
			this.data.templatePath = list.length > 0 ? list[0].path : "";
			await this.saveNow();
			this.applyModeChange();
		} else {
			this.applyModeChange();
		}
		this.refreshViews();
	}

	selectedTemplate(): PromptTemplate | undefined {
		const list = this.library.list();
		if (list.length === 0) return undefined;
		const found = list.find((t) => t.path === this.data.templatePath);
		if (found) return found;
		return list[0];
	}

	/** 扫描模式指纹（模板路径 + 正文 + 强度）；变了就清建议、按新标准重扫。 */
	private modeKey(): string {
		const template = this.selectedTemplate();
		if (!template) return "no-template";
		return `${template.path}\u0000${template.text}\u0000${this.data.strength}`;
	}

	private applyModeChange(): void {
		const key = this.modeKey();
		if (key === this.modeKeyAtLoad) {
			this.refreshViews();
			return;
		}
		this.modeKeyAtLoad = key;
		this.store.onModeChanged();
		this.refreshViews();
		this.scheduleRepaint();
	}

	private isInTemplateFolder(path: string): boolean {
		const folder = this.data.templateFolder;
		if (folder.length === 0) return false;
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		const want = folder === "/" ? "" : folder;
		return normalizePath(parent) === normalizePath(want);
	}

	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	async testKey(): Promise<{ ok: boolean; message: string }> {
		const template = this.selectedTemplate();
		try {
			await requestSuggestions({
				apiKey: this.data.apiKey,
				template: template?.text ?? "把含糊的地方说清楚。",
				text: "这是一段用来测试接口是否可用的文字。",
				strength: "low",
			});
			return { ok: true, message: "正常" };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : "连接失败" };
		}
	}

	async clearScanRecord(pageKey: string): Promise<void> {
		if (pageKey.length === 0) this.data.scans = {};
		else delete this.data.scans[pageKey];
		await this.saveNow();
	}

	// ------------------------------------------------------------------ 存储

	/** store 里任何状态变化：重画侧栏 + 正文标记。 */
	private onStoreChanged(): void {
		this.refreshViews();
		this.scheduleRepaint();
	}

	private refreshViews(): void {
		for (const view of this.views) {
			try {
				view.render();
			} catch (error) {
				console.error("[usage-norms] render", error);
			}
		}
	}

	/** 16ms 合并一次重画：避免在 CM 的 update 里直接 dispatch。 */
	private scheduleRepaint(): void {
		if (this.repaintTimer !== null) return;
		this.repaintTimer = window.setTimeout(() => {
			this.repaintTimer = null;
			this.repaint();
		}, 16);
	}

	private repaint(): void {
		const cm = this.panelOpen ? this.activeCm() : null;
		if (this.markedView && this.markedView !== cm) {
			clearMarks(this.markedView);
			this.markedView = null;
		}
		if (!cm) return;
		this.markedView = cm;
		const suggestions = this.store.items.map((item) => item.suggestion);
		applyMarks(cm, this.store.textSnapshot, suggestions, this.store.activeIndex);
	}

	/** 记账落盘：合并写、顺手裁掉太老的页面。 */
	schedulePersist(): void {
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow();
		}, 1200);
	}

	async saveNow(): Promise<void> {
		this.pruneScans();
		try {
			await this.saveData(this.data);
		} catch (error) {
			console.error("[usage-norms] 保存失败", error);
		}
	}

	private pruneScans(): void {
		const pages = Object.entries(this.data.scans);
		if (pages.length <= MAX_PAGES) return;
		pages.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
		const keep = new Set(pages.slice(0, MAX_PAGES).map(([key]) => key));
		for (const key of Object.keys(this.data.scans)) {
			if (!keep.has(key)) delete this.data.scans[key];
		}
	}
}
