# Folio PDF · Tauri 試作版

Electron 版の React 画面と PDF.js の描画処理を引き継いだ、Windows 向け Tauri 2 の試作です。Electron プロセスを使用せず、Windows WebView2 上で動作します。Electron 版とは別のアプリ識別子・設定保存先を使います。

## ダウンロード

[Releases](https://github.com/yuma1nu/FolioPDF-Tauri/releases) から Windows x64 用の `Folio.PDF.Tauri_0.1.0_x64-setup.exe` をダウンロードして実行してください。試作版のためプレリリースとして公開しています。インストーラーは未署名です。初回起動には WebView2 Runtime が必要で、未導入の場合はセットアップがダウンロードします。

変更内容と制限は [v0.1.0 リリースノート](docs/release-notes-0.1.0.md) を参照してください。

## 起動とビルド

Node.js 24 以降、pnpm、Rust stable（MSVC）、Visual Studio の「C++ によるデスクトップ開発」と Windows SDK、WebView2 Runtime が必要です。Windows のビルドスクリプトは `vswhere` で C++ ツールのある Visual Studio を探し、開発環境と Rustup の PATH を設定します。

```powershell
git clone https://github.com/yuma1nu/FolioPDF-Tauri.git
cd FolioPDF-Tauri
pnpm install --frozen-lockfile
pnpm dev             # ネイティブウィンドウを開く
pnpm build           # TypeScript 検証と画面のビルド
pnpm build:desktop   # リリース実行ファイルを生成
pnpm dist:win        # NSIS インストーラーを生成
```

実行ファイルは `src-tauri/target/release/folio-pdf-tauri.exe`、インストーラーは `src-tauri/target/release/bundle/nsis/` に出力されます。`pnpm dev:web` は画面の開発サーバーだけを起動します。通常のブラウザーからネイティブ機能は利用できません。

## 試作で対応した機能

- Ctrl+O／ファイル選択／ドロップによる PDF 読み込み、複数タブ。
- PDF.js による描画、サムネイル、ページ移動、全文検索、倍率変更、Space+ドラッグ。
- ページの回転・並べ替え・削除、Undo／Redo、ページ抽出、複数 PDF の結合。
- Ctrl+S で別名保存。原本と読み込み済みファイルへの上書きを拒否し、一時ファイル経由で保存。
- ライト／ダーク／OS の外観、最近開いたファイル、タブと閲覧位置の復元、履歴消去。
- 未保存編集を閉じる際の破棄確認。保存したい場合は確認をキャンセルして Ctrl+S を実行。
- パスワード付き PDF の閲覧。暗号化・署名・権限制限・未対応形式は編集を制限。

## Electron 版との差分・制限

- 単一ウィンドウの試作です。別ウィンドウへの移動、ウィンドウ間転送、印刷は未対応です。
- OS の PDF 関連付け、コマンドラインからの PDF オープン、単一起動制御、外部でのファイル変更監視は未実装です。
- ドロップした PDF は WebView の File API でメモリーに読み込みます。パスを取得しないため、最近使ったファイルや起動時復元には含めません。
- 未保存編集は再起動時に復元しません。復元対象は保存済みファイルと閲覧位置です。Electron 版の履歴は移行しません。
- ページ編集・抽出・結合では、しおり・フォーム・注釈・内部リンクなどを完全には保持できません。保存前に確認します。
- PDF.js と pdf-lib のデータをメモリーに保持します。大きな PDF の保存では IPC の配列転送も使うため、メモリー使用量の最適化は今後の課題です。
- インストーラーと実行ファイルは未署名です。

## 構成と検証

`src/bridge.ts` がタブ・編集履歴・セッションを管理し、既存 UI の `window.folio` API を実装します。`src/pdf-worker.ts` が PDF の検査・出力・結合を Web Worker で実行します。Rust 側の `src-tauri/src/main.rs` はダイアログ、許可済み PDF の読み取り、保存先を選択した PDF の書き込み、設定の永続化を担当します。任意パスへアクセスする汎用ファイルシステム権限はフロント側に与えていません。

```powershell
pnpm test
pnpm test:smoke
pnpm check:rust
pnpm test:rust
pnpm test:native     # build:desktop 後、実 WebView2 と Rust IPC を確認
```

`test:smoke` は Edge のヘッドレスブラウザーを使い、ファイルダイアログなどのネイティブ境界だけをテスト用に差し替えます。実際の PDF.js、画面、ブリッジ、PDF ワーカーを動かして、表示・検索・編集・保存・抽出・結合・復元を確認します。ネイティブダイアログと実 WebView2 での確認は別途必要です。スクリーンショットと検証用 PDF は `test-results/` に生成します。

`test:native` はリリース実行ファイルを起動し、実際の WebView2 で PDF 表示・検索、CSP とワーカー、Rust IPC 経由のセッション保存、ウィンドウ終了を確認します。実ダイアログの操作は含みません。`FOLIO_USER_DATA` で設定保存先を、`WEBVIEW2_USER_DATA_FOLDER` で WebView のデータ保存先をテスト専用ディレクトリへ分けています。

Tauri 設定の参照：[Vite](https://v2.tauri.app/start/frontend/vite/)、[Dialog](https://v2.tauri.app/plugin/dialog/)、[Configuration](https://v2.tauri.app/reference/config/)。

実行済みの検証は [VALIDATION.md](VALIDATION.md) を参照してください。
