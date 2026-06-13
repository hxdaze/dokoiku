# どこいくZUMBA

スポーツジムのスタジオレッスン時間割を、エリア・ジム・曜日・カテゴリー・先生・
フリーワードで検索できる静的サイト（GitHub Pages）。

参照: 「今日はどこでエアロ？」相当のビュー（曜日別 / 時間帯別 / 店舗別 /
カテゴリー別 / 先生別 / はしご / ジム別 / 代行情報）。

## 構成（静的SPA）
- `index.html` … UI（追加サーバ不要）
- `app.js` … データ読み込み・UI制御
- `query.js` … フィルタ/グルーピング（クライアント集計）
- `style.css` … スタイル
- `data/` … `lessons.json` / `meta.json` / `stores.json` / `daiko.json`

データは [getinfo_gym](../) の `build_site.py` で生成しています。

## ローカル確認
```bash
python3 -m http.server 8910
# http://127.0.0.1:8910/
```

## 公開（GitHub Pages）
リポジトリの Settings → Pages で、Branch を `main` / フォルダ `/(root)` に設定。
`.nojekyll` を置いているため `data/` 等もそのまま配信されます。
