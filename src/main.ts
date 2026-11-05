import {
	Editor,
	MarkdownFileInfo,
	MarkdownView,
	Notice,
	Platform,
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
import { PANEL_VISIBLE_CLASS, isPanelVisible } from "./visibility";
import { EditorView } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";

/** 「已经算过的句子」最多留多少页，超了按最后使用时间丢最旧的。 */
const MAX_PAGES = 500;

/** 面板可见性多久对一次（毫秒）。收起侧栏 / 切标签都没有可靠事件，只能巡检。 */
const VISIBILITY_TICK_MS = 300;

export default class UsageNormsPlugin extends Plugin {
	data: UsageNormsData = { ...normalizeData(null), scans: {} };
	library!: TemplateLibrary;
	store!: AssistStore;

	// 不缓存视图实例：活着的面板一律用 `getLeavesOfType` 现查（todo-panel 的做法）。
	private markedView: EditorView | null = null;
	private repaintTimer: number | null = null;
	private saveTimer: number | null = null;
	/** 面板开着时的自愈巡检（iPad 键盘弹起 / 侧栏重排后把行画回活容器）。 */
	private healTimer: number | null = null;
	private lastHealLog = "";
	/** 正文画不画虚线 / 删除线只看这一条：面板看不看得见（见 visibility.ts）。 */
	private lastPanelVisible = false;
	/** 可见性巡检：收起侧栏 / 切到别的标签不一定有事件，隔一会儿对一次。 */
	private visibilityTimer: number | null = null;
	private modeKeyAtLoad = "";
	/**
	 * 最近一次「真正在读的笔记」。
	 *
	 * 点侧栏按钮时 activeLeaf 是侧栏，`getActiveViewOfType(MarkdownView)` 会返回
	 * null —— 但这时 ✓ 仍然必须改到那篇笔记，所以记一份最近的 MarkdownView。
	 */
	private lastMarkdown: MarkdownView | null = null;

	/** 调试日志（只留最近 400 条），命令「导出调试日志」把它写成笔记。 */
	private logBuffer: string[] = [];
	private lastStoreLog = "";
	private lastMetrics = "";
	private lastRepaintLog = "";

	/** 记一行调试日志（不会自动写盘，只在命令导出时落成一个笔记）。 */
	log(message: string): void {
		const stamp = new Date().toISOString().slice(11, 23);
		this.logBuffer.push(`${stamp} ${message}`);
		if (this.logBuffer.length > 400) this.logBuffer.splice(0, this.logBuffer.length - 400);
	}

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
			log: (message) => this.log(message),
		});
		this.modeKeyAtLoad = this.modeKey();
		this.log(
			`load version=${this.manifest.version} mobile=${Platform.isMobile} apiKey=${this.data.apiKey.trim().length > 0} template=${this.selectedTemplate()?.path ?? "(none)"}`
		);

		// 正文标记（CM6 decoration）+ 光标变化
		this.registerEditorExtension(marksExtension((update) => this.onViewUpdate(update)));

		this.registerView(VIEW_TYPE_USAGE_NORMS, (leaf: WorkspaceLeaf) => new UsageNormsView(leaf, this));

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
		this.addCommand({
			id: "export-debug-log",
			name: "导出调试日志（排查用）",
			callback: () => void this.exportDebugLog(),
		});

		this.addSettingTab(new UsageNormsSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on("editor-change", (editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				this.onEditorChange(editor, info);
			})
		);
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onActiveLeafChange()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.onActiveLeafChange()));
		// iPad 键盘弹起 / 侧栏收起重建都会走 layout-change：重画面板和正文标记。
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onLayoutChange()));

		// 键盘弹起改的是视口尺寸：resize 也补一次重画（移动端 layout-change 不一定来）。
		this.registerDomEvent(window, "resize", () => this.onViewportChanged("window-resize"));

		// iPad 的软键盘更可靠地体现在 visualViewport 上（有时 window 不 resize）。
		const visual = window.visualViewport;
		if (visual) {
			const onVisual = () => this.onViewportChanged("visual-viewport");
			visual.addEventListener("resize", onVisual);
			visual.addEventListener("scroll", onVisual);
			this.register(() => {
				visual.removeEventListener("resize", onVisual);
				visual.removeEventListener("scroll", onVisual);
			});
		}

		// 面板可见性巡检：收起侧栏、切到别的标签都可能不触发事件，固定隔一会儿对一次。
		// 只有「看不看得见」真的变了才动手（正文标记跟着出现 / 消失）。
		this.visibilityTimer = window.setInterval(() => this.syncPanelVisibility(), VISIBILITY_TICK_MS);

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
			if (this.panelLeaves().length > 0) this.activateStoreForActiveFile();
		});

		console.log("[usage-norms] loaded");
	}

	onunload(): void {
		if (this.repaintTimer !== null) window.clearTimeout(this.repaintTimer);
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.stopHealthWatch();
		this.stopVisibilityWatch();
		void this.saveNow();
		clearMarks(this.markedView);
		// 插件卸载后正文不该还留着虚线 / 删除线（body 上的类名一并摘掉）。
		this.setPanelClass(false);
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
		this.startHealthWatch();
		this.refreshViews();
		// 面板一露头就把正文标记补上（不必等下一次巡检）。
		this.syncPanelVisibility();
	}

	closePanel(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_USAGE_NORMS);
		for (const leaf of leaves) leaf.detach();
	}

	/**
	 * 面板视图被创建（或者被 Obsidian 重建）。
	 *
	 * 和 todo-panel 一样：这里只负责重新挂上当前笔记 + 重画，不往任何 Set 里
	 * 记东西；「活着的视图」永远靠 `getLeavesOfType` 现查。
	 */
	async onPanelOpened(): Promise<void> {
		this.log(`panel-open leaves=${this.panelLeaves().length}`);
		this.startHealthWatch();
		// 先挂当前笔记、把内存里的建议画上去 —— 这一步不能等模板刷新：
		// iPad 键盘弹起会重建侧栏视图，库还没就绪时 await 会把面板空着。
		this.activateStoreForActiveFile();
		this.refreshViews();
		try {
			await this.library.refresh();
		} catch (error) {
			// 读模板失败不能把整个面板挂起（iPad 上库可能还没就绪）。
			this.log(`templates refresh failed: ${(error as Error).message}`);
			return;
		}
		this.refreshViews();
	}

	/**
	 * 视图被关闭：**什么都不做**。
	 *
	 * todo-panel 的 onClose 就是空的（它能一直显示，就是因为关闭时不清任何
	 * 状态，重画永远从 getLeavesOfType 现拿视图）。这里之前在这里清空 / 挂起，
	 * 键盘一弹侧栏一重建，行就没了。
	 */
	onPanelClosed(): void {
		this.log(`panel-close leaves=${this.panelLeaves().length}`);
		// 建议留着（下一次打开原样恢复），但正文标记要跟着消失；
		// 延迟一点再判断，避开 Obsidian 重建视图时的瞬时「没有叶子」。
		window.setTimeout(() => {
			if (this.panelOpen) {
				this.scheduleRepaint();
				return;
			}
			this.stopHealthWatch();
			clearMarks(this.markedView);
			this.markedView = null;
		}, 120);
	}

	/** 正在显示的面板视图（每次现查，不缓存实例）。 */
	private panelLeaves(): WorkspaceLeaf[] {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE_USAGE_NORMS);
	}

	private panelViews(): UsageNormsView[] {
		const views: UsageNormsView[] = [];
		for (const leaf of this.panelLeaves()) {
			if (leaf.view instanceof UsageNormsView) views.push(leaf.view);
		}
		return views;
	}

	/** 视图尺寸变了（iPad 键盘弹起 / 侧栏开合）：补画正文标记，巡检拉起来。 */
	onPanelResized(): void {
		this.startHealthWatch();
		this.scheduleRepaint();
	}

	/**
	 * 自愈巡检：面板开着时每 400ms 看一眼「活容器里的行数」是否等于建议条数。
	 *
	 * iPad 键盘弹起时 Obsidian 会重排侧栏：视图实例还在、`onOpen` / `onResize`
	 * 却不一定来，DOM 却可能已经被换掉 —— 只靠事件会漏。行数对不上就按当前
	 * store 重画一遍，最多 400ms 补回来；对得上时什么都不做，不会闪。
	 */
	private startHealthWatch(): void {
		if (this.healTimer !== null) return;
		if (!this.panelOpen) return;
		this.healTimer = window.setInterval(() => this.healthCheck(), 400);
	}

	private stopHealthWatch(): void {
		if (this.healTimer === null) return;
		window.clearInterval(this.healTimer);
		this.healTimer = null;
	}

	private healthCheck(): void {
		if (!this.panelOpen) {
			this.stopHealthWatch();
			return;
		}
		const want = this.store.items.length;
		for (const view of this.panelViews()) {
			const rows = view.rowCount;
			if (rows === want) continue;
			const line = `heal rows=${rows} want=${want} live=${view.live}`;
			if (line !== this.lastHealLog) {
				this.lastHealLog = line;
				this.log(line);
			}
			try {
				view.render();
			} catch (error) {
				this.log(`heal failed: ${(error as Error).message}`);
			}
		}
	}

	/** 视口变了（键盘弹出 / 收起）：重画面板 + 正文标记，并开着巡检。 */
	private onViewportChanged(source: string): void {
		this.log(`${source} ${window.innerWidth}x${window.innerHeight}`);
		if (!this.panelOpen) return;
		this.startHealthWatch();
		this.refreshViews();
		this.scheduleRepaint();
	}

	private activateStoreForActiveFile(): void {
		const info = this.activeEditorInfo();
		if (!info) {
			// 拿不到正文（侧栏刚重建、焦点还在键盘上）：保留已有建议，门先开着。
			this.store.resume();
			this.log("activate(resume) no active markdown");
			this.scheduleRepaint();
			return;
		}
		this.log(`activate file=${info.file.path} len=${info.text.length}`);
		this.store.activate(info.file.path, info.text, info.caret);
		this.scheduleRepaint();
	}

	/**
	 * 面板是不是还挂在工作区里。
	 *
	 * 不看 onOpen/onClose 的记账，直接问工作区有没有这个叶子：iPad 上键盘弹起
	 * 会触发侧栏收起 / 视图重建，记账会瞬间变成 0，但面板其实还在。
	 */
	private get panelOpen(): boolean {
		return this.panelLeaves().length > 0;
	}

	/**
	 * 面板此刻是不是真的在屏幕上 —— **正文要不要画虚线 / 删除线只看这一条**。
	 *
	 * 「有叶子」不等于「看得见」：左侧栏可以收起（sidedock collapsed）、侧栏里可以
	 * 停在别的标签（Obsidian 把非当前叶子 `display: none`）、iPad 上抽屉可以收回。
	 * 这三种情况下建议都看不见、`✓` `×` 都点不到，往正文画线只是噪音。
	 *
	 * 判据本身在 `visibility.ts` 里（纯函数，`npm test` 逐条覆盖），这里只负责把
	 * Obsidian 的 DOM / API 事实收集成 probe。
	 */
	private get panelVisible(): boolean {
		const leaves = this.panelLeaves();
		if (leaves.length === 0) return false;
		for (const leaf of leaves) {
			const el = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
			if (!el) continue;
			let shown: boolean | undefined;
			try {
				shown = typeof el.isShown === "function" ? el.isShown() : undefined;
			} catch {
				// 老版本没有 isShown / 元素正在销毁：交给尺寸判据。
				shown = undefined;
			}
			const rect = el.getBoundingClientRect();
			const visible = isPanelVisible({
				hasLeaf: true,
				connected: el.isConnected !== false,
				shown,
				width: rect.width,
				height: rect.height,
				dockCollapsed: this.dockCollapsed(leaf),
			});
			if (visible) return true;
		}
		return false;
	}

	/** 叶子所在的那个分栏（左侧栏 / 右侧栏 / 移动端抽屉）是不是收起了。 */
	private dockCollapsed(leaf: WorkspaceLeaf): boolean {
		const ws = this.app.workspace as unknown as {
			leftSplit?: { collapsed?: boolean; containerEl?: HTMLElement };
			rightSplit?: { collapsed?: boolean; containerEl?: HTMLElement };
		};
		const leafEl = (leaf as unknown as { containerEl?: HTMLElement }).containerEl;
		let dockEl: HTMLElement | null = null;
		try {
			dockEl = leafEl?.closest?.(
				".workspace-split.mod-left-split, .workspace-split.mod-right-split"
			) as HTMLElement | null;
		} catch {
			dockEl = null;
		}
		if (dockEl && ws.leftSplit?.containerEl === dockEl) return ws.leftSplit?.collapsed === true;
		if (dockEl && ws.rightSplit?.containerEl === dockEl) return ws.rightSplit?.collapsed === true;
		// 移动端：叶子挂在抽屉（WorkspaceMobileDrawer）里，收起状态在 parent 上。
		const parent = (leaf as unknown as { parent?: { collapsed?: boolean } }).parent;
		return parent?.collapsed === true;
	}

	/**
	 * 面板可见性变了：改 `body` 上的类名（CSS 兜底），并立刻重画 / 清掉正文标记。
	 *
	 * 类名是「看得见」才有的：**没有 `usage-norms-panel-visible` 就一条标记都不画**，
	 * 所以这里就算漏一次，正文里也不会真把线画出来，最多晚 300ms 消失。
	 */
	private syncPanelVisibility(): void {
		const visible = this.panelVisible;
		if (visible === this.lastPanelVisible) return;
		this.lastPanelVisible = visible;
		this.setPanelClass(visible);
		this.log(`panel visible=${visible} leaves=${this.panelLeaves().length}`);
		this.scheduleRepaint();
	}

	private stopVisibilityWatch(): void {
		if (this.visibilityTimer === null) return;
		window.clearInterval(this.visibilityTimer);
		this.visibilityTimer = null;
	}

	/** 给 `body` 挂 / 摘可见性类名（幂等；拿不到 body 就跳过）。 */
	private setPanelClass(visible: boolean): void {
		const body = this.app.workspace.containerEl?.ownerDocument?.body;
		if (!body) return;
		if (visible) body.addClass(PANEL_VISIBLE_CLASS);
		else body.removeClass(PANEL_VISIBLE_CLASS);
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

	/** 当前该服务的笔记：优先 activeLeaf，其次最近看过的，最后按已记录的文件路径找。 */
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
		// 侧栏重建过、lastMarkdown 指向已经销毁的视图：按 store 记的文件路径在
		// 现有 markdown leaf 里找同一个文件（iPad 键盘弹起后就是这条路径）。
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		const want = this.store?.fileKey ?? "";
		if (want.length > 0) {
			for (const item of leaves) {
				if (item.view instanceof MarkdownView && item.view.file?.path === want) {
					this.lastMarkdown = item.view;
					return item.view;
				}
			}
		}
		for (const item of leaves) {
			if (item.view instanceof MarkdownView && item.view.file) {
				this.lastMarkdown = item.view;
				return item.view;
			}
		}
		this.lastMarkdown = null;
		return null;
	}

	private activeCm(): EditorView | null {
		const view = this.currentMarkdownView();
		if (!view) return null;
		// 桌面端一直有 editor.cm（未写进公开类型）；移动端不一定有。
		const direct = (view.editor as unknown as { cm?: EditorView }).cm;
		if (direct && direct.dom && direct.dom.isConnected !== false) return direct;
		// 移动端：直接从 DOM 找 CM6 实例，别依赖 editor.cm。
		const dom = view.containerEl.querySelector(".cm-editor") as HTMLElement | null;
		if (!dom) return null;
		try {
			return EditorView.findFromDOM(dom) ?? null;
		} catch (error) {
			this.log(`activeCm findFromDOM failed: ${(error as Error).message}`);
			return null;
		}
	}

	private onEditorChange(editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
		if (info instanceof MarkdownView && info.file) this.lastMarkdown = info;
		if (!this.panelOpen) return;
		// iPad 上 info.file 偶尔为空：退回最近看过的笔记，别把事件整个丢掉。
		const file = info.file ?? this.lastMarkdown?.file ?? null;
		if (file && file.extension !== "md") return;
		const text = editor.getValue();
		const caret = editor.posToOffset(editor.getCursor());
		if (file && this.store.fileKey !== file.path) {
			this.store.activate(file.path, text, caret);
		} else if (!this.store.active) {
			this.store.resume();
		}
		this.log(
			`edit file=${file ? file.path : "(none)"} len=${text.length} caret=${caret} active=${this.store.active} key=${this.store.fileKey} items=${this.store.items.length}`
		);
		this.store.onText(text, caret);
		this.scheduleRepaint();
	}

	private onActiveLeafChange(): void {
		if (!this.panelOpen) return;
		this.log("active-leaf-change");
		this.activateStoreForActiveFile();
	}

	/** 布局变了（键盘、窗口尺寸、侧栏收起/重建）：把面板和标记重新贴上去。 */
	private onLayoutChange(): void {
		if (!this.panelOpen) return;
		this.log(
			`layout-change viewport=${window.innerWidth}x${window.innerHeight} leaves=${
				this.panelLeaves().length
			} active=${this.store.active}`
		);
		this.startHealthWatch();
		this.refreshViews();
		this.activateStoreForActiveFile();
		this.scheduleRepaint();
		// 侧栏重排 / 键盘动画结束后再补两次：有时事件先到、容器后换。
		for (const delay of [150, 600]) {
			window.setTimeout(() => {
				if (this.panelOpen) this.refreshViews();
			}, delay);
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

	/**
	 * 把内存里的调试日志写成一篇笔记（放在库根目录），用于排查「键盘弹起后
	 * 不再出建议」这类只在真机上出现的问题。日志只有事件和长度，没有正文。
	 */
	async exportDebugLog(): Promise<void> {
		const lines = [
			"# 用语规范调试日志",
			"",
			`插件版本：${this.manifest.version}`,
			`导出时间：${new Date().toLocaleString()}`,
			`平台：${Platform.isMobile ? "mobile" : "desktop"}`,
			`视口：${window.innerWidth}x${window.innerHeight}`,
			`data：apiKey=${this.data.apiKey.trim().length > 0} template=${this.selectedTemplate()?.path ?? "(none)"} strength=${this.data.strength}`,
			`store：active=${this.store.active} file=${this.store.fileKey || "(none)"} items=${this.store.items.length}`,
			"",
			"```",
			...this.logBuffer,
			"```",
			"",
		];
		try {
			await this.app.vault.adapter.write("用语规范调试.md", lines.join("\n"));
			new Notice("调试日志已写到库根目录「用语规范调试.md」");
		} catch (error) {
			new Notice(`写日志失败：${(error as Error).message}`);
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
		const snapshot = `items=${this.store.items.length} loading=${this.store.loading} active=${this.store.active} file=${
			this.store.fileKey
		} err=${this.store.error ?? ""}`;
		if (snapshot !== this.lastStoreLog) {
			this.lastStoreLog = snapshot;
			this.log(`store ${snapshot}`);
		}
		this.refreshViews();
		this.scheduleRepaint();
	}

	private refreshViews(): void {
		// 每次现查活着的视图（todo-panel 的做法），不缓存实例。
		for (const view of this.panelViews()) {
			try {
				view.render();
				this.logViewMetrics(view);
			} catch (error) {
				this.log(`render failed: ${(error as Error).message}`);
				console.error("[usage-norms] render", error);
			}
		}
	}

	/** 排查用：画了几行、容器多高（侧栏被收起时高度会是 0）。 */
	private logViewMetrics(view: UsageNormsView): void {
		const el = view.contentEl;
		const split = (this.app.workspace as unknown as { leftSplit?: { collapsed?: boolean; width?: number } })
			.leftSplit;
		const metrics = `view items=${this.store.items.length} rows=${view.rowCount} bodyH=${
			view.bodyHeight
		} elH=${el ? el.clientHeight : -1} elW=${el ? el.clientWidth : -1} splitCollapsed=${
			split?.collapsed ?? "?"
		} splitW=${split?.width ?? "?"}`;
		if (metrics !== this.lastMetrics) {
			this.lastMetrics = metrics;
			this.log(metrics);
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
		// 正文标记的开关只有一条：面板看得见才画。看不见（侧栏收起 / 停在别的标签 /
		// 抽屉收回）时连 cm 都不去拿，markedView 一律清掉，正文里一根线都不留。
		const visible = this.panelVisible;
		if (visible !== this.lastPanelVisible) {
			this.lastPanelVisible = visible;
			this.log(`panel visible=${visible}`);
		}
		this.setPanelClass(visible);
		const cm = visible ? this.activeCm() : null;
		if (this.markedView && this.markedView !== cm) {
			clearMarks(this.markedView);
			this.markedView = null;
		}
		if (!cm) {
			if (this.store.items.length > 0) this.log("repaint: no editor view (无法画正文标记)");
			return;
		}
		this.markedView = cm;
		const suggestions = this.store.items.map((item) => item.suggestion);
		const marks = applyMarks(cm, this.store.textSnapshot, suggestions, this.store.activeIndex);
		if (suggestions.length > 0) {
			const line = `repaint marks=${marks}/${suggestions.length}`;
			if (line !== this.lastRepaintLog) {
				this.lastRepaintLog = line;
				this.log(line);
			}
		}
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
