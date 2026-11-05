import {
	MAX_CHARS,
	Suggestion,
	SuggestRequest,
	Strength,
	UsageNormsError,
	fits,
	requestSuggestions,
} from "./engine";
import { openSentence, sentenceJustEnded, sentenceStartAt, splitSentences, spanText } from "./sentences";
import type { PromptTemplate } from "./templates";
import type { UsageNormsData } from "./settings";

/** 一句话至少这么长才值得单独送检（一个「。」不配一次请求）。 */
const MIN_SENTENCE_CHARS = 2;

/** 没写完的句子攒到这么长才送预览（太短送检没有意义，也省请求）。 */
const MIN_TAIL_CHARS = 6;

/** 停手多久送一次预览。 */
const PREVIEW_DELAY_MS = 900;

/** 同一句（逐字相同）在这段时间内不重复送。 */
const RESEND_GUARD_MS = 60_000;

/** 送给模型的「前文语境」最多多少字。 */
const CONTEXT_CHARS = 800;

export interface AssistItem {
	suggestion: Suggestion;
	/** 预览（半句时出的那条）：句号之后整句结果回来要覆盖它。 */
	preview: boolean;
}

interface Job {
	start: number;
	source: string;
	context: string;
	mode: string;
	scan: boolean;
	preview: boolean;
	cancelled: boolean;
}

/** 面板 / 设置 / 主插件之间的接口（避免循环引用）。 */
export interface StoreHost {
	data: UsageNormsData;
	template(): PromptTemplate | null;
	notify(): void;
	persist(): void;
	/** 测试用：替换真实请求。 */
	send?: (request: SuggestRequest) => Promise<Suggestion[]>;
	/** 测试用：把「停手送预览」的等待调短。 */
	previewDelayMs?: number;
	/** 排查用日志（只在导出时落盘）。 */
	log?: (message: string) => void;
}

/** 简单稳定的字符串哈希（扫描模式指纹用）。 */
function hash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/**
 * 侧栏的状态机：按句增量送检、记账、条目列表。
 *
 * 送检规则和参考实现 `assist_controller.dart` 对齐：
 * - **点开面板不整篇扫**：只有「这次改动真正碰到的那一句」才送（靠插入区间判断），
 *   整篇要显式跑「全文扫描」命令；
 * - 句号 / 换行落下且这一句被改动过 → 立刻送整句，前文只当 `context`；
 * - 光标在句子里（包括已有句号的老句子）停手 900ms → 送一次预览；
 * - 记账：每页每种扫描模式记「算过的句子」，同一句不重复花钱；
 * - 一次只发一个请求，后来的排队；被更完整提交覆盖的请求作废。
 */
export class AssistStore {
	items: AssistItem[] = [];
	activeIndex: number | null = null;
	error: string | null = null;
	fileKey = "";
	active = false;

	/** 开面板 / 换页之后有没有真的扫过东西（空态文案用）。 */
	scannedAnything = false;

	private text = "";
	private caret = 0;
	/** 上一次改动插入的范围：用来判断「刚打完这句是不是真的被改过」。 */
	private insertStart = 0;
	private insertEnd = 0;
	private queue: Job[] = [];
	private running: Job | null = null;
	private previewTimer: ReturnType<typeof setTimeout> | null = null;
	/** 整句送检的时间戳（同一句 60s 内不重复送）。 */
	private sentFull = new Map<string, number>();
	/** 预览送检的时间戳（句号到了要允许整句结果覆盖，所以和整句分开记）。 */
	private sentPreview = new Map<string, number>();

	constructor(private host: StoreHost) {}

	private send(request: SuggestRequest): Promise<Suggestion[]> {
		const send = this.host.send ?? requestSuggestions;
		return send(request);
	}

	// ------------------------------------------------------------------ 生命周期

	/**
	 * 面板可见 / 重新挂上当前笔记。
	 *
	 * 同一篇笔记会**保留已有建议**（iPad 上键盘弹起会让 Obsidian 重建侧栏
	 * 视图、触发 onClose/onOpen，不能因此把建议清空）；只有真的换了笔记才重置。
	 */
	activate(fileKey: string, text: string, caret: number): void {
		if (fileKey.length > 0 && this.fileKey === fileKey) {
			const old = this.text;
			this.active = true;
			this.text = text;
			this.caret = caret;
			if (old !== text) this.rebase(old, text);
			this.host.notify();
			return;
		}
		this.resetState();
		this.active = true;
		this.fileKey = fileKey;
		this.text = text;
		this.caret = caret;
		this.insertStart = text.length;
		this.insertEnd = text.length;
		this.host.notify();
	}

	/**
	 * 面板暂时不可见（侧栏被收起、键盘弹起、切走工作区）：停网、停计时器，
	 * 但**保留建议**，下次可见时原样恢复。
	 */
	suspend(): void {
		this.active = false;
		this.clearPreviewTimer();
		this.cancelAll();
	}

	/** 重新可见但拿不到正文（没有活动笔记）：只把门打开，不动已有状态。 */
	resume(): void {
		this.active = true;
	}

	/** 彻底关掉（卸载插件）：建议全部丢掉。 */
	deactivate(): void {
		this.active = false;
		this.fileKey = "";
		this.resetState();
		this.host.notify();
	}

	/** 换页（换到另一篇笔记）：旧页的偏移全部作废，新页从零开始。 */
	switchFile(fileKey: string, text: string, caret: number): void {
		if (!this.active) {
			this.fileKey = fileKey;
			return;
		}
		if (this.fileKey === fileKey) return;
		this.resetState();
		this.fileKey = fileKey;
		this.text = text;
		this.caret = caret;
		this.insertStart = text.length;
		this.insertEnd = text.length;
		this.host.notify();
	}

	/** 换模板 / 改模板正文 / 换强度：旧建议清空，按新标准整篇重扫。 */
	onModeChanged(): void {
		this.cancelAll();
		this.items = [];
		this.activeIndex = null;
		this.error = null;
		this.scannedAnything = false;
		this.host.notify();
		if (this.active && this.text.trim().length > 0 && this.canWork()) this.scanAll();
	}

	// -------------------------------------------------------------------- 输入

	onText(text: string, caret: number): void {
		const pos = Math.max(0, Math.min(caret, text.length));
		const textChanged = text !== this.text;
		if (!textChanged) {
			// 只是移动光标：什么都不送（否则点一下都在烧钱）。
			this.caret = pos;
			return;
		}
		const oldText = this.text;
		this.text = text;
		this.caret = pos;
		this.trackInsert(oldText, text);
		this.rebase(oldText, text);
		if (!this.active) {
			// 面板不可见时仍在写：偏移已经跟着对齐，建议留着等可见时再判断。
			return;
		}
		if (text.trim().length === 0) {
			this.cancelAll();
			this.items = [];
			this.activeIndex = null;
			this.error = null;
			this.host.notify();
			return;
		}
		if (this.canWork()) this.dispatchOnChange();
		this.host.notify();
	}

	/** 记下这次改动插入的区间（前后缀对齐后中间那一段）。 */
	private trackInsert(oldText: string, newText: string): void {
		let prefix = 0;
		const maxPrefix = Math.min(oldText.length, newText.length);
		while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix += 1;
		let suffix = 0;
		const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
		while (
			suffix < maxSuffix &&
			oldText.charCodeAt(oldText.length - 1 - suffix) ===
				newText.charCodeAt(newText.length - 1 - suffix)
		) {
			suffix += 1;
		}
		this.insertStart = prefix;
		this.insertEnd = newText.length - suffix;
	}

	/** 手动「全文扫描」：只扫**还没记过的句子**；全扫过就什么都不发。 */
	scanAll(): void {
		if (!this.active) return;
		this.clearPreviewTimer();
		this.cancelQueued();
		this.error = null;
		if (this.text.trim().length === 0 || !this.canWork()) {
			this.host.notify();
			return;
		}

		const record = this.record();
		const spans = splitSentences(this.text);
		const current = new Set(spans.map((span) => spanText(this.text, span)));
		// 笔记改短 / 删句后，记录里没用的旧句子顺手清掉。
		const before = record.sentences.length;
		record.sentences = record.sentences.filter((sentence) => current.has(sentence));
		let recordChanged = record.sentences.length !== before;
		// 一两个字的碎片不值得单独送，直接记成扫过。
		for (const span of spans) {
			const sentence = spanText(this.text, span);
			if (sentence.length < MIN_SENTENCE_CHARS && !record.sentences.includes(sentence)) {
				record.sentences.push(sentence);
				recordChanged = true;
			}
		}

		const pending = spans.filter((span) => !record.sentences.includes(spanText(this.text, span)));
		this.scannedAnything = true;
		if (pending.length === 0) {
			if (recordChanged) this.host.persist();
			this.host.notify();
			return;
		}
		for (const chunk of this.chunks(pending)) {
			const start = chunk[0].start;
			const end = chunk[chunk.length - 1].end;
			this.enqueue({
				start,
				source: this.text.slice(start, end),
				context: this.contextBefore(start),
				mode: this.mode(),
				scan: true,
				preview: false,
				cancelled: false,
			});
		}
		if (recordChanged) this.host.persist();
		this.host.notify();
	}

	/** 侧栏条目：选中（只高亮，不改正文）。 */
	select(index: number | null): void {
		if (this.activeIndex === index) return;
		this.activeIndex = index;
		this.host.notify();
	}

	/** 点 ✓：把这条从列表里拿掉，返回要写回正文的改动。 */
	accept(index: number): Suggestion | null {
		const item = this.items[index];
		if (!item) return null;
		this.items.splice(index, 1);
		this.activeIndex = null;
		this.host.notify();
		return item.suggestion;
	}

	/** 点 ×：只从侧栏和正文标记里拿掉，不改正文、不重新请求。 */
	ignore(index: number): void {
		const item = this.items[index];
		if (!item) return;
		const target = item.suggestion;
		this.items.splice(index, 1);
		this.activeIndex = null;
		for (const job of [...this.queue, ...(this.running ? [this.running] : [])]) {
			if (job.start < target.end && target.start < job.start + job.source.length) job.cancelled = true;
		}
		this.host.notify();
	}

	/** 当前活跃正文里的建议（装饰用；顺带丢掉对不上原文的）。 */
	liveSuggestions(): Suggestion[] {
		if (!this.active) return [];
		return this.items.map((item) => item.suggestion).filter((s) => fits(this.text, s));
	}

	get loading(): boolean {
		return this.queue.length > 0 || this.running !== null;
	}

	get textSnapshot(): string {
		return this.text;
	}

	// ------------------------------------------------------------------ 内部

	private canWork(): boolean {
		return this.host.data.apiKey.trim().length > 0 && this.host.template() !== null;
	}

	private mode(): string {
		const template = this.host.template();
		if (!template) return "no-template";
		return hash(`${template.path}\u0000${template.text}\u0000${this.host.data.strength}`);
	}

	private resetState(): void {
		this.clearPreviewTimer();
		this.cancelAll();
		this.items = [];
		this.activeIndex = null;
		this.error = null;
		this.text = "";
		this.caret = 0;
		this.insertStart = 0;
		this.insertEnd = 0;
		this.scannedAnything = false;
		this.sentFull.clear();
		this.sentPreview.clear();
	}

	private clearPreviewTimer(): void {
		if (this.previewTimer !== null) {
			clearTimeout(this.previewTimer);
			this.previewTimer = null;
		}
	}

	/** 取消排队和在飞的请求（在飞的只能等它回来再丢结果）。 */
	private cancelAll(): void {
		this.clearPreviewTimer();
		for (const job of this.queue) job.cancelled = true;
		this.queue = [];
		if (this.running) this.running.cancelled = true;
	}

	private cancelQueued(): void {
		for (const job of this.queue) job.cancelled = true;
		this.queue = [];
	}

	/** 正文变了：已有的建议先跟着对位（对不上的丢掉）。 */
	private rebase(oldText: string, newText: string): void {
		if (this.items.length === 0) return;
		const next: AssistItem[] = [];
		for (const item of this.items) {
			const s = item.suggestion;
			if (fits(newText, s)) {
				next.push(item);
				continue;
			}
			// 用户在前面插了字：按原文片段重新找一次，只有唯一命中才平移。
			const first = newText.indexOf(s.source);
			if (first < 0) continue;
			if (newText.indexOf(s.source, first + 1) >= 0) continue;
			next.push({
				preview: item.preview,
				suggestion: { ...s, start: first, end: first + s.source.length },
			});
		}
		this.items = next;
		if (this.activeIndex !== null && this.activeIndex >= next.length) this.activeIndex = null;
	}

	/**
	 * 正文变了之后：刚打完一句就立刻送；否则排一次「半句」的防抖预览。
	 *
	 * 和参考实现一致：只有**这次改动真的碰到了这一句**才送整句（避免光标停在
	 * 句号后面、或者只是粘了个空格就重算）；一次粘贴跨多句时，从插入点所在
	 * 那一句的句首开始送。
	 */
	private dispatchOnChange(): void {
		this.clearPreviewTimer();
		const ended = sentenceJustEnded(this.text, this.caret);
		if (ended) {
			const inserted = this.text.slice(this.insertStart, this.insertEnd);
			const touched = this.insertStart < ended.end && this.insertEnd > ended.start;
			const newlineTouched = inserted.includes("\n") && ended.end > this.insertStart;
			if (touched || newlineTouched) {
				let start = ended.start;
				if (this.insertStart < this.text.length) {
					const sentenceStart = sentenceStartAt(this.text, this.insertStart);
					if (sentenceStart < start) start = sentenceStart;
				}
				this.sendSpan(start, ended.end, false);
			}
		}
		this.schedulePreview();
	}

	/**
	 * 半句没写完：停手一会儿送一次预览（不进「扫过」记录）。
	 *
	 * 这里**不**因为句子以句号结尾就跳过：用户在已有一句的中间改字时，光标不在
	 * 句号后面，句子里带着原来的句号 —— 以前这里跳过，就变成「怎么改都不送」。
	 */
	private schedulePreview(): void {
		this.clearPreviewTimer();
		if (!this.active || !this.canWork()) return;
		const span = openSentence(this.text, this.caret);
		const sentence = spanText(this.text, span);
		if (sentence.trim().length < MIN_TAIL_CHARS) return;
		if (this.covered(sentence)) return;
		this.previewTimer = setTimeout(() => {
			this.previewTimer = null;
			const now = openSentence(this.text, this.caret);
			const nowText = spanText(this.text, now);
			if (nowText !== sentence) return;
			this.sendSpan(now.start, now.end, true);
		}, this.host.previewDelayMs ?? PREVIEW_DELAY_MS);
	}

	/** 这一句是不是已经在算 / 已经算过（免得重复送）。 */
	private covered(sentence: string): boolean {
		if (this.recent(this.sentPreview, sentence) || this.recent(this.sentFull, sentence)) return true;
		return this.isScannedSentence(sentence);
	}

	/** 这一句在当前扫描模式下是不是已经算过（记账）。 */
	private isScannedSentence(sentence: string): boolean {
		const record = this.host.data.scans[this.fileKey];
		if (!record || record.mode !== this.mode()) return false;
		return record.sentences.includes(sentence);
	}

	private recent(map: Map<string, number>, sentence: string): boolean {
		const at = map.get(sentence);
		if (at === undefined) return false;
		if (Date.now() - at > RESEND_GUARD_MS) {
			map.delete(sentence);
			return false;
		}
		return true;
	}

	private sendSpan(start: number, end: number, preview: boolean): void {
		const source = this.text.slice(start, end);
		if (source.trim().length < (preview ? MIN_TAIL_CHARS : MIN_SENTENCE_CHARS)) return;
		if (preview) {
			if (this.recent(this.sentPreview, source) || this.recent(this.sentFull, source)) return;
		} else {
			if (this.recent(this.sentFull, source)) return;
			// 同模式已经算过的整句不再花钱（改过字就变成另一句，照常送）。
			if (this.isScannedSentence(source)) return;
		}
		// 已经在算的同一段不重复排队。
		for (const job of [...this.queue, ...(this.running ? [this.running] : [])]) {
			if (job.start === start && job.source === source) return;
		}
		(preview ? this.sentPreview : this.sentFull).set(source, Date.now());
		this.enqueue({
			start,
			source,
			context: this.contextBefore(start),
			mode: this.mode(),
			scan: false,
			preview,
			cancelled: false,
		});
	}

	/** 这一段前面的正文，只当语境（提示词里说明不用改）。 */
	private contextBefore(start: number): string {
		const from = Math.max(0, start - CONTEXT_CHARS);
		return this.text.slice(from, start).trim();
	}

	/** 把待扫句子按「连续 + 总长不超 MAX_CHARS」切成几块。 */
	private chunks(spans: { start: number; end: number }[]): { start: number; end: number }[][] {
		const out: { start: number; end: number }[][] = [];
		let current: { start: number; end: number }[] = [];
		for (const span of spans) {
			if (current.length > 0) {
				const gap = this.text.slice(current[current.length - 1].end, span.start);
				if (gap.trim().length > 0 || span.end - current[0].start > MAX_CHARS) {
					out.push(current);
					current = [];
				}
			}
			current.push(span);
		}
		if (current.length > 0) out.push(current);
		return out;
	}

	private record(): { mode: string; at: number; sentences: string[] } {
		const key = this.fileKey || "unnamed";
		const mode = this.mode();
		let record = this.host.data.scans[key];
		if (!record) {
			record = { mode, at: Date.now(), sentences: [] };
			this.host.data.scans[key] = record;
		}
		if (record.mode !== mode) {
			// 换模式 = 之前的「扫过」全部不算数。
			record.mode = mode;
			record.sentences = [];
		}
		return record;
	}

	private markScanned(job: Job): void {
		if (job.preview) return;
		if (job.mode !== this.mode()) return;
		const record = this.record();
		let changed = false;
		for (const span of splitSentences(job.source)) {
			const sentence = spanText(job.source, span);
			if (sentence.length < MIN_SENTENCE_CHARS) continue;
			if (!record.sentences.includes(sentence)) {
				record.sentences.push(sentence);
				changed = true;
			}
		}
		record.at = Date.now();
		if (changed) this.host.persist();
	}

	// ------------------------------------------------------------------ 请求

	private enqueue(job: Job): void {
		this.queue.push(job);
		this.host.notify();
		this.pump();
	}

	private pump(): void {
		if (this.running || this.queue.length === 0) return;
		const job = this.queue.shift();
		if (!job) return;
		this.running = job;
		void this.run(job);
	}

	private async run(job: Job): Promise<void> {
		const template = this.host.template();
		this.host.log?.(`req start len=${job.source.length} preview=${job.preview} scan=${job.scan}`);
		try {
			if (!template) throw new UsageNormsError("no-template", "没有可用的模板");
			const suggestions = await this.send({
				apiKey: this.host.data.apiKey,
				template: template.text,
				text: job.source,
				strength: this.host.data.strength as Strength,
				context: job.context,
			});
			if (job.cancelled) return;
			this.applyResult(job, suggestions);
			this.host.log?.(`req ok n=${suggestions.length} items=${this.items.length}`);
		} catch (error) {
			if (job.cancelled) return;
			this.error = error instanceof UsageNormsError ? error.message : "出错了";
			this.host.log?.(`req err ${this.error}`);
			if (error instanceof UsageNormsError && error.details) {
				console.warn("[usage-norms]", error.code, error.details);
			}
		} finally {
			if (this.running === job) this.running = null;
			this.host.notify();
			this.pump();
		}
	}

	private applyResult(job: Job, parsed: Suggestion[]): void {
		if (job.cancelled) return;
		if (job.mode !== this.mode()) return;
		// 请求路上正文变了：按原文重新定位，只有唯一命中才认。
		let base = job.start;
		if (this.text.slice(base, base + job.source.length) !== job.source) {
			const at = this.text.indexOf(job.source);
			if (at < 0) return;
			if (this.text.indexOf(job.source, at + 1) >= 0) return;
			base = at;
		}
		const begin = base;
		const finish = base + job.source.length;

		// 整句结果覆盖预览；新的预览覆盖同一段旧预览。
		this.items = this.items.filter((item) => {
			if (!item.preview) return true;
			return !(item.suggestion.start >= begin && item.suggestion.end <= finish);
		});

		const overlap = (start: number, end: number): boolean =>
			this.items.some((item) => start < item.suggestion.end && end > item.suggestion.start);

		for (const suggestion of parsed) {
			const start = base + suggestion.start;
			const end = base + suggestion.end;
			if (this.text.slice(start, end) !== suggestion.source) continue;
			if (overlap(start, end)) continue;
			this.items.push({
				preview: job.preview,
				suggestion: { ...suggestion, start, end },
			});
		}
		this.items.sort((a, b) => a.suggestion.start - b.suggestion.start);
		this.error = null;
		this.scannedAnything = true;
		this.markScanned(job);
	}
}
