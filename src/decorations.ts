import type { Range } from "@codemirror/state";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Suggestion, fits, isDeletion } from "./engine";

/**
 * 正文标记的类名。
 *
 * **必须带 `cm-` 前缀，并且和 styles.css 里的选择器一字不差**：0.1.0～0.1.4
 * 这里写的是 `usage-norms-ins`，而样式表写的是 `.cm-usage-norms-ins`，结果
 * decoration 是画上去了、颜色却是 none —— 虚线和删除线一条都没显示出来。
 * 改这里就同步改 styles.css（`npm test` 里有一条专门盯这个的用例）。
 */
const CLASS_DEL = "cm-usage-norms-del";
const CLASS_INS = "cm-usage-norms-ins";
const CLASS_ACTIVE = "cm-usage-norms-active";

/**
 * 正文里的标记：只标 `quote` 那一小段。
 *
 * - 删除 → 删除线（`.cm-usage-norms-del`）；
 * - 替换 / 补全 → 虚线（`.cm-usage-norms-ins`）；
 * - 被选中的那条 → 加背景（`.cm-usage-norms-active`）。
 *
 * 用 CM6 的 mark decoration，不改正文、不进撤销栈。
 */
const setMarks = StateEffect.define<DecorationSet>();

const marksField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		let next = value.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(setMarks)) next = effect.value;
		}
		return next;
	},
	provide: (field) => EditorView.decorations.from(field),
});

/** 注册给插件：同时把每次 ViewUpdate 转给外部（拿去更新光标位置）。 */
export function marksExtension(onUpdate: (update: ViewUpdate) => void) {
	const plugin = ViewPlugin.fromClass(
		class {
			constructor(readonly view: EditorView) {}

			update(update: ViewUpdate): void {
				try {
					onUpdate(update);
				} catch (error) {
					console.error("[usage-norms] view update", error);
				}
			}
		}
	);
	return [marksField, plugin];
}

/** EditorView 是否还活着（`destroyed` 在新版本里是私有的，看 DOM 更稳）。 */
function isAlive(view: EditorView | null): view is EditorView {
	return !!view && !!view.dom && view.dom.isConnected !== false;
}

/** 把当前建议画到正文上；对不上原文的自动跳过。返回真正画上去的条数。 */
export function applyMarks(
	view: EditorView | null,
	text: string,
	suggestions: Suggestion[],
	activeIndex: number | null
): number {
	if (!isAlive(view)) return -1;
	const doc = view.state.doc;
	const ranges: Range<Decoration>[] = [];
	for (let i = 0; i < suggestions.length; i += 1) {
		const suggestion = suggestions[i];
		if (!fits(text, suggestion)) continue;
		if (suggestion.end > doc.length) continue;
		try {
			if (doc.sliceString(suggestion.start, suggestion.end) !== suggestion.source) continue;
		} catch {
			continue;
		}
		const active = i === activeIndex;
		const classes = [isDeletion(suggestion) ? CLASS_DEL : CLASS_INS];
		if (active) classes.push(CLASS_ACTIVE);
		ranges.push(Decoration.mark({ class: classes.join(" ") }).range(suggestion.start, suggestion.end));
	}
	ranges.sort((a, b) => a.from - b.from);
	try {
		view.dispatch({ effects: setMarks.of(Decoration.set(ranges, true)) });
		return ranges.length;
	} catch (error) {
		console.error("[usage-norms] apply marks", error);
		return -1;
	}
}

/** 清掉正文上的标记（换页 / 关面板）。 */
export function clearMarks(view: EditorView | null): void {
	if (!isAlive(view)) return;
	try {
		view.dispatch({ effects: setMarks.of(Decoration.none) });
	} catch {
		// view 正在销毁，忽略
	}
}
