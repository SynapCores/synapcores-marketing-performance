/**
 * Dependency-free User-Agent parsing + bot classification for the collector.
 *
 * Deliberately small and rule-ordered (no ua-parser-js): we need browser +
 * version, OS + version, a device class and — the part that matters most here
 * — a reliable bot flag that names AI crawlers/agents separately from search
 * engines, social unfurlers, monitors and scripted HTTP clients.
 *
 * Pure function, unit tested in tests/visitor.test.ts.
 */

import type { CrawlerOperator } from './crawler-ranges';

export type BotCategory = 'ai' | 'search' | 'social' | 'seo' | 'monitor' | 'tool' | 'headless' | 'other';
export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'tv' | 'console' | 'bot' | 'unknown';

export interface ParsedUA {
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  deviceType: DeviceType;
  isBot: boolean;
  botName: string | null;
  botCategory: BotCategory | null;
}

/**
 * Known bots, most specific first. `ai` covers AI training crawlers, AI
 * search/answer-engine crawlers and on-demand AI agents/fetchers. Google-Extended
 * and Applebot-Extended are robots.txt tokens, not UAs, but we match them in case
 * a crawler ever announces them.
 */
type BotRule = [RegExp, string, BotCategory, CrawlerOperator?];
const BOTS: BotRule[] = [
  // — AI crawlers, answer engines and agents —
  [/GPTBot/i, 'GPTBot (OpenAI)', 'ai', 'openai'],
  [/ChatGPT-User/i, 'ChatGPT-User (OpenAI)', 'ai', 'openai'],
  [/OAI-SearchBot/i, 'OAI-SearchBot (OpenAI)', 'ai', 'openai'],
  [/ChatGPT[- ]Agent/i, 'ChatGPT Agent (OpenAI)', 'ai', 'openai'],
  [/ClaudeBot/i, 'ClaudeBot (Anthropic)', 'ai', 'anthropic'],
  [/Claude-User/i, 'Claude-User (Anthropic)', 'ai', 'anthropic'],
  [/Claude-SearchBot/i, 'Claude-SearchBot (Anthropic)', 'ai', 'anthropic'],
  [/Claude-Web|anthropic-ai/i, 'Claude-Web (Anthropic)', 'ai', 'anthropic'],
  [/PerplexityBot/i, 'PerplexityBot', 'ai', 'perplexity'],
  [/Perplexity-User/i, 'Perplexity-User', 'ai', 'perplexity'],
  [/Google-Extended/i, 'Google-Extended', 'ai', 'google'],
  [/Google-CloudVertexBot/i, 'Google-CloudVertexBot', 'ai', 'google'],
  [/GoogleAgent|Google-Agent|Gemini-Deep-Research|Google-NotebookLM/i, 'Google AI Agent', 'ai', 'google'],
  [/Applebot-Extended/i, 'Applebot-Extended', 'ai', 'apple'],
  [/CCBot/i, 'CCBot (Common Crawl)', 'ai', 'commoncrawl'],
  [/Bytespider/i, 'Bytespider (ByteDance)', 'ai'],
  [/meta-externalagent/i, 'Meta-ExternalAgent', 'ai'],
  [/meta-externalfetcher/i, 'Meta-ExternalFetcher', 'ai'],
  [/FacebookBot/i, 'FacebookBot (Meta AI)', 'ai'],
  [/Amazonbot/i, 'Amazonbot', 'ai'],
  [/cohere-ai|cohere-training-data-crawler/i, 'Cohere', 'ai'],
  [/Diffbot/i, 'Diffbot', 'ai'],
  [/YouBot/i, 'YouBot (You.com)', 'ai'],
  [/MistralAI-User/i, 'MistralAI-User', 'ai'],
  [/DeepSeekBot/i, 'DeepSeekBot', 'ai'],
  [/PetalBot/i, 'PetalBot (Huawei)', 'ai'],
  [/AI2Bot/i, 'AI2Bot (Allen AI)', 'ai'],
  [/Timpibot/i, 'Timpibot', 'ai'],
  [/ImagesiftBot/i, 'ImagesiftBot', 'ai'],
  [/omgili/i, 'Omgili (Webz.io)', 'ai'],
  [/Kangaroo Bot/i, 'Kangaroo Bot', 'ai'],
  [/PanguBot/i, 'PanguBot', 'ai'],
  [/iaskspider/i, 'iAskSpider', 'ai'],
  [/DuckAssistBot/i, 'DuckAssistBot', 'ai'],
  [/Phind/i, 'Phind', 'ai'],
  [/FirecrawlAgent|firecrawl/i, 'Firecrawl', 'ai'],
  [/Novellum|QualifiedBot|Brightbot/i, 'AI data crawler', 'ai'],

  // — search engines —
  // Google: every token Google documents for its crawlers and fetchers. The
  // smartphone Googlebot / GoogleOther UAs look like Chrome on a Nexus 5X, so
  // the token is the only UA tell (the IP check in classify.ts is the backstop).
  [/Google-InspectionTool/i, 'Google-InspectionTool', 'search', 'google'],
  [/Googlebot-Image/i, 'Googlebot-Image', 'search', 'google'],
  [/Googlebot-Video/i, 'Googlebot-Video', 'search', 'google'],
  [/Googlebot-News/i, 'Googlebot-News', 'search', 'google'],
  [/Googlebot/i, 'Googlebot', 'search', 'google'],
  [/GoogleOther/i, 'GoogleOther', 'search', 'google'],
  [/AdsBot-Google/i, 'AdsBot-Google', 'search', 'google'],
  [/Mediapartners-Google/i, 'Mediapartners-Google (AdSense)', 'search', 'google'],
  [/APIs-Google/i, 'APIs-Google', 'search', 'google'],
  [/FeedFetcher-Google/i, 'FeedFetcher-Google', 'search', 'google'],
  [/Storebot-Google/i, 'Storebot-Google', 'search', 'google'],
  [/Google-Site-Verification/i, 'Google-Site-Verification', 'other', 'google'],
  [/Google-Read-Aloud/i, 'Google-Read-Aloud', 'other', 'google'],
  [/Google-Safety/i, 'Google-Safety', 'other', 'google'],
  [/GoogleProducer|Google-PageRenderer|Google-Structured-Data|Google-Test|Google Favicon|Google Web Preview|Google-Adwords|DuplexWeb-Google|Google-Apps-Script|Google-Firebase/i, 'Google (service)', 'other', 'google'],
  [/bingbot|BingPreview|msnbot|adidxbot|MicrosoftPreview/i, 'Bingbot', 'search', 'bing'],
  [/Applebot/i, 'Applebot', 'search', 'apple'],
  [/DuckDuckBot|DuckDuckGo-Favicons-Bot/i, 'DuckDuckBot', 'search', 'duckduckgo'],
  [/YandexBot|YandexImages|YandexMobileBot|Yandex(?:[A-Z][a-z]+)+\//, 'YandexBot', 'search'],
  [/Baiduspider/i, 'Baiduspider', 'search'],
  [/Sogou/i, 'Sogou', 'search'],
  [/SeznamBot/i, 'SeznamBot', 'search'],
  [/Qwantify|Qwantbot/i, 'Qwantbot', 'search'],
  [/Yeti\/|NaverBot/i, 'Naver Yeti', 'search'],
  [/Mojeek/i, 'MojeekBot', 'search'],
  [/Slurp/i, 'Yahoo Slurp', 'search'],
  [/coccocbot/i, 'CocCocBot', 'search'],
  [/Brave(?:Search)?Bot|Bravebot/i, 'BraveBot', 'search'],

  // — social / link unfurlers —
  [/facebookexternalhit|facebookcatalog/i, 'Facebook link preview', 'social'],
  [/Twitterbot/i, 'Twitterbot', 'social'],
  [/LinkedInBot/i, 'LinkedInBot', 'social'],
  [/Slackbot|Slack-ImgProxy/i, 'Slackbot', 'social'],
  [/Discordbot/i, 'Discordbot', 'social'],
  [/TelegramBot/i, 'TelegramBot', 'social'],
  [/WhatsApp/i, 'WhatsApp', 'social'],
  [/Pinterestbot/i, 'Pinterestbot', 'social'],
  [/redditbot/i, 'Redditbot', 'social'],
  [/Embedly|Iframely|vkShare|SkypeUriPreview|Snap URL Preview|Mastodon|Bluesky|Cardyb/i, 'Link preview', 'social'],

  // — SEO tools —
  [/AhrefsBot|AhrefsSiteAudit/i, 'AhrefsBot', 'seo'],
  [/SemrushBot|SiteAuditBot/i, 'SemrushBot', 'seo'],
  [/MJ12bot/i, 'MJ12bot (Majestic)', 'seo'],
  [/DotBot/i, 'DotBot (Moz)', 'seo'],
  [/rogerbot/i, 'Rogerbot (Moz)', 'seo'],
  [/Screaming Frog/i, 'Screaming Frog', 'seo'],
  [/serpstatbot|BLEXBot|DataForSeoBot|SEOkicks|barkrowler|Seekport|MegaIndex/i, 'SEO crawler', 'seo'],

  // — uptime / performance monitors —
  [/Chrome-Lighthouse|Lighthouse/i, 'Lighthouse', 'monitor'],
  [/PTST\/|WebPageTest/i, 'WebPageTest', 'monitor'],
  [/GTmetrix/i, 'GTmetrix', 'monitor'],
  [/Pingdom/i, 'Pingdom', 'monitor'],
  [/UptimeRobot/i, 'UptimeRobot', 'monitor'],
  [/StatusCake|Site24x7|Better ?Uptime|Uptime-Kuma|Datadog|NewRelicPinger|Checkly|HetrixTools/i, 'Uptime monitor', 'monitor'],

  // — headless / automation —
  [/HeadlessChrome/i, 'HeadlessChrome', 'headless'],
  [/PhantomJS/i, 'PhantomJS', 'headless'],
  [/Puppeteer|Playwright|Selenium|webdriver|Cypress|Electron\/|SlimerJS|jsdom/i, 'Browser automation', 'headless'],

  // — scripted HTTP clients —
  [/^curl\//i, 'curl', 'tool'],
  [/^Wget/i, 'Wget', 'tool'],
  [/python-requests|python-urllib|aiohttp|httpx|Scrapy/i, 'Python HTTP client', 'tool'],
  [/Go-http-client|^Go \d|fasthttp/i, 'Go HTTP client', 'tool'],
  [/reqwest|^Ruby|Faraday|^PHP|GuzzleHttp|^Dart\/|^Deno\/|^Bun\/|^Wget|^HTTPClient|^lwp-/i, 'HTTP client', 'tool'],
  [/axios|node-fetch|undici|got \(|^node$/i, 'Node HTTP client', 'tool'],
  [/okhttp|Apache-HttpClient|Java\//i, 'Java HTTP client', 'tool'],
  [/libwww-perl|PostmanRuntime|insomnia|HTTPie/i, 'HTTP tool', 'tool'],
];

/** The operator whose published IP list can verify a UA claim (`null` = no list). */
export function botOperator(botName: string | null): CrawlerOperator | null {
  if (!botName) return null;
  for (const [, name, , op] of BOTS) if (name === botName) return op ?? null;
  return null;
}

/** Generic markers that betray an unknown bot. */
const GENERIC_BOT = /bot\b|crawler|spider|crawling|scraper|fetcher|preview|archiver|validator|checker|monitor|feed|httpclient/i;

function ver(m: RegExpExecArray | null, i = 1): string | null {
  const v = m?.[i];
  return v ? v.replace(/_/g, '.') : null;
}

function major(v: string | null, parts = 2): string | null {
  if (!v) return null;
  return v.split('.').slice(0, parts).join('.');
}

function parseBrowser(ua: string): [string | null, string | null] {
  let m: RegExpExecArray | null;
  if ((m = /EdgA?\/([\d.]+)/.exec(ua)) || (m = /Edg(?:e|iOS)\/([\d.]+)/.exec(ua))) return ['Edge', major(ver(m), 1)];
  if ((m = /OPR\/([\d.]+)/.exec(ua)) || (m = /Opera\/[\d.]+.*Version\/([\d.]+)/.exec(ua))) return ['Opera', major(ver(m), 1)];
  if ((m = /SamsungBrowser\/([\d.]+)/.exec(ua))) return ['Samsung Internet', major(ver(m), 1)];
  if ((m = /YaBrowser\/([\d.]+)/.exec(ua))) return ['Yandex Browser', major(ver(m), 1)];
  if ((m = /Vivaldi\/([\d.]+)/.exec(ua))) return ['Vivaldi', major(ver(m), 1)];
  if ((m = /Brave\/([\d.]+)/.exec(ua))) return ['Brave', major(ver(m), 1)];
  if ((m = /DuckDuckGo\/([\d.]+)/.exec(ua))) return ['DuckDuckGo', major(ver(m), 1)];
  if ((m = /(?:FBAN|FBAV)\/([\d.]+)/.exec(ua))) return ['Facebook in-app', major(ver(m), 1)];
  if ((m = /Instagram ([\d.]+)/.exec(ua))) return ['Instagram in-app', major(ver(m), 1)];
  if ((m = /LinkedInApp\/([\d.]+)/.exec(ua))) return ['LinkedIn in-app', major(ver(m), 1)];
  if ((m = /UCBrowser\/([\d.]+)/.exec(ua))) return ['UC Browser', major(ver(m), 1)];
  if ((m = /Firefox\/([\d.]+)/.exec(ua)) || (m = /FxiOS\/([\d.]+)/.exec(ua))) return ['Firefox', major(ver(m), 1)];
  if ((m = /CriOS\/([\d.]+)/.exec(ua))) return ['Chrome', major(ver(m), 1)];
  if ((m = /HeadlessChrome\/([\d.]+)/.exec(ua))) return ['Headless Chrome', major(ver(m), 1)];
  if ((m = /Chrom(?:e|ium)\/([\d.]+)/.exec(ua))) return [/Chromium\//.test(ua) ? 'Chromium' : 'Chrome', major(ver(m), 1)];
  if (/Safari\//.test(ua) && (m = /Version\/([\d.]+)/.exec(ua))) return [/Mobile\//.test(ua) ? 'Mobile Safari' : 'Safari', major(ver(m))];
  if ((m = /MSIE ([\d.]+)/.exec(ua)) || (m = /Trident\/.*rv:([\d.]+)/.exec(ua))) return ['Internet Explorer', major(ver(m), 1)];
  return [null, null];
}

function parseOs(ua: string): [string | null, string | null] {
  let m: RegExpExecArray | null;
  if ((m = /Windows NT ([\d.]+)/.exec(ua))) {
    const nt: Record<string, string> = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7', '6.0': 'Vista', '5.1': 'XP' };
    return ['Windows', nt[m[1]!] ?? m[1]!];
  }
  if (/Windows Phone/.test(ua)) return ['Windows Phone', ver(/Windows Phone(?: OS)? ([\d.]+)/.exec(ua))];
  if ((m = /(?:iPhone|CPU) OS ([\d_]+)/.exec(ua)) && /iPhone|iPad|iPod/.test(ua)) return [/iPad/.test(ua) ? 'iPadOS' : 'iOS', major(ver(m))];
  if ((m = /Mac OS X ([\d_.]+)/.exec(ua))) return ['macOS', major(ver(m))];
  if (/Macintosh/.test(ua)) return ['macOS', null];
  if ((m = /Android ([\d.]+)/.exec(ua))) return ['Android', major(ver(m), 1)];
  if (/Android/.test(ua)) return ['Android', null];
  if ((m = /CrOS \S+ ([\d.]+)/.exec(ua))) return ['ChromeOS', major(ver(m), 1)];
  if (/Ubuntu/.test(ua)) return ['Ubuntu', null];
  if (/Fedora/.test(ua)) return ['Fedora', null];
  if (/Linux/.test(ua)) return ['Linux', null];
  if (/PlayStation/.test(ua)) return ['PlayStation', null];
  if (/Xbox/.test(ua)) return ['Xbox', null];
  return [null, null];
}

function parseDevice(ua: string): DeviceType {
  if (/SMART-TV|SmartTV|GoogleTV|AppleTV|HbbTV|BRAVIA|Roku|AFT[A-Z]|Tizen.*TV|WebOS.*TV|NetCast/i.test(ua)) return 'tv';
  if (/PlayStation|Xbox|Nintendo/i.test(ua)) return 'console';
  if (/iPad|Tablet|PlayBook|Silk|Kindle|SM-T\d|Nexus (?:7|9|10)/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry|Opera Mini|IEMobile/i.test(ua)) return 'mobile';
  if (/Windows|Macintosh|X11|Linux|CrOS/i.test(ua)) return 'desktop';
  return 'unknown';
}

/** Parse a User-Agent into browser / OS / device and a bot verdict. */
export function parseUserAgent(raw: string | null | undefined): ParsedUA {
  const ua = (raw ?? '').trim();
  if (!ua) {
    // Real browsers always send a UA; an empty one is a script.
    return { browser: null, browserVersion: null, os: null, osVersion: null, deviceType: 'unknown', isBot: true, botName: 'Empty user agent', botCategory: 'tool' };
  }
  const [browser, browserVersion] = parseBrowser(ua);
  const [os, osVersion] = parseOs(ua);
  let device = parseDevice(ua);

  let botName: string | null = null;
  let botCategory: BotCategory | null = null;
  for (const [re, name, cat] of BOTS) {
    if (re.test(ua)) { botName = name; botCategory = cat; break; }
  }
  if (!botName && GENERIC_BOT.test(ua) && !/CUBOT|Cubot/.test(ua)) {
    const m = /([A-Za-z][\w.-]*(?:bot|crawler|spider|fetcher))\b/i.exec(ua);
    botName = m?.[1] ?? 'Unknown bot';
    botCategory = 'other';
  }
  // A "browser" UA with no engine tokens at all is not a browser.
  if (!botName && !browser && !/Mozilla\/|Opera/.test(ua)) {
    botName = ua.split(/[\s/;(]/)[0] || 'Unknown client';
    botCategory = 'tool';
  }
  const isBot = botName != null;
  if (isBot && botCategory !== 'headless') device = 'bot';
  return { browser, browserVersion, os, osVersion, deviceType: device, isBot, botName, botCategory };
}
