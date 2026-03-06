#!/usr/bin/env node
/**
 * jina-retry-bodies の .txt を memory/raw_content へ移動し、
 * 対応する clip の raw_content / raw_policy を更新する。
 * 使い方: node scripts/migrate-jina-bodies-to-raw.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOM = process.env.ROOM || '/Users/yuco/Code/ROOM/ROOM';
const BODIES_DIR = path.join(ROOM, 'project/thinkingLog/jina-retry-bodies');
const RAW_CONTENT_DIR = path.join(ROOM, 'memory/raw_content');
const CLIP_DIR = path.join(ROOM, 'library/clip');

function safeFilename(name) {
  return name.replace(/[^\w\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\-_.]/g, '_').slice(0, 80);
}

function clipStem(filename) {
  return filename.replace(/\.md$/i, '');
}

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

function main() {
  if (!fs.existsSync(BODIES_DIR)) {
    console.log('jina-retry-bodies が存在しません');
    return;
  }

  const clipFiles = fs.readdirSync(CLIP_DIR).filter((f) => f.endsWith('.md'));
  const bodyFiles = fs.readdirSync(BODIES_DIR).filter((f) => f.endsWith('.txt') && !f.includes('/'));

  const clipBySafe = new Map();
  for (const c of clipFiles) {
    const key = safeFilename(c) + '.txt';
    clipBySafe.set(key, c);
  }

  if (!fs.existsSync(RAW_CONTENT_DIR)) fs.mkdirSync(RAW_CONTENT_DIR, { recursive: true });

  let moved = 0;
  let updated = 0;

  for (const bodyFile of bodyFiles) {
    const clipFilename = clipBySafe.get(bodyFile);
    if (!clipFilename) {
      console.log('Skip (no clip match):', bodyFile);
      continue;
    }

    const srcPath = path.join(BODIES_DIR, bodyFile);
    const stem = clipStem(clipFilename);
    const rawContentPath = `memory/raw_content/${stem}.txt`;
    const destPath = path.join(ROOM, rawContentPath);

    if (!fs.existsSync(srcPath)) continue;

    fs.copyFileSync(srcPath, destPath);
    moved++;
    console.log('Moved:', bodyFile, '->', rawContentPath);

    const clipPath = path.join(CLIP_DIR, clipFilename);
    if (fs.existsSync(clipPath)) {
      const content = fs.readFileSync(clipPath, 'utf8');
      const updatedContent = updateClipFrontmatter(content, rawContentPath);
      fs.writeFileSync(clipPath, updatedContent, 'utf8');
      updated++;
      console.log('  Updated clip:', clipFilename);
    }
  }

  // 上記で触っていない clip のうち、raw_content が jina-retry-bodies を指しているものを修正
  for (const clipFilename of clipFiles) {
    const clipPath = path.join(CLIP_DIR, clipFilename);
    const content = fs.readFileSync(clipPath, 'utf8');
    if (!content.includes('jina-retry-bodies')) continue;
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) continue;
    const block = fmMatch[1];
    const rawMatch = block.match(/^raw_content:\s*(.+)$/m);
    if (!rawMatch || !rawMatch[1].includes('jina-retry-bodies')) continue;
    const stem = clipStem(clipFilename);
    const rawContentPath = `memory/raw_content/${stem}.txt`;
    const updatedContent = updateClipFrontmatter(content, rawContentPath);
    fs.writeFileSync(clipPath, updatedContent, 'utf8');
    updated++;
    console.log('Fixed raw_content ref:', clipFilename);
  }

  console.log('Done. Moved', moved, 'files, updated', updated, 'clips.');
}

main();
