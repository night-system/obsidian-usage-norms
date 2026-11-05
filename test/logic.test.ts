/**
 * 纯逻辑自测（不需要 Obsidian、不联网）：
 *   npm test
 *
 * 覆盖三块：
 *   1. 切句（句号 / 换行 / 小数 / 日期 / Markdown 行首 / 收尾引号）
 *   2. 五字段解析闸门（sentence 定位、quote 在句内、重叠、删除类、条数上限）
 *   3. 侧栏状态机（开栏不整篇扫、句末送检、预览被整句覆盖、记账、换模式重扫、作废在飞请求）
 */
import * as assert from "node:assert";
import { parseSuggestions, buildSystemPrompt, buildUserMessage, Suggestion } from "../src/engine";
import { sentenceJustEnded, openSentence, splitSentences } from "../src/sentences";
import { AssistStore } from "../src/store";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed += 1;
			console.log(`  ok   ${name}`);
		})
		.catch((error) => {
			failed += 1;
			failures.push(`${name}\n       ${(error as Error).message}`);
			console.log(`  FAIL ${name}: ${(error as Error).message}`);
		});
}

const flush = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function texts(text: string): string[] {
	return splitSentences(text).map((span) => text.slice(span.start, span.end));
}

/** 一段真正的模型输出（五字段）。 */
function modelReply(items: unknown[]): string {
	return JSON.stringify({ suggestions: items });
}

// ------------------------------------------------------------------ 1. 切句

async function sentencesSuite(): Promise<void> {
	console.log("\n# 切句");

	await test("句号 / 感叹号 / 问号都断句", () => {
		assert.deepStrictEqual(texts("今天去了公园。明天去海边！为什么？"), [
			"今天去了公园。",
			"明天去海边！",
			"为什么？",
		]);
	});

	await test("小数和日期不切开", () => {
		assert.deepStrictEqual(texts("圆周率是3.14左右。日期是2026.11.04。"), [
			"圆周率是3.14左右。",
			"日期是2026.11.04。",
		]);
	});

	await test("英文句点后面跟空格才断句", () => {
		assert.deepStrictEqual(texts("Hello world. Next one."), ["Hello world.", "Next one."]);
	});

	await test("换行断句", () => {
		assert.deepStrictEqual(texts("第一行\n第二行"), ["第一行", "第二行"]);
	});

	await test("Markdown 行首标记不算进句子", () => {
		const text = "# 标题内容。\n- 列表项目。";
		const spans = splitSentences(text);
		assert.strictEqual(text.slice(spans[0].start, spans[0].end), "标题内容。");
		assert.strictEqual(text.slice(spans[1].start, spans[1].end), "列表项目。");
	});

	await test("收尾引号属于上一句", () => {
		assert.deepStrictEqual(texts("他说「走吧。」然后走了。"), ["他说「走吧。」", "然后走了。"]);
	});

	await test("光标停在句号后时返回刚结束的那一句", () => {
		const text = "第一句。第二句";
		const ended = sentenceJustEnded(text, 4);
		assert.ok(ended);
		assert.strictEqual(text.slice(ended!.start, ended!.end), "第一句。");
	});

	await test("光标在句中时返回这一句（含后面没写完的）", () => {
		const text = "第一句。第二句还没写完";
		const open = openSentence(text, 6);
		assert.strictEqual(text.slice(open.start, open.end), "第二句还没写完");
	});
}

// ------------------------------------------------------------------ 2. 解析闸门

async function parseSuite(): Promise<void> {
	console.log("\n# 五字段解析闸门");

	const text = "这个方案我觉得还是比较好的。他昨天去了公园。";

	await test("正常一条：定位到原文偏移", () => {
		const raw = modelReply([
			{
				sentence: "这个方案我觉得还是比较好的。",
				reason: "含糊",
				quote: "还是比较好的",
				kind: "替换",
				rewrite: "可行",
			},
		]);
		const out = parseSuggestions(raw, text, 5);
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].source, "还是比较好的");
		assert.strictEqual(text.slice(out[0].start, out[0].end), "还是比较好的");
		assert.strictEqual(out[0].kind, "replace");
		assert.strictEqual(out[0].reason, "含糊");
	});

	await test("sentence 不是原文 → 整条丢", () => {
		const raw = modelReply([
			{ sentence: "这个方案我觉得还行。", quote: "还行", kind: "替换", rewrite: "可行" },
		]);
		assert.deepStrictEqual(parseSuggestions(raw, text, 5), []);
	});

	await test("quote 不在这一句里 → 丢", () => {
		const raw = modelReply([
			{ sentence: "这个方案我觉得还是比较好的。", quote: "昨天", kind: "替换", rewrite: "可行" },
		]);
		assert.deepStrictEqual(parseSuggestions(raw, text, 5), []);
	});

	await test("rewrite 和 quote 一样 → 丢", () => {
		const raw = modelReply([
			{ sentence: "这个方案我觉得还是比较好的。", quote: "方案", kind: "替换", rewrite: "方案" },
		]);
		assert.deepStrictEqual(parseSuggestions(raw, text, 5), []);
	});

	await test("删除类就算写了 rewrite 也按空串处理", () => {
		const raw = modelReply([
			{ sentence: "这个方案我觉得还是比较好的。", quote: "我觉得", kind: "删除", rewrite: "不该写" },
		]);
		const out = parseSuggestions(raw, text, 5);
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].replacement, "");
	});

	await test("kind 漏了但 rewrite 是空串 → 按删除", () => {
		const raw = modelReply([
			{ sentence: "这个方案我觉得还是比较好的。", quote: "我觉得", rewrite: "" },
		]);
		const out = parseSuggestions(raw, text, 5);
		assert.strictEqual(out[0].kind, "delete");
	});

	await test("同一个 sentence 的两条（不同 quote）都收", () => {
		const raw = modelReply([
			{ sentence: "这个方案我觉得还是比较好的。", quote: "我觉得", kind: "删除", rewrite: "" },
			{ sentence: "这个方案我觉得还是比较好的。", quote: "还是比较好", kind: "替换", rewrite: "可行" },
		]);
		const out = parseSuggestions(raw, text, 5);
		assert.strictEqual(out.length, 2);
	});

	await test("互相重叠的条目丢后一条", () => {
		const raw = modelReply([
			{ sentence: "这个方案我觉得还是比较好的。", quote: "我觉得还是比较", kind: "替换", rewrite: "可行" },
			{ sentence: "这个方案我觉得还是比较好的。", quote: "比较好", kind: "替换", rewrite: "好" },
		]);
		assert.strictEqual(parseSuggestions(raw, text, 5).length, 1);
	});

	await test("条数上限按强度截断", () => {
		const raw = modelReply(
			Array.from({ length: 6 }, (_, i) => ({
				sentence: "这个方案我觉得还是比较好的。",
				quote: ["这", "个", "方", "案", "我", "觉"][i],
				kind: "替换",
				rewrite: "X",
			}))
		);
		assert.strictEqual(parseSuggestions(raw, text, 3).length, 3);
	});

	await test("```json 围栏也能解析", () => {
		const raw =
			"好的，结果如下：\n```json\n" +
			modelReply([{ sentence: "他昨天去了公园。", quote: "昨天", kind: "替换", rewrite: "前天" }]) +
			"\n```\n";
		const out = parseSuggestions(raw, text, 5);
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].source, "昨天");
	});

	await test("不是 JSON → 空数组，不抛异常", () => {
		assert.deepStrictEqual(parseSuggestions("今天天气不错", text, 5), []);
	});

	await test("system 提示词带契约 + 条数", () => {
		const prompt = buildSystemPrompt("把含糊的地方说清楚。", "low");
		assert.ok(prompt.startsWith("把含糊的地方说清楚。"));
		assert.ok(prompt.includes("只输出 JSON"));
		assert.ok(prompt.includes("最多给出 3 条建议"));
	});

	await test("user 消息是 JSON，context 单独放", () => {
		const message = JSON.parse(buildUserMessage("正文。", "前文。"));
		assert.strictEqual(message.text, "正文。");
		assert.strictEqual(message.context, "前文。");
	});
}

// ------------------------------------------------------------------ 3. 状态机

interface HostOptions {
	send?: (
		request: { text: string; context?: string }
	) => Suggestion[] | Promise<Suggestion[]>;
	previewDelayMs?: number;
}

function makeStore(options: HostOptions = {}) {
	const data: {
		templateFolder: string;
		templatePath: string;
		strength: string;
		showReason: boolean;
		apiKey: string;
		scans: Record<string, { mode: string; at: number; sentences: string[] }>;
	} = {
		templateFolder: "",
		templatePath: "模板/清晰.md",
		strength: "medium",
		showReason: false,
		apiKey: "sk-test",
		scans: {},
	};
	const template = { path: "模板/清晰.md", name: "清晰", text: "把含糊的地方说清楚。" };
	const requests: { text: string; context: string }[] = [];

	/** 默认假装模型把每个 chunk 的第一句最后两个字换成「改好」。 */
	const defaultSend = (request: { text: string; context?: string }): Suggestion[] => {
		const first = splitSentences(request.text)[0];
		if (!first) return [];
		const sentence = request.text.slice(first.start, first.end);
		const body = sentence.replace(/[。！？；\n]+$/, "");
		const quote = body.slice(-2);
		if (quote.length === 0) return [];
		const at = request.text.indexOf(quote, first.start);
		if (at < 0) return [];
		return [
			{
				start: at,
				end: at + quote.length,
				source: quote,
				replacement: "改好",
				kind: "replace",
				reason: "含糊",
			},
		];
	};

	const host = {
		data,
		template: () => template,
		notify: () => {},
		persist: () => {},
		previewDelayMs: options.previewDelayMs,
		send: async (request: { text: string; context?: string }) => {
			requests.push({ text: request.text, context: request.context ?? "" });
			return await (options.send ?? defaultSend)(request);
		},
	};

	const store = new AssistStore(host as never);
	return { store, data, requests, template };
}

async function storeSuite(): Promise<void> {
	console.log("\n# 侧栏状态机");

	await test("开栏不整篇扫：已有正文一条都不送", async () => {
		const { store, requests } = makeStore();
		const text = "已经写好的第一句。已经写好的第二句。";
		store.activate("a.md", text, text.length);
		store.onText(text, text.length);
		await flush();
		assert.strictEqual(requests.length, 0);
	});

	await test("句号落下就送这一句，前文只当 context", async () => {
		const { store, requests } = makeStore();
		const before = "已经写好的第一句。";
		store.activate("a.md", before, before.length);
		const text = `${before}今天天气很好。`;
		store.onText(text, text.length);
		await flush();
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].text, "今天天气很好。");
		assert.strictEqual(requests[0].context, before);
		assert.strictEqual(store.items.length, 1);
		assert.strictEqual(store.items[0].suggestion.start, before.length + 4);
		assert.strictEqual(text.slice(store.items[0].suggestion.start, store.items[0].suggestion.end), "很好");
	});

	await test("算过一句就记账，再改同一个字不再送", async () => {
		const { store, requests, data } = makeStore();
		store.activate("a.md", "", 0);
		const text = "今天天气很好。";
		store.onText(text, text.length);
		await flush();
		assert.strictEqual(requests.length, 1);
		assert.deepStrictEqual(data.scans["a.md"].sentences, ["今天天气很好。"]);

		// 在句号后补一个空格：光标仍算「停在句末」，但不该重复送同一句。
		store.onText(`${text} `, text.length + 1);
		await flush();
		assert.strictEqual(requests.length, 1);
	});

	await test("改开栏之前就存在的句子（句号在句内）也会送预览", async () => {
		const { store, requests } = makeStore({ previewDelayMs: 15 });
		const text = "这是开栏之前就写好的句子。";
		store.activate("p.md", text, text.length);
		// 在句子中间改一个字，光标停在句号前面（不在句末）
		const edited = "这是开栏之前就写坏的句子。";
		store.onText(edited, edited.length - 1);
		await flush(70);
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].text, edited);
	});

	await test("只是移动光标不发请求", async () => {
		const { store, requests } = makeStore({ previewDelayMs: 15 });
		store.activate("q.md", "已经写好的句子。", 8);
		store.onText("已经写好的句子。", 2);
		await flush(60);
		assert.strictEqual(requests.length, 0);
	});

	await test("整句送过之后，光标停在句号后面原地不动也不再送", async () => {
		const { store, requests } = makeStore({ previewDelayMs: 15 });
		store.activate("r.md", "", 0);
		const text = "今天天气很好。";
		store.onText(text, text.length);
		await flush();
		const before = requests.length;
		store.onText(text, text.length); // 没有改动
		await flush(60);
		assert.strictEqual(requests.length, before);
	});

	await test("✓ 把条目从列表拿掉并返回改动", async () => {
		const { store } = makeStore();
		store.activate("a.md", "", 0);
		store.onText("今天天气很好。", 7);
		await flush();
		assert.strictEqual(store.items.length, 1);
		const applied = store.accept(0);
		assert.ok(applied);
		assert.strictEqual(applied!.source, "很好");
		assert.strictEqual(applied!.replacement, "改好");
		assert.strictEqual(store.items.length, 0);
	});

	await test("× 只拿掉这一条，不改正文、不重新请求", async () => {
		const { store, requests } = makeStore();
		store.activate("a.md", "", 0);
		store.onText("今天天气很好。", 7);
		await flush();
		const count = requests.length;
		store.ignore(0);
		assert.strictEqual(store.items.length, 0);
		await flush();
		assert.strictEqual(requests.length, count);
	});

	await test("半句停手先出预览，句号到了被整句结果覆盖", async () => {
		const { store, requests } = makeStore({ previewDelayMs: 15 });
		store.activate("b.md", "", 0);
		store.onText("今天不太舒服", 6);
		await flush(60);
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].text, "今天不太舒服");
		assert.strictEqual(store.items.length, 1);
		assert.strictEqual(store.items[0].preview, true);

		store.onText("今天不太舒服。", 7);
		await flush(60);
		assert.strictEqual(requests.length, 2);
		assert.strictEqual(store.items.length, 1);
		assert.strictEqual(store.items[0].preview, false);
		assert.strictEqual(store.items[0].suggestion.start, 4);
	});

	await test("全文扫描：只送没扫过的句子，再点一次什么都不发", async () => {
		const { store, requests, data } = makeStore();
		const text = "第一句内容。第二句内容。第三句内容。";
		store.activate("c.md", text, text.length);
		store.scanAll();
		await flush(60);
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(data.scans["c.md"].sentences.length, 3);
		store.scanAll();
		await flush();
		assert.strictEqual(requests.length, 1);
	});

	await test("换强度 → 旧记录作废、按新标准重扫", async () => {
		const { store, requests, data } = makeStore();
		const text = "第一句内容。第二句内容。";
		store.activate("d.md", text, text.length);
		store.scanAll();
		await flush(60);
		assert.strictEqual(requests.length, 1);
		(data as { strength: string }).strength = "high";
		store.onModeChanged();
		await flush(80);
		assert.strictEqual(requests.length, 2);
		assert.strictEqual(data.scans["d.md"].sentences.length, 2);
	});

	await test("侧栏被收起再重建（iPad 键盘弹起）：建议还在，也不重新送检", async () => {
		const { store, requests } = makeStore();
		store.activate("g.md", "", 0);
		store.onText("今天天气很好。", 7);
		await flush();
		assert.strictEqual(store.items.length, 1);
		const before = requests.length;

		// Obsidian 收侧栏 / 重建视图：onClose → onOpen
		store.suspend();
		store.activate("g.md", "今天天气很好。", 7);

		assert.strictEqual(store.items.length, 1);
		assert.strictEqual(store.items[0].suggestion.source, "很好");
		assert.strictEqual(requests.length, before);
	});

	await test("换到另一篇笔记仍然清空", async () => {
		const { store } = makeStore();
		store.activate("h1.md", "", 0);
		store.onText("今天天气很好。", 7);
		await flush();
		assert.strictEqual(store.items.length, 1);
		store.activate("h2.md", "", 0);
		assert.strictEqual(store.items.length, 0);
	});

	await test("请求回来时原文已经变了 → 结果丢掉，不挂在错的位置", async () => {
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { store } = makeStore({
			send: async () => {
				await gate;
				return [
					{
						start: 5,
						end: 7,
						source: "很好",
						replacement: "改好",
						kind: "replace",
						reason: "",
					},
				];
			},
		});

		store.activate("e.md", "", 0);
		store.onText("今天天气很好。", 7);
		await flush(10);
		// 放开之前把这句删掉
		store.onText("", 0);
		release!();
		await flush(30);
		assert.strictEqual(store.items.length, 0);
	});

	await test("关面板后不再发请求", async () => {
		const { store, requests } = makeStore();
		store.activate("f.md", "", 0);
		store.deactivate();
		store.onText("今天天气很好。", 7);
		await flush();
		assert.strictEqual(requests.length, 0);
	});
}

// ------------------------------------------------------------------ 入口

(async () => {
	await sentencesSuite();
	await parseSuite();
	await storeSuite();
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		console.log("\n失败项：\n" + failures.join("\n"));
		process.exit(1);
	}
})();
