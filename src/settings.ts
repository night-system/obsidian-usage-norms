import {
	App,
	FuzzySuggestModal,
	Notice,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	setIcon,
} from "obsidian";
import { STRENGTHS, STRENGTH_LABEL, STRENGTH_MAX, Strength, isStrength } from "./engine";
import type UsageNormsPlugin from "./main";
import { createTemplateFile } from "./templates";

export interface ScanRecord {
	/** 扫描模式指纹（模板路径 + 模板正文 + 强度）。模式一变旧记录作废。 */
	mode: string;
	/** 最后一次写记录的时间，用来裁剪太老的页面。 */
	at: number;
	/** 已经送检成功、不需要再送的句子原文。 */
	sentences: string[];
}

export interface UsageNormsData {
	/** 模板文件夹（仓库相对路径，空串 = 仓库根目录）。 */
	templateFolder: string;
	/** 当前默认模板（文件路径）。 */
	templatePath: string;
	strength: Strength;
	/** 侧栏每条建议下面要不要多显示一行模型写的 reason。不影响请求、不重扫。 */
	showReason: boolean;
	apiKey: string;
	/** 按笔记路径存的「已经算过的句子」。 */
	scans: Record<string, ScanRecord>;
}

export const DEFAULT_DATA: UsageNormsData = {
	templateFolder: "",
	templatePath: "",
	strength: "medium",
	showReason: false,
	apiKey: "",
	scans: {},
};

/** 容错读取：坏字段回默认，坏记录丢掉，不让一次手滑把插件打不开。 */
export function normalizeData(raw: unknown): UsageNormsData {
	const data: UsageNormsData = { ...DEFAULT_DATA, scans: {} };
	if (!raw || typeof raw !== "object") return data;
	const record = raw as Record<string, unknown>;
	if (typeof record.templateFolder === "string") data.templateFolder = record.templateFolder;
	if (typeof record.templatePath === "string") data.templatePath = record.templatePath;
	if (isStrength(record.strength)) data.strength = record.strength;
	data.showReason = record.showReason === true;
	if (typeof record.apiKey === "string") data.apiKey = record.apiKey;
	const scans = record.scans;
	if (scans && typeof scans === "object" && !Array.isArray(scans)) {
		for (const [page, value] of Object.entries(scans as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			const item = value as Record<string, unknown>;
			const sentences = Array.isArray(item.sentences)
				? item.sentences.filter((s): s is string => typeof s === "string")
				: [];
			data.scans[page] = {
				mode: typeof item.mode === "string" ? item.mode : "",
				at: typeof item.at === "number" ? item.at : 0,
				sentences,
			};
		}
	}
	return data;
}

/** 选择模板文件夹：列出库里全部文件夹。 */
export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private onPick: (folder: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		super.onOpen();
		this.setPlaceholder("选择放提示词模板的文件夹…");
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		for (const file of this.app.vault.getAllLoadedFiles()) {
			if (file instanceof TFolder) folders.push(file);
		}
		folders.sort((a, b) => a.path.localeCompare(b.path, "zh"));
		return folders;
	}

	getItemText(folder: TFolder): string {
		return folder.path === "/" ? "（仓库根目录）" : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		// 根目录用 "/" 当哨兵：和「还没选」的空串区分开。
		this.onPick(folder.path === "/" ? "/" : folder.path);
	}
}

/** 「用语规范」的设置页：模板文件夹 / 模板列表 / 思考强度 / reason / 密钥。 */
export class UsageNormsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: UsageNormsPlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("usage-norms-settings");

		const data = this.plugin.data;
		const templates = this.plugin.library.list();
		const folderLabel =
			data.templateFolder === "/"
				? "（仓库根目录）"
				: data.templateFolder.length > 0
					? data.templateFolder
					: "（还没选）";

		// ---------------------------------------------------------- 模板文件夹
		containerEl.createEl("h3", { text: "提示词模板文件夹" });
		new Setting(containerEl)
			.setName("模板文件夹")
			.setDesc(
				`文件夹里的每个 .md / .txt 文件就是一个模板：文件名是模板名，文件内容是提示词正文。当前：${folderLabel}`
			)
			.addButton((button) =>
				button.setButtonText("选择文件夹").onClick(() => {
					new FolderPickerModal(this.app, async (folder) => {
						await this.plugin.setTemplateFolder(folder);
						this.rerender();
					}).open();
				})
			)
			.addExtraButton((button) =>
				button
					.setIcon("refresh-cw")
					.setTooltip("重新读取模板文件")
					.onClick(async () => {
						await this.plugin.reloadTemplates();
						this.rerender();
					})
			);

		if (data.templateFolder.length === 0) {
			containerEl.createDiv({
				cls: "usage-norms-warn",
				text: "还没有选模板文件夹。选一个只放提示词文件的文件夹（不要选笔记根目录，否则所有笔记都会被当成模板）。",
			});
		} else if (!this.plugin.library.folderExists()) {
			containerEl.createDiv({
				cls: "usage-norms-warn",
				text: `文件夹「${data.templateFolder}」不在这个库里了，重新选一个。`,
			});
		}

		// ------------------------------------------------------------ 模板列表
		const listHeader = new Setting(containerEl)
			.setName(`模板  ${templates.length} 个`)
			.setDesc("点一行设为默认模板。模板正文直接在文件里改，改完自动重扫。");
		listHeader.addExtraButton((button) =>
			button
				.setIcon("plus")
				.setTooltip("在模板文件夹里新建一个模板文件")
				.onClick(async () => {
					if (data.templateFolder.length === 0) {
						new Notice("先选一个模板文件夹");
						return;
					}
					const file = await createTemplateFile(
						this.app,
						data.templateFolder,
						"清晰",
						"把含糊、绕口的地方改成清楚、具体的说法，保持原意，不添加新信息。\n"
					);
					if (!file) {
						new Notice("新建模板失败：检查模板文件夹是否存在");
						return;
					}
					await this.plugin.reloadTemplates();
					await this.plugin.setTemplate(file.path);
					await this.app.workspace.getLeaf(false).openFile(file);
					this.rerender();
				})
		);

		if (templates.length === 0) {
			containerEl.createDiv({
				cls: "usage-norms-warn",
				text: "这个文件夹里还没有可用的模板。放一个 .md 文件进去，或者点右上角 + 新建一个。",
			});
		} else {
			const listEl = containerEl.createDiv({ cls: "usage-norms-tpl-list" });
			const selectedPath = this.plugin.selectedTemplate()?.path ?? "";
			for (const template of templates) {
				this.renderTemplateRow(listEl, template.path, template.name, template.text, selectedPath);
			}
			containerEl.createDiv({
				cls: "usage-norms-hint",
				text: "模板只写「怎么改」；正文和输出格式由插件单独加，不用写占位符。",
			});
		}

		// ------------------------------------------------------------ 思考强度
		containerEl.createEl("h3", { text: "思考强度" });
		const strengthSetting = new Setting(containerEl)
			.setName("一次最多几条")
			.setDesc(
				`低 ${STRENGTH_MAX.low} 条 / 中 ${STRENGTH_MAX.medium} 条 / 高 ${STRENGTH_MAX.high} 条；强度变了会按新标准重扫。`
			);
		const seg = strengthSetting.controlEl.createDiv({ cls: "usage-norms-seg" });
		for (const level of STRENGTHS) {
			const button = seg.createEl("button", { cls: "usage-norms-seg-btn", text: STRENGTH_LABEL[level] });
			if (level === data.strength) button.addClass("is-active");
			button.addEventListener("click", async () => {
				await this.plugin.setStrength(level);
				this.rerender();
			});
		}

		// ----------------------------------------------------------- 显示 reason
		new Setting(containerEl)
			.setName("显示 reason")
			.setDesc("每条建议下面多一行：模型为什么这么改（它写的是 10 个字以内的短理由）。只影响显示，不重新请求。")
			.addToggle((toggle) =>
				toggle.setValue(data.showReason).onChange(async (value) => {
					await this.plugin.setShowReason(value);
					this.rerender();
				})
			);

		// --------------------------------------------------------------- 密钥
		containerEl.createEl("h3", { text: "DeepSeek 密钥" });
		const keySetting = new Setting(containerEl)
			.setName("API 密钥")
			.setDesc("只存在本库的插件数据里（明文），不会上传到别处。换密钥不会重扫。");
		keySetting.addText((text) => {
			text.inputEl.type = "password";
			text.inputEl.addClass("usage-norms-key-input");
			text.setPlaceholder("sk-…").setValue(data.apiKey).onChange(async (value) => {
				await this.plugin.setApiKey(value.trim());
			});
		});
		keySetting.addButton((button) =>
			button.setButtonText("测试").onClick(async () => {
				button.setDisabled(true);
				button.setButtonText("测试中…");
				const result = await this.plugin.testKey();
				new Notice(result.ok ? "连接正常" : `连接失败：${result.message}`);
				button.setDisabled(false);
				button.setButtonText("测试");
			})
		);
		if (data.apiKey.trim().length > 0) {
			keySetting.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip("清除密钥")
					.onClick(async () => {
						await this.plugin.setApiKey("");
						this.rerender();
					})
			);
		}

		// ----------------------------------------------------------- 扫描记录
		containerEl.createEl("h3", { text: "扫描记录" });
		const pageKey = this.plugin.store.fileKey;
		const pageSentences = pageKey ? data.scans[pageKey]?.sentences.length ?? 0 : 0;
		new Setting(containerEl)
			.setName("已扫记录")
			.setDesc(
				`按笔记存「哪些句子在这个模板 + 强度下已经算过」，同一段不会重复花钱。当前笔记：${pageSentences} 句；全库：${
					Object.keys(data.scans).length
				} 页。`
			)
			.addButton((button) =>
				button.setButtonText("清空本页").onClick(async () => {
					await this.plugin.clearScanRecord(pageKey);
					new Notice("已清空当前笔记的扫描记录");
					this.rerender();
				})
			)
			.addButton((button) =>
				button.setButtonText("清空全部").onClick(async () => {
					await this.plugin.clearScanRecord("");
					new Notice("已清空全部扫描记录");
					this.rerender();
				})
			);

		// --------------------------------------------------------------- 说明
		const about = containerEl.createDiv({ cls: "usage-norms-about" });
		about.createDiv({
			text: "面板在左侧边栏。工具条上的图标可以打开 / 关闭它；命令面板里也有「用语规范：打开侧栏」。",
		});
		about.createDiv({
			text: "设置只保存在本机的插件数据里（data.json，含密钥明文），不进 git、不上传。",
		});
		about.createDiv({
			text: "改模板名 = 新建一个文件；改模板正文 = 直接用任意编辑器改那个文件，保存后会自动重扫。",
		});
	}

	private renderTemplateRow(
		parent: HTMLElement,
		path: string,
		name: string,
		text: string,
		selectedPath: string
	): void {
		const row = parent.createDiv({ cls: "usage-norms-tpl-row" });
		if (path === selectedPath) row.addClass("is-selected");

		const radio = row.createEl("input", { cls: "usage-norms-tpl-radio" });
		radio.type = "radio";
		radio.name = "usage-norms-template";
		radio.checked = path === selectedPath;
		radio.addEventListener("click", async (event) => {
			event.stopPropagation();
			await this.plugin.setTemplate(path);
			this.rerender();
		});

		const body = row.createDiv({ cls: "usage-norms-tpl-body" });
		body.addEventListener("click", async () => {
			await this.plugin.setTemplate(path);
			this.rerender();
		});
		body.createDiv({ cls: "usage-norms-tpl-name", text: name });
		body.createDiv({ cls: "usage-norms-tpl-desc", text: text.replace(/\s+/g, " ").slice(0, 120) });

		const open = row.createEl("button", { cls: "usage-norms-tpl-open" });
		setIcon(open, "pencil");
		open.setAttribute("aria-label", "打开这个模板文件");
		open.addEventListener("click", async (event) => {
			event.stopPropagation();
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
			else new Notice("模板文件不见了");
		});
	}

	/** 重画设置页并保持滚动位置（不然点一下选项就跳回顶部）。 */
	private rerender(): void {
		const scroller = this.containerEl.closest(".vertical-tab-content-container") as HTMLElement | null;
		const top = scroller ? scroller.scrollTop : 0;
		this.display();
		if (scroller) scroller.scrollTop = top;
	}
}
