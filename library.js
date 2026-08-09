'use strict';
const LIBRARY_KEY = 'openSubLibrary';
let library = {};

function safeFileName(value) {
  return String(value || 'subtitles').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'subtitles';
}

function downloadText(text, name, type = 'application/x-subrip;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function save() { await chrome.storage.local.set({ [LIBRARY_KEY]: library }); }

function render() {
  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  list.innerHTML = '';
  const entries = Object.entries(library).sort((a,b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')));
  empty.classList.toggle('hidden', entries.length !== 0);

  for (const [key, entry] of entries) {
    const div = document.createElement('div');
    div.className = 'entry';
    const h2 = document.createElement('h2'); h2.textContent = entry.title || 'Video page';
    const url = document.createElement('div'); url.className = 'url'; url.textContent = entry.pageUrl || key;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = `${entry.cueCount || '?'} cues • ${entry.translatedText ? `${entry.sourceLanguage || '?'} → ${entry.targetLanguage || '?'}` : (entry.sourceLanguage || 'original')} • offset ${Number(entry.offset || 0).toFixed(2)}s${entry.enabled === false ? ' • disabled' : ''}`;
    const row = document.createElement('div'); row.className = 'row';

    const open = document.createElement('button'); open.textContent = '▶ Open page'; open.onclick = () => chrome.tabs.create({ url: entry.pageUrl || key });
    const source = document.createElement('button'); source.textContent = '↓ Source SRT'; source.disabled = !entry.sourceText; source.onclick = () => downloadText(entry.sourceText, `${safeFileName(entry.title)}.${entry.sourceLanguage || 'source'}.srt`);
    const translated = document.createElement('button'); translated.textContent = '↓ Translated SRT'; translated.disabled = !entry.translatedText; translated.onclick = () => downloadText(entry.translatedText, `${safeFileName(entry.title)}.${entry.targetLanguage || 'translated'}.srt`);
    const toggle = document.createElement('button'); toggle.textContent = entry.enabled === false ? 'Enable' : 'Disable'; toggle.onclick = async () => { entry.enabled = entry.enabled === false; await save(); render(); };
    const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = 'Remove'; remove.onclick = async () => { delete library[key]; await save(); render(); };
    row.append(open, source, translated, toggle, remove);
    div.append(h2, url, meta, row);
    list.appendChild(div);
  }
}

document.getElementById('exportBackup').addEventListener('click', () => {
  downloadText(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), library }, null, 2), 'OpenSub-Overlay-backup.json', 'application/json;charset=utf-8');
});

document.getElementById('importBackup').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.library !== 'object') throw new Error('Invalid backup.');
    library = { ...library, ...data.library };
    await save();
    render();
  } catch (error) {
    alert(`Could not import backup: ${error.message}`);
  }
});

chrome.storage.local.get(LIBRARY_KEY).then(data => { library = data[LIBRARY_KEY] || {}; render(); });
