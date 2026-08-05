// kagayoi.com サブドメイン (grok-plugin.kagayoi.com) のランディングページ配信 Worker。
//
// 姉妹アプリ (Lumin4ti / Lhamiel / Kiriha) の Worker は同一ホスト名に張った R2 カスタム
// ドメインへ更新ファイルを委譲するが、このプラグインは Velopack 配信を持たない
// (Claude Code の /plugin marketplace から GitHub 経由で入る) ため、R2 origin は無い。
// そこで:
//   - "/" と "/index.html" : バンドルしたランディングページ HTML を返す
//   - それ以外のパス        : 404 を返す（存在しない更新パスへ fetch を投げ返さない）
import landingHtml from "./index.html";

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(landingHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
