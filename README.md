# tabReaper

全ウィンドウ・タブを構造化リストで取得し、選択して保存できるChrome拡張機能

## 機能

- 開いている全ウィンドウとタブの一覧取得
- ウィンドウ単位・タブ単位での選択
- 選択したタブの情報をMarkdown形式でクリップボードにコピー
- **保存**: 選択タブを web_summary（1タブ1ファイル）と ウィンドウごとのリスト（1ウィンドウ1ファイル）に書き出し（要セットアップ）
- アクティブなタブの内容も取得可能

## インストール

1. このディレクトリ全体をダウンロード
2. Chromeで `chrome://extensions/` を開く
3. 右上の「デベロッパーモード」をONにする
4. 「パッケージ化されていない拡張機能を読み込む」をクリック
5. このディレクトリを選択

## 使い方

1. ツールバーのtabReaperアイコンをクリック
2. 開くと現在のウィンドウのタブを表示。「全ウィンドウ取得」で全ウィンドウを取得可能
3. 取得したいタブにチェックを入れる
4. 「選択をコピー」でクリップボードにコピー、または「保存」でファイルに書き出し

## 保存のセットアップ

Chrome拡張は Downloads 直下のパスにしか保存できないため、**Downloads 内に `toObsidian` フォルダを作り、その中にシンボリックリンクを2本置く**。

### 手順

1. ダウンロードフォルダに `toObsidian` フォルダを作成する。
2. その中に次の2本のシンボリックリンクを置く（リンク先は正のパス）。

```bash
mkdir -p ~/Downloads/toObsidian
ln -s /Users/yuco/Code/ROOM/ROOM/library/webclip/web_summary ~/Downloads/toObsidian/web_summary
ln -s /Users/yuco/Code/ROOM/ROOM/library/webclip ~/Downloads/toObsidian/webclip
```

3. 「保存」を押すと次の2種類が保存される。
   - **タブごとの要約 md**: `ROOM/ROOM/library/webclip/web_summary/p-${short_title}_${uid8}.md`（1タブ1ファイル）
   - **ウィンドウごとのリスト md**: `ROOM/ROOM/library/webclip/${YYYYMMDD}-${window_title}.md`（1ウィンドウ1ファイル。例: `20260213-ウィンドウ1.md`）

### ウィンドウリストの出力形式（1ファイルあたり）

```
[[YYYY-MM-DD]]
- ウィンドウ 1
	- [タイトル](URL)
	- [タイトル](URL)
```

## 制約事項

- Discarded（メモリ解放）状態のタブは内容取得不可
- `chrome://` や `webstore` 等の特権ページは注入不可

## 開発

プロジェクト構成・仕様は `ROOM/ROOM/project/VISION/tabReaper.md` を参照
