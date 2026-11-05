/* 测试用的 obsidian 桩：只实现引擎真正用到的 requestUrl。 */
export async function requestUrl(): Promise<never> {
	throw new Error("network disabled in tests");
}

export function normalizePath(path: string): string {
	return path;
}

export default {};
