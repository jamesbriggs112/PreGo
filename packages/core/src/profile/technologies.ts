import type { Page } from 'playwright';

// What a site is built with and runs on, from what any visitor's browser receives: response headers,
// cookie names, the addresses of files the page loads, the generator tag and a few well-known
// markers in the page. Nothing is requested to find out. Prego's own rules (not a third-party
// fingerprint set), so each one can say why it matched.

export type TechCategory =
  | 'Content management'
  | 'Online shop'
  | 'Website builder'
  | 'Framework'
  | 'Hosting'
  | 'Content delivery'
  | 'Web server'
  | 'Language'
  | 'Analytics'
  | 'Tag manager'
  | 'Advertising'
  | 'Consent'
  | 'Chat and support'
  | 'Marketing'
  | 'Fonts'
  | 'Video'
  | 'Maps'
  | 'Payments'
  | 'Security'
  | 'Search'
  | 'Forms'
  | 'Social'
  | 'Reviews'
  | 'Accessibility overlay'
  | 'JavaScript library';

/** Report order. */
export const TECH_CATEGORIES: TechCategory[] = [
  'Content management',
  'Online shop',
  'Website builder',
  'Framework',
  'Language',
  'Web server',
  'Hosting',
  'Content delivery',
  'Security',
  'Analytics',
  'Tag manager',
  'Advertising',
  'Consent',
  'Marketing',
  'Chat and support',
  'Forms',
  'Search',
  'Payments',
  'Reviews',
  'Social',
  'Video',
  'Maps',
  'Fonts',
  'Accessibility overlay',
  'JavaScript library',
];

interface TechRule {
  name: string;
  category: TechCategory;
  /** Response header name (lower case) to a pattern for its value. A capture group is the version. */
  headers?: Record<string, RegExp>;
  cookies?: RegExp;
  /** Addresses of files the page loads (scripts, styles, images, API calls). */
  urls?: RegExp;
  /** The generator meta tag. A capture group is the version. */
  generator?: RegExp;
  /** A global variable the site's own scripts set, checked in the page. */
  global?: string;
  /** A CSS selector for a marker in the page. */
  selector?: string;
  /** The network the server address belongs to (IPtoASN's name). */
  network?: RegExp;
}

export const TECH_RULES: TechRule[] = [
  // Content management
  {
    name: 'WordPress',
    category: 'Content management',
    generator: /^WordPress\s*([\d.]+)?/i,
    urls: /\/wp-(content|includes)\//,
    headers: { link: /rel="https:\/\/api\.w\.org\/"/ },
    global: 'wp',
  },
  {
    name: 'Drupal',
    category: 'Content management',
    generator: /^Drupal\s*([\d.]+)?/i,
    headers: { 'x-generator': /Drupal\s*([\d.]+)?/i, 'x-drupal-cache': /./ },
    urls: /\/sites\/(default|all)\/(files|modules|themes)\//,
    global: 'Drupal',
  },
  { name: 'Joomla', category: 'Content management', generator: /^Joomla!?\s*([\d.]+)?/i, urls: /\/media\/(jui|system)\/js\// },
  { name: 'Umbraco', category: 'Content management', generator: /Umbraco/i, urls: /\/umbraco\//i, headers: { 'x-umbraco-version': /([\d.]+)/ } },
  { name: 'Sitecore', category: 'Content management', cookies: /^(SC_ANALYTICS_GLOBAL_COOKIE|sxa_site|SC_[A-Z_]+)$/, urls: /\/-\/media\/|\/sitecore\//i },
  { name: 'Adobe Experience Manager', category: 'Content management', urls: /\/etc\.clientlibs\/|\/content\/dam\//, selector: '[data-cmp-is]' },
  { name: 'Craft CMS', category: 'Content management', headers: { 'x-powered-by': /Craft CMS/i }, cookies: /^CraftSessionId$/ },
  { name: 'Contentful', category: 'Content management', urls: /\/\/(images|assets|videos)\.ctfassets\.net\// },
  { name: 'Sanity', category: 'Content management', urls: /\/\/cdn\.sanity\.io\// },
  { name: 'Storyblok', category: 'Content management', urls: /\/\/a\.storyblok\.com\// },
  { name: 'Prismic', category: 'Content management', urls: /\/\/images\.prismic\.io\// },
  { name: 'Ghost', category: 'Content management', generator: /^Ghost\s*([\d.]+)?/i },
  { name: 'HubSpot CMS', category: 'Content management', headers: { 'x-hs-hub-id': /./ }, generator: /HubSpot/i },
  { name: 'Kentico', category: 'Content management', cookies: /^CMSPreferredCulture$|^CMSCsrfCookie$/, generator: /Kentico/i },
  { name: 'Statamic', category: 'Content management', headers: { 'x-powered-by': /Statamic/i } },
  { name: 'Strapi', category: 'Content management', headers: { 'x-powered-by': /Strapi/i } },
  { name: 'TYPO3', category: 'Content management', generator: /TYPO3\s*(?:CMS)?\s*([\d.]+)?/i, urls: /\/typo3(conf|temp)\// },
  // Shops and builders
  { name: 'Shopify', category: 'Online shop', urls: /\/\/cdn\.shopify\.com\/|\/cdn\/shop\//, headers: { 'x-shopid': /./, 'x-shopify-stage': /./ }, global: 'Shopify' },
  { name: 'WooCommerce', category: 'Online shop', urls: /\/wp-content\/plugins\/woocommerce\//, selector: 'body.woocommerce, body.woocommerce-page' },
  {
    name: 'Magento (Adobe Commerce)',
    category: 'Online shop',
    cookies: /^(X-Magento-Vary|mage-cache-storage|form_key)$/,
    urls: /\/static\/version\d+\/frontend\//,
    global: 'Mage',
  },
  { name: 'BigCommerce', category: 'Online shop', urls: /\/\/cdn\d*\.bigcommerce\.com\// },
  { name: 'Salesforce Commerce Cloud', category: 'Online shop', urls: /\/on\/demandware\.(store|static)\// },
  { name: 'PrestaShop', category: 'Online shop', generator: /PrestaShop/i, cookies: /^PrestaShop-/ },
  { name: 'Squarespace', category: 'Website builder', urls: /\/\/(static1|images)\.squarespace(-cdn)?\.com\//, global: 'Static.SQUARESPACE_CONTEXT' },
  { name: 'Wix', category: 'Website builder', urls: /\/\/static\.(wixstatic|parastorage)\.com\//, headers: { 'x-wix-request-id': /./ } },
  {
    name: 'Webflow',
    category: 'Website builder',
    generator: /Webflow/i,
    urls: /\/\/(assets|uploads)-global\.website-files\.com\/|\/\/cdn\.prod\.website-files\.com\//,
    global: 'Webflow',
  },
  { name: 'Framer', category: 'Website builder', urls: /\/\/framerusercontent\.com\//, generator: /Framer/i },
  { name: 'Duda', category: 'Website builder', urls: /\/\/irp\.cdn-website\.com\// },
  { name: 'GoDaddy Website Builder', category: 'Website builder', urls: /\/\/img1\.wsimg\.com\// },
  // Frameworks and languages
  { name: 'Next.js', category: 'Framework', urls: /\/_next\/static\//, headers: { 'x-powered-by': /Next\.js\s*([\d.]+)?/i }, global: '__NEXT_DATA__' },
  { name: 'Nuxt', category: 'Framework', urls: /\/_nuxt\//, global: '__NUXT__' },
  { name: 'Gatsby', category: 'Framework', generator: /Gatsby\s*([\d.]+)?/i, selector: '#___gatsby' },
  { name: 'Astro', category: 'Framework', generator: /Astro\s*v?([\d.]+)?/i, selector: 'astro-island' },
  { name: 'SvelteKit', category: 'Framework', urls: /\/_app\/immutable\//, global: '__sveltekit_dev' },
  { name: 'Remix', category: 'Framework', global: '__remixContext' },
  { name: 'Angular', category: 'Framework', selector: '[ng-version]' },
  { name: 'React', category: 'JavaScript library', selector: '[data-reactroot]', global: 'React' },
  { name: 'Vue.js', category: 'JavaScript library', global: '__VUE__', selector: '[data-v-app]' },
  { name: 'jQuery', category: 'JavaScript library', global: 'jQuery' },
  { name: 'Laravel', category: 'Framework', cookies: /^laravel_session$/ },
  { name: 'ASP.NET', category: 'Framework', headers: { 'x-aspnet-version': /([\d.]+)/, 'x-powered-by': /ASP\.NET/i }, cookies: /^(ASP\.NET_SessionId|\.AspNetCore\.)/ },
  { name: 'PHP', category: 'Language', headers: { 'x-powered-by': /PHP\/?([\d.]+)?/i }, cookies: /^PHPSESSID$/ },
  { name: 'Express', category: 'Framework', headers: { 'x-powered-by': /^Express$/i } },
  // Servers, hosts and delivery networks
  { name: 'nginx', category: 'Web server', headers: { server: /nginx\/?([\d.]+)?/i } },
  { name: 'Apache', category: 'Web server', headers: { server: /Apache\/?([\d.]+)?/i } },
  { name: 'Microsoft IIS', category: 'Web server', headers: { server: /Microsoft-IIS\/?([\d.]+)?/i } },
  { name: 'LiteSpeed', category: 'Web server', headers: { server: /LiteSpeed/i } },
  { name: 'Cloudflare', category: 'Content delivery', headers: { 'cf-ray': /./, server: /^cloudflare$/i }, network: /CLOUDFLARENET/i },
  { name: 'Fastly', category: 'Content delivery', headers: { 'x-served-by': /cache-/i, 'fastly-debug-digest': /./ }, network: /FASTLY/i },
  { name: 'Akamai', category: 'Content delivery', headers: { 'x-akamai-transformed': /./, server: /AkamaiGHost|AkamaiNetStorage/i }, network: /AKAMAI/i },
  { name: 'Amazon CloudFront', category: 'Content delivery', headers: { 'x-amz-cf-id': /./, via: /CloudFront/i } },
  { name: 'Azure Front Door', category: 'Content delivery', headers: { 'x-azure-ref': /./ } },
  { name: 'Bunny CDN', category: 'Content delivery', headers: { server: /BunnyCDN/i } },
  { name: 'Vercel', category: 'Hosting', headers: { 'x-vercel-id': /./, server: /^Vercel$/i } },
  { name: 'Netlify', category: 'Hosting', headers: { 'x-nf-request-id': /./, server: /^Netlify$/i } },
  { name: 'GitHub Pages', category: 'Hosting', headers: { server: /^GitHub\.com$/i } },
  { name: 'WP Engine', category: 'Hosting', headers: { 'x-powered-by': /WP Engine/i, wpe: /./ }, network: /WPENGINE/i },
  { name: 'Kinsta', category: 'Hosting', headers: { 'x-kinsta-cache': /./ } },
  { name: 'Pantheon', category: 'Hosting', headers: { 'x-pantheon-styx-hostname': /./ } },
  { name: 'Acquia', category: 'Hosting', headers: { 'x-ah-environment': /./ } },
  { name: 'Automattic (WordPress VIP)', category: 'Hosting', network: /AUTOMATTIC/i, headers: { 'x-hacker': /automattic/i } },
  { name: 'Amazon Web Services', category: 'Hosting', network: /^AMAZON/i },
  { name: 'Google Cloud', category: 'Hosting', network: /^GOOGLE/i },
  { name: 'Microsoft Azure', category: 'Hosting', network: /MICROSOFT/i },
  { name: 'DigitalOcean', category: 'Hosting', network: /DIGITALOCEAN/i },
  { name: 'OVHcloud', category: 'Hosting', network: /^OVH/i },
  { name: 'Hetzner', category: 'Hosting', network: /HETZNER/i },
  { name: 'Linode (Akamai)', category: 'Hosting', network: /LINODE/i },
  { name: 'IONOS', category: 'Hosting', network: /IONOS|1AND1/i },
  { name: 'GoDaddy', category: 'Hosting', network: /GODADDY/i },
  { name: 'Rackspace', category: 'Hosting', network: /RACKSPACE/i },
  { name: 'Krystal', category: 'Hosting', network: /KRYSTAL/i },
  { name: 'Wordfence', category: 'Security', urls: /\/wp-content\/plugins\/wordfence\// },
  { name: 'Sucuri', category: 'Security', headers: { 'x-sucuri-id': /./, server: /Sucuri/i } },
  { name: 'Imperva', category: 'Security', headers: { 'x-iinfo': /./ }, cookies: /^(incap_ses|visid_incap)_/ },
  { name: 'reCAPTCHA', category: 'Security', urls: /\/\/www\.(google|gstatic)\.com\/recaptcha\// },
  { name: 'hCaptcha', category: 'Security', urls: /\/\/(js\.)?hcaptcha\.com\// },
  { name: 'Cloudflare Turnstile', category: 'Security', urls: /\/\/challenges\.cloudflare\.com\/turnstile\// },
  // Measurement and marketing
  {
    name: 'Google Analytics',
    category: 'Analytics',
    urls: /\/\/(www\.)?google-analytics\.com\/|\/\/[a-z0-9.-]*analytics\.google\.com\/|googletagmanager\.com\/gtag\/js/,
    cookies: /^_ga(_|$)/,
  },
  { name: 'Google Tag Manager', category: 'Tag manager', urls: /\/\/www\.googletagmanager\.com\/gtm\.js/, global: 'google_tag_manager' },
  { name: 'Adobe Analytics', category: 'Analytics', urls: /\/\/assets\.adobedtm\.com\/|\.omtrdc\.net\/|\/\/[a-z0-9.-]+\.2o7\.net\// },
  { name: 'Matomo', category: 'Analytics', urls: /\/matomo\.(js|php)|\/piwik\.(js|php)/, cookies: /^_pk_(id|ses)/ },
  { name: 'Plausible', category: 'Analytics', urls: /\/\/plausible\.io\/js\// },
  { name: 'Fathom', category: 'Analytics', urls: /\/\/cdn\.usefathom\.com\// },
  { name: 'Hotjar', category: 'Analytics', urls: /\/\/[a-z0-9.-]*hotjar\.(com|io)\// },
  { name: 'Microsoft Clarity', category: 'Analytics', urls: /\/\/[a-z0-9.-]*clarity\.ms\// },
  { name: 'Mixpanel', category: 'Analytics', urls: /\/\/[a-z0-9.-]*(mixpanel\.com|mxpnl\.com)\// },
  { name: 'Segment', category: 'Analytics', urls: /\/\/cdn\.segment\.(com|io)\// },
  { name: 'Contentsquare', category: 'Analytics', urls: /\/\/t\.contentsquare\.net\// },
  { name: 'Google Ads', category: 'Advertising', urls: /\/\/[a-z0-9.-]*(doubleclick\.net|googlesyndication\.com|googleadservices\.com)\// },
  { name: 'Meta (Facebook) Pixel', category: 'Advertising', urls: /\/\/connect\.facebook\.net\/|\/\/www\.facebook\.com\/tr/ },
  { name: 'LinkedIn Insight', category: 'Advertising', urls: /\/\/snap\.licdn\.com\/|\/\/px\.ads\.linkedin\.com\// },
  { name: 'Microsoft Advertising', category: 'Advertising', urls: /\/\/bat\.bing\.com\// },
  { name: 'TikTok Pixel', category: 'Advertising', urls: /\/\/analytics\.tiktok\.com\// },
  { name: 'X (Twitter) Ads', category: 'Advertising', urls: /\/\/static\.ads-twitter\.com\/|\/\/analytics\.twitter\.com\// },
  { name: 'Pinterest Tag', category: 'Advertising', urls: /\/\/s\.pinimg\.com\/ct\/|\/\/ct\.pinterest\.com\// },
  { name: 'Criteo', category: 'Advertising', urls: /\/\/[a-z0-9.-]*criteo\.(com|net)\// },
  { name: 'HubSpot', category: 'Marketing', urls: /\/\/js\.(hs-scripts|hs-analytics|hsforms|hs-banner|usemessages)\.(com|net)\/|\/\/js\.hsforms\.net\// },
  { name: 'Mailchimp', category: 'Marketing', urls: /\/\/[a-z0-9.-]*(chimpstatic\.com|list-manage\.com)\// },
  { name: 'Klaviyo', category: 'Marketing', urls: /\/\/static\.klaviyo\.com\// },
  { name: 'Marketo', category: 'Marketing', urls: /\/\/munchkin\.marketo\.net\// },
  { name: 'Salesforce Pardot', category: 'Marketing', urls: /\/\/pi\.pardot\.com\// },
  { name: 'Cookiebot', category: 'Consent', urls: /\/\/consent(cdn)?\.cookiebot\.(com|eu)\// },
  { name: 'OneTrust', category: 'Consent', urls: /\/\/cdn\.cookielaw\.org\/|\/\/[a-z0-9.-]*onetrust\.com\// },
  { name: 'CookieYes', category: 'Consent', urls: /\/\/cdn-cookieyes\.com\// },
  { name: 'Civic Cookie Control', category: 'Consent', urls: /\/\/cc\.cdn\.civiccomputing\.com\// },
  { name: 'Termly', category: 'Consent', urls: /\/\/app\.termly\.io\// },
  { name: 'Iubenda', category: 'Consent', urls: /\/\/cdn\.iubenda\.com\// },
  { name: 'Complianz', category: 'Consent', urls: /\/wp-content\/plugins\/complianz-gdpr/ },
  { name: 'Intercom', category: 'Chat and support', urls: /\/\/(widget|js)\.intercom(cdn)?\.(io|com)\// },
  { name: 'Zendesk', category: 'Chat and support', urls: /\/\/static\.zdassets\.com\// },
  { name: 'Drift', category: 'Chat and support', urls: /\/\/js\.driftt\.com\// },
  { name: 'LiveChat', category: 'Chat and support', urls: /\/\/cdn\.livechatinc\.com\// },
  { name: 'Tidio', category: 'Chat and support', urls: /\/\/code\.tidio\.co\// },
  { name: 'Tawk.to', category: 'Chat and support', urls: /\/\/embed\.tawk\.to\// },
  { name: 'Freshchat', category: 'Chat and support', urls: /\/\/wchat\.freshchat\.com\// },
  { name: 'Crisp', category: 'Chat and support', urls: /\/\/client\.crisp\.chat\// },
  { name: 'Gravity Forms', category: 'Forms', urls: /\/wp-content\/plugins\/gravityforms\// },
  { name: 'Contact Form 7', category: 'Forms', urls: /\/wp-content\/plugins\/contact-form-7\// },
  { name: 'Typeform', category: 'Forms', urls: /\/\/embed\.typeform\.com\// },
  { name: 'Jotform', category: 'Forms', urls: /\/\/(cdn|form)\.jotform\.com\// },
  { name: 'Algolia', category: 'Search', urls: /\/\/[a-z0-9.-]*algolia(net)?\.(com|net|io)\// },
  { name: 'Stripe', category: 'Payments', urls: /\/\/js\.stripe\.com\// },
  { name: 'PayPal', category: 'Payments', urls: /\/\/www\.paypal(objects)?\.com\/sdk|\/\/www\.paypalobjects\.com\// },
  { name: 'Klarna', category: 'Payments', urls: /\/\/[a-z0-9.-]*klarna(cdn|services)?\.(com|net)\// },
  { name: 'Trustpilot', category: 'Reviews', urls: /\/\/widget\.trustpilot\.com\// },
  { name: 'Feefo', category: 'Reviews', urls: /\/\/api\.feefo\.com\// },
  { name: 'Reviews.io', category: 'Reviews', urls: /\/\/widget\.reviews\.(io|co\.uk)\// },
  { name: 'AddToAny', category: 'Social', urls: /\/\/static\.addtoany\.com\// },
  { name: 'ShareThis', category: 'Social', urls: /\/\/[a-z0-9.-]*sharethis\.com\// },
  { name: 'Instagram embed', category: 'Social', urls: /\/\/www\.instagram\.com\/embed/ },
  { name: 'YouTube', category: 'Video', urls: /\/\/(www\.)?(youtube(-nocookie)?\.com\/(embed|iframe_api|s\/player)|ytimg\.com\/)/ },
  { name: 'Vimeo', category: 'Video', urls: /\/\/(player\.vimeo\.com|f\.vimeocdn\.com)\// },
  { name: 'Wistia', category: 'Video', urls: /\/\/fast\.wistia\.(com|net)\// },
  { name: 'Google Maps', category: 'Maps', urls: /\/\/maps\.(googleapis|gstatic)\.com\/|\/\/www\.google\.com\/maps\/embed/ },
  { name: 'Mapbox', category: 'Maps', urls: /\/\/api\.mapbox\.com\// },
  { name: 'Google Fonts', category: 'Fonts', urls: /\/\/fonts\.(googleapis|gstatic)\.com\// },
  { name: 'Adobe Fonts', category: 'Fonts', urls: /\/\/use\.typekit\.net\/|\/\/p\.typekit\.net\// },
  { name: 'Font Awesome', category: 'Fonts', urls: /\/\/(kit|use|ka-f)\.fontawesome\.com\/|font-?awesome/i },
  { name: 'UserWay', category: 'Accessibility overlay', urls: /\/\/cdn\.userway\.org\// },
  { name: 'accessiBe', category: 'Accessibility overlay', urls: /\/\/acsbapp?\.com\/|\/\/acsbap\.com\// },
  { name: 'AudioEye', category: 'Accessibility overlay', urls: /\/\/[a-z0-9.-]*audioeye\.com\// },
  { name: 'Recite Me', category: 'Accessibility overlay', urls: /\/\/api\.reciteme\.com\// },
  { name: 'EqualWeb', category: 'Accessibility overlay', urls: /\/\/cdn\.equalweb\.com\// },
];

export interface DetectedTech {
  name: string;
  category: TechCategory;
  version: string | null;
  /** Why Prego thinks so, in plain words, e.g. `files from /wp-content/`. */
  evidence: string;
}

export interface TechSignals {
  headers: Record<string, string>;
  cookies: string[];
  urls: string[];
  generator: string | null;
  /** Rule names whose global or selector was found in the page. */
  markers: string[];
  network: string | null;
}

/** Read the generator tag and the rules' markers from the page. */
export async function readTechMarkers(page: Page): Promise<{ generator: string | null; markers: string[] }> {
  const probes = TECH_RULES.filter((r) => r.global || r.selector).map((r) => ({ name: r.name, global: r.global ?? null, selector: r.selector ?? null }));
  return page.evaluate((list) => {
    const has = (path: string) => {
      let value: unknown = window;
      for (const key of path.split('.')) {
        if (value === null || value === undefined) return false;
        value = (value as Record<string, unknown>)[key];
      }
      return value !== undefined && value !== null;
    };
    const markers = list
      .filter((p) => {
        try {
          return (p.global && has(p.global)) || (p.selector && document.querySelector(p.selector));
        } catch {
          return false;
        }
      })
      .map((p) => p.name);
    return { generator: document.querySelector('meta[name="generator" i]')?.getAttribute('content')?.trim() || null, markers };
  }, probes);
}

const shortUrl = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.length > 40 ? `${u.pathname.slice(0, 40)}…` : u.pathname}`;
  } catch {
    return url.slice(0, 60);
  }
};

/** Headers whose value says something to a person; others (request IDs) are only named. */
const SHOW_VALUE = new Set(['server', 'x-powered-by', 'x-generator', 'via', 'x-umbraco-version', 'x-aspnet-version']);

/** Match the rules against what the browser received. */
export function detectTechnologies(signals: TechSignals): DetectedTech[] {
  const headers = Object.fromEntries(Object.entries(signals.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: DetectedTech[] = [];
  for (const rule of TECH_RULES) {
    let evidence: string | null = null;
    let version: string | null = null;
    if (rule.generator && signals.generator) {
      const m = rule.generator.exec(signals.generator);
      if (m) [evidence, version] = [`generator tag “${signals.generator}”`, m[1] ?? null];
    }
    for (const [name, pattern] of Object.entries(rule.headers ?? {})) {
      if (evidence && version) break;
      const value = headers[name];
      const m = value !== undefined ? pattern.exec(value) : null;
      if (m) {
        evidence ??= `${name} header${SHOW_VALUE.has(name) && value.length < 60 ? `: ${value}` : ''}`;
        version ??= m[1] ?? null;
      }
    }
    if (!evidence && rule.cookies) {
      const cookie = signals.cookies.find((c) => rule.cookies!.test(c));
      if (cookie) evidence = `${cookie} cookie`;
    }
    if (!evidence && rule.urls) {
      const url = signals.urls.find((u) => rule.urls!.test(u));
      if (url) evidence = `loads ${shortUrl(url)}`;
    }
    if (!evidence && signals.markers.includes(rule.name)) evidence = rule.global && !rule.selector ? `the page sets ${rule.global}` : 'a marker in the page';
    if (!evidence && rule.network && signals.network && rule.network.test(signals.network)) evidence = `the server’s address belongs to ${signals.network}`;
    if (evidence) out.push({ name: rule.name, category: rule.category, version, evidence });
  }
  return out;
}

/** Categories that describe how a site is built, not an outside service it loads. */
const NOT_SERVICES = new Set<TechCategory>(['Content management', 'Framework', 'Web server', 'Language', 'JavaScript library']);

/** The named service a third-party address belongs to, if Prego knows it. */
export function serviceFor(url: string): { name: string; category: TechCategory } | null {
  const rule = TECH_RULES.find((r) => r.urls && r.urls.test(url) && !NOT_SERVICES.has(r.category));
  return rule ? { name: rule.name, category: rule.category } : null;
}
