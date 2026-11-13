# 試作版の検証記録

検証日：2026-11-13。Windows x64、Node.js 24.22.1、pnpm 11.25.0、Rust 1.99.1、Visual Studio 2022 / Windows SDK 10.0.26100.0。

| 対象 | 結果 |
| --- | --- |
| Electron 版の移動後 `pnpm test` | 既存 6 テスト成功。 |
| Electron 版の移動後 `pnpm build` | TypeScript、Vite、Electron の各ビルド成功。 |
| Tauri 版 `pnpm build` | TypeScript と Vite のビルド成功。 |
| Tauri 版 `pnpm test` | ページ指定・並べ替え・回転／削除の 3 テスト成功。 |
| Tauri 版 `pnpm test:smoke` | 実 PDF.js と Web Worker で表示・検索・倍率変更・回転／移動／削除・Undo・閉じる／保存のキャンセル・原本上書きの拒否・保存・抽出・結合・外観・復元・ドロップを確認。出力 PDF のページ数と回転、原本のバイト不変を確認。ネイティブ境界はテスト用に差し替え。 |
| Tauri 版 `pnpm check:rust` | Rust のコンパイル確認成功。 |
| Tauri 版 `pnpm test:rust` | PDF パス検証と一時ファイル経由の置換保存の 2 テスト成功。 |
| Tauri 版 `pnpm build:desktop` | リリース版 `src-tauri/target/release/folio-pdf-tauri.exe` を生成。 |
| Tauri 版 `pnpm test:native` | 生成したリリース実行ファイルを実際に起動。WebView2 上での本番アセット・CSP・ワーカー・PDF の描画／検索、Rust IPC の設定保存、ネイティブウィンドウ終了を確認。 |
| Tauri 版 `pnpm dist:win` | v0.1.0 の Windows x64 NSIS インストーラーを生成（4,857,004 バイト）。リリース添付時に SHA-256 を記録。 |

公開前に単体テスト 3 件、Rust テスト 2 件、画面スモークテスト、生成したリリース実行ファイルのネイティブスモークテストを再実行し、すべて成功しました。インストーラーを使ったインストール／アンインストール操作は未検証です。

画面テストのスクリーンショットは `test-results/`、実 WebView2 のスクリーンショットと独立したプロファイルは `test-results/native-*/` にあります。

ネイティブのファイル選択／保存ダイアログの手動操作、実プリンター、OS のファイル関連付け、大容量 PDF の長時間利用、暗号化・署名付き PDF の網羅的な互換性試験は実施していません。試作版の未対応機能は [README.md](README.md) に記載しています。
