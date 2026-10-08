export type Cue = { start: number; end: number; text: string; speaker?: string };
export type Paragraph = { start: number; speaker?: string; text: string };
export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<RunResult>;
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export type Platform = "darwin" | "linux";

/** Ошибка, которую показываем пользователю как есть: одна строка с подсказкой. */
export class UserError extends Error {}
