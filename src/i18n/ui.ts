export const languages = { zh: '中文', en: 'English' } as const;

export type Lang = keyof typeof languages;

export const defaultLang: Lang = 'zh';

export const contact = {
  email: 'hi@novashang.com',
  github: 'https://github.com/NovaShang',
  linkedin: 'https://www.linkedin.com/in/shanggao666/',
} as const;

export const ui = {
  zh: {
    'site.title': '高尚',
    'site.description': '高尚的个人网站：做过的项目和写过的文章。',

    'nav.home': '首页',
    'nav.projects': '项目',
    'nav.posts': '文章',


    'auth.signin': '登录',
    'auth.signout': '退出',
    'auth.signing_in': '登录中…',

    'home.hero.name': '高尚',
    'home.hero.role': '为 AI 搭一座通往现实世界的桥。',

    'home.hero.alt': 'Shang Gao',
    'home.section.posts': '文章',
    'home.section.projects': '项目',
    'home.posts.all': '全部文章',
    'home.projects.all': '全部 {n} 个',

    'projects.title': '项目',
    'projects.subtitle': '做过的、还在做的东西。都链到项目自己的网站或代码仓库。',
    'projects.group.building': '建筑与工程',
    'projects.group.tools': 'Agent 与效率工具',
    'projects.group.fun': '做着玩的',

    'posts.title': '文章',
    'posts.subtitle': '写 BIM、AI Agent 和工程实践。',
    'posts.empty': '还没有发布过文章。',

    '404.title': '页面不见了',
    '404.body': '你访问的页面不存在或已被移走。',
    '404.cta': '回到首页',
  },
  en: {
    'site.title': 'Shang Gao',
    'site.description': "Shang Gao's personal site: projects and writing.",

    'nav.home': 'Home',
    'nav.projects': 'Projects',
    'nav.posts': 'Writing',


    'auth.signin': 'Sign in',
    'auth.signout': 'Sign out',
    'auth.signing_in': 'Signing in…',

    'home.hero.name': 'Shang Gao',
    'home.hero.role': 'Building the bridge between AI and the physical world.',

    'home.hero.alt': '高尚',
    'home.section.posts': 'Writing',
    'home.section.projects': 'Projects',
    'home.posts.all': 'All writing',
    'home.projects.all': 'All {n} projects',

    'projects.title': 'Projects',
    'projects.subtitle': 'Things I have built or am still building. Each links to its own site or repo.',
    'projects.group.building': 'Buildings & engineering',
    'projects.group.tools': 'Agents & everyday tools',
    'projects.group.fun': 'For fun',

    'posts.title': 'Writing',
    'posts.subtitle': 'On BIM, AI agents and engineering practice.',
    'posts.empty': 'No posts yet.',

    '404.title': 'Page not found',
    '404.body': 'The page you were looking for is gone or never existed.',
    '404.cta': 'Back home',
  },
} as const;

export type UIKey = keyof (typeof ui)['zh'];
