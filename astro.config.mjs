// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { rehypeMedia, rehypeTableScroll } from './src/lib/media.mjs';

const cn = process.env.PUBLIC_VARIANT === 'cn';

export default defineConfig({
  site: cn ? 'https://gaoshang.me' : 'https://novashang.com',
  outDir: cn ? './dist-cn' : './dist',
  output: 'static',
  i18n: {
    locales: ['zh', 'en'],
    defaultLocale: 'zh',
    routing: {
      prefixDefaultLocale: true,
      redirectToDefaultLocale: false,
    },
  },
  markdown: {
    shikiConfig: { theme: 'github-dark' },
    rehypePlugins: [[rehypeMedia, { cn }], rehypeTableScroll],
  },
  integrations: [
    mdx(),
    sitemap({
      i18n: {
        defaultLocale: 'zh',
        locales: { zh: 'zh-CN', en: 'en-US' },
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
