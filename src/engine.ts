/**
 * 输出契约 + 解析闸门 + DeepSeek 请求（移植自参考实现 `assist_engine.dart`）。
 *
 * 这一层是「系统固定、用户改不到」的：用户只提供提示词模板正文，
 * 五字段契约、硬校验、条数上限都在这里。
 */

import { requestUrl } from "obsidian";

export type Strength = "low" | "medium" | "high";

export const STRENGTHS: Strength[] = ["low", "medium", "high"];

export const STRENGTH_LABEL: Record<Strength, string> = {
	low: "低",
	medium: "中",
	high: "高",
};

/** 一次最多接受的建议条数（模型有时多给，本地截断）。 */
export const STRENGTH_MAX: Record<Strength, number> = {
	low: 3,
	medium: 5,
	high: 8,
};

/** 响应的 `max_tokens`。中文一个字 ≈ 1 token，8 条短句 3000 足够。 */
export const STRENGTH_MAX_TOKENS: Record<Strength, number> = {
	low: 1200,
	medium: 2000,
	high: 3000,
};

export function isStrength(value: unknown): value is Strength {
	return value === "low" || value === "medium" || value === "high";
}

export type Kind = "delete" | "replace" | "complete";

export const KIND_LABEL: Record<Kind, string> = {
	delete: "删除",
	replace: "替换",
	complete: "补全",
};

/** 模型回给我们的 kind 可能是中文、英文、或者干脆漏了：一律宽容解析。 */
export function kindFrom(raw: unknown): Kind {
	const value = String(raw ?? "")
		.trim()
		.toLowerCase();
	switch (value) {
		case "删除":
		case "delete":
		case "remove":
		case "del":
			return "delete";
		case "补全":
		case "complete":
		case "completion":
		case "add":
			return "complete";
		default:
			return "replace";
	}
}

/** 一条建议。`start` / `end` 是**整篇正文**里的字符偏移。 */
export interface Suggestion {
	start: number;
	end: number;
	source: string;
	replacement: string;
	kind: Kind;
	/** 模型先写的那句「为什么改」（提示词要求 ≤10 字）。不参与任何校验。 */
	reason: string;
}

export function isDeletion(s: Suggestion): boolean {
	return s.replacement.length === 0;
}

/** 这条建议在侧栏里显示的一行字：删除类显示被删的原文，其余显示改后的文本。 */
export function rowText(s: Suggestion): string {
	return isDeletion(s) ? s.source : s.replacement;
}

/** 原文现在还是不是这条建议看的那一段（用户打字后就不能盲改了）。 */
export function fits(text: string, s: Suggestion): boolean {
	if (s.start < 0 || s.end > text.length || s.start > s.end) return false;
	return text.slice(s.start, s.end) === s.source;
}

/** DeepSeek 的接口地址与模型（用户只填密钥，别的都不填）。 */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODEL = "deepseek-chat";

/** 一次最多送给模型的正文字数（防洪上限，超了按句切块）。 */
export const MAX_CHARS = 3000;

/** 请求失败：`code` 给程序看，`message` 给界面看（侧栏里一行灰字）。 */
export class UsageNormsError extends Error {
	code: string;
	details?: string;

	constructor(code: string, message: string, details?: string) {
		super(message);
		this.name = "UsageNormsError";
		this.code = code;
		this.details = details;
	}
}

/**
 * 固定附加在用户模板后面的输出契约。用户改的是模板，改不到这一段。
 *
 * 字段（与参考实现一致）：
 * - `sentence`：要改的那一句，**定位用**——必须逐字命中送检正文，对不上整条丢；
 * - `reason`：这条为什么改，**10 个字以内**，**先于 `quote` 输出**，不参与校验；
 * - `quote`：`sentence` 里要被替换的短片段，**不限制长短**；
 * - `kind`：删除 / 替换 / 补全，决定正文画删除线还是虚线；
 * - `rewrite`：换成什么。界面只画 `quote`，点 ✓ 只替换 `quote`。
 */
export const FORMAT_RULES = `只输出 JSON，不要解释，不要 Markdown：
{"suggestions":[{"sentence":"要改的那一句（定位用，逐字原文）","reason":"太含糊","quote":"这一句里要被替换的短片段","kind":"删除|替换|补全","rewrite":"改后的文本"}]}

规则：
- sentence 是**定位用**的：必须是原文里逐字出现的一整句（含标点），不能改字、不能省略、不能改写；
- 每条都必须有 reason，而且**先写 reason、再写 quote**：reason 用**不超过 10 个字**说明这一条为什么要改（例如「太含糊」「重复」「语气生硬」）；不要写进 quote 或 rewrite；
- quote 是 sentence 里**要被替换的短错误片段**，必须逐字出现在 sentence 里；**不限制长短**；
- 每条只换掉 quote 这一段，sentence 里其他字一个都不动；
- 「删除」类的 rewrite 必须是空字符串 ""，其余类型的 rewrite 不能为空；
- 不要纠错别字、语法和标点，不做文学润色，不改事实；
- 条与条不要重叠，按原文出现顺序排；
- user 消息里的 context 是**前文语境（已经写过、不需要修改）**，只用来理解指代和语气；
  sentence / quote 只能逐字取自 text，不要引用或改写 context 里的内容；
- 没有值得改的地方就返回 {"suggestions":[]}。`;

/** 拼 system 消息：用户模板 + 固定格式契约 + 按强度限制条数。 */
export function buildSystemPrompt(template: string, strength: Strength): string {
	const body = template.trim();
	return `${body}\n\n${FORMAT_RULES}\n\n最多给出 ${STRENGTH_MAX[strength]} 条建议。`;
}

/**
 * 拼 user 消息：只带正文，避免模板里的措辞和正文混在一起。
 *
 * `context` 是这一段前面的正文（按句增量送检时才有）：模型只看不改。
 */
export function buildUserMessage(text: string, context = ""): string {
	const trimmed = context.trim();
	if (trimmed.length === 0) return JSON.stringify({ text });
	return JSON.stringify({ context, text });
}

/** 从模型返回的 content 里抠出 JSON 对象（去掉 ```json 围栏 / 前后废话）。 */
export function decodeJson(content: string): Record<string, unknown> | null {
	let raw = content.trim();
	raw = raw.replace(/^```(?:json)?\s*/i, "");
	raw = raw.replace(/\s*```$/, "");
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const value: unknown = JSON.parse(raw.slice(start, end + 1));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * 把模型给的 `{"suggestions":[…]}` 落到原文上。
 *
 * **硬校验**（不做任何容错回退）：
 * - `sentence` 必须在送检正文里**逐字**找到，找不到整条丢；
 * - `quote` 必须逐字出现在**这一句**里，否则丢；`quote` **不限长度**；
 * - 重叠 / 和原文一样 / 空 `quote` 的照样丢；
 * - 删除类 `rewrite` 必须是空串。
 */
export function parseSuggestions(content: string, text: string, max: number): Suggestion[] {
	const data = decodeJson(content);
	const raw = data?.suggestions;
	if (!Array.isArray(raw) || text.length === 0) return [];

	const picked: Suggestion[] = [];
	// 按原文顺序找句子；同一句的多条共用一次定位。
	let sentenceFrom = 0;
	let lastSentence: string | null = null;
	let lastSentenceStart = -1;

	const overlaps = (start: number, end: number): boolean => {
		for (const s of picked) {
			if (start < s.end && end > s.start) return true;
		}
		return false;
	};

	for (const item of raw) {
		if (picked.length >= max) break;
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;

		const rawSentence = record.sentence;
		if (typeof rawSentence !== "string" || rawSentence.trim().length === 0) continue;
		const sentence = rawSentence;
		let sentenceStart: number;
		if (lastSentence === sentence && lastSentenceStart >= 0) {
			sentenceStart = lastSentenceStart;
		} else {
			sentenceStart = text.indexOf(sentence, sentenceFrom);
			if (sentenceStart < 0) continue; // 硬校验：定位不到就整条丢
			sentenceFrom = sentenceStart + sentence.length;
			lastSentence = sentence;
			lastSentenceStart = sentenceStart;
		}

		const rawQuote = record.quote;
		if (typeof rawQuote !== "string" || rawQuote.length === 0) continue;
		const quote = rawQuote;
		let at = sentence.indexOf(quote);
		if (at < 0) continue; // 硬校验：quote 必须是 sentence 里的原文
		// 同一句里可能有重复的短片段：跳过已经被别的条目占住的那一段。
		while (at >= 0 && overlaps(sentenceStart + at, sentenceStart + at + quote.length)) {
			at = sentence.indexOf(quote, at + 1);
		}
		if (at < 0) continue;
		const start = sentenceStart + at;
		const end = start + quote.length;

		let kind = kindFrom(record.kind);
		const rawRewrite = record.rewrite;
		let replacement = typeof rawRewrite === "string" ? rawRewrite : "";
		if (kind === "delete") {
			replacement = "";
		} else if (replacement.trim().length === 0) {
			// 模型把「删除」写成了空 rewrite 但 kind 漏了：按删除处理。
			kind = "delete";
			replacement = "";
		}
		// 空替换 = 删除；和原文一字不差的条目没有意义。
		if (replacement === quote) continue;

		const rawReason = record.reason;
		picked.push({
			start,
			end,
			source: quote,
			replacement,
			kind,
			reason: typeof rawReason === "string" ? rawReason.trim() : "",
		});
	}

	picked.sort((a, b) => a.start - b.start);
	return picked;
}

export interface SuggestRequest {
	apiKey: string;
	template: string;
	text: string;
	strength: Strength;
	context?: string;
	baseUrl?: string;
	model?: string;
	/** 之后外部可能取消：调用方在 await 回来后再判断，这里只负责发完。 */
	isCancelled?: () => boolean;
}

interface ChatResponse {
	choices?: Array<{ message?: { content?: string } }>;
}

/**
 * 真正调 DeepSeek。
 *
 * 用 Obsidian 的 `requestUrl` 而不是 `fetch`：它绕开 CORS，桌面 / 手机都能用。
 * DeepSeek 的 content-type 不带 charset，`requestUrl` 的 `text` 已经按 UTF-8 解好。
 */
export async function requestSuggestions(req: SuggestRequest): Promise<Suggestion[]> {
	const apiKey = req.apiKey.trim();
	if (apiKey.length === 0) throw new UsageNormsError("no-key", "没有填写 DeepSeek 密钥");
	if (req.text.trim().length === 0) return [];

	const body = {
		model: req.model ?? DEEPSEEK_MODEL,
		messages: [
			{ role: "system", content: buildSystemPrompt(req.template, req.strength) },
			{ role: "user", content: buildUserMessage(req.text, req.context ?? "") },
		],
		temperature: 0.2,
		max_tokens: STRENGTH_MAX_TOKENS[req.strength],
		stream: false,
	};

	let response;
	try {
		response = await requestUrl({
			url: `${(req.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "")}/chat/completions`,
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			throw: false,
		});
	} catch (error) {
		throw new UsageNormsError("network", "连不上 DeepSeek", String(error));
	}

	const raw = response.text ?? "";
	if (response.status !== 200) throw httpError(response.status, raw);

	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		throw new UsageNormsError("bad-json", "返回不是 JSON", raw);
	}
	const data = (decoded ?? {}) as ChatResponse;
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new UsageNormsError("no-content", "返回里没有内容", raw);
	}
	return parseSuggestions(content, req.text, STRENGTH_MAX[req.strength]);
}

function httpError(status: number, body: string): UsageNormsError {
	let message: string;
	if (status === 401) message = "密钥无效";
	else if (status === 402) message = "余额不足";
	else if (status === 429) message = "请求太频繁";
	else if (status >= 500) message = "DeepSeek 服务出错";
	else message = `HTTP ${status}`;
	return new UsageNormsError(`http-${status}`, message, body);
}
