import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { STRENGTHS, STRENGTH_LABEL, isDeletion, rowText } from "./engine";
import type UsageNormsPlugin from "./main";

export const VIEW_TYPE_USAGE_NORMS = "usage-norms-view";

/**
 * 左侧边栏面板。
 *
 * 布局（刻意压到很窄也放得下）：
 *   第一行：[条数] [模板下拉] [全文扫描] [设置] [关闭]
 *   第二行：[低][中][高]
 *   下面  ：建议条目，一行一条：× 改后文本 ✓
 *
 * 和参考实现一样：没有「开始」按钮，打开即工作；错误和空态只在栏里一行灰字，
 * 不弹窗、不 toast。
 */
export class UsageNormsView extends ItemView {
	private headerEl!: HTMLElement;
	private countEl!: HTMLElement;
	private templateEl!: HTMLSelectElement;
	private strengthEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private footerEl!: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: UsageNormsPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_USAGE_NORMS;
	}

	getDisplayText(): string {
		return "用语规范";
	}

	getIcon(): string {
		return "sparkles";
	}

	async onOpen(): Promise<void> {
		this.build();
		await this.plugin.onPanelOpened(this);
	}

	async onClose(): Promise<void> {
		this.plugin.onPanelClosed(this);
	}

	// -------------------------------------------------------------------- 骨架

	private build(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("usage-norms");
		root.removeClass("markdown-preview-view");

		this.headerEl = root.createDiv({ cls: "usage-norms-head" });

		this.countEl = this.headerEl.createSpan({ cls: "usage-norms-count", text: "0" });

		this.templateEl = this.headerEl.createEl("select", { cls: "dropdown usage-norms-template-select" });
		this.templateEl.addEventListener("change", () => {
			void this.plugin.setTemplate(this.templateEl.value);
		});

		this.addIconButton(this.headerEl, "scan-text", "全文扫描", () => void this.plugin.scanAll());
		this.addIconButton(this.headerEl, "settings", "提示词与密钥", () => this.plugin.openSettings());
		this.addIconButton(this.headerEl, "x", "关闭用语规范面板", () => this.plugin.closePanel());

		this.strengthEl = root.createDiv({ cls: "usage-norms-strength" });
		for (const level of STRENGTHS) {
			const button = this.strengthEl.createEl("button", {
				cls: "usage-norms-strength-btn",
				text: STRENGTH_LABEL[level],
			});
			button.addEventListener("click", () => void this.plugin.setStrength(level));
		}

		this.bodyEl = root.createDiv({ cls: "usage-norms-body" });
		this.footerEl = root.createDiv({ cls: "usage-norms-footer" });
	}

	private addIconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createEl("button", { cls: "clickable-icon usage-norms-icon-btn" });
		setIcon(button, icon);
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
		button.addEventListener("click", onClick);
	}

	// -------------------------------------------------------------------- 渲染

	render(): void {
		if (!this.bodyEl) return;
		const store = this.plugin.store;
		const template = this.plugin.selectedTemplate();
		const data = this.plugin.data;

		// 模板下拉：只在选项集合变了的时候重建（否则每次打字都会把下拉关掉）。
		const templates = this.plugin.library.list();
		this.syncTemplateOptions(templates.map((t) => ({ path: t.path, name: t.name })));

		this.countEl.setText(String(store.items.length));

		for (let i = 0; i < this.strengthEl.children.length; i += 1) {
			const button = this.strengthEl.children[i] as HTMLElement;
			button.toggleClass("is-active", STRENGTHS[i] === data.strength);
		}

		this.bodyEl.empty();
		this.footerEl.empty();

		if (data.apiKey.trim().length === 0) {
			this.hint("key-round", "填 DeepSeek 密钥（点这里去设置）", () => this.plugin.openSettings());
			return;
		}
		if (!template) {
			this.hint("folder-search", "在设置里选一个提示词模板文件夹", () => this.plugin.openSettings());
			return;
		}

		const items = store.items;
		if (items.length === 0) {
			if (store.error) {
				this.hint("circle-alert", store.error, () => void this.plugin.scanAll());
			} else if (store.loading) {
				this.bodyEl.createDiv({ cls: "usage-norms-spinner" });
			} else if (store.scannedAnything) {
				this.bodyEl.createDiv({ cls: "usage-norms-empty", text: "没有需要改的" });
			} else {
				this.bodyEl.createDiv({ cls: "usage-norms-empty", text: "开栏后新写的会自动检查" });
			}
			return;
		}

		for (let i = 0; i < items.length; i += 1) {
			this.renderRow(i);
		}
		if (store.loading) {
			this.footerEl.createDiv({ cls: "usage-norms-spinner" });
		} else if (store.error) {
			const line = this.footerEl.createDiv({ cls: "usage-norms-error-line", text: store.error });
			line.addEventListener("click", () => void this.plugin.scanAll());
		}
	}

	private syncTemplateOptions(options: { path: string; name: string }[]): void {
		const current = Array.from(this.templateEl.options).map((o) => o.value);
		const next = options.map((o) => o.path);
		const same = current.length === next.length && current.every((value, i) => value === next[i]);
		if (!same) {
			this.templateEl.empty();
			for (const option of options) {
				const el = this.templateEl.createEl("option", { text: option.name });
				el.value = option.path;
			}
		}
		const selected = this.plugin.selectedTemplate()?.path ?? "";
		if (this.templateEl.value !== selected) this.templateEl.value = selected;
		this.templateEl.toggleClass("is-missing", options.length === 0);
	}

	private renderRow(index: number): void {
		const item = this.plugin.store.items[index];
		const suggestion = item.suggestion;
		const active = this.plugin.store.activeIndex === index;
		const row = this.bodyEl.createDiv({ cls: "usage-norms-row" });
		if (active) row.addClass("is-active");

		const ignore = row.createEl("button", { cls: "usage-norms-row-btn usage-norms-ignore" });
		setIcon(ignore, "x");
		ignore.setAttribute("aria-label", "忽视这一条");
		ignore.addEventListener("click", (event) => {
			event.stopPropagation();
			this.plugin.ignore(index);
		});

		const textEl = row.createDiv({ cls: "usage-norms-row-text" });
		if (isDeletion(suggestion)) textEl.addClass("is-deletion");
		textEl.createDiv({ cls: "usage-norms-row-main", text: rowText(suggestion) });
		if (this.plugin.data.showReason && suggestion.reason.length > 0) {
			textEl.createDiv({ cls: "usage-norms-row-reason", text: suggestion.reason });
		}

		row.addEventListener("click", () => this.plugin.select(index));

		const accept = row.createEl("button", { cls: "usage-norms-row-btn usage-norms-accept" });
		setIcon(accept, "check");
		accept.setAttribute("aria-label", "用这条替换原文");
		accept.addEventListener("click", (event) => {
			event.stopPropagation();
			this.plugin.accept(index);
		});
	}

	private hint(icon: string, text: string, onClick: () => void): void {
		const el = this.bodyEl.createDiv({ cls: "usage-norms-hint" });
		const iconEl = el.createDiv({ cls: "usage-norms-hint-icon" });
		setIcon(iconEl, icon);
		el.createDiv({ cls: "usage-norms-hint-text", text });
		el.addEventListener("click", onClick);
	}
}
