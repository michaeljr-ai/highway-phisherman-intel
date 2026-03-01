import { promisify } from "node:util";
import { exec } from "node:child_process";

const execAsync = promisify(exec);

export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export async function runCommand(
  cmd: string,
  timeoutMs = 60_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  const shell = process.env.SHELL && process.env.SHELL.trim().length > 0 ? process.env.SHELL : "/bin/bash";
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      shell
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    const stderr =
      err.stderr && err.stderr.trim().length > 0 ? err.stderr : err.message ?? "Unknown command error";
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr
    };
  }
}
