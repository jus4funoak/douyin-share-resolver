/**
 * douyin-share-resolver · 核心解析模块
 *
 * 输入一段某音分享文案（或任意含某音链接的文本），输出该视频的全部可获取信息。
 * 零第三方依赖，依赖 Node 18+ 内置 fetch。
 *
 * 数据链路：
 *   分享文本 → 提取短链 → 跟随重定向 → 提取 aweme_id → Feed API → 解析字段
 *
 * 注意：Feed API 必须用 App 侧 UA（okhttp/3.10.4）。换成浏览器 UA 会只返回几十字节的空包。
 */

// ───────────────────────── 常量 ─────────────────────────

/** Feed API 专用 UA，模拟某音 App 客户端。切勿改成浏览器 UA，否则返回空。 */
const FEED_UA = 'okhttp/3.10.4';
const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FEED_API = 'https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_HOPS = 8;

// ───────────────────────── 工具 ─────────────────────────

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** 去掉粘在 URL 尾部的中文标点/括号等噪声 */
const trimTail = (v) => text(v).replace(/[)\]}>,"'。，、；：！？]+$/g, '');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const withTimeout = (ms) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
};

/** 从各种形态的节点里取第一个 URL：数组 / {url_list} / {urlList} / 字符串 */
const pickFirstUrl = (node) => {
  if (!node) return '';
  if (typeof node === 'string') return text(node);
  if (Array.isArray(node)) return text(node[0]);
  const list = node.url_list || node.urlList;
  if (Array.isArray(list)) return text(list[0]);
  if (typeof node.url === 'string') return text(node.url);
  if (typeof node.uri === 'string') return text(node.uri);
  return '';
};

const pickUrlList = (node) => {
  if (!node) return [];
  if (Array.isArray(node)) return node.map(text).filter(Boolean);
  const list = node.url_list || node.urlList;
  if (Array.isArray(list)) return list.map(text).filter(Boolean);
  return [];
};

const firstNonEmpty = (...vals) => vals.find((v) => text(v)) || '';

// ───────────────────────── URL / ID 提取 ─────────────────────────

/**
 * 优先取 v.douyin.com 短链；否则取第一个某音域名链接；再退化到第一个 http(s) 链接。
 */
export const extractShareUrl = (input) => {
  const s = text(input);
  if (!s) return '';

  const shortMatch = s.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_\-]+\/?/i);
  if (shortMatch) return trimTail(shortMatch[0]);

  const all = s.match(/https?:\/\/[^\s]+/gi) || [];
  let fallback = '';
  let douyin = '';
  for (const raw of all) {
    const candidate = trimTail(raw);
    if (!candidate) continue;
    if (!fallback) fallback = candidate;
    if (!douyin && /douyin\.com|iesdouyin\.com/i.test(candidate)) douyin = candidate;
  }
  return douyin || fallback;
};

/** 支持长链 /video/、老分享链 /share/video/、带 modal_id= 的跳转链 */
export const extractAwemeId = (input) => {
  const s = text(input);
  if (!s) return '';
  const patterns = [
    /\/video\/(\d{10,25})/,
    /\/share\/video\/(\d{10,25})/,
    /[?&]modal_id=(\d{10,25})/,
    /"aweme_id"\s*:\s*"?(\d{10,25})"?/,
    /"itemId"\s*:\s*"?(\d{10,25})"?/
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m?.[1]) return m[1];
  }
  return '';
};

// ───────────────────────── 重定向 ─────────────────────────

/**
 * 手工跟随重定向，返回每一跳，便于排查「短链变了/被拦截」这类问题。
 * @returns {{chain: Array<{url:string,status:number,location:string}>, finalUrl: string}}
 */
export const followRedirect = async (startUrl, { maxHops = DEFAULT_MAX_HOPS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const chain = [];
  let current = startUrl;

  for (let i = 0; i < maxHops; i++) {
    const t = withTimeout(timeoutMs);
    try {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': PC_UA, Referer: 'https://www.douyin.com/' },
        signal: t.signal
      });
      const location = res.headers.get('location') || '';
      chain.push({ url: current, status: res.status, location });

      if (![301, 302, 303, 307, 308].includes(res.status) || !location) break;
      current = new URL(location, current).toString();
    } catch (err) {
      chain.push({ url: current, status: 0, location: '', error: text(err?.message) });
      break;
    } finally {
      t.clear();
    }
  }

  return { chain, finalUrl: current };
};

// ───────────────────────── Feed API ─────────────────────────

/**
 * 调用 Feed API。务必保持 okhttp UA。
 * @returns {{data: object|null, list: Array, httpStatus: number, bytes: number, error: string}}
 */
export const fetchFeed = async (awemeId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const url = `${FEED_API}${encodeURIComponent(awemeId)}`;
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': FEED_UA, Accept: 'application/json' },
      signal: t.signal
    });
    const body = await res.text();
    if (!res.ok) return { data: null, list: [], httpStatus: res.status, bytes: body.length, error: `HTTP ${res.status}` };
    if (!body.trim()) return { data: null, list: [], httpStatus: res.status, bytes: 0, error: 'empty_body' };

    const data = JSON.parse(body);
    const list = Array.isArray(data?.aweme_list) ? data.aweme_list : [];
    return { data, list, httpStatus: res.status, bytes: body.length, error: '' };
  } catch (err) {
    return { data: null, list: [], httpStatus: 0, bytes: 0, error: text(err?.message) };
  } finally {
    t.clear();
  }
};

// ───────────────────────── 字段解析 ─────────────────────────

const parseVideo = (aweme) => {
  const v = aweme?.video || {};
  const durationMs = num(v.duration);
  const bitRate = Array.isArray(v.bit_rate) ? v.bit_rate : Array.isArray(v.bitRate) ? v.bitRate : [];

  const qualities = bitRate
    .map((item) => ({
      gearName: text(item?.gear_name || item?.quality || ''),
      bitRateKbps: num(item?.bit_rate ?? item?.bitRate),
      width: num(item?.play_addr?.width),
      height: num(item?.play_addr?.height),
      dataSize: num(item?.play_addr?.data_size),
      url: pickFirstUrl(item?.play_addr)
    }))
    .filter((q) => q.url);

  const fallbackUrl = firstNonEmpty(pickFirstUrl(v.play_addr), pickFirstUrl(v.playAddr));

  return {
    playUrl: fallbackUrl,
    playUrlList: pickUrlList(v.play_addr) ?? [],
    /** 多清晰度（bit_rate）列表，含 URL，通常比 play_addr 更全 */
    qualities,
    durationMs,
    durationSec: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
    width: num(v.width),
    height: num(v.height),
    ratio: text(v.ratio),
    cover: firstNonEmpty(pickFirstUrl(v.cover), pickFirstUrl(v.origin_cover)),
    coverList: pickUrlList(v.cover),
    originCover: firstNonEmpty(pickFirstUrl(v.origin_cover), pickFirstUrl(v.originCover)),
    dynamicCover: pickFirstUrl(v.dynamic_cover),
    dataSize: num(v.play_addr?.data_size),
    fileCs: text(v.play_addr?.file_cs),
    caption: pickFirstUrl(v.caption)
  };
};

const parseMusic = (aweme) => {
  const m = aweme?.music || {};
  const playUrl = firstNonEmpty(
    pickFirstUrl(m.play_url),
    pickFirstUrl(m.playUrl),
    pickFirstUrl(m.url_list),
    text(aweme?.music_play_url)
  );
  return {
    id: text(m.id ?? m.id_str ?? m.mid),
    title: text(m.title),
    author: text(m.author),
    album: text(m.album),
    durationSec: num(m.duration),
    playUrl,
    playUrlList: pickUrlList(m.play_url),
    coverLarge: pickFirstUrl(m.cover_large) || pickFirstUrl(m.cover_hd),
    /** true 表示这是作者「创作的原声」，其 playUrl 就是人声本身 */
    isOriginalSound: /创作的原声/.test(text(m.title))
  };
};

const parseAuthor = (aweme) => {
  const a = aweme?.author || {};
  return {
    uid: text(a.uid),
    secUid: text(a.sec_uid),
    shortId: text(a.short_id),
    nickname: text(a.nickname),
    customVerify: text(a.custom_verify),
    enterpriseVerify: text(a.enterprise_verify_reason),
    signature: text(a.signature),
    avatar: pickFirstUrl(a.avatar_larger) || pickFirstUrl(a.avatar_thumb),
    followerCount: num(a.follower_count),
    totalFavorited: num(a.total_favorited),
    awemeCount: num(a.aweme_count)
  };
};

const parseStats = (aweme) => {
  const s = aweme?.statistics || aweme?.stats || {};
  return {
    playCount: num(s.play_count),
    diggCount: num(s.digg_count),
    commentCount: num(s.comment_count),
    shareCount: num(s.share_count),
    collectCount: num(s.collect_count),
    downloadCount: num(s.download_count),
    forwardCount: num(s.forward_count)
  };
};

const parseTags = (aweme) => {
  const list = Array.isArray(aweme?.text_extra) ? aweme.text_extra : [];
  return list
    .map((t) => ({
      type: num(t.hashtag_name) === 0 && t.hashtag_name === undefined ? '' : 'hashtag',
      name: text(t.hashtag_name || t.tag_name || t.mention_name)
    }))
    .filter((t) => t.name);
};

// ───────────────────────── 主入口 ─────────────────────────

const fail = (error, extra = {}) => ({
  ok: false,
  error,
  awemeId: '',
  video: null,
  author: null,
  music: null,
  stats: null,
  tags: [],
  ...extra
});

/**
 * 解析某音分享文本，返回命中的所有信息。
 *
 * @param {string} shareText 分享文案 / 链接
 * @param {{timeoutMs?: number, maxHops?: number, includeRaw?: boolean}} [options]
 */
export const resolveShare = async (shareText, options = {}) => {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxHops = DEFAULT_MAX_HOPS, includeRaw = false } = options;
  const startedAt = Date.now();
  const raw = text(shareText);

  if (!raw) return fail('benchmark_video_empty', { elapsedMs: 0 });

  const shareUrl = extractShareUrl(raw);
  if (!shareUrl) return fail('share_url_not_found', { input: raw, elapsedMs: Date.now() - startedAt });
  if (!/douyin\.com|iesdouyin\.com/i.test(shareUrl)) {
    return fail('share_url_not_douyin', { input: raw, shareUrl, elapsedMs: Date.now() - startedAt });
  }

  const { chain, finalUrl } = await followRedirect(shareUrl, { maxHops, timeoutMs });
  const awemeId =
    extractAwemeId(finalUrl) || extractAwemeId(raw) || extractAwemeId(chain.map((h) => h.url).join(' '));
  if (!awemeId) {
    return fail('aweme_id_not_found', {
      input: raw,
      shareUrl,
      redirectChain: chain,
      resolvedUrl: finalUrl,
      elapsedMs: Date.now() - startedAt
    });
  }

  const feed = await fetchFeed(awemeId, { timeoutMs });
  const input = {
    raw,
    shareUrl,
    redirectChain: chain,
    resolvedUrl: finalUrl,
    awemeId,
    feedApi: { httpStatus: feed.httpStatus, bytes: feed.bytes, listSize: feed.list.length, error: feed.error }
  };

  if (feed.error) return fail(`feed_api_failed: ${feed.error}`, { input, elapsedMs: Date.now() - startedAt });

  const matched = feed.list.find((item) => text(item?.aweme_id) === awemeId) || feed.list.find((item) => text(item?.awemeId) === awemeId);
  if (!matched) {
    return fail('aweme_not_matched_in_feed', {
      input,
      /** Feed API 对无效 ID 会返回推荐流而不是报错，这里把返回了哪些 ID 暴露出来便于判断 */
      returnedIds: feed.list.slice(0, 10).map((i) => text(i?.aweme_id)),
      elapsedMs: Date.now() - startedAt
    });
  }

  const result = {
    ok: true,
    error: '',
    elapsedMs: Date.now() - startedAt,
    input,
    video: parseVideo(matched),
    author: parseAuthor(matched),
    music: parseMusic(matched),
    stats: parseStats(matched),
    tags: parseTags(matched),
    desc: text(matched.desc),
    createTime: num(matched.create_time),
    createTimeText: num(matched.create_time) ? new Date(num(matched.create_time) * 1000).toISOString() : '',
    isTop: matched.is_top === 1,
    isAd: matched.is_ad === true || matched.is_ad === 1,
    region: text(matched.region),
    /** 顶层还有哪些字段没解析，方便按需扩展 */
    availableFields: Object.keys(matched || {}),
    ...(includeRaw ? { raw: matched } : {})
  };

  return result;
};

export default resolveShare;
