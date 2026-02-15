/**
 * tabReaper 設定画面 - APIキー3種（担当AIは pipelines ai-roles の worker で自動選択）
 */

const STORAGE_KEYS = {
  apiKeyGemini: "tabReaper_apiKeyGemini",
  apiKeyOpenAI: "tabReaper_apiKeyOpenAI",
  apiKeyClaude: "tabReaper_apiKeyClaude",
} as const;

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
    STORAGE_KEYS.apiKeyGemini,
    STORAGE_KEYS.apiKeyOpenAI,
    STORAGE_KEYS.apiKeyClaude,
    "tabReaper_apiKey",
  ]);
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
  const keyGemini = apiKeyGemini.value.trim();
  const keyOpenAI = apiKeyOpenAI.value.trim();
  const keyClaude = apiKeyClaude.value.trim();
  if (!keyGemini && !keyOpenAI && !keyClaude) {
    showMessage("いずれか1つ以上のAPIキーを入力してください", true);
    return;
  }
  chrome.storage.local.set({
    [STORAGE_KEYS.apiKeyGemini]: keyGemini,
    [STORAGE_KEYS.apiKeyOpenAI]: keyOpenAI,
    [STORAGE_KEYS.apiKeyClaude]: keyClaude,
  });
  updateKeyStatus(statusGemini, keyGemini);
  updateKeyStatus(statusOpenAI, keyOpenAI);
  updateKeyStatus(statusClaude, keyClaude);
  showMessage("保存しました");
}

apiKeyGemini.addEventListener("input", () => updateKeyStatus(statusGemini, apiKeyGemini.value));
apiKeyOpenAI.addEventListener("input", () => updateKeyStatus(statusOpenAI, apiKeyOpenAI.value));
apiKeyClaude.addEventListener("input", () => updateKeyStatus(statusClaude, apiKeyClaude.value));
saveBtn.addEventListener("click", save);

load();
