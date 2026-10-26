# novashang-site

Shang Gao's personal site: [novashang.com](https://novashang.com), and the same site for readers in mainland China at [gaoshang.me](https://gaoshang.me).

Astro 5 + Tailwind v4, statically built. Behind every page is a real-time WebGL2 render of the Mac OS X Mountain Lion galaxy (`src/lib/galaxy`): a ray-marched dust volume baked into a 3D texture, GPU-generated stars occluded by that dust, and a camera that moves to a different shot for each page. The magenta tile is an object in that scene on the landing page and docks into the nav as you scroll (`src/lib/brand.ts`).

## Develop

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # global site -> dist/
npm run build:cn   # cn site     -> dist-cn/
```

## Two builds from one codebase

|                  | global (`build`)                | cn (`build:cn`, `PUBLIC_VARIANT=cn`)        |
|------------------|---------------------------------|---------------------------------------------|
| Domain           | novashang.com                   | gaoshang.me                                 |
| Hosting          | Cloudflare Pages (`novashang-site`)  | Aliyun ESA Pages                            |
| Post media       | R2, `storage.novashang.com`     | OSS, `static.gaoshang.me`                   |
| Sign-in          | via auth.novashang.com          | none                                        |
| Footer           |                                 | ICP licence from `PUBLIC_ICP`               |

Fonts are self-hosted in both (`@fontsource-variable/inter`).

## Post media

Write images and downloads as `/media/...` in Markdown. The build rewrites them to R2 (global) or OSS (cn), see `src/lib/media.mjs`.

To add files: put them under the git-ignored `media/` folder with the same layout as the paths, then `npm run media:push` to upload to R2 (the source of truth). CI copies anything OSS is missing before each cn deploy (`npm run media:sync-oss`).

## Deploy

Pushing to `master` runs `.github/workflows/deploy.yml`, which builds and deploys both sites from the same commit. The secrets and variables it needs are listed at the top of that file.

## Auth

Sign-in is delegated to `auth.novashang.com` (separate repo); the session is shared through `.novashang.com` cookies and read from `GET /api/me`.
