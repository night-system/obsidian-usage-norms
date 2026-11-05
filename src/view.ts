import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { isDeletion, rowText } from "./engine";
import type UsageNormsPlugin from "./main";

export const VIEW_TYPE_USAGE_NORMS = "usage-norms-view";

/**
 * 左侧边栏面板：**只显示建议条目**。
 *
 * 没有顶栏、没有条数、没有模板名、没有图标按钮、没有空态文案 —— 栏里除了
 * 一行行建议什么都没有。其余能力都走命令面板：
 * - 全文扫描 → 命令「用语规范：全文扫描当前笔记」
 * - 打开面板 → 命令「用语规范：打开 / 聚焦左侧面板」
 * - 模板 / 强度 / 密钥 → Obsidian 设置页
 *
 * 每条建议：`×` 改后文本 `✓`（删除类显示被删的原文并画删除线），可带一行
 * reason。图标都是裸 `<span>` + `setIcon`，不用 `<button>`（主题会把 button
 * 画成大药丸，实测）。
 */
export class UsageNormsView extends ItemView {
	private bodyEl!: HTMLElement;

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
		await this.plugin.onPanelOpened();
	}

	async onClose(): Promise<void> {
		this.plugin.onPanelClosed();
	}

	private build(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("usage-norms");
		this.bodyEl = root.createDiv({ cls: "usage-norms-body" });
	}

	render(): void {
		if (!this.bodyEl) return;
		const store = this.plugin.store;
		this.bodyEl.empty();
		for (let i = 0; i < store.items.length; i += 1) this.renderRow(i);
	}

	/** 排查用：实际画出来了几行。 */
	get rowCount(): number {
		return this.bodyEl ? this.bodyEl.childElementCount : -1;
	}

	/** 排查用：列表容器的高度（被侧栏收起时会是 0）。 */
	get bodyHeight(): number {
		return this.bodyEl ? this.bodyEl.clientHeight : -1;
	}

	private renderRow(index: number): void {
		const item = this.plugin.store.items[index];
		const suggestion = item.suggestion;
		const row = this.bodyEl.createDiv({ cls: "usage-norms-row" });
		if (this.plugin.store.activeIndex === index) row.addClass("is-active");

		this.rowIcon(row, "x", "忽视这一条", () => this.plugin.ignore(index), "usage-norms-ignore");

		const textEl = row.createDiv({ cls: "usage-norms-row-text" });
		if (isDeletion(suggestion)) textEl.addClass("is-deletion");
		textEl.createDiv({ cls: "usage-norms-row-main", text: rowText(suggestion) });
		if (this.plugin.data.showReason && suggestion.reason.length > 0) {
			textEl.createDiv({ cls: "usage-norms-row-reason", text: suggestion.reason });
		}

		row.addEventListener("click", () => this.plugin.select(index));

		this.rowIcon(row, "check", "用这条替换原文", () => this.plugin.accept(index), "usage-norms-accept");
	}

	private rowIcon(
		row: HTMLElement,
		name: string,
		label: string,
		onClick: () => void,
		extra: string
	): void {
		const el = row.createSpan({ cls: `usage-norms-row-icon ${extra}` });
		setIcon(el, name);
		el.setAttribute("role", "button");
		el.setAttribute("aria-label", label);
		el.setAttribute("title", label);
		el.addEventListener("click", (event) => {
			event.stopPropagation();
			onClick();
		});
	}
}
