/**
 * 句子切分（移植自参考实现 `assist_sentences.dart`，逐条对齐）。
 *
 * 只认这几样当句末：`。！？!?；;…` 和换行。英文 `.` 只在后面跟空白 / 到结尾、
 * 且前面不是数字时才算（别把 `3.14` / `2026.11.04` 切开）。
 * - 句末后面的收尾引号 / 括号（`」』””）】`）算这一句；
 * - 句首的 Markdown 行首标记（`# ` / `- ` / `> ` / `1. `）**不算**，免得模型
 *   把标记一起改掉；
 * - 所有偏移都是**整篇正文**的偏移，和 `Suggestion` 一致，不碰正文。
 */

export interface Span {
	start: number;
	end: number;
}

export function spanText(text: string, span: Span): string {
	if (span.start < 0 || span.end > text.length || span.start > span.end) return "";
	return text.slice(span.start, span.end);
}

/** 空白（空格 / Tab / 换行 / 全角空格）。切句和送检都要用。 */
export function isSpace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x3000;
}

/** 句末后面的「填空」空白（不含换行：换行本身就是句末）。 */
function isPadSpace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x3000;
}

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

/** 句末后面的收尾符号：它们属于这一句，不属于下一句。 */
function isCloser(code: number): boolean {
	switch (code) {
		case 0x22:
		case 0x27:
		case 0x29:
		case 0xff09:
		case 0x5d:
		case 0xff3d:
		case 0x3009:
		case 0x300b:
		case 0x300d:
		case 0x300f:
		case 0x3011:
		case 0x3015:
		case 0x2019:
		case 0x201d:
			return true;
		default:
			return false;
	}
}

/** `index` 这个字符是不是句末。 */
function isStop(text: string, index: number): boolean {
	if (index < 0 || index >= text.length) return false;
	switch (text.charCodeAt(index)) {
		case 0x3002: // 。
		case 0xff01: // ！
		case 0x21: // !
		case 0xff1f: // ？
		case 0x3f: // ?
		case 0xff1b: // ；
		case 0x3b: // ;
		case 0x2026: // …
		case 0x0a: // \n
		case 0x0d: // \r
		case 0xff0e: // ．
			return true;
		case 0x2e: // .：后面必须是空白 / 结尾，前面不能是数字
			if (index + 1 < text.length && !isSpace(text.charCodeAt(index + 1))) return false;
			if (index > 0 && isDigit(text.charCodeAt(index - 1))) return false;
			return true;
		default:
			return false;
	}
}

/** 往回找句末时用：`\r\n` 只算一个句末。 */
function isBoundary(text: string, index: number): boolean {
	if (!isStop(text, index)) return false;
	if (text.charCodeAt(index) === 0x0d && index + 1 < text.length && text.charCodeAt(index + 1) === 0x0a) {
		return false;
	}
	return true;
}

function skipSpaces(text: string, from: number, cap: number): number {
	let i = from;
	while (i < cap && isSpace(text.charCodeAt(i))) i += 1;
	return i;
}

/** 剥掉行首的 Markdown 标记（`# ` / `> ` / `- ` / `1. `）。只在真的顶格时剥。 */
function linePrefixEnd(text: string, i: number, cap: number): number {
	let j = i;
	// `# 标题`
	let k = j;
	while (k < cap && text.charCodeAt(k) === 0x23) k += 1;
	if (k > j && k < cap && text.charCodeAt(k) === 0x20) return skipSpaces(text, k + 1, cap);
	// `> 引用`（可以连着好几层）
	k = j;
	while (k < cap && text.charCodeAt(k) === 0x3e) {
		k += 1;
		if (k < cap && text.charCodeAt(k) === 0x20) k += 1;
	}
	if (k > j) return skipSpaces(text, k, cap);
	// `- 列表` / `* 列表` / `+ 列表`
	if (
		j + 1 < cap &&
		(text.charCodeAt(j) === 0x2d || text.charCodeAt(j) === 0x2a || text.charCodeAt(j) === 0x2b) &&
		text.charCodeAt(j + 1) === 0x20
	) {
		return skipSpaces(text, j + 2, cap);
	}
	// `1. 列表`
	k = j;
	while (k < cap && isDigit(text.charCodeAt(k))) k += 1;
	if (k > j && k + 1 < cap && text.charCodeAt(k) === 0x2e && text.charCodeAt(k + 1) === 0x20) {
		return skipSpaces(text, k + 2, cap);
	}
	return j;
}

/** 从 `start` 往后跳过句首空白 / 行首标记。 */
function skipLeading(text: string, start: number, limit: number): number {
	const cap = Math.min(limit, text.length);
	let i = start < 0 ? 0 : start;
	i = skipSpaces(text, i, cap);
	if (i >= cap) return i;
	// 只有「这一行在 i 之前全是空白」才剥行首标记。
	let atLineStart = i === 0;
	if (!atLineStart) {
		let back = i - 1;
		while (back >= 0 && (text.charCodeAt(back) === 0x20 || text.charCodeAt(back) === 0x09)) back -= 1;
		atLineStart = back < 0 || text.charCodeAt(back) === 0x0a;
	}
	if (!atLineStart) return i;
	return linePrefixEnd(text, i, cap);
}

/** 从 `from` 往后找这一句的句末（含句号 / 换行和收尾引号，末尾空白去掉）。 */
function sentenceEnd(text: string, from: number): number {
	let i = Math.max(0, Math.min(from, text.length));
	while (i < text.length) {
		if (isStop(text, i)) {
			// 连续的句末符号（`！！` / `……` / `。？`）和收尾引号都算这一句。
			while (i < text.length && (isStop(text, i) || isCloser(text.charCodeAt(i)))) i += 1;
			break;
		}
		i += 1;
	}
	while (i > from && isSpace(text.charCodeAt(i - 1))) i -= 1;
	return i;
}

/** 句子在 `stopIndex` 那个句末结束：往前跳过同一串句末符号 / 收尾引号，再找上一个边界。 */
function sentenceStartBefore(text: string, stopIndex: number, limit: number): number {
	let k = stopIndex - 1;
	while (k >= 0 && (isStop(text, k) || isCloser(text.charCodeAt(k)))) k -= 1;
	while (k >= 0 && !isBoundary(text, k)) k -= 1;
	return skipLeading(text, k + 1, limit);
}

/**
 * 把整篇正文切成一句一句（首尾空白、行首 Markdown 标记都不算在 span 里）。
 *
 * 「全文扫描」用它算「哪些句子已经扫过」：切出来的文字必须和按句增量送检的
 * 那一句**逐字一样**，否则已扫记录对不上，会重复送。
 */
export function splitSentences(text: string): Span[] {
	const spans: Span[] = [];
	let i = 0;
	while (i < text.length) {
		if (isSpace(text.charCodeAt(i))) {
			i += 1;
			continue;
		}
		const start = skipLeading(text, i, text.length);
		if (start >= text.length) break;
		const end = sentenceEnd(text, start);
		if (end > start) {
			spans.push({ start, end });
			i = end;
		} else {
			i = start + 1;
		}
	}
	return spans;
}

/** 某个字符所在的句子，句首在哪。 */
export function sentenceStartAt(text: string, at: number): number {
	if (text.length === 0) return 0;
	let pos = Math.max(0, Math.min(at, text.length - 1));
	// 收尾引号属于上一句：先退到句号上。
	while (pos > 0 && isCloser(text.charCodeAt(pos))) pos -= 1;
	if (isBoundary(text, pos)) return sentenceStartBefore(text, pos, pos + 1);
	let j = pos - 1;
	while (j >= 0 && !isBoundary(text, j)) j -= 1;
	return skipLeading(text, j + 1, pos + 1);
}

/** 光标所在的（可能还没写完的）这一句。 */
export function openSentence(text: string, caret: number): Span {
	const pos = Math.max(0, Math.min(caret, text.length));
	let start: number;
	const ended = sentenceJustEnded(text, pos);
	if (ended) {
		// 光标刚停在句末：下一句才刚开始。
		start = skipLeading(text, pos, text.length);
	} else if (pos <= 0) {
		start = 0;
	} else {
		// 光标前那个字属于哪一句，这一句的句首就是它。
		start = sentenceStartAt(text, pos - 1);
	}
	const end = sentenceEnd(text, Math.min(start, text.length));
	return { start, end: end < start ? start : end };
}

/** 光标是不是正好停在一句的末尾（前面是句号 / 回车，允许中间夹空白和引号）。 */
export function sentenceJustEnded(text: string, caret: number): Span | null {
	const pos = Math.max(0, Math.min(caret, text.length));
	let i = pos - 1;
	while (i >= 0 && (isPadSpace(text.charCodeAt(i)) || isCloser(text.charCodeAt(i)))) i -= 1;
	if (i < 0 || !isStop(text, i)) return null;
	const start = sentenceStartBefore(text, i, pos);
	let end = pos;
	while (end > start && isSpace(text.charCodeAt(end - 1))) end -= 1;
	if (end <= start) return null;
	return { start, end };
}
