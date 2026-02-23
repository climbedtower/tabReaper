/**
 * tabReaper popup - URL要約は @pipelines/url-summary 経由。担当AIは ai-roles の worker。
 * ファイル保存は Obsidian Local REST API 経由。
 */

import {
  fetchViaJina,
  generateSummaryJson,
  parseSummaryJson,
  buildSummaryMdFromJson,
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
import {
  loadRestConfig,
  healthCheck,
  putVaultFile,
  appendVaultFile,
  type ObsidianRestConfig,
} from "./obsidian-rest";

const VAULT_CLIP_DIR = "library/clip";
const VAULT_RAW_DIR = "memory/raw_content";
const RAW_CONTENT_PATH_PREFIX = "memory/raw_content";
const SHORT_TITLE_MAX_LEN = 60;
const WINDOW_LABEL_MAX_LEN = 40;

const TWITTER_HOST_RE = /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)(\/|$)/i;
const YOUTUBE_HOST_RE = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)(\/|$)/i;

type SourceType = "web" | "x" | "youtube" | "paper" | "blog";

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

/** Content Script 注入不可または Discarded の場合は true */
function isTabUninjectable(url: string, discarded: boolean): boolean {
  if (discarded) return true;
  if (!url || !url.startsWith("http")) return true;
  if (/^https?:\/\/chrome\.google\.com\/webstore\//i.test(url)) return true;
  return false;
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
  rawFilename?: string;
  rawContent?: string;
  /** 1-0 本文取得で設定。要約 md の raw_content に書くパス */
  rawContentPathForSummary?: string;
  /** 本文中に言及された URL（要点リスト末尾に追記用） */
  extractedUrls?: string[];
  uid8?: string;
  baseForFilename?: string;
}

let allWindows: { id: number; tabs: TabInfo[]; label: string; labelFromSelection?: boolean }[] = [];
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
    await refineAllWindowsLabelsOnFetch();
    renderTabList();
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
    windowHeader.appendChild(windowCheckbox);
    windowHeader.appendChild(labelSpan);
    windowHeader.appendChild(tabCountSpan);
    windowGroup.appendChild(windowHeader);

    win.tabs.forEach((tab) => {
      const tabItem = document.createElement("div");
      tabItem.className = "tab-item";
      const tabCheckbox = document.createElement("input");
      tabCheckbox.type = "checkbox";
      tabCheckbox.id = `tab-${tab.id}`;
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
      tab.summaryFilename = `p-${base}_${uid}.md`;
      tab.summaryContent = buildPlaceholderSummaryMd(tab, tab.rawContentPathForSummary, w.windowLabel);
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
): Promise<{ summaryFilename: string; summaryContent: string }> {
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
  const fm = buildClipFrontmatter({ url: tab.url, rawContentPath: rawPath, windowLabel, hasRaw });
  const pageTitle = (tab.title || "").trim() || "（無題）";
  const program = {
    url: tab.url,
    raw_content: rawPath,
    created_at: created,
    linked_from: "tabReaper",
    raw_pagetitle: pageTitle,
  };

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
    const summaryBody = buildSummaryMdFromJson(json, program);
    let summaryContent = `${fm}\n\n${summaryBody}`;
    summaryContent = appendUrlsToPointsSection(summaryContent, tab.extractedUrls ?? []);
    const base = getShortTitleForFilename(json.short_title) || generateShortTitle({ rawTitle: tab.title || "", url: tab.url });
    const summaryFilename = `p-${base}_${uid}.md`;
    return { summaryFilename, summaryContent };
  } catch {
    const summaryFilename = `p-untitled_${uid}.md`;
    const summaryContent = buildPlaceholderSummaryMd(tab, tab.rawContentPathForSummary, windowLabel);
    return { summaryFilename, summaryContent };
  }
}

function getSelectedTabsByWindow(): {
  windowIndex: number;
  windowLabel: string;
  tabs: TabInfo[];
}[] {
  const byWindow: { windowIndex: number; windowLabel: string; tabs: TabInfo[] }[] = [];
  allWindows.forEach((win, winIndex) => {
    const tabs = win.tabs.filter((t) => selectedTabs.has(t.id));
    if (tabs.length === 0) return;
    byWindow.push({
      windowIndex: winIndex + 1,
      windowLabel: win.label,
      tabs: tabs.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        content: t.content,
        discarded: t.discarded,
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
) {
  const flat = byWindow.flatMap((w) => w.tabs).filter((t) => t.summaryFilename && t.summaryContent);
  for (const tab of flat) {
    await putVaultFile(cfg, `${VAULT_CLIP_DIR}/${tab.summaryFilename!}`, tab.summaryContent!);
  }
}

async function saveRawToVault(
  cfg: ObsidianRestConfig,
  byWindow: { windowIndex: number; windowLabel: string; tabs: TabInfo[] }[]
) {
  const flat = byWindow.flatMap((w) => w.tabs).filter((t) => t.rawFilename && t.rawContent);
  for (const tab of flat) {
    await putVaultFile(cfg, `${VAULT_RAW_DIR}/${tab.rawFilename!}`, tab.rawContent!, "text/markdown");
  }
}

const DAY_INDEX_PATH = "library/day-index.md";

function buildDayIndexEntry(
  byWindow: { windowIndex: number; windowLabel: string; tabs: TabInfo[] }[],
  date: Date
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
      const link = t.summaryFilename
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
  date: Date
) {
  const entry = buildDayIndexEntry(byWindow, date);
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
      tab.rawFilename = `p-${base}_${uid}.txt`;
      tab.rawContent = bodyText;
      tab.rawContentPathForSummary = `${RAW_CONTENT_PATH_PREFIX}/p-${base}_${uid}.txt`;
    } else {
      tab.rawContentPathForSummary = "（未設定）";
    }
  }

  const tabWindowLabel = new Map<number, string>();
  byWindow.forEach((w) => w.tabs.forEach((t) => tabWindowLabel.set(t.id, w.windowLabel)));

  if (workerModel && apiKey) {
    for (let i = 0; i < flatTabs.length; i++) {
      const tab = flatTabs[i];
      const wLabel = tabWindowLabel.get(tab.id) ?? "";
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
          succeeded = true;
        } catch (err) {
          console.error(`URL要約エラー (attempt ${attempt + 1}/${maxAttempts}):`, tab.url, err);
          if (attempt === maxAttempts - 1) {
            tab.summaryFilename = `p-untitled_${tab.uid8 ?? uid8()}.md`;
            tab.summaryContent = buildPlaceholderSummaryMd(tab, tab.rawContentPathForSummary, wLabel);
          }
        }
      }
    }
  } else {
    addPlaceholderFilenames(byWindow);
  }

  showStatus("Obsidian に保存中...", "info");
  try {
    await saveRawToVault(restCfg, byWindow);
    await saveTabSummariesToVault(restCfg, byWindow);
    await appendDayIndex(restCfg, byWindow, new Date());
    showStatus("library/clip/ に保存しました", "success");
    window.close();
  } catch (e) {
    showStatus(`保存エラー: ${(e as Error).message}`, "error");
    console.error(e);
  }
}

function showStatus(message: string, type: "info" | "success" | "error") {
  statusEl.textContent = message;
  statusEl.className = `status show ${type}`;
  if (type === "success") {
    setTimeout(() => {
      statusEl.className = "status";
    }, 3000);
  }
}
