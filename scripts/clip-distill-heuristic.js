#!/usr/bin/env node
/**
 * 入力JSONの body からヒューリスティックで蒸留JSONを生成し results/N.json に保存。
 * 完全なLLM蒸留の代わりに、本文の先頭・キー文から claim/summary/topics を組み立てる。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOM = process.env.ROOM || '/Users/yuco/Code/ROOM/ROOM';
const WORK_DIR = path.join(ROOM, 'project/thinkingLog/jina-retry-bodies');
const INPUTS_DIR = path.join(WORK_DIR, 'inputs');
const RESULTS_DIR = path.join(WORK_DIR, 'results');

function stripJinaNoise(text) {
  return text
    .replace(/\s*\/ X\s*\n===============.*?(?=\n\n[^\n]|$)/gs, ' ')
    .replace(/\[.*?\]\(https?:\/\/[^)]+\)/g, '')
    .replace(/Don't miss what's happening[\s\S]*?Conversation\s*============/g, ' ')
    .replace(/Translate post[\s\S]*?© \d+ .*?Corp\.?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMeaningfulBlock(body, maxLen = 600) {
  const cleaned = stripJinaNoise(body);
  const s = cleaned.slice(0, maxLen);
  const dot = s.lastIndexOf('。');
  if (dot > 200) return s.slice(0, dot + 1);
  return s;
}

function distill(input) {
  const body = (input.body || '').trim();
  const main = firstMeaningfulBlock(body, 1200);
  const shortTitle = (input.filename || '').replace(/\.md$/, '').replace(/^\d+/, '').slice(-25);
  const claim = main.split(/[。\n]/).filter((s) => s.length > 20 && s.length < 120)[0] || main.slice(0, 80);
  const summary = main.slice(0, 280);
  const topics = [{ topic: '本文', points: [main.slice(0, 200)] }];
  const tags = 'X,要約';
  return {
    claim: claim.endsWith('。') ? claim : claim + '。',
    catchphrases: [main.slice(0, 60)],
    topics,
    how_to: null,
    summary,
    tags,
    credibility: 'secondary',
    short_title: shortTitle,
  };
}

function main() {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(INPUTS_DIR, 'manifest.json'), 'utf8'));
  for (let n = 1; n <= manifest.length; n++) {
    const inputPath = path.join(INPUTS_DIR, `${n}.json`);
    if (!fs.existsSync(inputPath)) continue;
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const json = distill(input);
    fs.writeFileSync(path.join(RESULTS_DIR, `${n}.json`), JSON.stringify(json, null, 0), 'utf8');
  }
  console.log('Wrote', manifest.length, 'results');
}

main();
