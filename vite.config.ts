import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const base = "/note-article-manager/";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: "auto",
      manifest: {
        id: base,
        name: "note記事管理",
        short_name: "note記事",
        description: "note記事の公開順・公開状況・転送を管理する個人用アプリ",
        lang: "ja",
        display: "standalone",
        start_url: base,
        scope: base,
        theme_color: "#173f35",
        background_color: "#f6f4ef",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: {
        navigateFallback: "index.html",
        runtimeCaching: [],
      },
    }),
  ],
});
