#!/usr/bin/env node
/**
 * Jina 取得済み body から clip を蒸留用入力に用意し、蒸留結果 JSON から clip を組み立てて上書きする。
 * Usage:
 *   node scripts/clip-distill-from-bodies.js prepare   → inputs/ に 1.json, 2.json, ... を出力
 *   node scripts/clip-distill-from-bodies.js build 1 2 3 ...  → results/N.json から clip を組み立てて上書き
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOM = process.env.ROOM || '/Users/yuco/Code/ROOM/ROOM';
const CLIP_DIR = path.join(ROOM, 'library/clip');
const RAW_CONTENT_DIR = path.join(ROOM, 'memory/raw_content');
const WORK_DIR = path.join(ROOM, 'project/thinkingLog/jina-retry-bodies');
const INPUTS_DIR = path.join(WORK_DIR, 'inputs');
const RESULTS_DIR = path.join(WORK_DIR, 'results');

function safeFilename(name) {
  return name.replace(/[^\w\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\-_.]/g, '_').slice(0, 80);
}

function extractFrontmatter(content) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = { source_type: 'x', url: '', date: '', window: '', raw_policy: 'url_only', raw_content: '' };
  if (fm) {
    const block = fm[1];
    const get = (key) => { const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : ''; };
    out.source_type = get('source_type') || get('source_type') || 'x';
    out.url = get('url') || get('clip_url') || '';
    out.date = get('date') || '';
    out.window = get('window') || '';
    out.raw_policy = get('raw_policy') || 'url_only';
    out.raw_content = get('raw_content') || '';
  }
  return out;
}

// 今回 ok だった 42 件（TSV の順）
const OK_FILES = [
  '20251208デザイン再現時は、UIをセクション単位で提供し、モデルの視覚.md',
  '20251209過去の気象情報途絶からの教訓として、戦時下の情報統制が国民生.md',
  '20251216記憶機能は、複数の情報源を統合し文脈を毎回再構築していること.md',
  '20251217スライド生成前に、デザイン設定のYAML指示書を準備する。.md',
  'p-AIコーディングの課題とソフトウェア理解_961c5487.md',
  'p-AIツールとセキュリティ_02e40f96.md',
  'p-Claude Code PRレビューのコ_f6f17674.md',
  'p-Claude Code開発チームの開発手_6a2840a8.md',
  'p-Gemini Deep Think アッ_675febc7.md',
  'p-GitHub Copilotの評価_aa163151.md',
  "p-Lumiere'k系列 スタッフ募集_7c2d00e0.md",
  'p-OpenClawの進化と自己課題_217778dc.md',
  'p-SoftMatcha 2 リリース_ea2f33de.md',
  'p-Typelessのプライバシーリスク_5d7a6620.md',
  'p-Webサイトサーバー費用の検討_2410580a.md',
  'p-Webパフォーマンス改善_d20ec153.md',
  'p-World Monitor_5e9de587.md',
  'p-localStorageに個人情報を入れ_1983c982.md',
  'p-n8n請求書管理自動化_3fda5c83.md',
  'p-x-AIと動物の会話_6043c93e.md',
  'p-x-AI動画編集の革命_82519872.md',
  'p-x-AI文章作成実験_fc107154.md',
  'p-x-AI時代_ 好奇心と問題解決_5b46ac5b.md',
  'p-x-AI時代のビジネス展望_98c8ee51.md',
  'p-x-Googleの新AI「Hatter」_ac4c2705.md',
  'p-x-Mac vs AWSのLLM費用対効果_51ad4522.md',
  'p-x-PlaywrightとAIによるバグ検出_62873505.md',
  'p-x-RSSフィードアプリ「Current」_e42f14bf.md',
  'p-x-Requestly_ フロントエンドデバ_1af91e89.md',
  'p-x-Xの最新情報_ddc06d14.md',
  'p-x-X投稿の要約_2a07ffe9.md',
  'p-x-アリサ・リュウの表現哲学_f12e7e9d.md',
  'p-x-クレアチンモノハイドレート_00124fd9.md',
  'p-個人開発向けテックスタック_ddd31663.md',
];

function prepare() {
  if (!fs.existsSync(INPUTS_DIR)) fs.mkdirSync(INPUTS_DIR, { recursive: true });
  const manifest = [];
  for (let i = 0; i < OK_FILES.length; i++) {
    const filename = OK_FILES[i];
    const clipPath = path.join(CLIP_DIR, filename);
    const bodyPath = path.join(RAW_CONTENT_DIR, filename.replace(/\.md$/i, '') + '.txt');
    if (!fs.existsSync(clipPath) || !fs.existsSync(bodyPath)) {
      console.error('Skip (missing):', filename);
      continue;
    }
    const clipContent = fs.readFileSync(clipPath, 'utf8');
    const meta = extractFrontmatter(clipContent);
    const body = fs.readFileSync(bodyPath, 'utf8').slice(0, 14000);
    const n = i + 1;
    const input = { filename, url: meta.url, source_type: meta.source_type, date: meta.date, window: meta.window, raw_policy: meta.raw_policy, raw_content: meta.raw_content || '', body };
    fs.writeFileSync(path.join(INPUTS_DIR, `${n}.json`), JSON.stringify(input, null, 0), 'utf8');
    manifest.push(filename);
  }
  fs.writeFileSync(path.join(INPUTS_DIR, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  console.log('Prepared', manifest.length, 'inputs');
}

function buildMdFromJson(json, meta) {
  const j = json;
  const claim = (j.claim || '').trim();
  const catchphrases = Array.isArray(j.catchphrases) ? j.catchphrases : [];
  const topics = Array.isArray(j.topics) ? j.topics : [];
  const howTo = Array.isArray(j.how_to) ? j.how_to : null;
  const summary = (j.summary || '').trim();
  const tagsStr = (j.tags || '').trim();
  const tags = tagsStr ? tagsStr.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const credibility = j.credibility || 'secondary';

  let body = '';
  if (claim) body += `> **claim**: ${claim}\n\n`;
  catchphrases.forEach((c) => { body += `- ${c}\n`; });
  if (catchphrases.length) body += '\n';
  body += '## 論点整理\n';
  topics.forEach((t) => {
    const topic = (t && t.topic) ? t.topic : t;
    const points = (t && Array.isArray(t.points)) ? t.points : [];
    body += `- [[${topic}]]\n`;
    points.forEach((p) => { body += `    - ${p}\n`; });
  });
  if (howTo && howTo.length > 0) {
    body += '\n## 手順\n';
    howTo.forEach((h) => { body += `- ${h}\n`; });
  }
  body += '\n## 要約\n' + summary + '\n\n### tags\n';
  body += tags.map((t) => `[[${t}]]`).join(' ') + '\n\n---\n' + meta.url + '\n';

  const fm = `---
source_type: ${meta.source_type}
pipeline: summary
raw_policy: ${meta.raw_policy}
date: ${meta.date}
window: ${meta.window}
url: ${meta.url}
raw_content: ${meta.raw_content}
linked_from: tabReaper
credibility: ${credibility}
---
`;
  return fm + body;
}

function build(indices) {
  if (!fs.existsSync(RESULTS_DIR)) { console.error('No results dir'); return; }
  const manifestPath = path.join(INPUTS_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const n of indices) {
    const inputPath = path.join(INPUTS_DIR, `${n}.json`);
    const resultPath = path.join(RESULTS_DIR, `${n}.json`);
    if (!fs.existsSync(inputPath) || !fs.existsSync(resultPath)) continue;
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const json = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const meta = {
      source_type: input.source_type || 'x',
      raw_policy: input.raw_policy || 'url_only',
      date: (input.date && !input.date.startsWith('window')) ? input.date : '',
      window: (input.window && !input.window.startsWith('url:')) ? input.window : '',
      url: input.url || '',
      raw_content: input.raw_content || '',
    };
    const md = buildMdFromJson(json, meta);
    const clipPath = path.join(CLIP_DIR, input.filename);
    fs.writeFileSync(clipPath, md, 'utf8');
    console.log('Wrote', input.filename);
  }
}

const [,, cmd, ...args] = process.argv;
if (cmd === 'prepare') prepare();
else if (cmd === 'build') build(args.map(Number).filter((n) => n >= 1 && n <= 42));
else console.error('Usage: prepare | build 1 2 3 ...');
