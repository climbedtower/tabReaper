/**
 * Obsidian Local REST API wrapper.
 * HTTP mode (non-encrypted) on localhost to avoid self-signed cert issues in Chrome extensions.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:27123";

export const STORAGE_KEY_REST_TOKEN = "tabReaper_obsidianRestToken";
export const STORAGE_KEY_REST_URL = "tabReaper_obsidianRestUrl";

export interface ObsidianRestConfig {
  baseUrl: string;
  token: string;
}

export async function loadRestConfig(): Promise<ObsidianRestConfig | null> {
  const o = await chrome.storage.local.get([STORAGE_KEY_REST_TOKEN, STORAGE_KEY_REST_URL]);
  const token = (o[STORAGE_KEY_REST_TOKEN] || "").trim();
  if (!token) return null;
  const baseUrl = (o[STORAGE_KEY_REST_URL] || "").trim() || DEFAULT_BASE_URL;
  return { baseUrl, token };
}

function headers(token: string, contentType = "text/markdown"): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
  };
}

export async function healthCheck(cfg: ObsidianRestConfig): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.baseUrl}/`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** PUT /vault/{path} — create or overwrite a file */
export async function putVaultFile(
  cfg: ObsidianRestConfig,
  vaultPath: string,
  content: string,
  contentType = "text/markdown",
): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}/vault/${encodeVaultPath(vaultPath)}`, {
    method: "PUT",
    headers: headers(cfg.token, contentType),
    body: content,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PUT /vault/${vaultPath} failed: ${res.status} ${body}`);
  }
}

/** PUT /vault/{path} — create or overwrite a binary file (images, etc.) */
export async function putVaultBinary(
  cfg: ObsidianRestConfig,
  vaultPath: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}/vault/${encodeVaultPath(vaultPath)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": contentType,
    },
    body: data,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PUT /vault/${vaultPath} failed: ${res.status} ${body}`);
  }
}

/** POST /vault/{path} — append content to a file (creates if not exists) */
export async function appendVaultFile(
  cfg: ObsidianRestConfig,
  vaultPath: string,
  content: string,
): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}/vault/${encodeVaultPath(vaultPath)}`, {
    method: "POST",
    headers: headers(cfg.token),
    body: content,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /vault/${vaultPath} failed: ${res.status} ${body}`);
  }
}

/** GET /vault/{path} — read file content. Returns null if not found. */
export async function getVaultFile(
  cfg: ObsidianRestConfig,
  vaultPath: string,
): Promise<string | null> {
  const res = await fetch(`${cfg.baseUrl}/vault/${encodeVaultPath(vaultPath)}`, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "text/markdown" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /vault/${vaultPath} failed: ${res.status}`);
  return res.text();
}

function encodeVaultPath(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}
