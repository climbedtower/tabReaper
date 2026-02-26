/**
 * tabReaper popup - URL要約は @pipelines/url-summary 経由。担当AIは ai-roles の worker。
 * ファイル保存は Obsidian Local REST API 経由。
 */

import {
  fetchViaJina,
  generateSummaryJson,
  parseSummaryJson,
  getShortTitleForFilename,
  generateShortTitle,
  normalizeUrlForDedup,
} from "@pipelines/url-summary";
import {
  requireModelForRole,
  getApiKeyForProvider,
  type APIKeySettings,
  type AIProvider,
} from "ai-roles";
import { callAI } from "call-ai";
import { logger } from "@pipelines/vault-logger";
import { normalize, type ChatMessage } from "@pipelines/normalizer";
import { process as runTaskReaperProcess } from "@pipelines/task-reaper";
import {
  loadRestConfig,
  healthCheck,
  putVaultFile,
  putVaultBinary,
  appendVaultFile,
  type ObsidianRestConfig,
} from "./obsidian-rest";

const VAULT_CLIP_DIR = "library/clip";
const VAULT_REFERENCE_DIR = "library/reference";
const VAULT_RAW_DIR = "memory/raw_content";
const RAW_CONTENT_PATH_PREFIX = "memory/raw_content";
const VAULT_IMAGE_DIR = "memory/raw_content/img";
const SHORT_TITLE_MAX_LEN = 60;
const WINDOW_LABEL_MAX_LEN = 40;

const TWITTER_HOST_RE = /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)(\/|$)/i;
const YOUTUBE_HOST_RE = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)(\/|$)/i;

type SourceType = "web" | "x" | "youtube" | "paper" | "blog";
type ChatService = "chatgpt" | "claude" | "gemini";

function detectSourceType(url: string): SourceType {
  if (TWITTER_HOST_RE.test(url)) return "x";
  if (YOUTUBE_HOST_RE.test(url)) return "youtube";
  if (/\.pdf(\?|#|$)/i.test(url)) return "paper";
  return "web";
}

function isTwitterUrl(url: string): boolean {
  try {
    return TWITTER_HOST_RE.test(url || "");
  } catch {
    return false;
  }
}

function detectChatService(url: string): ChatService | null {
  const u = (url || "").toLowerCase();
  if (u.includes("chatgpt.com") || u.includes("chat.openai.com")) return "chatgpt";
  if (u.includes("claude.ai")) return "claude";
  if (u.includes("gemini.google.com")) return "gemini";
  return null;
}

/**
 * ページコンテキストで実行する。本ツイート＋同一作者のスレッド続きのみを連結して返す。
 * executeScript に渡すため自己完結した関数にすること。
 */
function extractTwitterThreadInPage(): string {
  const sel = 'article[data-testid="tweet"]';
  const articles = document.querySelectorAll(sel);
  if (!articles.length) return "";

  const getAuthor = (art: Element): string => {
    const link = art.querySelector('a[href^="/"]');
    if (!link) return "";
    const href = (link.getAttribute("href") || "").trim();
    if (href.includes("/status/")) return "";
    return href.replace(/^\/|\/$/g, "").toLowerCase();
  };

  const getText = (art: Element): string => {
    const el = art.querySelector('[data-testid="tweetText"]');
    return el ? (el.textContent || "").trim() : "";
  };

  const main = articles[0];
  const author = getAuthor(main);
  const parts: string[] = [getText(main)];

  if (!author) return parts[0] || "";

  for (let i = 1; i < articles.length; i++) {
    const art = articles[i];
    if (getAuthor(art) !== author) continue;
    const text = getText(art);
    if (text) parts.push(text);
  }

  return parts.join("\n\n---\n\n");
}

/**
 * ページコンテキストで実行。main / article / body の順で本文を抽出しプレーンテキストで返す。
 * executeScript に渡すため自己完結した関数にすること。
 */
function extractBodyTextInPage(): string {
  const main = document.querySelector("main");
  const article = document.querySelector("article");
  const el = main ?? article ?? document.body;
  if (!el) return "";
  return (el as HTMLElement).innerText?.trim() ?? "";
}

/**
 * ページコンテキストで実行。本文コンテナのテキストと、その中の a タグを Obsidian リンク [title](href) で返す。
 * title は a の title 属性、なければテキスト、なければ href。
 * （executeScript で注入するため、この関数内で完結させる。他関数を参照しないこと。）
 */
function extractBodyTextAndLinksInPage(): { bodyText: string; links: string[] } {
  const main = document.querySelector("main");
  const article = document.querySelector("article");
  const contentRoot = main ?? article ?? document.body;
  const bodyText = contentRoot ? ((contentRoot as HTMLElement).innerText?.trim() ?? "") : "";
  if (!contentRoot) return { bodyText: "", links: [] };
  const excludeSelector =
    "nav, header, footer, aside, [id*='ad'], [class*='ad-'], [class*='banner'], [class*='sponsored'], " +
    ".ad-container, .social-share, .share-buttons, .menu, .navbar, .sidebar, #sidebar";
  const anchors = Array.from(contentRoot.querySelectorAll<HTMLAnchorElement>('a[href^="http"]'));
  const filtered = anchors.filter((a) => !a.closest(excludeSelector));
  const seen = new Set<string>();
  const links: string[] = [];
  for (const a of filtered) {
    const href = a.href.trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const rawTitle =
      (a.getAttribute("title") ?? "").trim() ||
      (a.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 200) ||
      href;
    const label = rawTitle.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
    links.push("[" + label + "](" + href + ")");
    if (links.length >= 30) break;
  }
  return { bodyText, links };
}

/**
 * ページコンテキストで実行。ページ内の主要な画像・動画サムネイルURLを抽出して返す。
 * Twitter/X: ツイート添付画像 + 動画poster
 * YouTube: ページ or 埋め込みのサムネイル
 * 一般サイト: 記事本文内の画像 + video poster + YouTube埋め込みサムネ
 * executeScript に渡すため自己完結した関数にすること。
 */
function extractPageImagesInPage(): { src: string; alt: string; videoUrl?: string }[] {
  const host = location.hostname.toLowerCase();
  const isTwitter = host.includes("twitter.com") || host.includes("x.com");
  const isYouTube = host.includes("youtube.com") || host.includes("youtu.be");

  if (isYouTube) {
    const match = location.href.match(/[?&]v=([^&#]+)/);
    if (!match) return [];
    const videoId = match[1];
    return [{
      src: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      alt: document.title || "YouTube動画",
      videoUrl: location.href,
    }];
  }

  if (isTwitter) {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (articles.length === 0) return [];
    const statusId = location.pathname.match(/\/status\/(\d+)/)?.[1] ?? null;
    const targetArticle = statusId
      ? articles.find((art) => art.querySelector(`a[href*="/status/${statusId}"]`)) ?? articles[0]
      : articles[0];
    const permalink =
      (targetArticle.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null)?.href || location.href;
    const seen = new Set<string>();
    const result: { src: string; alt: string; videoUrl?: string }[] = [];
    let hasUncapturedVideo = false;

    const allImgs = targetArticle.querySelectorAll("img");
    for (const img of allImgs) {
      const el = img as HTMLImageElement;
      let src = el.src;
      if (!src || src.startsWith("data:") || src.startsWith("blob:")) continue;
      if (!src.includes("pbs.twimg.com")) continue;
      if (src.includes("/profile_images/")) continue;
      if (el.naturalWidth > 0 && el.naturalWidth < 64) continue;
      if (el.naturalHeight > 0 && el.naturalHeight < 64) continue;
      if (src.includes("name=")) src = src.replace(/name=\w+/, "name=large");
      if (seen.has(src)) continue;
      seen.add(src);
      result.push({ src, alt: el.alt || "" });
    }

    const videoEls = targetArticle.querySelectorAll("video");
    for (const v of videoEls) {
      const el = v as HTMLVideoElement;
      let captured = false;
      if (el.readyState >= 2 && el.videoWidth > 0) {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = el.videoWidth;
          canvas.height = el.videoHeight;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(el, 0, 0);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
            if (dataUrl && dataUrl.length > 1000) {
              result.push({ src: dataUrl, alt: "動画スクショ", videoUrl: permalink });
              captured = true;
            }
          }
        } catch { /* CORS tainted canvas */ }
      }
      if (!captured) {
        const poster = el.poster;
        if (poster && !poster.startsWith("data:") && !seen.has(poster)) {
          let src = poster;
          if (src.includes("name=")) src = src.replace(/name=\w+/, "name=large");
          seen.add(src);
          result.push({ src, alt: "動画サムネイル", videoUrl: permalink });
          captured = true;
        }
      }
      if (!captured) hasUncapturedVideo = true;
    }

    if (hasUncapturedVideo) {
      const ogImg = document.querySelector('meta[property="og:image"]');
      const ogSrc = ogImg?.getAttribute("content");
      if (ogSrc && !seen.has(ogSrc)) {
        seen.add(ogSrc);
        result.push({ src: ogSrc, alt: "動画サムネイル", videoUrl: permalink });
      }
    }

    return result.slice(0, 10);
  }

  const main = document.querySelector("main");
  const article = document.querySelector("article");
  const contentRoot = main ?? article ?? document.body;
  if (!contentRoot) return [];

  const excludeSel =
    "nav, header, footer, aside, [class*='sidebar'], [class*='menu'], [class*='ad-'], [class*='banner']";
  const seen = new Set<string>();
  const result: { src: string; alt: string; videoUrl?: string }[] = [];

  const imgs = contentRoot.querySelectorAll("img");
  for (const img of imgs) {
    const el = img as HTMLImageElement;
    if (!el.src || el.src.startsWith("data:")) continue;
    if (el.closest(excludeSel)) continue;
    if (el.naturalWidth > 0 && el.naturalWidth < 80) continue;
    if (el.naturalHeight > 0 && el.naturalHeight < 80) continue;
    const src = el.src;
    if (seen.has(src)) continue;
    seen.add(src);
    result.push({ src, alt: el.alt || "" });
  }

  const ytIframes = contentRoot.querySelectorAll('iframe[src*="youtube.com/embed"]');
  for (const iframe of ytIframes) {
    const iframeSrc = (iframe as HTMLIFrameElement).src;
    const m = iframeSrc.match(/youtube\.com\/embed\/([^?&#]+)/);
    if (!m) continue;
    const thumbUrl = `https://img.youtube.com/vi/${m[1]}/maxresdefault.jpg`;
    if (seen.has(thumbUrl)) continue;
    seen.add(thumbUrl);
    result.push({ src: thumbUrl, alt: "YouTube動画", videoUrl: `https://www.youtube.com/watch?v=${m[1]}` });
  }

  const videos = contentRoot.querySelectorAll("video");
  for (const v of videos) {
    const el = v as HTMLVideoElement;
    if (el.closest(excludeSel)) continue;
    let captured = false;
    if (el.readyState >= 2 && el.videoWidth > 0) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = el.videoWidth;
        canvas.height = el.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(el, 0, 0);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          if (dataUrl && dataUrl.length > 1000) {
            const videoSrc = el.src || el.querySelector("source")?.src || "";
            result.push({ src: dataUrl, alt: "動画スクショ", videoUrl: videoSrc || undefined });
            captured = true;
          }
        }
      } catch { /* CORS tainted canvas */ }
    }
    if (!captured) {
      const poster = el.poster;
      if (poster && !poster.startsWith("data:") && !seen.has(poster)) {
        seen.add(poster);
        const videoSrc = el.src || el.querySelector("source")?.src || "";
        result.push({ src: poster, alt: "動画サムネイル", videoUrl: videoSrc || undefined });
      }
    }
  }

  return result.slice(0, 10);
}

/** ページコンテキストで実行。webchat から同期的にテキストを取得（待機・スクロールなし）。
 *  Gemini: main.innerText が仮想スクロールで空になる場合、document.body.innerText へフォールバック。
 *  DOM セレクタ方式はバックグラウンドタブでレンダリングされないため使用不可（E｜20260224 参照）。
 *  ターン分離・ノイズ除去は normalizer 側で実施。 */
function extractWebchatInPage(): { service: string; rawText: string } {
  const host = location.hostname.toLowerCase();
  let service = "unknown";
  if (host.includes("chatgpt.com") || host.includes("chat.openai.com")) service = "chatgpt";
  else if (host.includes("claude.ai")) service = "claude";
  else if (host.includes("gemini.google.com")) service = "gemini";
  const main = document.querySelector("main");
  const article = document.querySelector("article");
  const el = main ?? article ?? document.body;
  let rawText = (el as HTMLElement | null)?.innerText?.trim() ?? "";

  if (service === "gemini" && rawText.length < 200) {
    const bodyText = document.body.innerText?.trim() ?? "";
    if (bodyText.length > rawText.length) rawText = bodyText;
  }

  return { service, rawText };
}

/** Content Script 注入不可または Discarded の場合は true */
function isTabUninjectable(url: string, discarded: boolean): boolean {
  if (discarded) return true;
  if (!url || !url.startsWith("http")) return true;
  if (/^https?:\/\/chrome\.google\.com\/webstore\//i.test(url)) return true;
  return false;
}

/** 指定タブからページ内の画像・動画サムネURLを抽出 */
async function fetchTabImages(
  tabId: number,
  url: string,
  discarded: boolean,
): Promise<{ src: string; alt: string; videoUrl?: string }[]> {
  if (isTabUninjectable(url, discarded)) return [];
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageImagesInPage,
    });
    return (result?.[0]?.result as { src: string; alt: string; videoUrl?: string }[]) ?? [];
  } catch {
    return [];
  }
}

/** 画像URLからバイナリをダウンロード。失敗や巨大ファイルは null */
async function downloadImage(
  imageUrl: string,
): Promise<{ data: ArrayBuffer; contentType: string; ext: string } | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (ct.includes("svg")) return null;
    const data = await res.arrayBuffer();
    if (data.byteLength > 5 * 1024 * 1024 || data.byteLength < 100) return null;
    let ext = "jpg";
    if (ct.includes("png")) ext = "png";
    else if (ct.includes("gif")) ext = "gif";
    else if (ct.includes("webp")) ext = "webp";
    return { data, contentType: ct, ext };
  } catch {
    return null;
  }
}

/** 要約mdの末尾に画像・動画サムネセクションを追記 */
function appendImagesSectionToMd(
  md: string,
  images: { filename: string; alt: string; videoUrl?: string }[],
): string {
  if (images.length === 0) return md;
  const lines: string[] = [];
  for (const img of images) {
    lines.push(`![[${img.filename}]]`);
    if (img.videoUrl) {
      lines.push(`[動画リンク](${img.videoUrl})`);
    }
  }
  return `${md.trimEnd()}\n\n## 画像\n${lines.join("\n")}\n`;
}

/** ページで選択中のテキストを返す（executeScript 用・単体で注入される） */
function getSelectionInPage(): string {
  return (typeof window.getSelection !== "function" ? "" : window.getSelection()?.toString() ?? "").trim();
}

/** 指定タブで選択中のテキストを取得。取得不可・未選択なら null */
async function getSelectedTextInTab(tabId: number, url: string, discarded: boolean): Promise<string | null> {
  if (isTabUninjectable(url, discarded)) return null;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: getSelectionInPage,
    });
    const s = result?.[0]?.result;
    return typeof s === "string" && s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

/** 選択タブの本文を Content Script で取得。取得不可なら null */
async function fetchTabBodyText(tabId: number, url: string, discarded: boolean): Promise<string | null> {
  if (isTabUninjectable(url, discarded)) return null;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractBodyTextInPage,
    });
    const raw = result?.[0]?.result;
    if (typeof raw !== "string" || !raw.trim()) return null;
    return raw.trim();
  } catch {
    return null;
  }
}

/**
 * Discarded タブをバックグラウンドでリロードし、読み込み完了を待つ。2-0 用。
 * アクティブにしないのでポップアップが閉じない。最大 30 秒で打ち切り。
 */
async function ensureTabLoadedForBody(tabId: number): Promise<void> {
  await chrome.tabs.reload(tabId);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
    const listener = (
      id: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (id !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** 選択タブの本文と本文コンテナ内リンクを一度に取得 */
async function fetchTabBodyAndLinks(
  tabId: number,
  url: string,
  discarded: boolean
): Promise<{ bodyText: string | null; links: string[] }> {
  if (isTabUninjectable(url, discarded)) return { bodyText: null, links: [] };
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractBodyTextAndLinksInPage,
    });
    const data = result?.[0]?.result as { bodyText?: string; links?: string[] } | undefined;
    const bodyText = data?.bodyText != null && String(data.bodyText).trim() ? String(data.bodyText).trim() : null;
    const links = Array.isArray(data?.links) ? (data.links as string[]) : [];
    return { bodyText, links };
  } catch {
    return { bodyText: null, links: [] };
  }
}

async function fetchChatContent(
  tabId: number,
  url: string,
  discarded: boolean
): Promise<{ service: string; messages: ChatMessage[]; raw_text: string }> {
  if (isTabUninjectable(url, discarded)) {
    return { service: "unknown", messages: [], raw_text: "" };
  }
  try {
    const extraction = chrome.scripting.executeScript({
      target: { tabId },
      func: extractWebchatInPage,
    });
    const timed = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("chat extraction timeout")), 5000)
    );
    const result = (await Promise.race([extraction, timed])) as chrome.scripting.InjectionResult[];
    const data = result?.[0]?.result as { service?: string; rawText?: string } | undefined;
    const normalized = normalize({
      mode: "chat",
      rawText: data?.rawText ?? "",
      metadata: { service: data?.service ?? "unknown" },
    });
    return {
      service: (normalized.metadata.service as string) ?? "unknown",
      messages: normalized.messages,
      raw_text: normalized.raw_text,
    };
  } catch {
    return { service: "unknown", messages: [], raw_text: "" };
  }
}

function isChatCaptureFailed(chat: {
  service: string;
  messages: ChatMessage[];
  raw_text: string;
}): { failed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const rawChars = (chat.raw_text || "").trim().length;
  if (rawChars < 80) reasons.push("short_raw_text");
  if ((chat.messages?.length ?? 0) === 0) reasons.push("zero_turns");
  return { failed: reasons.length > 0, reasons };
}

function buildChatCaptureFailedSummaryMd(opts: {
  tab: TabInfo;
  windowLabel: string;
  rawChatPath: string;
  chat: { service: string; messages: ChatMessage[]; raw_text: string };
  reasons: string[];
}): string {
  const rawPath = opts.tab.rawContentPathForSummary ?? "（未設定）";
  const hasRaw = rawPath !== "（未設定）";
  const extraction = {
    domTurns: 0,
    turns: opts.chat.messages.length,
    rawChars: (opts.chat.raw_text || "").length,
    partial: true,
    warnings: [...opts.reasons, "capture_failed"],
  };
  const fm = buildChatReferenceFrontmatter({
    url: opts.tab.url,
    rawContentPath: rawPath,
    rawChatPath: opts.rawChatPath,
    windowLabel: opts.windowLabel,
    hasRaw,
    service: opts.tab.chatService ?? opts.chat.service ?? "unknown",
    extraction,
  });
  return `${fm}

## 要点
- chat捕獲に失敗したため、distillを停止しました。
- raw_chat を確認して再実行してください。
- 理由: ${opts.reasons.join(", ")}

## 要約
会話の抽出品質が基準未満（capture_failed）だったため、誤要約を防ぐ目的で distill を実行していません。

## 教訓・示唆
- Gemini UI 変更や未描画状態で会話本文が取得できないことがある
- partial 保存だけでは見落としやすいため、明示失敗として扱う

## レイヤー判定
capture_failed

### tags
[[distill]] [[chat]] [[capture_failed]]

---
url: ${opts.tab.url}
raw_content: ${rawPath}
raw_chat: ${opts.rawChatPath}
created_at: ${new Date().toISOString()}
raw_pagetitle: ${(opts.tab.title || "").trim() || "（無題）"}
linked_from: tabReaper
---

## 会話
${opts.chat.raw_text.slice(0, 20000)}
`;
}

/** タイトルから装飾・サイト名を除去して内容のみ返す（" - Site" / " | Site" 等の後ろを落とす） */
function contentOnlyTitle(title: string | null): string {
  if (!title || !title.trim()) return "";
  const t = title.trim();
  const first = t
    .split(/\s*[-–—|]\s*|\s+\|\s+/)[0]
    ?.trim()
    .replace(/^\s*[·・]\s*|\s*[·・]\s*$/g, "")
    .trim();
  if (!first) return "";
  if (/^(無題|Untitled|untitled)$/i.test(first)) return "";
  return first.slice(0, WINDOW_LABEL_MAX_LEN);
}

const STORAGE_KEYS = {
  apiKeyGemini: "tabReaper_apiKeyGemini",
  apiKeyOpenAI: "tabReaper_apiKeyOpenAI",
  apiKeyClaude: "tabReaper_apiKeyClaude",
} as const;

interface TabInfo {
  id: number;
  title: string | null;
  url: string;
  content?: string | null;
  discarded?: boolean;
  summaryFilename?: string;
  summaryContent?: string;
  summaryVaultDir?: string;
  rawFilename?: string;
  rawContent?: string;
  chatRawFilename?: string;
  chatRawContent?: string;
  /** 1-0 本文取得で設定。要約 md の raw_content に書くパス */
  rawContentPathForSummary?: string;
  /** 本文中に言及された URL（要点リスト末尾に追記用） */
  extractedUrls?: string[];
  uid8?: string;
  baseForFilename?: string;
  chatService?: ChatService;
  pageImageUrls?: { src: string; alt: string; videoUrl?: string }[];
  capturedImages?: { filename: string; alt: string; videoUrl?: string }[];
}

let allWindows: { id: number; tabs: TabInfo[]; label: string; labelFromSelection?: boolean; captureImages?: boolean }[] = [];
const selectedTabs = new Set<number>();

const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const tabListEl = document.getElementById("tabList") as HTMLDivElement;
const openOptionsEl = document.getElementById("openOptions") as HTMLAnchorElement;

saveBtn.addEventListener("click", saveSelectedTabs);
openOptionsEl.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
fetchCurrentWindowTabs();

async function buildWindowData(
  win: chrome.windows.Window,
  winIndex: number
): Promise<{ id: number; tabs: TabInfo[]; suggestedLabel: string }> {
  const windowData = { id: win.id!, tabs: [] as TabInfo[] };
  const tabs = win.tabs || [];
  for (const tab of tabs) {
    let content: string | null = null;
    if (tab.url?.startsWith("http") && !tab.discarded) {
      try {
        const injection = await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          func: () => document.body?.innerText?.substring(0, 200) ?? "",
        });
        if (injection?.[0]?.result != null) content = String(injection[0].result);
      } catch {
        content = null;
      }
    }
    windowData.tabs.push({
      id: tab.id!,
      title: tab.title ?? null,
      url: tab.url || "",
      content,
      discarded: tab.discarded,
      chatService: detectChatService(tab.url || "") ?? undefined,
    });
  }
  const activeTab = tabs.find((t) => (t as chrome.tabs.Tab).active) ?? tabs[0];
  const firstTitle = tabs[0]?.title ?? null;
  const suggested =
    contentOnlyTitle(activeTab?.title ?? null) ||
    contentOnlyTitle(firstTitle) ||
    `ウィンドウ ${winIndex + 1}`;
  return { ...windowData, suggestedLabel: suggested };
}

async function fetchCurrentWindowTabs() {
  showStatus("取得中...", "info");
  tabListEl.innerHTML = "";
  selectedTabs.clear();
  saveBtn.disabled = true;
  try {
    const win = await chrome.windows.getCurrent({ populate: true });
    if (!win?.tabs?.length) {
      showStatus("ウィンドウ情報を取得できませんでした", "error");
      return;
    }
    const activeTab = win.tabs?.find((t) => (t as chrome.tabs.Tab).active) ?? win.tabs?.[0];
    let initialLabelFromSelection: string | null = null;
    if (activeTab?.id != null && activeTab.url && !activeTab.discarded) {
      const selected = await getSelectedTextInTab(activeTab.id, activeTab.url, !!activeTab.discarded);
      if (selected && selected.length > 0) {
        initialLabelFromSelection = selected.replace(/\s+/g, " ").slice(0, 80);
      }
    }
    const data = await buildWindowData(win, 0);
    const labelFromSelection = initialLabelFromSelection != null;
    const initialLabel = initialLabelFromSelection ?? data.suggestedLabel ?? "ウィンドウ 1";
    allWindows = [{ id: data.id, tabs: data.tabs, label: initialLabel, labelFromSelection }];
    // 画像以外はすべてチェック済みで表示（画像は未チェックのまま）
    for (const w of allWindows) {
      for (const t of w.tabs) selectedTabs.add(t.id);
    }
    await refineAllWindowsLabelsOnFetch();
    renderTabList();
    updateCopyButton();
    showStatus(`現在のウィンドウ（${allWindows[0].tabs.length}タブ）`, "success");
  } catch (error) {
    showStatus(`エラー: ${(error as Error).message}`, "error");
  }
}

function renderTabList() {
  tabListEl.innerHTML = "";
  allWindows.forEach((win, winIndex) => {
    const windowGroup = document.createElement("div");
    windowGroup.className = "window-group";

    const windowHeader = document.createElement("div");
    windowHeader.className = "window-header";
    const windowCheckbox = document.createElement("input");
    windowCheckbox.type = "checkbox";
    windowCheckbox.id = `window-${winIndex}`;
    windowCheckbox.checked = win.tabs.some((t) => selectedTabs.has(t.id));
    windowCheckbox.addEventListener("change", (e) => {
      toggleWindow(winIndex, (e.target as HTMLInputElement).checked);
    });
    const labelSpan = document.createElement("span");
    labelSpan.className = "window-label-editable";
    labelSpan.contentEditable = "true";
    labelSpan.textContent = win.label;
    labelSpan.title = "クリックして編集。Enterで確定";
    labelSpan.addEventListener("blur", () => {
      const next = (labelSpan.textContent || "").trim();
      if (next) allWindows[winIndex].label = next;
    });
    labelSpan.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        labelSpan.blur();
      }
    });
    labelSpan.addEventListener("click", (e) => e.stopPropagation());
    const tabCountSpan = document.createElement("span");
    tabCountSpan.className = "window-tab-count";
    tabCountSpan.textContent = ` (${win.tabs.length}タブ)`;
    const imgToggle = document.createElement("label");
    imgToggle.className = "img-capture-toggle";
    imgToggle.addEventListener("click", (e) => e.stopPropagation());
    const imgCheckbox = document.createElement("input");
    imgCheckbox.type = "checkbox";
    imgCheckbox.checked = win.captureImages ?? false;
    imgCheckbox.addEventListener("change", (e) => {
      allWindows[winIndex].captureImages = (e.target as HTMLInputElement).checked;
      imgToggle.classList.toggle("active", (e.target as HTMLInputElement).checked);
    });
    const imgLabelText = document.createElement("span");
    imgLabelText.textContent = "画像";
    imgToggle.appendChild(imgCheckbox);
    imgToggle.appendChild(imgLabelText);

    windowHeader.appendChild(windowCheckbox);
    windowHeader.appendChild(labelSpan);
    windowHeader.appendChild(tabCountSpan);
    windowHeader.appendChild(imgToggle);
    windowGroup.appendChild(windowHeader);

    win.tabs.forEach((tab) => {
      const tabItem = document.createElement("div");
      tabItem.className = "tab-item";
      const tabCheckbox = document.createElement("input");
      tabCheckbox.type = "checkbox";
      tabCheckbox.id = `tab-${tab.id}`;
      tabCheckbox.checked = selectedTabs.has(tab.id);
      tabCheckbox.addEventListener("change", (e) => {
        toggleTab(tab.id, (e.target as HTMLInputElement).checked);
      });
      const tabInfo = document.createElement("div");
      tabInfo.className = "tab-info";
      const tabTitle = document.createElement("div");
      tabTitle.className = "tab-title";
      tabTitle.textContent = tab.title || "（無題）";
      const tabUrl = document.createElement("div");
      tabUrl.className = "tab-url";
      tabUrl.textContent = tab.url;
      tabInfo.appendChild(tabTitle);
      tabInfo.appendChild(tabUrl);
      if (tab.content) {
        const tabContent = document.createElement("div");
        tabContent.className = "tab-content";
        tabContent.textContent = tab.content;
        tabInfo.appendChild(tabContent);
      }
      tabItem.appendChild(tabCheckbox);
      tabItem.appendChild(tabInfo);
      windowGroup.appendChild(tabItem);
    });
    tabListEl.appendChild(windowGroup);
  });
}

function toggleWindow(winIndex: number, checked: boolean) {
  const win = allWindows[winIndex];
  win.tabs.forEach((tab) => {
    if (checked) selectedTabs.add(tab.id);
    else selectedTabs.delete(tab.id);
    const checkbox = document.getElementById(`tab-${tab.id}`) as HTMLInputElement | null;
    if (checkbox) checkbox.checked = checked;
  });
  syncWindowCheckboxes();
  updateCopyButton();
}

function syncWindowCheckboxes() {
  allWindows.forEach((win, winIndex) => {
    const cb = document.getElementById(`window-${winIndex}`) as HTMLInputElement | null;
    if (cb) cb.checked = win.tabs.some((t) => selectedTabs.has(t.id));
  });
}

function toggleTab(tabId: number, checked: boolean) {
  if (checked) selectedTabs.add(tabId);
  else selectedTabs.delete(tabId);
  syncWindowCheckboxes();
  updateCopyButton();
}

function updateCopyButton() {
  saveBtn.disabled = selectedTabs.size === 0;
}

function uid8(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  } catch {
    return Date.now().toString(36).slice(-8);
  }
}

/** Obsidian リンク文字列 "[...](url)" から href を取得 */
function hrefFromObsidianLink(obsidianLink: string): string | null {
  const m = obsidianLink.match(/\]\((https?:\S+)\)$/);
  return m ? m[1] : null;
}

/** 本文テキストから http(s) URL を抽出（重複除く・最大20件） */
function extractUrlsFromText(text: string): string[] {
  if (!text?.trim()) return [];
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  const found = text.match(re) ?? [];
  const normalized = found.map((u) => u.replace(/[.,;:!?)]+$/, ""));
  return [...new Set(normalized)].slice(0, 20);
}

/** 要約 md の「## 要点」リスト末尾に本文中の URL を追記（コードで囲まない） */
function appendUrlsToPointsSection(md: string, urls: string[]): string {
  if (urls.length === 0) return md;
  const pointsHeading = "## 要点\n";
  const idx = md.indexOf(pointsHeading);
  if (idx === -1) return md;
  const afterPoints = idx + pointsHeading.length;
  const nextSection = md.indexOf("\n\n## ", afterPoints);
  const insertAt = nextSection !== -1 ? nextSection : md.length;
  const lines = urls.map((u) => "- " + u).join("\n");
  return md.slice(0, insertAt) + "\n" + lines + md.slice(insertAt);
}

function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildClipFrontmatter(opts: {
  url: string;
  rawContentPath: string;
  windowLabel: string;
  hasRaw: boolean;
}): string {
  const sourceType = detectSourceType(opts.url);
  const rawPolicy = opts.hasRaw ? "stored" : "url_only";
  return [
    "---",
    `source_type: ${sourceType}`,
    `pipeline: summary`,
    `raw_policy: ${rawPolicy}`,
    `date: ${todayDate()}`,
    `window: ${opts.windowLabel}`,
    `url: ${opts.url}`,
    `raw_content: ${opts.rawContentPath}`,
    `linked_from: tabReaper`,
    "---",
  ].join("\n");
}

function buildPlaceholderSummaryMd(tab: TabInfo, rawContentPath?: string, windowLabel?: string): string {
  const rawLine = rawContentPath ?? "（未設定）";
  const fm = buildClipFrontmatter({
    url: tab.url,
    rawContentPath: rawLine,
    windowLabel: windowLabel ?? "",
    hasRaw: rawContentPath != null && rawContentPath !== "（未設定）",
  });
  const pointLines =
    (tab.extractedUrls?.length ?? 0) > 0
      ? "- （要約は未取得）\n" + tab.extractedUrls!.map((u) => "- " + u).join("\n")
      : "- （要約は未取得）";
  return `${fm}

## 要点
${pointLines}

## 要約
（未取得）

### tags
（未設定）
`;
}

/** タブからファイル名用の短いベース名を取得（要約・raw で共通） */
function getBaseForTab(tab: TabInfo): string {
  return (tab.title || "untitled")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SHORT_TITLE_MAX_LEN) || "untitled";
}

function addPlaceholderFilenames(
  byWindow: { windowIndex: number; windowLabel: string; tabs: TabInfo[] }[]
) {
  byWindow.forEach((w) => {
    w.tabs.forEach((tab) => {
      const uid = tab.uid8 ?? uid8();
      const base = tab.baseForFilename ?? getBaseForTab(tab);
      if (!tab.uid8) tab.uid8 = uid;
      if (!tab.baseForFilename) tab.baseForFilename = base;
      const prefix = tab.chatService ? "c-" : detectSourceType(tab.url ?? "") === "x" ? "p-x-" : "p-";
      tab.summaryFilename = `${prefix}${base}_${uid}.md`;
      tab.summaryContent = buildPlaceholderSummaryMd(tab, tab.rawContentPathForSummary, w.windowLabel);
      tab.summaryVaultDir = tab.chatService ? VAULT_REFERENCE_DIR : VAULT_CLIP_DIR;
    });
  });
}

/** memory/raw_content 形式の .md 本文を組み立て（ROOM/memory/raw_content を参考） */
function buildRawContentMd(
  bodyText: string,
  url: string,
  createdAt: string
): string {
  const normalized = normalizeUrlForDedup(url);
  const chars = (bodyText || "").length;
  const front = [
    "---",
    "kind: raw_content",
    `created_at: ${createdAt}`,
    `updated_at: ${createdAt}`,
    "source: jina",
    `url: "${url.replace(/"/g, '\\"')}"`,
    `normalized_url: "${normalized.replace(/"/g, '\\"')}"`,
    `chars: ${chars}`,
    "---",
    "",
  ].join("\n");
  return front + (bodyText || "");
}

function formatChatTurns(messages: ChatMessage[]): string {
  if (messages.length === 0) return "";
  return messages.map((m) => `### ${m.speaker}\n${m.text}`).join("\n\n");
}

function buildChatDistillSource(messages: ChatMessage[], rawText: string): string {
  if (messages.length === 0) return rawText;
  const full = messages.map((m) => `${m.speaker}:\n${m.text}`).join("\n\n");
  const tailCount = Math.min(10, messages.length);
  const tail = messages
    .slice(-tailCount)
    .map((m) => `${m.speaker}:\n${m.text}`)
    .join("\n\n");
  return [
    "【要約方針】会話全体を要約しつつ、後半（最新側）の論点・結論を重視すること。",
    "",
    "【全体会話】",
    full,
    "",
    "【後半重点（最新）】",
    tail,
  ].join("\n");
}

function normalizeSentence(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function splitJapaneseSentences(text: string): string[] {
  const normalized = normalizeSentence(text);
  if (!normalized) return [];
  const parts = normalized
    .split(/(?<=[。！？!?])/)
    .map((p) => normalizeSentence(p))
    .filter(Boolean);
  return parts.length > 0 ? parts : [normalized];
}

function pickGlobalThreePoints(summary: string, details: string[]): string[] {
  const sentences = splitJapaneseSentences(summary);
  if (sentences.length >= 3) {
    const mid = Math.floor((sentences.length - 1) / 2);
    return [sentences[0], sentences[mid], sentences[sentences.length - 1]].map(normalizeSentence);
  }
  if (sentences.length === 2) {
    const fallback = details.find((d) => normalizeSentence(d).length > 0) ?? "";
    return [sentences[0], sentences[1], fallback || sentences[1]].map(normalizeSentence);
  }
  if (sentences.length === 1) {
    const clauses = sentences[0]
      .split(/、|，|;|；/g)
      .map((c) => normalizeSentence(c))
      .filter(Boolean);
    if (clauses.length >= 3) {
      const mid = Math.floor((clauses.length - 1) / 2);
      return [clauses[0], clauses[mid], clauses[clauses.length - 1]];
    }
    const topDetails = details
      .map((d) => normalizeSentence(d))
      .filter(Boolean)
      .slice(0, 2);
    return [sentences[0], ...topDetails].slice(0, 3);
  }
  const ds = details.map((d) => normalizeSentence(d)).filter(Boolean).slice(0, 3);
  return ds.length > 0 ? ds : ["（distill未取得）"];
}

function buildTaskReaperApiKeys(provider: AIProvider, apiKey: string): APIKeySettings {
  const keys: APIKeySettings = {};
  if (provider === "gemini") keys.geminiApiKey = apiKey;
  if (provider === "openai") keys.openaiApiKey = apiKey;
  if (provider === "claude") keys.claudeApiKey = apiKey;
  return keys;
}

type ChatDistillJson = {
  short_title: string;
  points: string[];
  summary: string;
  lessons: string[];
  longSummary: string;
  topic_solutions: string[];
  tags: string;
};

function parseChatDistillJson(raw: string): ChatDistillJson {
  const t = (raw || "").trim();
  const codeBlock = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const jsonText = (codeBlock ? codeBlock[1] : t).trim();
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  return {
    short_title: String(parsed.short_title || ""),
    points: Array.isArray(parsed.points) ? parsed.points.map(String).filter(Boolean) : [],
    summary: String(parsed.summary || ""),
    lessons: Array.isArray(parsed.lessons) ? parsed.lessons.map(String).filter(Boolean) : [],
    longSummary: String(parsed.longSummary || ""),
    topic_solutions: Array.isArray(parsed.topic_solutions)
      ? parsed.topic_solutions.map(String).filter(Boolean)
      : [],
    tags: String(parsed.tags || ""),
  };
}

function buildChatDistillPrompt(): string {
  return `あなたは会話ログ要約の実行器です。入力された会話を読み、JSONのみを返してください。

## 出力形式（JSONのみ）
\`\`\`json
{
  "short_title": "ファイル名用の短いタイトル（20文字以内・日本語）",
  "points": ["要点1", "要点2", "..."],
  "summary": "要約（3〜6文）",
  "lessons": ["教訓1", "教訓2", "..."],
  "longSummary": "詳細要約（十分なボリューム。重要論点を広くカバー）",
  "topic_solutions": ["話題A → 解決法A", "話題B → 解決法B", "..."],
  "tags": "タグ1, タグ2, タグ3"
}
\`\`\`

## ルール
- 会話全体を対象にしつつ、後半（最新側）の論点・結論を重視する
- 捏造禁止。本文にないことは書かない
- すべて日本語で出力
- points は **ちょうど3項目**（不足時も3項目に要約して出す）
- lessons は 3〜8 項目
- topic_solutions は必要なだけ列挙する（上限なし）。「話題 → 解決法」の構造で書く
- 長文でも論点を落とさず、抽象化しすぎない
- 余計な説明文は付けず JSON のみ返す`;
}

function buildChatRawContentMd(
  rawText: string,
  url: string,
  service: string,
  createdAt: string
): string {
  const normalized = normalizeUrlForDedup(url);
  const body = rawText ?? "";
  const chars = body.length;
  const front = [
    "---",
    "kind: raw_chat",
    `created_at: ${createdAt}`,
    `updated_at: ${createdAt}`,
    "source: tabReaper",
    `service: ${service}`,
    `url: "${url.replace(/"/g, '\\"')}"`,
    `normalized_url: "${normalized.replace(/"/g, '\\"')}"`,
    `chars: ${chars}`,
    "---",
    "",
  ].join("\n");
  return front + body;
}

function buildChatReferenceFrontmatter(opts: {
  url: string;
  rawContentPath: string;
  rawChatPath: string;
  windowLabel: string;
  hasRaw: boolean;
  service: string;
  extraction: { domTurns: number; turns: number; rawChars: number; partial: boolean; warnings: string[] };
}): string {
  const rawPolicy = opts.hasRaw ? "stored" : "url_only";
  return [
    "---",
    "source_type: chat",
    "pipeline: distill",
    `raw_policy: ${rawPolicy}`,
    `date: ${todayDate()}`,
    `service: ${opts.service}`,
    `window: ${opts.windowLabel}`,
    `url: ${opts.url}`,
    `raw_content: ${opts.rawContentPath}`,
    `raw_chat: ${opts.rawChatPath}`,
    "linked_from: tabReaper",
    `extraction_dom_turns: ${opts.extraction.domTurns}`,
    `extraction_turns: ${opts.extraction.turns}`,
    `extraction_raw_chars: ${opts.extraction.rawChars}`,
    `extraction_partial: ${opts.extraction.partial}`,
    `extraction_warnings: ${JSON.stringify(opts.extraction.warnings)}`,
    "---",
  ].join("\n");
}

/** Twitter/X のときはタブでスレッド（本ツイート＋本人続き）を取得。失敗時は null */
async function fetchTwitterThreadText(tabId: number): Promise<string | null> {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractTwitterThreadInPage,
    });
    const raw = result?.[0]?.result;
    if (typeof raw !== "string" || !raw.trim()) return null;
    return raw.trim();
  } catch {
    return null;
  }
}

async function runUrlSummaryForTab(
  tab: TabInfo,
  apiKey: string,
  provider: AIProvider,
  modelId: string,
  windowLabel: string,
): Promise<{ summaryFilename: string; summaryContent: string; outputDir: string }> {
  const uid = tab.uid8 ?? uid8();
  const created = new Date().toISOString();
  let text: string;
  if (isTwitterUrl(tab.url)) {
    const threadText = await fetchTwitterThreadText(tab.id);
    text = (threadText && threadText.length > 0 ? threadText : null) ?? (await fetchViaJina(tab.url, 15000));
  } else {
    text = await fetchViaJina(tab.url, 15000);
  }
  const rawPath = tab.rawContentPathForSummary ?? "（未設定）";
  const hasRaw = rawPath !== "（未設定）";
  const sourceType = detectSourceType(tab.url ?? "");
  const st: "web" | "x" | "youtube" | "paper" | "chat" = sourceType === "blog" ? "web" : sourceType;

  try {
    const raw = await generateSummaryJson({
      fetchedText: text,
      sourceUrl: tab.url,
      apiKey,
      provider,
      model: modelId,
      timeout: 90000,
    });
    const json = parseSummaryJson(raw);
    const shortTitle =
      getShortTitleForFilename(json.short_title) || generateShortTitle({ rawTitle: tab.title || "", url: tab.url });
    const claim = (json.claim ?? "").trim() || undefined;
    const structure = json.structure ?? [...(json.three_point ?? []), ...(json.how_to ?? [])].filter(Boolean);
    const summary = (json.shortSummary ?? json.summary ?? "").trim();
    const tags = (json.tags ?? "").trim();
    const out = logger({
      mode: "clip",
      sourceType: st,
      pipeline: "summary",
      rawPolicy: hasRaw ? "stored" : "url_only",
      date: todayDate(),
      window: windowLabel,
      url: tab.url ?? "",
      rawContentPath: rawPath,
      shortTitle,
      uid8: uid,
      claim,
      structure,
      summary,
      tags,
      extractedUrls: tab.extractedUrls,
    });
    return { summaryFilename: out.filename, summaryContent: out.content, outputDir: out.outputDir };
  } catch {
    const clipPrefix = st === "x" ? "p-x-" : "p-";
    const summaryFilename = `${clipPrefix}untitled_${uid}.md`;
    const summaryContent = buildPlaceholderSummaryMd(tab, tab.rawContentPathForSummary, windowLabel);
    return {
      summaryFilename,
      summaryContent,
      outputDir: VAULT_CLIP_DIR,
    };
  }
}

async function runChatDistillForTab(
  tab: TabInfo,
  apiKey: string,
  provider: AIProvider,
  modelId: string,
  windowLabel: string,
  chatContent: { messages: ChatMessage[]; raw_text: string },
  rawChatPath: string
): Promise<{ summaryFilename: string; summaryContent: string; outputDir: string }> {
  const uid = tab.uid8 ?? uid8();
  const messages = chatContent.messages;
  const conversationMd =
    messages.length > 0 ? formatChatTurns(messages) : chatContent.raw_text.slice(0, 50000);
  const distillSource = buildChatDistillSource(messages, chatContent.raw_text);
  const turnsCount = messages.length;
  const rawChars = (chatContent.raw_text || "").length;
  const userCount = messages.filter((m) => m.speaker === "user").length;
  const asstCount = messages.filter((m) => m.speaker === "assistant").length;
  const warnings: string[] = [];
  if (turnsCount < 4) warnings.push("low_turn_count");
  if (rawChars < 80) warnings.push("short_raw_text");
  if (Math.max(userCount, asstCount) >= 3 * Math.max(Math.min(userCount, asstCount), 1)) warnings.push("biased_roles");
  const extraction = {
    domTurns: 0,
    turns: turnsCount,
    rawChars,
    partial: warnings.length > 0,
    warnings,
  };
  const rawPath = tab.rawContentPathForSummary ?? "（未設定）";
  const hasRaw = rawPath !== "（未設定）";
  const fm = buildChatReferenceFrontmatter({
    url: tab.url,
    rawContentPath: rawPath,
    rawChatPath,
    windowLabel,
    hasRaw,
    service: tab.chatService ?? "unknown",
    extraction,
  });

  const normalizedInput = {
    messages,
    metadata: {
      source_type: "chat",
      title: tab.title || "",
      url: tab.url,
      service: tab.chatService ?? "unknown",
    },
    raw_text: chatContent.raw_text,
  };

  try {
    const taskReaperOut = await runTaskReaperProcess(
      {
        text: distillSource.slice(0, 30000),
        mode: "task",
        metadata: {
          source_type: "chat",
          title: tab.title || "",
          url: tab.url,
          service: tab.chatService ?? "unknown",
        },
        options: {
          pipelineMode: "distill",
          normalizedInput,
        },
      },
      buildTaskReaperApiKeys(provider, apiKey)
    );

    const titleSeed = (taskReaperOut.summary || "").trim() || (tab.title || "").trim();
    const shortTitle =
      getShortTitleForFilename(titleSeed) || generateShortTitle({ rawTitle: titleSeed, url: tab.url });
    const points = pickGlobalThreePoints(taskReaperOut.summary || "", taskReaperOut.details || []);
    const lessons = taskReaperOut.details ?? [];
    const tags = ["distill", "chat", tab.chatService ?? "unknown", taskReaperOut.distill_mode ?? "logical"].join(" ");
    const logicalForLogger =
      taskReaperOut.action != null
        ? {
            actions: taskReaperOut.action.actions.map((a: { label: string; type: string; deadline?: string }) => ({
              label: a.label,
              type: a.type,
              deadline: a.deadline,
            })),
            details: taskReaperOut.action.details,
          }
        : taskReaperOut.logical != null
          ? { actions: [] as Array<{ label: string; type: string; deadline?: string }>, details: taskReaperOut.logical.details }
          : undefined;
    const emotionalForLogger = taskReaperOut.emotional;
    const phase1ForLogger = taskReaperOut.phase1
      ? {
          attribution_ledger: taskReaperOut.phase1.attribution_ledger.map((a) => ({
            idea: a.idea,
            origin: a.origin,
            confidence: a.confidence,
            accepted: a.accepted,
          })),
          anchor: taskReaperOut.phase1.anchor,
        }
      : undefined;

    const out = logger({
      mode: "reference",
      sourceType: "chat",
      pipeline: "distill",
      distillMode: taskReaperOut.distill_mode ?? "logical",
      rawPolicy: hasRaw ? "stored" : "url_only",
      date: todayDate(),
      window: windowLabel,
      service: tab.chatService ?? "unknown",
      url: tab.url ?? "",
      rawContentPath: rawPath,
      rawChatPath,
      shortTitle,
      uid8: uid,
      points,
      summary: taskReaperOut.summary ?? "",
      lessons,
      conversationMd,
      logical: logicalForLogger,
      emotional: emotionalForLogger,
      phase1: phase1ForLogger,
      extractionDomTurns: extraction.domTurns,
      extractionTurns: extraction.turns,
      extractionRawChars: extraction.rawChars,
      extractionPartial: extraction.partial,
      extractionWarnings: extraction.warnings,
    });
    return { summaryFilename: out.filename, summaryContent: out.content, outputDir: out.outputDir };
  } catch {
    try {
      const prompt = `${buildChatDistillPrompt()}\n\n## 会話ログ\n${distillSource.slice(0, 30000)}`;
      const ai = await callAI(provider, [{ role: "user", content: prompt }], {
        apiKey,
        model: modelId,
        timeout: 90000,
        maxTokens: 3500,
        temperature: 0.25,
      });
      const json = parseChatDistillJson(ai.text || "");
      const base =
        getShortTitleForFilename(json.short_title) ||
        generateShortTitle({ rawTitle: tab.title || "", url: tab.url });
      const summaryFilename = `c-${base}_${uid}.md`;
      const pointsMd = json.points.length > 0 ? json.points.map((p) => `- ${p}`).join("\n") : "- （distill未取得）";
      const lessonsMd =
        json.lessons.length > 0 ? json.lessons.map((p) => `- ${p}`).join("\n") : "- （distill未取得）";
      const topicSolutionsMd =
        json.topic_solutions.length > 0
          ? json.topic_solutions.map((p) => `- ${p}`).join("\n")
          : "- （distill未取得）";
      const tagsMd = (json.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => `[[${t}]]`)
        .join(" ");
      const summaryContent = `${fm}

## 要点
${pointsMd}

## 要約
${json.summary || "（distill未取得）"}

## 教訓・示唆
${lessonsMd}

## 詳細要約
${json.longSummary || "（distill未取得）"}

## 話題と解決法
${topicSolutionsMd}

### tags
${tagsMd || "（未設定）"}

---
url: ${tab.url}
raw_content: ${rawPath}
created_at: ${new Date().toISOString()}
raw_pagetitle: ${(tab.title || "").trim() || "（無題）"}
linked_from: tabReaper
---

## 会話
${conversationMd}
`;
      return { summaryFilename, summaryContent, outputDir: VAULT_REFERENCE_DIR };
    } catch {
      const summaryFilename = `c-chat_${uid}.md`;
      const summaryContent = `${fm}

## 要点
- （distill未取得）

## 会話
${conversationMd}
`;
      return { summaryFilename, summaryContent, outputDir: VAULT_REFERENCE_DIR };
    }
  }
}

function getSelectedTabsByWindow(): {
  windowIndex: number;
  windowLabel: string;
  tabs: TabInfo[];
  captureImages: boolean;
}[] {
  const byWindow: { windowIndex: number; windowLabel: string; tabs: TabInfo[]; captureImages: boolean }[] = [];
  allWindows.forEach((win, winIndex) => {
    const tabs = win.tabs.filter((t) => selectedTabs.has(t.id));
    if (tabs.length === 0) return;
    byWindow.push({
      windowIndex: winIndex + 1,
      windowLabel: win.label,
      captureImages: win.captureImages ?? false,
      tabs: tabs.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        content: t.content,
        discarded: t.discarded,
        chatService: t.chatService,
      })),
    });
  });
  return byWindow;
}

const WINDOW_LABEL_REFINE_PROMPT = `以下はブラウザのウィンドウラベル（タブタイトルから取った）です。
サービス名・サイト名・著者名を除き、内容を表す言葉だけにしてください。20文字以内。説明や前置きは不要。1行だけ返す。`;

/** 作業AIでウィンドウラベルを短くする（サービス名・著者名カット、内容のみ） */
async function refineWindowLabelWithAI(
  label: string,
  apiKey: string,
  provider: AIProvider,
  modelId: string
): Promise<string> {
  if (!label || /^ウィンドウ\s*\d+$/.test(label.trim())) return label;
  try {
    const res = await callAI(provider, [{ role: "user", content: `${WINDOW_LABEL_REFINE_PROMPT}\n\n${label}` }], {
      apiKey,
      model: modelId,
      timeout: 15000,
      maxTokens: 80,
      temperature: 0.2,
    });
    const out = (res.text || "").trim().replace(/\n.*/s, "").trim();
    return out.slice(0, 20) || label;
  } catch {
    return label;
  }
}

/** 全ウィンドウのラベルを作業AIで短縮（保存前に1回だけ） */
async function refineWindowLabelsWithAI(
  byWindow: { windowLabel: string }[],
  apiKey: string,
  provider: AIProvider,
  modelId: string
): Promise<void> {
  for (let i = 0; i < byWindow.length; i++) {
    showStatus(`ウィンドウ名を整理中 (${i + 1}/${byWindow.length})...`, "info");
    byWindow[i].windowLabel = await refineWindowLabelWithAI(byWindow[i].windowLabel, apiKey, provider, modelId);
  }
}

/** ポップアップ用: allWindows のラベルを作業AIで短縮（APIキーがあれば取得直後に実行） */
async function refineAllWindowsLabelsOnFetch(): Promise<void> {
  let apiKey: string | undefined;
  let workerModel: { modelId: string; provider: AIProvider } | null = null;
  try {
    const o = await chrome.storage.local.get([
      STORAGE_KEYS.apiKeyGemini,
      STORAGE_KEYS.apiKeyOpenAI,
      STORAGE_KEYS.apiKeyClaude,
    ]);
    const settings: APIKeySettings = {
      geminiApiKey: (o[STORAGE_KEYS.apiKeyGemini] || "").trim() || undefined,
      openaiApiKey: (o[STORAGE_KEYS.apiKeyOpenAI] || "").trim() || undefined,
      claudeApiKey: (o[STORAGE_KEYS.apiKeyClaude] || "").trim() || undefined,
    };
    workerModel = requireModelForRole("worker", settings);
    apiKey = getApiKeyForProvider(workerModel.provider, settings);
  } catch {
    return;
  }
  if (!workerModel || !apiKey || allWindows.length === 0) return;
  for (let i = 0; i < allWindows.length; i++) {
    if (allWindows[i].labelFromSelection) continue;
    showStatus(`ウィンドウ名を整理中 (${i + 1}/${allWindows.length})...`, "info");
    allWindows[i].label = await refineWindowLabelWithAI(
      allWindows[i].label,
      apiKey,
      workerModel.provider,
      workerModel.modelId
    );
  }
}

async function saveTabSummariesToVault(
  cfg: ObsidianRestConfig,
  byWindow: { windowIndex: number; windowLabel: string; tabs: TabInfo[] }[]
): Promise<Set<number>> {
  const failedSummaryTabIds = new Set<number>();
  const flat = byWindow.flatMap((w) => w.tabs).filter((t) => t.summaryFilename && t.summaryContent);
  for (const tab of flat) {
    const dir = tab.summaryVaultDir ?? (tab.chatService ? VAULT_REFERENCE_DIR : VAULT_CLIP_DIR);
    try {
      await putVaultFile(cfg, `${dir}/${tab.summaryFilename!}`, tab.summaryContent!);
    } catch (e) {
      failedSummaryTabIds.add(tab.id);
      console.error("summary save error:", tab.url, e);
    }
  }
  return failedSummaryTabIds;
}

async function saveRawToVault(
  cfg: ObsidianRestConfig,
  byWindow: { windowIndex: number; windowLabel: string; tabs: TabInfo[] }[]
) {
  const flat = byWindow.flatMap((w) => w.tabs).filter((t) => t.rawFilename && t.rawContent);
  for (const tab of flat) {
    await putVaultFile(cfg, `${VAULT_RAW_DIR}/${tab.rawFilename!}`, tab.rawContent!, "text/markdown");
  }
  const chatRawTabs = byWindow.flatMap((w) => w.tabs).filter((t) => t.chatRawFilename && t.chatRawContent);
  for (const tab of chatRawTabs) {
    await putVaultFile(cfg, `${VAULT_RAW_DIR}/${tab.chatRawFilename!}`, tab.chatRawContent!, "text/markdown");
  }
}

const DAY_INDEX_PATH = "library/day-index.md";

function buildDayIndexEntry(
  byWindow: { windowIndex: number; windowLabel: string; tabs: TabInfo[] }[],
  date: Date,
  failedSummaryTabIds: Set<number> = new Set<number>()
): string {
  const ymd =
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0");
  const lines: string[] = [`[[${ymd}]]`];
  byWindow.forEach((w) => {
    lines.push(`- ${w.windowLabel}`);
    w.tabs.forEach((t) => {
      const useUrl = failedSummaryTabIds.has(t.id);
      const link = !useUrl && t.summaryFilename
        ? `[[${t.summaryFilename.replace(/\.md$/i, "")}]]`
        : `[${t.title || "（無題）"}](${t.url})`;
      lines.push(`\t- ${link}`);
    });
  });
  return lines.join("\n") + "\n";
}

async function appendDayIndex(
  cfg: ObsidianRestConfig,
  byWindow: { windowIndex: number; windowLabel: string; tabs: TabInfo[] }[],
  date: Date,
  failedSummaryTabIds: Set<number> = new Set<number>()
) {
  const entry = buildDayIndexEntry(byWindow, date, failedSummaryTabIds);
  await appendVaultFile(cfg, DAY_INDEX_PATH, "\n" + entry);
}

async function saveSelectedTabs() {
  if (selectedTabs.size === 0) {
    showStatus("タブを選択してください", "error");
    return;
  }

  const restCfg = await loadRestConfig();
  if (!restCfg) {
    showStatus("Obsidian REST API Key が未設定です（設定画面で入力）", "error");
    return;
  }
  showStatus("Obsidian 接続確認中...", "info");
  const alive = await healthCheck(restCfg);
  if (!alive) {
    showStatus("Obsidian に接続できません（REST API プラグインが起動しているか確認）", "error");
    return;
  }

  const o = await chrome.storage.local.get([
    STORAGE_KEYS.apiKeyGemini,
    STORAGE_KEYS.apiKeyOpenAI,
    STORAGE_KEYS.apiKeyClaude,
  ]);
  const settings: APIKeySettings = {
    geminiApiKey: (o[STORAGE_KEYS.apiKeyGemini] || "").trim() || undefined,
    openaiApiKey: (o[STORAGE_KEYS.apiKeyOpenAI] || "").trim() || undefined,
    claudeApiKey: (o[STORAGE_KEYS.apiKeyClaude] || "").trim() || undefined,
  };
  let workerModel: { modelId: string; provider: AIProvider } | null = null;
  let apiKey: string | undefined;
  try {
    workerModel = requireModelForRole("worker", settings);
    apiKey = getApiKeyForProvider(workerModel.provider, settings);
  } catch {
    // 使用可能なキーなし
  }

  const byWindow = getSelectedTabsByWindow();
  const flatTabs = byWindow.flatMap((w) => w.tabs);
  const total = flatTabs.length;

  // 1-0 / 2-0: 本文取得の第一パス。Discarded はアクティブ化してから取得。順次・進捗表示。
  for (let i = 0; i < flatTabs.length; i++) {
    const tab = flatTabs[i];
    const discarded = tab.discarded ?? false;
    if (discarded) {
      showStatus(`Discarded タブを読み込み中 (${i + 1}/${total})...`, "info");
      await ensureTabLoadedForBody(tab.id);
    }
    showStatus(`本文取得中 (${i + 1}/${total})...`, "info");
    const uid = uid8();
    const base = getBaseForTab(tab);
    tab.uid8 = uid;
    tab.baseForFilename = base;
    const { bodyText, links } = await fetchTabBodyAndLinks(
      tab.id,
      tab.url,
      false
    );
    const fromText = bodyText ? extractUrlsFromText(bodyText) : [];
    const hrefs = new Set(links.map(hrefFromObsidianLink).filter((h): h is string => h != null));
    const fromTextLinks = fromText.filter((u) => !hrefs.has(u)).map((u) => `[${u}](${u})`);
    tab.extractedUrls = [...links, ...fromTextLinks].slice(0, 30);
    if (bodyText != null && bodyText.length > 0) {
      const rawPrefix = tab.chatService ? "c-" : detectSourceType(tab.url ?? "") === "x" ? "p-x-" : "p-";
      tab.rawFilename = `${rawPrefix}${base}_${uid}.txt`;
      tab.rawContent = bodyText;
      tab.rawContentPathForSummary = `${RAW_CONTENT_PATH_PREFIX}/${rawPrefix}${base}_${uid}.txt`;
    } else {
      tab.rawContentPathForSummary = "（未設定）";
    }

    const winForTab = byWindow.find((w) => w.tabs.some((t) => t.id === tab.id));
    if (winForTab?.captureImages) {
      showStatus(`画像URL取得中 (${i + 1}/${total})...`, "info");
      tab.pageImageUrls = await fetchTabImages(tab.id, tab.url, false);
    }
  }

  const tabWindowLabel = new Map<number, string>();
  byWindow.forEach((w) => w.tabs.forEach((t) => tabWindowLabel.set(t.id, w.windowLabel)));

  if (workerModel && apiKey) {
    for (let i = 0; i < flatTabs.length; i++) {
      const tab = flatTabs[i];
      const wLabel = tabWindowLabel.get(tab.id) ?? "";
      if (tab.chatService) {
        showStatus(`チャット抽出中 (${i + 1}/${total})...`, "info");
        const chat = await fetchChatContent(tab.id, tab.url, false);
        const uid = tab.uid8 ?? uid8();
        const createdAt = new Date().toISOString();
        tab.chatRawFilename = `chat-${tab.chatService}_${uid}.md`;
        tab.chatRawContent = buildChatRawContentMd(chat.raw_text, tab.url, tab.chatService, createdAt);
        const rawChatPath = `${RAW_CONTENT_PATH_PREFIX}/${tab.chatRawFilename}`;
        const captureCheck = isChatCaptureFailed(chat);
        if (captureCheck.failed) {
          showStatus(
            `chat捕獲失敗 (${i + 1}/${total}): ${captureCheck.reasons.join(", ")}。distill停止`,
            "error"
          );
          const summaryFilename = `c-capture_failed_${uid}.md`;
          tab.summaryFilename = summaryFilename;
          tab.summaryContent = buildChatCaptureFailedSummaryMd({
            tab,
            windowLabel: wLabel,
            rawChatPath,
            chat,
            reasons: captureCheck.reasons,
          });
          tab.summaryVaultDir = VAULT_REFERENCE_DIR;
          continue;
        }
        showStatus(`distill中 (${i + 1}/${total})...`, "info");
        const out = await runChatDistillForTab(
          tab,
          apiKey,
          workerModel.provider,
          workerModel.modelId,
          wLabel,
          chat,
          rawChatPath
        );
        tab.summaryFilename = out.summaryFilename;
        tab.summaryContent = out.summaryContent;
        tab.summaryVaultDir = out.outputDir;
        continue;
      }
      const maxAttempts = 3;
      let succeeded = false;
      for (let attempt = 0; attempt < maxAttempts && !succeeded; attempt++) {
        showStatus(
          attempt === 0 ? `要約中 (${i + 1}/${total})...` : `要約リトライ (${i + 1}/${total})...`,
          "info"
        );
        try {
          const out = await runUrlSummaryForTab(
            tab,
            apiKey,
            workerModel!.provider,
            workerModel!.modelId,
            wLabel,
          );
          tab.summaryFilename = out.summaryFilename;
          tab.summaryContent = out.summaryContent;
          tab.summaryVaultDir = out.outputDir;
          succeeded = true;
        } catch (err) {
          console.error(`URL要約エラー (attempt ${attempt + 1}/${maxAttempts}):`, tab.url, err);
          if (attempt === maxAttempts - 1) {
            const fallbackPrefix = detectSourceType(tab.url ?? "") === "x" ? "p-x-" : "p-";
            tab.summaryFilename = `${fallbackPrefix}untitled_${tab.uid8 ?? uid8()}.md`;
            tab.summaryContent = buildPlaceholderSummaryMd(tab, tab.rawContentPathForSummary, wLabel);
            tab.summaryVaultDir = VAULT_CLIP_DIR;
          }
        }
      }
    }
  } else {
    addPlaceholderFilenames(byWindow);
  }

  for (let i = 0; i < flatTabs.length; i++) {
    const tab = flatTabs[i];
    if (!tab.pageImageUrls?.length) continue;
    showStatus(`画像ダウンロード中 (${i + 1}/${total})...`, "info");
    const tabUid = tab.uid8 ?? uid8();
    const images: { filename: string; alt: string; videoUrl?: string }[] = [];
    for (let j = 0; j < tab.pageImageUrls.length; j++) {
      const img = tab.pageImageUrls[j];
      const downloaded = await downloadImage(img.src);
      if (!downloaded) continue;
      const filename = `img-${tabUid}_${j}.${downloaded.ext}`;
      try {
        await putVaultBinary(
          restCfg,
          `${VAULT_IMAGE_DIR}/${filename}`,
          downloaded.data,
          downloaded.contentType,
        );
        images.push({ filename, alt: img.alt, videoUrl: img.videoUrl });
      } catch (e) {
        console.error("image save error:", img.src, e);
      }
    }
    tab.capturedImages = images;
    if (images.length > 0 && tab.summaryContent) {
      tab.summaryContent = appendImagesSectionToMd(tab.summaryContent, images);
    }
  }

  showStatus("Obsidian に保存中...", "info");
  try {
    await saveRawToVault(restCfg, byWindow);
    const failedSummaryTabIds = await saveTabSummariesToVault(restCfg, byWindow);
    await appendDayIndex(restCfg, byWindow, new Date(), failedSummaryTabIds);
    showStatus("library/clip・library/reference に保存しました", "success");
    // 取り込み終了状態でポップアップは開いたままにする（自動で閉じない）
  } catch (e) {
    showStatus(`保存エラー: ${(e as Error).message}`, "error");
    console.error(e);
  }
}

function showStatus(message: string, type: "info" | "success" | "error") {
  statusEl.textContent = message;
  statusEl.className = `status show ${type}`;
  // success は消さず表示を残す（取り込み終了の確認のため）
}
