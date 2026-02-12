// State
let allWindows = [];
let selectedTabs = new Set();

// Elements
const fetchBtn = document.getElementById('fetchBtn');
const copyBtn = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');
const tabListEl = document.getElementById('tabList');

// Event listeners
fetchBtn.addEventListener('click', fetchAllTabs);
copyBtn.addEventListener('click', copySelectedTabs);

// Main functions
async function fetchAllTabs() {
  showStatus('取得中...', 'info');
  tabListEl.innerHTML = '';
  selectedTabs.clear();
  copyBtn.disabled = true;

  try {
    const windows = await chrome.windows.getAll({ populate: true });
    allWindows = [];

    for (const win of windows) {
      const windowData = {
        id: win.id,
        tabs: []
      };

      for (const tab of win.tabs) {
        let content = null;

        // http/https かつ非Discarded状態のタブのみ内容取得
        if (tab.url.startsWith('http') && !tab.discarded) {
          try {
            const injection = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => document.body.innerText
            });
            if (injection && injection[0]) {
              content = injection[0].result.substring(0, 200);
            }
          } catch (e) {
            content = `Error: ${e.message}`;
          }
        }

        windowData.tabs.push({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          content: content,
          discarded: tab.discarded
        });
      }

      allWindows.push(windowData);
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
  updateCopyButton();
}

function toggleTab(tabId, checked) {
  if (checked) {
    selectedTabs.add(tabId);
  } else {
    selectedTabs.delete(tabId);
  }
  updateCopyButton();
}

function updateCopyButton() {
  copyBtn.disabled = selectedTabs.size === 0;
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

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status show ${type}`;
  
  if (type === 'success') {
    setTimeout(() => {
      statusEl.className = 'status';
    }, 3000);
  }
}
