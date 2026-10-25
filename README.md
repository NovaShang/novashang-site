# nova-site

Personal site for novashang.com — Astro + Tailwind v4, deployed to Cloudflare Pages.

## Stack

- Astro 5 (SSG, no adapter)
- Tailwind CSS v4 via `@tailwindcss/vite`
- Astro Content Collections + MDX for posts/projects
- Astro built-in i18n (`/zh/` + `/en/` prefix routing)
- Astro View Transitions for SPA-style nav + brand-logo morph
- Inter Variable + Noto Sans SC

## Auth

Auth is delegated to `auth.novashang.com` (Better Auth on Cloudflare Workers, repo: `../nova-auth`). Session is shared via `.novashang.com` cross-subdomain cookies. Site fetches `GET /api/me` with `credentials: 'include'` from the browser.

## Develop

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # outputs to dist/
npm run preview
```

## Deploy

```bash
npm run build
npx wrangler pages deploy dist --project-name=nova-site
```

Then bind `novashang.com` and `www.novashang.com` to the Pages project in the Cloudflare dashboard.
