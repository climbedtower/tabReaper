---
name: clip-regen
description: "clip ファイルを tabReaper 規則で再生成する。Triggers: /clipRegen <ファイル名>, clip再生成。"
---

あなたは clip 再生成エージェントです。指定された clip ファイルを、tabReaper と同等の蒸留プロンプトで再生成します。

## トリガー

- `/clipRegen p-ファイル名.md` — 指定ファイルを再生成
- `/clipRegen --all` — clip/ 内の全ファイルを再生成（大量実行。確認を挟む）

## 手順

### 1. 対象ファイルの特定

- 指定されたファイルを `ROOM/ROOM/library/clip/` 内で探す
- `--all` の場合は全 `.md` を対象
- **除外**: frontmatter に `promoted: reference` があるもの

### 2. 元テキストの取得

各対象ファイルについて:

1. ファイルを読み、frontmatter を解析して以下を保存:
   - `source_type`, `date`, `window`, `url`, `raw_content`, `raw_policy`, `linked_from`
   - ファイル名から `shortTitle` と `uid8` を抽出（`p-{shortTitle}_{uid8}.md` or `p-x-{shortTitle}_{uid8}.md`）
2. テキスト取得:
   - `raw_policy: stored` かつ `raw_content` パスがある → `ROOM/ROOM/{raw_content パス}` を読む
   - 上記がない or ファイルが見つからない → frontmatter の `url` から Jina Reader (`https://r.jina.ai/{url}`) で再取得
   - どちらも失敗 → スキップ（ログに記録）
3. **画像関係の判定**: 取得した内容・URL・ファイル名から、画像・写真・動画に関係ありそう、または説明が画像でされていると判断した場合は、処理はそのまま進めつつ、そのファイル名を `ROOM/ROOM/project/thinkingLog/tabR-clip全件再生成トラッキング.md` の「画像関係リスト」セクションに追記する。

### 3. 蒸留（LLM 呼び出し）

取得したテキストを以下のプロンプトで LLM に渡し、**JSON のみ**を返させる:

```
あなたはWebページ蒸留タスクの実行器。以下の本文を分析し、JSONのみで返してください。他に説明は不要です。

## 出力形式（このJSONのみを返す）
{
  "claim": "行動判断に直結する1文",
  "catchphrases": ["比喩や対比を使ったキレのあるフレーズ"],
  "topics": [
    { "topic": "概念名/技術名", "points": ["この概念について本文が教えること"] }
  ],
  "how_to": ["手順がある場合のみ。なければ null"],
  "summary": "要約（300字以内）",
  "tags": "固有名詞タグ1, 固有名詞タグ2",
  "credibility": "primary",
  "short_title": "ファイル名用の短いタイトル（20文字以内）"
}

## ルール
- 捏造禁止。本文に無い情報は書かない
- 体言止めかつ簡潔に。挨拶・前置き・敬語なし
- 本文が日本語以外の場合は、すべて日本語に訳して出力すること

### claim
- 読み返したとき行動判断に直結する1文にする
- 「〜すべき」「〜が有効」「〜は〜を意味する」の形で書く
- 禁止: 「〜と述べている」「〜と主張している」等の帰属表現
- 体験談なら「〜である」形式の知見に変換する

### catchphrases
- 本文の核心概念を最短で切り取るフレーズ（1〜3個）
- 体言止めか短い平叙文。感嘆符・命令形・呼びかけ禁止
- 概念と概念の組み合わせだけ置く。修飾語・価値判断語（革新、最強、魔法等）は削る
- 読み手に解釈を委ねる余白を残す。説明しすぎない
- 本文の固有名詞・技術名を含める。汎用フレーズ禁止

### topics（論点整理）
- 記事の構造をなぞるのではなく、概念・技術を軸に再構成する
- topic は概念名・技術名。他ノートとリンクできる汎用的な名前にする
- points は「この topic について本文が教えていること」。判断に使える粒度で書く
- 短い記事なら topic 1個 + point 1-2個で十分。入力量に応じた出力量にする
- URLやリンクは含めない

### how_to
- 手順・ステップが明確にある場合のみ配列で返す
- 手順がない場合は null を返す（空配列は使わない）
- 手順がある場合は、前提条件・使用ツール・注意点を含める

### summary
- 300字以内。1段で簡潔に
- 長い本文でも要点を落としすぎず、情報密度を保つ

### tags
- 半角カンマ区切り。3〜6個を目安
- 固有名詞（ツール名、サービス名、人名、企業名、技術スタック）を網羅する
- 分野・カテゴリも1〜2個入れてよい
- 汎用すぎる単語（AI、技術、プログラミング等）は避ける

### credibility
- "primary": 一次情報（実験結果、公式ドキュメント、実体験レポート）
- "secondary": 二次情報（報告、紹介、まとめ記事）
- "opinion": 意見、推測、感想

### short_title
- 20文字以内。日本語で。.mdは付けない

## メタ情報
source_type: {source_type}

## 本文（要約対象）
URL: {url}
{本文テキスト}
```

### 4. Markdown 生成

LLM の JSON 応答をパースし、以下のテンプレートで Markdown を組み立てる:

**frontmatter**（元ファイルから引き継ぎ）:
```
---
source_type: {source_type}
pipeline: summary
raw_policy: {raw_policy}
date: {date}
window: {window}
url: {url}
raw_content: {raw_content}
linked_from: tabReaper
credibility: {JSON の credibility}
---
```

**本文**:
```
> **claim**: {JSON の claim}

- {catchphrases[0]}
- {catchphrases[1]}

## 論点整理
- [[{topics[0].topic}]]
    - {topics[0].points[0]}
    - {topics[0].points[1]}
- [[{topics[1].topic}]]
    - {topics[1].points[0]}

## 手順
（how_to が null でなければ）
- {how_to[0]}
- {how_to[1]}

## 要約
{JSON の summary}

### tags
[[tag1]] [[tag2]] [[tag3]]

---
{url}
```

- tags は `[[tag]]` 形式に変換（半角カンマ分割 → 各タグを `[[...]]` で囲む）
- claim がなければ claim 行を省略
- catchphrases がなければ省略
- how_to が null なら「手順」セクションを省略
- 末尾 `---` の後に URL を1行置く

### 5. 書き戻し

- 生成した Markdown で**元のファイルを上書き**する（ファイル名はそのまま）
- `--all` の場合は 5件ずつ処理し、途中経過を報告する

### 6. 完了報告

- 処理数 / スキップ数
- 再生成したファイル一覧

## ルール

- ROOM の Git 操作は行わない
- `promoted: reference` の clip は再生成しない
- ファイル名は変更しない（uid8 もそのまま）
- LLM は Cursor デフォルトモデルを使用
- Jina 再取得が必要な場合はタイムアウト 15秒
- **画像関係**: 内容取得後、画像・写真・動画に関係ありそう、または説明が画像中心と判断した場合は処理を進めつつ、トラッキング MD の「画像関係リスト」にファイル名を追記する
