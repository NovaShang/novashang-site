export const languages = { zh: '中文', en: 'English' } as const;

export type Lang = keyof typeof languages;

export const defaultLang: Lang = 'zh';

export const ui = {
  zh: {
    'site.title': '高尚',
    'site.tagline': '探索技术与表达的可能',
    'site.description': '高尚的个人主页：项目、文章与思考。',

    'nav.home': '首页',
    'nav.projects': '项目',
    'nav.posts': '文章',

    'theme.toggle': '切换主题',
    'theme.light': '亮色',
    'theme.dark': '深色',
    'theme.system': '跟随系统',

    'lang.switch': 'EN',

    'auth.signin': '登录',
    'auth.signout': '退出',
    'auth.signing_in': '登录中…',

    'home.hero.kicker': '你好，我是',
    'home.hero.name': '高尚',
    'home.hero.role': '独立开发者 / 设计与工程',
    'home.hero.cta_projects': '看看作品',
    'home.hero.cta_posts': '读些文章',

    'home.section.featured_posts': '精选文章',
    'home.section.featured_projects': '精选项目',
    'home.section.see_all': '查看全部 →',

    'projects.title': '项目',
    'projects.subtitle': '一些我做过、还在做、或正在打磨的东西。',
    'projects.empty': '暂无项目。',

    'posts.title': '文章',
    'posts.subtitle': '关于产品、工程、设计与生活的零散记录。',
    'posts.empty': '还没有发布过文章。',
    'posts.read_more': '继续阅读 →',
    'posts.published': '发布于',
    'posts.updated': '更新于',
    'posts.tags': '标签',

    'footer.copyright': '© 高尚',
    'footer.builtwith': '用 Astro 与 Cloudflare 构建',

    '404.title': '页面不见了',
    '404.body': '你访问的页面不存在或已被移走。',
    '404.cta': '回到首页',
  },
  en: {
    'site.title': 'Shang Gao',
    'site.tagline': 'Exploring what to build, and how to say it',
    'site.description': "Shang Gao's personal site — projects, posts, and notes.",

    'nav.home': 'Home',
    'nav.projects': 'Projects',
    'nav.posts': 'Writing',

    'theme.toggle': 'Toggle theme',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'theme.system': 'System',

    'lang.switch': '中',

    'auth.signin': 'Sign in',
    'auth.signout': 'Sign out',
    'auth.signing_in': 'Signing in…',

    'home.hero.kicker': "Hi, I'm",
    'home.hero.name': 'Shang Gao',
    'home.hero.role': 'Independent developer · design & engineering',
    'home.hero.cta_projects': 'See projects',
    'home.hero.cta_posts': 'Read writing',

    'home.section.featured_posts': 'Featured writing',
    'home.section.featured_projects': 'Featured projects',
    'home.section.see_all': 'See all →',

    'projects.title': 'Projects',
    'projects.subtitle': 'Things I have built, am building, or am still polishing.',
    'projects.empty': 'No projects yet.',

    'posts.title': 'Writing',
    'posts.subtitle': 'Scattered notes on product, engineering, design, and life.',
    'posts.empty': 'No posts yet.',
    'posts.read_more': 'Read more →',
    'posts.published': 'Published',
    'posts.updated': 'Updated',
    'posts.tags': 'Tags',

    'footer.copyright': '© Shang Gao',
    'footer.builtwith': 'Built with Astro on Cloudflare',

    '404.title': 'Page not found',
    '404.body': 'The page you were looking for is gone or never existed.',
    '404.cta': 'Back home',
  },
} as const;

export type UIKey = keyof (typeof ui)['zh'];
