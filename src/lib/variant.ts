// One codebase, two builds:
//   global  novashang.com on Cloudflare Pages (default)
//   cn      gaoshang.me on Aliyun ESA: ICP licence in the footer, no sign-in
//           (auth.novashang.com isn't reachable reliably from mainland China)
// Fonts are self-hosted in both, so neither depends on Google Fonts.

export const variant = import.meta.env.PUBLIC_VARIANT === 'cn' ? 'cn' : 'global';
export const isCn = variant === 'cn';

/** ICP licence number for the cn build, e.g. "沪ICP备12345678号". */
export const icp = (import.meta.env.PUBLIC_ICP as string | undefined) ?? '';
