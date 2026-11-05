import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { isDeletion, rowText } from "./engine";
import type UsageNormsPlugin from "./main";

export const VIEW_TYPE_USAGE_NORMS = "usage-norms-view";

/**
 * 左侧边栏面板：**只显示建议条目**，一个多余的像素都不放。
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
 *
 * **0.1.8：这个 view 整个从 `obsidian-todo-panel` 的 `TodoPanelView` 搬过来。**
 *
 * 用户在 iPad 上的事实：todo panel 的行不会因为键盘弹起而消失，这个面板会。
 * 0.1.5 / 0.1.6 / 0.1.7 都是在「猜差异、对齐某个机制」——缓存 body、现查容器、
 * onResize、自愈巡检——但真机上照样空。所以不再挑机制抄，改成整块移植：
 *
 * - `render()` 和 todo panel 一样：**只**取 `this.containerEl.children[1]`、
 *   先存 `scrollTop`、`container.empty()`、把行直接画进去、再把 `scrollTop` 放回；
 * - 不缓存任何 DOM（没有 `bodyEl`），也不在 render 之外维护第二套容器；
 * - 不加 `onResize` / 自愈巡检 / 布局事件里的重画 —— todo panel 没有这些，
 *   它的行就是靠「只在 onOpen 和数据变化时画」活下来的；
 * - `onClose()` 什么都不做（和 todo panel 一样），关栏不清建议、不挂起。
 *
 * 数据仍然从本插件的 store 来，不再有第二份状态。
 */
export class UsageNormsView extends ItemView {
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

	/** 和 todo panel 一样：打开时画一遍，之后靠数据变化再画。 */
	async onOpen(): Promise<void> {
		this.render();
	}

	/** 和 todo panel 一样：关闭时什么都不做，建议留在内存里。 */
	async onClose(): Promise<void> {}

	/**
	 * 画整个面板。**逐行照 `TodoPanelView.render()` 的写法**：
	 *
	 * ```ts
	 * const container = this.containerEl.children[1];
	 * const scrollTop = container.scrollTop;
	 * container.empty();
	 * container.addClass("todo-panel-container");
	 * ```
	 *
	 * 这里只把数据源换成 `plugin.store.items`。容器的获取方式、清空方式、
	 * 滚动位置的保存与恢复都与 todo panel 相同。
	 */
	render(): void {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (!container) return;
		const scrollTop = container.scrollTop;
		container.empty();
		container.addClass("usage-norms");

		const store = this.plugin.store;
		// 和 todo panel 的 `.todo-panel-list` 一样：容器里先放一个列表，再往里放行。
		const list = container.createDiv({ cls: "usage-norms-list" });
		for (let i = 0; i < store.items.length; i += 1) this.renderRow(list, i);
		container.scrollTop = scrollTop;
	}

	/** 排查用：活容器里实际画出来了几行。 */
	get rowCount(): number {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		return container ? container.querySelectorAll(".usage-norms-row").length : -1;
	}

	/** 排查用：容器的高度（侧栏被收起时会是 0）。 */
	get bodyHeight(): number {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		return container ? container.clientHeight : -1;
	}

	/** 排查用：视图的容器是不是还挂在文档里。 */
	get live(): boolean {
		return !!(this.containerEl && this.containerEl.isConnected);
	}

	private renderRow(list: HTMLElement, index: number): void {
		const item = this.plugin.store.items[index];
		const suggestion = item.suggestion;
		const row = list.createDiv({ cls: "usage-norms-row" });
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
