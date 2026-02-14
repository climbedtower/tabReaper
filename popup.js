// Constants: Downloads/toObsidian/ 内にシンボリックリンクを置く
//   web_summary -> ROOM/ROOM/library/webclip/web_summary
//   webclip     -> ROOM/ROOM/library/webclip
const TO_OBSIDIAN_WEB_SUMMARY = 'toObsidian/web_summary';
const TO_OBSIDIAN_CLIP = 'toObsidian/webclip';
const SHORT_TITLE_MAX_LEN = 30;

// State
let allWindows = [];
let selectedTabs = new Set();

// Elements
const fetchBtn = document.getElementById('fetchBtn');
const copyBtn = document.getElementById('copyBtn');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const tabListEl = document.getElementById('tabList');

// Event listeners
fetchBtn.addEventListener('click', fetchAllTabs);
copyBtn.addEventListener('click', copySelectedTabs);
saveBtn.addEventListener('click', saveSelectedTabs);
fetchCurrentWindowTabs();

async function buildWindowData(win) {
  const windowData = { id: win.id, tabs: [] };
  for (const tab of win.tabs) {
    let content = null;
    if (tab.url.startsWith('http') && !tab.discarded) {
      try {
        const injection = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.body.innerText
        });
        if (injection && injection[0]) content = injection[0].result.substring(0, 200);
      } catch (e) {
        content = `Error: ${e.message}`;
      }
    }
    windowData.tabs.push({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      content,
      discarded: tab.discarded
    });
  }
  return windowData;
}

async function fetchCurrentWindowTabs() {
  showStatus('取得中...', 'info');
  tabListEl.innerHTML = '';
  selectedTabs.clear();
  copyBtn.disabled = true;
  saveBtn.disabled = true;
  try {
    const win = await chrome.windows.getCurrent({ populate: true });
    if (!win || !win.tabs) {
      showStatus('ウィンドウ情報を取得できませんでした', 'error');
      return;
    }
    allWindows = [await buildWindowData(win)];
    renderTabList();
    showStatus(`現在のウィンドウ（${allWindows[0].tabs.length}タブ）`, 'success');
  } catch (error) {
    showStatus(`エラー: ${error.message}`, 'error');
    console.error('Fetch current window error:', error);
  }
}

async function fetchAllTabs() {
  showStatus('取得中...', 'info');
  tabListEl.innerHTML = '';
  selectedTabs.clear();
  copyBtn.disabled = true;
  saveBtn.disabled = true;
  try {
    const windows = await chrome.windows.getAll({ populate: true });
    allWindows = [];
    for (const win of windows) {
      allWindows.push(await buildWindowData(win));
    }
    renderTabList();
    showStatus(`${allWindows.length}個のウィンドウから取得完了`, 'success');
  } catch (error) {
    showStatus(`エラー: ${error.message}`, 'error');
    console.error('Fetch error:', error);
  }
}

function renderTabList() {
  tabListEl.innerHTML = '';

  allWindows.forEach((win, winIndex) => {
    const windowGroup = document.createElement('div');
    windowGroup.className = 'window-group';

    // Window header with checkbox
    const windowHeader = document.createElement('div');
    windowHeader.className = 'window-header';

    const windowCheckbox = document.createElement('input');
    windowCheckbox.type = 'checkbox';
    windowCheckbox.id = `window-${winIndex}`;
    windowCheckbox.checked = win.tabs.some(t => selectedTabs.has(t.id));
    windowCheckbox.addEventListener('change', (e) => {
      toggleWindow(winIndex, e.target.checked);
    });

    const windowLabel = document.createElement('label');
    windowLabel.htmlFor = `window-${winIndex}`;
    windowLabel.textContent = `ウィンドウ ${winIndex + 1} (${win.tabs.length}タブ)`;

    windowHeader.appendChild(windowCheckbox);
    windowHeader.appendChild(windowLabel);
    windowGroup.appendChild(windowHeader);

    // Tab items
    win.tabs.forEach((tab) => {
      const tabItem = document.createElement('div');
      tabItem.className = 'tab-item';

      const tabCheckbox = document.createElement('input');
      tabCheckbox.type = 'checkbox';
      tabCheckbox.id = `tab-${tab.id}`;
      tabCheckbox.addEventListener('change', (e) => {
        toggleTab(tab.id, e.target.checked);
      });

      const tabInfo = document.createElement('div');
      tabInfo.className = 'tab-info';

      const tabTitle = document.createElement('div');
      tabTitle.className = 'tab-title';
      tabTitle.textContent = tab.title || '(無題)';

      const tabUrl = document.createElement('div');
      tabUrl.className = 'tab-url';
      tabUrl.textContent = tab.url;

      tabInfo.appendChild(tabTitle);
      tabInfo.appendChild(tabUrl);

      if (tab.content) {
        const tabContent = document.createElement('div');
        tabContent.className = 'tab-content';
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

function toggleWindow(winIndex, checked) {
  const win = allWindows[winIndex];
  win.tabs.forEach(tab => {
    if (checked) {
      selectedTabs.add(tab.id);
    } else {
      selectedTabs.delete(tab.id);
    }
    const checkbox = document.getElementById(`tab-${tab.id}`);
    if (checkbox) checkbox.checked = checked;
  });
  syncWindowCheckboxes();
  updateCopyButton();
}

function syncWindowCheckboxes() {
  allWindows.forEach((win, winIndex) => {
    const cb = document.getElementById(`window-${winIndex}`);
    if (cb) cb.checked = win.tabs.some(t => selectedTabs.has(t.id));
  });
}

function toggleTab(tabId, checked) {
  if (checked) {
    selectedTabs.add(tabId);
  } else {
    selectedTabs.delete(tabId);
  }
  syncWindowCheckboxes();
  updateCopyButton();
}

function updateCopyButton() {
  copyBtn.disabled = selectedTabs.size === 0;
  updateSaveButton();
}

function updateSaveButton() {
  saveBtn.disabled = selectedTabs.size === 0;
}

async function copySelectedTabs() {
  const selectedData = [];

  allWindows.forEach(win => {
    win.tabs.forEach(tab => {
      if (selectedTabs.has(tab.id)) {
        selectedData.push({
          title: tab.title,
          url: tab.url,
          content: tab.content
        });
      }
    });
  });

  const outputText = selectedData.map(tab => {
    let text = `## ${tab.title}\n${tab.url}`;
    if (tab.content) {
      text += `\n\n${tab.content}`;
    }
    return text;
  }).join('\n\n---\n\n');

  try {
    await navigator.clipboard.writeText(outputText);
    showStatus(`${selectedData.length}個のタブをコピーしました`, 'success');
  } catch (error) {
    showStatus(`コピー失敗: ${error.message}`, 'error');
  }
}

function sanitizeShortTitle(title) {
  if (!title || typeof title !== 'string') return 'untitled';
  const s = title.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return s.slice(0, SHORT_TITLE_MAX_LEN) || 'untitled';
}

function uid8() {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  } catch (_) {
    return Date.now().toString(36).slice(-8);
  }
}

function buildTabSummaryMd(tab) {
  const shortTitle = sanitizeShortTitle(tab.title);
  const u = uid8();
  const pageUid = `${u}-${Date.now().toString(36)}`;
  const created = new Date().toISOString();
  return `---
page_uid: ${pageUid}
---
# ${(tab.title || '').trim() || '（無題）'}

## 要点
- （要約は未取得）

## 要約
（MVPでは空欄）

### tags
（未設定）

---
url: ${tab.url}
raw_content: （未設定）
created_at: ${created}
linked_from: （未設定）

---

## how_to
（手順があるときだけ。なければ省略可）
`;
}

function getSelectedTabsByWindow() {
  const byWindow = [];
  allWindows.forEach((win, winIndex) => {
    const tabs = win.tabs.filter(t => selectedTabs.has(t.id));
    if (tabs.length === 0) return;
    byWindow.push({
      windowIndex: winIndex + 1,
      windowLabel: `ウィンドウ ${winIndex + 1}`,
      tabs: tabs.map(t => ({ id: t.id, title: t.title || '（無題）', url: t.url }))
    });
  });
  return byWindow;
}

function addSummaryFilenames(byWindow) {
  byWindow.forEach(w => {
    w.tabs.forEach(tab => {
      const shortTitle = sanitizeShortTitle(tab.title);
      const u = uid8();
      tab.summaryFilename = `p-${shortTitle}_${u}.md`;
    });
  });
}

function saveTabSummariesToDownloads(byWindow) {
  if (!byWindow || byWindow.length === 0) return Promise.resolve();
  const flatTabs = byWindow.flatMap(w => w.tabs);
  const promises = flatTabs.map(tab => {
    const filename = `${TO_OBSIDIAN_WEB_SUMMARY}/${tab.summaryFilename}`;
    const content = buildTabSummaryMd(tab);
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    return chrome.downloads.download({ url, filename, saveAs: false }).then(() => {
      URL.revokeObjectURL(url);
    });
  });
  return Promise.all(promises);
}

function buildJournalContent(byWindow, date) {
  const ymd = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  const lines = [`[[${ymd}]]`];
  byWindow.forEach(w => {
    w.tabs.forEach(t => {
      const link = t.summaryFilename
        ? `[[${t.summaryFilename.replace(/\.md$/i, '')}]]`
        : `[${t.title || '（無題）'}](${t.url})`;
      lines.push(`- ${link}`);
    });
  });
  return lines.join('\n') + '\n';
}

function sanitizeWindowTitleForFilename(label) {
  return (label || 'ウィンドウ1').replace(/\s+/g, '').replace(/[/\\:*?"<>|]/g, '_').slice(0, 40) || 'ウィンドウ1';
}

function saveWindowListsToDownloads(byWindow, date) {
  const yyyymmdd = date.getFullYear() + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0');
  const promises = byWindow.map(w => {
    const windowTitle = sanitizeWindowTitleForFilename(w.windowLabel);
    const filename = `${TO_OBSIDIAN_CLIP}/${yyyymmdd}-${windowTitle}.md`;
    const content = buildJournalContent([w], date);
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    return chrome.downloads.download({ url, filename, saveAs: false }).then(() => URL.revokeObjectURL(url));
  });
  return Promise.all(promises);
}

async function saveSelectedTabs() {
  if (selectedTabs.size === 0) {
    showStatus('タブを選択してください', 'error');
    return;
  }
  showStatus('保存中...', 'info');
  try {
    const byWindow = getSelectedTabsByWindow();
    addSummaryFilenames(byWindow);
    await saveTabSummariesToDownloads(byWindow);
    await saveWindowListsToDownloads(byWindow, new Date());
    showStatus('web_summary と clip に保存しました', 'success');
  } catch (e) {
    showStatus(`保存エラー: ${e.message}`, 'error');
    console.error(e);
  }
}

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status show ${type}`;
  
  if (type === 'success') {
    setTimeout(() => {
      statusEl.className = 'status';
    }, 3000);
  }
}
