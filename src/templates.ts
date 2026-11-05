import { App, TFile, TFolder } from "obsidian";

/**
 * 模板库：把「某个文件夹里的文件」当成模板。
 *
 * 和参考实现（模板存在 `assist.json` 里、可在 App 内编辑）不同：这里模板就是
 * 仓库里的普通文件 —— **文件名 = 模板名，文件内容 = 提示词正文**。这样模板
 * 可以用 Obsidian 自己编辑、可以进 git、可以同步。
 */
export interface PromptTemplate {
	path: string;
	name: string;
	text: string;
}

/** 去掉开头的 YAML frontmatter（模板文件里写说明用，不进提示词）。 */
export function stripFrontmatter(raw: string): string {
	const text = raw.replace(/^\uFEFF/, "");
	if (!text.startsWith("---")) return text.trim();
	const end = text.indexOf("\n---", 3);
	if (end < 0) return text.trim();
	let body = text.slice(end + 4);
	if (body.startsWith("\r\n")) body = body.slice(2);
	else if (body.startsWith("\n")) body = body.slice(1);
	return body.trim();
}

function normalizeFolder(path: string): string {
	return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export class TemplateLibrary {
	/** 模板文件夹（仓库相对路径；空串 = 仓库根目录）。 */
	folder = "";

	private cache = new Map<string, { mtime: number; text: string }>();

	constructor(private app: App) {}

	/** 传 "/" 表示仓库根目录。 */
	setFolder(folder: string): void {
		this.folder = folder === "/" ? "" : normalizeFolder(folder);
	}

	/** 文件夹里直接放着的 .md / .txt 文件（不进子文件夹）。 */
	files(): TFile[] {
		const want = this.folder;
		const out: TFile[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (!/\.(md|txt)$/i.test(file.path)) continue;
			const parent = normalizeFolder(file.parent ? file.parent.path : "/");
			if (parent !== want) continue;
			out.push(file);
		}
		out.sort((a, b) => a.basename.localeCompare(b.basename, "zh"));
		return out;
	}

	/** 文件夹存在吗（不存在时设置页要提示）。 */
	folderExists(): boolean {
		if (this.folder === "") return true;
		return this.app.vault.getAbstractFileByPath(this.folder) instanceof TFolder;
	}

	/** 把文件内容读进缓存；只读 mtime 变过的那些。 */
	async refresh(): Promise<void> {
		const files = this.files();
		const alive = new Set(files.map((f) => f.path));
		for (const path of Array.from(this.cache.keys())) {
			if (!alive.has(path)) this.cache.delete(path);
		}
		for (const file of files) {
			const cached = this.cache.get(file.path);
			if (cached && cached.mtime === file.stat.mtime) continue;
			try {
				const raw = await this.app.vault.cachedRead(file);
				this.cache.set(file.path, { mtime: file.stat.mtime, text: stripFrontmatter(raw) });
			} catch (error) {
				console.error("[usage-norms] 读模板失败", file.path, error);
			}
		}
	}

	/** 当前可用的模板（内容为空的不算，避免误选一个空文件）。 */
	list(): PromptTemplate[] {
		const out: PromptTemplate[] = [];
		for (const file of this.files()) {
			const cached = this.cache.get(file.path);
			const text = cached?.text ?? "";
			if (text.trim().length === 0) continue;
			out.push({ path: file.path, name: file.basename, text });
		}
		return out;
	}

	find(path: string): PromptTemplate | undefined {
		return this.list().find((t) => t.path === path);
	}

	/** 文件被改 / 被删后，下一次 `list()` 之前先丢掉缓存。 */
	invalidate(path?: string): void {
		if (path) this.cache.delete(path);
		else this.cache.clear();
	}
}

/** 在模板文件夹里新建一个模板文件（默认给一段能直接用的提示词）。 */
export async function createTemplateFile(
	app: App,
	folder: string,
	name: string,
	content: string
): Promise<TFile | null> {
	const dir = folder === "/" ? "" : normalizeFolder(folder);
	for (let i = 1; i <= 50; i += 1) {
		const suffix = i === 1 ? "" : ` ${i}`;
		const path = dir.length > 0 ? `${dir}/${name}${suffix}.md` : `${name}${suffix}.md`;
		if (app.vault.getAbstractFileByPath(path)) continue;
		try {
			return await app.vault.create(path, content);
		} catch (error) {
			console.error("[usage-norms] 新建模板失败", path, error);
			return null;
		}
	}
	return null;
}
