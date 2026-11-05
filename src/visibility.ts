/**
 * 「正文要不要画虚线 / 删除线」只看这一件事：**面板此刻是不是真的在屏幕上**。
 *
 * 用户的诉求：左侧栏没打开、或者侧栏停在别的标签（文件列表 / 搜索 / 大纲 …）时，
 * 正文里不要出现语法修正的虚线 / 删除线 —— 看不见建议的时候，标记既点不了 `✓`
 * 也点不了 `×`，只是噪音。
 *
 * 判据单独放在这个文件里（纯函数、不碰 Obsidian 的 DOM）：
 * 桌面端的左侧栏、iPad 键盘弹起后的抽屉、手机上的普通视图，三种容器形态共用一套
 * 规则，而且 `npm test` 能把每条规则单独跑一遍。
 */

/** 面板可见时挂在 `body` 上的类名。CSS 用它兜底：没有这个类，一条标记都不画。 */
export const PANEL_VISIBLE_CLASS = "usage-norms-panel-visible";

/** 一个面板叶子（ItemView）能提供给判据的全部事实。 */
export interface PanelProbe {
	/** 工作区里还有这个叶子吗（有叶子 ≠ 看得见）。 */
	hasLeaf: boolean;
	/** 视图容器还挂在文档里吗。 */
	connected: boolean;
	/** 容器 `isShown()`：祖先里有 `display: none` 就是 false；拿不到这个 API 时传 undefined。 */
	shown?: boolean;
	/** 容器外部宽高；侧栏收起动画中、被压成 0 时都是 0。 */
	width: number;
	height: number;
	/** 叶子所在的分栏 / 抽屉是不是收起了。 */
	dockCollapsed?: boolean;
}

/**
 * 面板是不是真的看得见。
 *
 * **任何一条不满足就当看不见**：宁可少画一次标记（面板一露头立刻补回来），
 * 也不要在用户看不见建议的时候往正文里画线。
 *
 * 三条「有叶子但看不见」的实测形态：
 * - 桌面端收起左侧栏：`WorkspaceSidedock.collapse()` 先 `collapsed = true`，
 *   动画结束再 `containerEl.hide()`（display: none）；
 * - 侧栏里切到别的标签：Obsidian 的 `updateTabDisplay()` 把非当前叶子的
 *   `containerEl.toggle(...)` 关掉（display: none），叶子本身还在；
 * - iPad 键盘弹起 / 抽屉收回：`WorkspaceMobileDrawer.collapsed = true`。
 */
export function isPanelVisible(probe: PanelProbe): boolean {
	if (!probe.hasLeaf) return false;
	if (!probe.connected) return false;
	if (probe.dockCollapsed === true) return false;
	if (probe.shown === false) return false;
	if (!(probe.width > 0)) return false;
	if (!(probe.height > 0)) return false;
	return true;
}
