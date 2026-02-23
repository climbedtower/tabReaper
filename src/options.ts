/**
 * tabReaper 設定画面 - Obsidian REST API 接続 + LLM APIキー3種
 */

import { STORAGE_KEY_REST_TOKEN, STORAGE_KEY_REST_URL, healthCheck } from "./obsidian-rest";

const STORAGE_KEYS = {
  apiKeyGemini: "tabReaper_apiKeyGemini",
  apiKeyOpenAI: "tabReaper_apiKeyOpenAI",
  apiKeyClaude: "tabReaper_apiKeyClaude",
} as const;

const obsidianToken = document.getElementById("obsidianToken") as HTMLInputElement;
const obsidianUrl = document.getElementById("obsidianUrl") as HTMLInputElement;
const statusObsidian = document.getElementById("statusObsidian") as HTMLSpanElement;
const testConnectionBtn = document.getElementById("testConnectionBtn") as HTMLButtonElement;
const connectionMessage = document.getElementById("connectionMessage") as HTMLSpanElement;

const apiKeyGemini = document.getElementById("apiKeyGemini") as HTMLInputElement;
const apiKeyOpenAI = document.getElementById("apiKeyOpenAI") as HTMLInputElement;
const apiKeyClaude = document.getElementById("apiKeyClaude") as HTMLInputElement;
const statusGemini = document.getElementById("statusGemini") as HTMLSpanElement;
const statusOpenAI = document.getElementById("statusOpenAI") as HTMLSpanElement;
const statusClaude = document.getElementById("statusClaude") as HTMLSpanElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const messageEl = document.getElementById("message") as HTMLSpanElement;

function showMessage(text: string, isError = false) {
  messageEl.textContent = text;
  messageEl.className = "message" + (isError ? " error" : "");
  if (text) {
    setTimeout(() => {
      messageEl.textContent = "";
      messageEl.className = "message";
    }, 4000);
  }
}

function updateKeyStatus(el: HTMLSpanElement, value: string) {
  const v = (value || "").trim();
  el.textContent = v ? "設定済み" : "未設定";
  el.classList.toggle("has-key", !!v);
}

async function load() {
  const o = await chrome.storage.local.get([
    STORAGE_KEY_REST_TOKEN,
    STORAGE_KEY_REST_URL,
    STORAGE_KEYS.apiKeyGemini,
    STORAGE_KEYS.apiKeyOpenAI,
    STORAGE_KEYS.apiKeyClaude,
    "tabReaper_apiKey",
  ]);
  obsidianToken.value = o[STORAGE_KEY_REST_TOKEN] || "";
  obsidianUrl.value = o[STORAGE_KEY_REST_URL] || "";
  updateKeyStatus(statusObsidian, obsidianToken.value);
  apiKeyGemini.value = o[STORAGE_KEYS.apiKeyGemini] || "";
  apiKeyOpenAI.value = o[STORAGE_KEYS.apiKeyOpenAI] || "";
  apiKeyClaude.value = o[STORAGE_KEYS.apiKeyClaude] || "";
  if (o.tabReaper_apiKey && !apiKeyGemini.value && !apiKeyOpenAI.value && !apiKeyClaude.value) {
    apiKeyGemini.value = o.tabReaper_apiKey;
  }
  updateKeyStatus(statusGemini, apiKeyGemini.value);
  updateKeyStatus(statusOpenAI, apiKeyOpenAI.value);
  updateKeyStatus(statusClaude, apiKeyClaude.value);
}

function save() {
  const token = obsidianToken.value.trim();
  const url = obsidianUrl.value.trim();
  if (!token) {
    showMessage("Obsidian REST API Key は必須です", true);
    return;
  }
  const keyGemini = apiKeyGemini.value.trim();
  const keyOpenAI = apiKeyOpenAI.value.trim();
  const keyClaude = apiKeyClaude.value.trim();
  chrome.storage.local.set({
    [STORAGE_KEY_REST_TOKEN]: token,
    [STORAGE_KEY_REST_URL]: url,
    [STORAGE_KEYS.apiKeyGemini]: keyGemini,
    [STORAGE_KEYS.apiKeyOpenAI]: keyOpenAI,
    [STORAGE_KEYS.apiKeyClaude]: keyClaude,
  });
  updateKeyStatus(statusObsidian, token);
  updateKeyStatus(statusGemini, keyGemini);
  updateKeyStatus(statusOpenAI, keyOpenAI);
  updateKeyStatus(statusClaude, keyClaude);
  showMessage("保存しました");
}

async function testConnection() {
  const token = obsidianToken.value.trim();
  const url = obsidianUrl.value.trim() || "http://127.0.0.1:27123";
  if (!token) {
    connectionMessage.textContent = "REST API Key を入力してください";
    connectionMessage.className = "message error";
    return;
  }
  connectionMessage.textContent = "接続中...";
  connectionMessage.className = "message";
  const ok = await healthCheck({ baseUrl: url, token });
  connectionMessage.textContent = ok ? "接続OK" : "接続失敗（Obsidian + REST APIプラグインが起動しているか確認）";
  connectionMessage.className = ok ? "message" : "message error";
}

obsidianToken.addEventListener("input", () => updateKeyStatus(statusObsidian, obsidianToken.value));
apiKeyGemini.addEventListener("input", () => updateKeyStatus(statusGemini, apiKeyGemini.value));
apiKeyOpenAI.addEventListener("input", () => updateKeyStatus(statusOpenAI, apiKeyOpenAI.value));
apiKeyClaude.addEventListener("input", () => updateKeyStatus(statusClaude, apiKeyClaude.value));
testConnectionBtn.addEventListener("click", testConnection);
saveBtn.addEventListener("click", save);

load();
