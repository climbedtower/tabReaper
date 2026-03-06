#!/usr/bin/env node
/**
 * 失敗リストのうち「リトライ結果が成功でない」行のみ Jina 取得（30s）。
 * 出力: 1行1ファイル TSV: filename, status, url, bodyPath
 * status: skip_gemini | no_url | timeout | empty | error | ok
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOM = process.env.ROOM || '/Users/yuco/Code/ROOM/ROOM';
const CLIP_DIR = path.join(ROOM, 'library/clip');
const RAW_CONTENT_DIR = path.join(ROOM, 'memory/raw_content');
const JINA_TIMEOUT_MS = 30_000;

// 失敗リストでリトライ結果が空 or 再失敗 の行（#1,2,9,31,122,123,127,131,150 は成功のため含めない）
const RETRY_FILES = [
  '20251207用途に応じたクリッカーの種類と機能を把握する。.md',
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
  'p-x-テトリスでトラウマ軽減_a7bc027e.md',
  'p-x-マグネシウムオイルと睡眠_aa6d1b49.md',
  'p-x-個人開発アプリのワークフロー_c421e9c3.md',
  'p-x-利用規約とプライバシーポリシー_ac55a2f6.md',
  'p-x-味の素コーンポタプロテイン_8ea3385f.md',
  'p-x-売上向上のためのビジネス戦略_8b664b17.md',
  'p-x-感覚と動きの関係_404cb9df.md',
  'p-x-色彩に関するXの投稿_47bd3ee9.md',
  'p-x-論文作成効率化_fa8b2f5f.md',
  'p-コモリ部屋のある家_a6b8c8b9.md',
  'p-ネオ・クイーン・セレニティ撮影_aed9fd39.md',
  'p-個人開発向けテックスタック_ddd31663.md',
  'p-六甲のサンルーム戸建て_227c1800.md',
  'p-思考整理プロンプト_0a94d905.md',
  'p-次世代デジタルライブラリー テキスト_f085ecc9.md',
  'p-理想のタスク管理ツール5年間_3e22ebb8.md',
  'p-生成AIプロンプト集748例_f9ae1f2d.md',
  'p-生成AI質問術_cc8c2e90.md',
  'p-異人館賃貸、神戸市161㎡_7ab64656.md',
  'p-神戸ヴィンテージマンション_19fb71a6.md',
  'p-絵本のようなパステルカラーの家_e718d65b.md',
  'p-絵本カフェ売物件_408b593c.md',
  'p-脳の負荷を減らす仕事術_7cd06ade.md',
  'p-高速用例検索ツール_5980a216.md',
];

function extractUrl(content) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const block = fm[1];
    const u = block.match(/^url:\s*(.+)$/m) || block.match(/^clip_url:\s*(.+)$/m);
    if (u) return u[1].trim();
  }
  const trailing = content.match(/---\r?\n([\s\S]*)$/);
  if (trailing) {
    const u = trailing[1].match(/^url:\s*(.+)$/m);
    if (u) return u[1].trim();
  }
  return null;
}

async function fetchJina(url) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      signal: controller.signal,
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'markdown' },
    });
    clearTimeout(to);
    if (!res.ok) return { ok: false, status: res.status, body: '' };
    const text = await res.text();
    return { ok: true, body: text };
  } catch (e) {
    clearTimeout(to);
    if (e.name === 'AbortError') return { ok: false, timeout: true, body: '' };
    return { ok: false, error: e.message, body: '' };
  }
}

function clipStem(filename) {
  return filename.replace(/\.md$/i, '');
}

/** frontmatter の raw_content と raw_policy を更新 */
function updateClipFrontmatter(content, rawContentPath, rawPolicy = 'stored') {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return content;
  const block = fmMatch[1];
  let out = block.replace(/^raw_content:\s*.*$/m, `raw_content: ${rawContentPath}`);
  if (!/^raw_content:\s/m.test(out)) out = out + '\nraw_content: ' + rawContentPath;
  out = out.replace(/^raw_policy:\s*.*$/m, `raw_policy: ${rawPolicy}`);
  if (!/^raw_policy:\s/m.test(out)) out = out + '\nraw_policy: ' + rawPolicy;
  return '---\n' + out + '\n---' + content.slice(fmMatch[0].length);
}

async function main() {
  if (!fs.existsSync(RAW_CONTENT_DIR)) fs.mkdirSync(RAW_CONTENT_DIR, { recursive: true });

  for (const filename of RETRY_FILES) {
    const filePath = path.join(CLIP_DIR, filename);
    let url = '';
    let bodyPath = '';

    if (!fs.existsSync(filePath)) {
      console.log([filename, 'no_file', '', ''].join('\t'));
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const u = extractUrl(content);
    if (!u) {
      console.log([filename, 'no_url', '', ''].join('\t'));
      continue;
    }
    url = u;

    if (url.includes('gemini.google.com')) {
      console.log([filename, 'skip_gemini', url, ''].join('\t'));
      continue;
    }

    const result = await fetchJina(url);
    if (result.timeout) {
      console.log([filename, 'timeout', url, ''].join('\t'));
      continue;
    }
    if (!result.ok) {
      console.log([filename, 'error', url, ''].join('\t'));
      continue;
    }

    const body = (result.body || '').trim();
    if (body.length < 200) {
      console.log([filename, 'empty', url, ''].join('\t'));
      continue;
    }

    const stem = clipStem(filename);
    const rawContentPath = `memory/raw_content/${stem}.txt`;
    const rawPath = path.join(ROOM, rawContentPath);
    fs.writeFileSync(rawPath, body, 'utf8');
    const updated = updateClipFrontmatter(content, rawContentPath);
    fs.writeFileSync(filePath, updated, 'utf8');
    bodyPath = rawPath;
    console.log([filename, 'ok', url, bodyPath].join('\t'));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
