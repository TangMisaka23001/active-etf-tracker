// @ts-check
import { defineConfig } from 'astro/config';

// 部署到 GitHub Pages 时，把 site 改成你的 Pages 地址，
// 例如 https://<用户名>.github.io/active-etf-tracker/
// 本地构建不需要改。
export default defineConfig({
  site: 'https://example.github.io/active-etf-tracker/',
  base: '/active-etf-tracker/',
});
