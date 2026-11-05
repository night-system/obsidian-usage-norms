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
 *
 * **任何 DOM 节点都不缓存**（照 obsidian-todo-panel 的写法）：iPad 键盘弹起
 * 时 Obsidian 会重排侧栏，视图实例还在、`onOpen` 却不一定再来；之前缓存的
 * bodyEl 会成为脱离文档的孤儿节点 —— 行画进去了，屏幕上什么都没有，看起来
 * 就是「键盘一抬，左边就空了」。所以每次 render 都现查活容器、缺了就重建。
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

	async onOpen(): Promise<void> {
		// 先同步画一遍（不依赖模板 / 库），再交给插件挂当前笔记：
		// 等 async 的 onPanelOpened 走完再画，iPad 上中间会空一下。
		this.render();
		await this.plugin.onPanelOpened();
	}

	async onClose(): Promise<void> {
		this.plugin.onPanelClosed();
	}

	/**
	 * Obsidian 改了这个视图的尺寸（iPad 键盘弹起 / 侧栏开合 / 宽度变化）。
	 *
	 * 这是官方给的「尺寸变了」回调，比 window.resize 与 layout-change 更早也更
	 * 准；这里直接重画一遍，顺手让插件补画正文标记。
	 */
	onResize(): void {
		this.render();
		this.plugin.onPanelResized();
	}

	/**
	 * 当前**活着的**内容容器。
	 *
	 * `ItemView.contentEl` 是构造时记下的 `containerEl.children[1]`；移动端侧栏
	 * 重建后这个子元素可能被换掉，所以每次现查 children[1]，查不到再退回
	 * contentEl。
	 */
	private liveRoot(): HTMLElement | null {
		const kids = this.containerEl ? this.containerEl.children : null;
		const child = kids && kids.length > 1 ? kids[1] : null;
		if (child instanceof HTMLElement) return child;
		return this.contentEl instanceof HTMLElement ? this.contentEl : null;
	}

	private bodyOf(root: HTMLElement): HTMLElement | null {
		for (const child of Array.from(root.children)) {
			if (child instanceof HTMLElement && child.classList.contains("usage-norms-body")) {
				return child;
			}
		}
		return null;
	}

	render(): void {
		const root = this.liveRoot();
		if (!root) return;
		// 容器被换掉时上面的类名也没了，每次补一遍（幂等）。
		root.addClass("usage-norms");
		let body = this.bodyOf(root);
		if (!body) {
			body = root.createDiv({ cls: "usage-norms-body" });
			// 只有真的重建了才记一笔：日志里一眼能看出「面板容器被换过」。
			this.plugin.log(`view rebuild body (root children=${root.childElementCount})`);
		}
		body.empty();
		const store = this.plugin.store;
		for (let i = 0; i < store.items.length; i += 1) this.renderRow(body, i);
	}

	/** 排查用：活容器里实际画出来了几行。 */
	get rowCount(): number {
		const root = this.liveRoot();
		const body = root ? this.bodyOf(root) : null;
		return body ? body.childElementCount : -1;
	}

	/** 排查用：列表容器的高度（侧栏被收起时会是 0）。 */
	get bodyHeight(): number {
		const root = this.liveRoot();
		const body = root ? this.bodyOf(root) : null;
		return body ? body.clientHeight : -1;
	}

	/** 排查用：视图的容器是不是还挂在文档里。 */
	get live(): boolean {
		return !!(this.containerEl && this.containerEl.isConnected);
	}

	private renderRow(body: HTMLElement, index: number): void {
		const item = this.plugin.store.items[index];
		const suggestion = item.suggestion;
		const row = body.createDiv({ cls: "usage-norms-row" });
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
