// ==UserScript==
// @name         Bilibili Comment Sidecar
// @namespace    local.bilibili.comment.sidecar
// @version      0.8.0
// @description  Show Bilibili video comments beside the player.
// @author       weibin.fang
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/watchlater*
// @run-at       document-end
// @grant        GM_addStyle
// @grant        GM.addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// ==/UserScript==

(function () {
  'use strict';

  /* ── fetch interceptor: capture B站 native reply API calls ── */
  let _interceptedReplyData = null;
  let _interceptResolve = null;
  const _originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (url.includes('/x/v2/reply/') && url.includes('main')) {
      console.log('[BCS] Intercepted native reply API call:', url);
      return _originalFetch.apply(this, args).then(resp => {
        const clone = resp.clone();
        clone.json().then(data => {
          console.log('[BCS] Captured native reply data - code:', data?.code, 'replies:', data?.data?.replies?.length);
          _interceptedReplyData = data;
          if (_interceptResolve) { _interceptResolve(data); _interceptResolve = null; }
        }).catch(e => console.error('[BCS] Failed to parse intercepted response:', e));
        return resp;
      });
    }
    return _originalFetch.apply(this, args);
  };

  /* ── XHR interceptor: capture B站 native reply API calls via XHR ── */
  const _originalXHROpen = XMLHttpRequest.prototype.open;
  const _originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._bcs_url = url;
    return _originalXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      if (this._bcs_url && this._bcs_url.includes('/x/v2/reply') && this._bcs_url.includes('main')) {
        console.log('[BCS] Intercepted XHR reply API:', this._bcs_url.substring(0, 200));
        try {
          const data = JSON.parse(this.responseText);
          console.log('[BCS] XHR reply - code:', data?.code, 'cursor:', JSON.stringify(data?.data?.cursor));
        } catch(e) {}
      }
    });
    return _originalXHRSend.apply(this, args);
  };

  /* ── scan __INITIAL_STATE__ for cursor data ── */
  try {
    const st = window.__INITIAL_STATE__;
    if (st) {
      console.log('[BCS] __INITIAL_STATE__ keys:', Object.keys(st).join(','));
      if (st.reply) console.log('[BCS] __INITIAL_STATE__.reply keys:', Object.keys(st.reply).join(','));
      if (st.comments) console.log('[BCS] __INITIAL_STATE__.comments keys:', Object.keys(st.comments).join(','));
    }
  } catch(e) { console.log('[BCS] __INITIAL_STATE__ error:', e.message); }

  /* ── config ───────────────────────────────────────────── */
  const CFG = {
    pageSize: 20, childPageSize: 10,
    retryDelay: 350, maxRetryDelay: 2000,
    minWidth: 380, maxWidth: 460, gap: 16,
    topFallback: 72, bottomGap: 16
  };

  const VIDEO_RE = /^https:\/\/www\.bilibili\.com\/(video|list\/watchlater)/;
  const PLAYER_SEL = ['#bilibili-player','.bpx-player-container','.player-wrap','#playerWrap','.video-player'];
  const HIDE_SEL = '#commentapp,bili-comments,.reply-warp,.comment-module,.video-comment';
  // Selectors for right-side content that might be covered by sidecar
  const RIGHT_CONTENT_SEL = '.recommend-list,#reco_list,.right-container,.video-page-card-right,#slide_ad,.pop-live-small-mode';

  /* ── state ───────────────────────────────────────────── */
  const S = {
    url: location.href, aid: null, bvid: null,
    paginationOffset: '', loading: false, done: false,
    retryTimer: null, guardTimer: null,
    host: null, shadow: null,
    sidecar: null, list: null,
    status: null, count: null, loadMore: null, backToTop: null,
    repliedRpidSet: new Set()  // Track replied comment IDs in current session
  };

  /* ── WBI signing ────────────────────────────────────── */
  const WBI_MIXIN_TABLE = [
    46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,
    27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,
    37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,
    22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,47
  ];
  let _wbiKeys = null;

  async function getWbiKeys() {
    if (_wbiKeys) return _wbiKeys;
    console.log('[BCS] Fetching WBI keys from nav API...');
    const resp = await fetchJSON('https://api.bilibili.com/x/web-interface/nav');
    console.log('[BCS] Nav API code:', resp?.code);
    if (resp?.code !== 0) throw new Error('Failed to get WBI keys: ' + (resp?.message || 'unknown'));
    const img = resp.data.wbi_img.img_url;
    const sub = resp.data.wbi_img.sub_url;
    // WBI keys obtained (debug logging suppressed)
    _wbiKeys = {
      img_key: img.split('/').pop().split('.')[0].slice(0, 32),
      sub_key: sub.split('/').pop().split('.')[0].slice(0, 32)
    };

    return _wbiKeys;
  }

  function getMixinKey(raw) {
    let s = '';
    for (let i = 0; i < 32; i++) s += raw[WBI_MIXIN_TABLE[i]];
    return s;
  }

  async function signWbiParams(params) {
    const keys = await getWbiKeys();
    const rawKey = keys.img_key + keys.sub_key;
    const mixinKey = getMixinKey(rawKey);
    params.wts = Math.floor(Date.now() / 1000);
    console.log('[BCS] WBI sign - params:', JSON.stringify(params));
    // Sort by key and build query string
    const sortedKeys = Object.keys(params).sort();
    const qs = sortedKeys
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');

    const w_rid = md5(qs + mixinKey);

    return qs + '&w_rid=' + w_rid;
  }

  /* ── minimal MD5 implementation ──────────────────────── */
  function md5(string) {
    function md5cycle(x, k) {
      let a = x[0], b = x[1], c = x[2], d = x[3];
      const ff = (a,b,c,d,x,s,ac) => { a += (b&c|~b&d) + x + ac; return ((a<<s)|(a>>>(32-s))) + b; };
      const gg = (a,b,c,d,x,s,ac) => { a += (b&d|c&~d) + x + ac; return ((a<<s)|(a>>>(32-s))) + b; };
      const hh = (a,b,c,d,x,s,ac) => { a += (b^c^d) + x + ac; return ((a<<s)|(a>>>(32-s))) + b; };
      const ii = (a,b,c,d,x,s,ac) => { a += (c^(b|~d)) + x + ac; return ((a<<s)|(a>>>(32-s))) + b; };
      a=ff(a,b,c,d,k[0],7,-680876936);d=ff(d,a,b,c,k[1],12,-389564586);c=ff(c,d,a,b,k[2],17,606105819);b=ff(b,c,d,a,k[3],22,-1044525330);
      a=ff(a,b,c,d,k[4],7,-176418897);d=ff(d,a,b,c,k[5],12,1200080426);c=ff(c,d,a,b,k[6],17,-1473231341);b=ff(b,c,d,a,k[7],22,-45705983);
      a=ff(a,b,c,d,k[8],7,1770035416);d=ff(d,a,b,c,k[9],12,-1958414417);c=ff(c,d,a,b,k[10],17,-42063);b=ff(b,c,d,a,k[11],22,-1990404162);
      a=ff(a,b,c,d,k[12],7,1804603682);d=ff(d,a,b,c,k[13],12,-40341101);c=ff(c,d,a,b,k[14],17,-1502002290);b=ff(b,c,d,a,k[15],22,1236535329);
      a=gg(a,b,c,d,k[1],5,-165796510);d=gg(d,a,b,c,k[6],9,-1069501632);c=gg(c,d,a,b,k[11],14,643717713);b=gg(b,c,d,a,k[0],20,-373897302);
      a=gg(a,b,c,d,k[5],5,-701558691);d=gg(d,a,b,c,k[10],9,38016083);c=gg(c,d,a,b,k[15],14,-660478335);b=gg(b,c,d,a,k[4],20,-405537848);
      a=gg(a,b,c,d,k[9],5,568446438);d=gg(d,a,b,c,k[14],9,-1019803690);c=gg(c,d,a,b,k[3],14,-187363961);b=gg(b,c,d,a,k[8],20,1163531501);
      a=gg(a,b,c,d,k[13],5,-1444681467);d=gg(d,a,b,c,k[2],9,-51403784);c=gg(c,d,a,b,k[7],14,1735328473);b=gg(b,c,d,a,k[12],20,-1926607734);
      a=hh(a,b,c,d,k[5],4,-378558);d=hh(d,a,b,c,k[8],11,-2022574463);c=hh(c,d,a,b,k[11],16,1839030562);b=hh(b,c,d,a,k[14],23,-35309556);
      a=hh(a,b,c,d,k[1],4,-1530992060);d=hh(d,a,b,c,k[4],11,1272893353);c=hh(c,d,a,b,k[7],16,-155497632);b=hh(b,c,d,a,k[10],23,-1094730640);
      a=hh(a,b,c,d,k[13],4,681279174);d=hh(d,a,b,c,k[0],11,-358537222);c=hh(c,d,a,b,k[3],16,-722521979);b=hh(b,c,d,a,k[6],23,76029189);
      a=hh(a,b,c,d,k[9],4,-640364487);d=hh(d,a,b,c,k[12],11,-421815835);c=hh(c,d,a,b,k[15],16,530742520);b=hh(b,c,d,a,k[2],23,-995338651);
      a=ii(a,b,c,d,k[0],6,-198630844);d=ii(d,a,b,c,k[7],10,1126891415);c=ii(c,d,a,b,k[14],15,-1416354905);b=ii(b,c,d,a,k[5],21,-57434055);
      a=ii(a,b,c,d,k[12],6,1700485571);d=ii(d,a,b,c,k[3],10,-1894986606);c=ii(c,d,a,b,k[10],15,-1051523);b=ii(b,c,d,a,k[1],21,-2054922799);
      a=ii(a,b,c,d,k[8],6,1873313359);d=ii(d,a,b,c,k[15],10,-30611744);c=ii(c,d,a,b,k[6],15,-1560198380);b=ii(b,c,d,a,k[13],21,1309151649);
      a=ii(a,b,c,d,k[4],6,-145523070);d=ii(d,a,b,c,k[11],10,-1120210379);c=ii(c,d,a,b,k[2],15,718787259);b=ii(b,c,d,a,k[9],21,-343485551);
      x[0]=(a+x[0])>>>0;x[1]=(b+x[1])>>>0;x[2]=(c+x[2])>>>0;x[3]=(d+x[3])>>>0;
    }
    function md5blk(s) {
      const l = s.length, r = [];
      for (let i = 0; i < l; i += 4)
        r.push(s.charCodeAt(i)|(s.charCodeAt(i+1)<<8)|(s.charCodeAt(i+2)<<16)|(s.charCodeAt(i+3)<<24));
      return r;
    }
    let n = string.length;
    let state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(string.substring(i - 64, i)));
    string = string.substring(i - 64);
    const tail = Array(16).fill(0);
    for (i = 0; i < string.length; i++) tail[i >> 2] |= string.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) { md5cycle(state, tail); tail.fill(0); }
    tail[14] = n * 8;
    md5cycle(state, tail);
    const hex = '0123456789abcdef';
    let s = '';
    for (const v of state) for (let j = 0; j < 4; j++) s += hex[(v >> (j * 8 + 4)) & 0xF] + hex[(v >> (j * 8)) & 0xF];
    return s;
  }

  /* ── helpers ──────────────────────────────────────────── */
  const isVideo = () => VIDEO_RE.test(location.href);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const now = Date.now();
    const commentTime = ts * 1000;
    const diffMs = now - commentTime;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    // Relative time format
    if (diffSec < 60) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;
    if (diffHour < 24) return `${diffHour}小时前`;
    if (diffDay < 7) return `${diffDay}天前`;
    if (diffDay < 30) return `${Math.floor(diffDay / 7)}周前`;

    // For older comments, show date
    const d = new Date(commentTime);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function playerEl() {
    for (const s of PLAYER_SEL) { const e = document.querySelector(s); if (e) return e; }
    return null;
  }

  /* ── Local Storage helpers for replied comments ─────── */
  function getRepliedCommentsKey() {
    // Use video ID as key to store replied comments per video
    return S.aid ? `bcs_replied_${S.aid}` : null;
  }

  function loadRepliedComments() {
    const key = getRepliedCommentsKey();
    if (!key) return new Set();
    try {
      const data = localStorage.getItem(key);
      if (data) {
        return new Set(JSON.parse(data));
      }
    } catch(e) {
      console.error('Failed to load replied comments:', e);
    }
    return new Set();
  }

  function saveRepliedComment(rpid) {
    const key = getRepliedCommentsKey();
    if (!key) return;
    try {
      const repliedSet = loadRepliedComments();
      repliedSet.add(String(rpid));
      localStorage.setItem(key, JSON.stringify([...repliedSet]));
      // Also update session set
      S.repliedRpidSet.add(String(rpid));
    } catch(e) {
      console.error('Failed to save replied comment:', e);
    }
  }

  function isCommentReplied(rpid) {
    // Check both session and local storage
    return S.repliedRpidSet.has(String(rpid)) || loadRepliedComments().has(String(rpid));
  }

  /* ── inject CSS ──────────────────────────────────────── */
  function addStyle(css) {
    if (typeof GM_addStyle === 'function') { GM_addStyle(css); return; }
    if (typeof GM !== 'undefined' && typeof GM.addStyle === 'function') { GM.addStyle(css); return; }
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  /* Page-level CSS to hide original comment sections */
  addStyle(`
    html.bcs-active #commentapp,
    html.bcs-active bili-comments,
    html.bcs-active .reply-warp,
    html.bcs-active .comment-module,
    html.bcs-active .video-comment {
      display: none !important;
    }

    /* Enlarge Bilibili video player progress bar thumb */
    .bpx-player-progress-thumb {
      width: 60px !important;
      height: 60px !important;
    }
    .bpx-player-progress-thumb-icon {
      width: 60px !important;
      height: 60px !important;
    }
    .bpx-player-progress-thumb-icon svg {
      width: 60px !important;
      height: 60px !important;
    }
    .bpx-player-progress-cursor {
      width: 32px !important;
      height: 32px !important;
      border-radius: 16px !important;
      top: -14px !important;
      left: -16px !important;
    }
    .bpx-player-progress-pull-indicator {
      width: 52px !important;
      height: 52px !important;
    }
  `);

  /* Apply inline !important to hide native comment sections */
  function applyNativeOverrides() {
    document.querySelectorAll(HIDE_SEL).forEach(el => {
      el.style.setProperty('display', 'none', 'important');
    });
  }

  /* ─ layout: shift body content to make room for sidecar */
  function updateLayout() {
    if (!isVideo()) {
      document.body.style.marginLeft = '';
      // Remove inline styles from left-side elements
      document.querySelectorAll('.left-container,#slide_ad').forEach(el => {
        el.style.removeProperty('margin-left');
        el.style.removeProperty('margin-right');
      });
      return;
    }

    // Calculate the space needed for sidecar
    const sidecarWidth = getSidecarWidth();

    // Apply margin-left to body to push content right
    document.body.style.setProperty('margin-left', sidecarWidth + 'px', 'important');
  }

  function getSidecarWidth() {
    const p = playerEl();
    const vw = window.innerWidth;
    if (p) {
      const r = p.getBoundingClientRect();
      // Space available on the LEFT of player
      const ls = r.left - CFG.gap - 16;
      if (ls >= CFG.minWidth) {
        return Math.min(CFG.maxWidth, ls) + CFG.gap;
      }
    }
    return CFG.maxWidth + CFG.gap;
  }

  /* ── video id resolution ─────────────────────────────── */
  function getInitialState() {
    const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (w.__INITIAL_STATE__) return w.__INITIAL_STATE__;
    for (const sc of document.scripts) {
      const t = sc.textContent || '';
      if (!t.includes('__INITIAL_STATE__')) continue;
      const a = t.match(/"aid"\s*:\s*(\d+)/) || t.match(/\baid\s*:\s*(\d+)/);
      const b = t.match(/"bvid"\s*:\s*"([^"]+)"/) || t.match(/\bbvid\s*:\s*"([^"]+)"/);
      return { aid: a ? +a[1] : null, bvid: b ? b[1] : null };
    }
    return {};
  }

  async function fetchJSON(url) {
    console.log('[BCS] fetchJSON:', url);
    const isWbiReplyApi = url.includes('/x/v2/reply/wbi/');
    // For WBI reply API, skip fetch (consistently 412) and go straight to GM_xmlhttpRequest
    if (!isWbiReplyApi) {
    // Use fetch for same-origin bilibili API calls (browser auto-sends referer + cookies)
    try {
      const r = await fetch(url, {
        credentials:'include',
        headers:{
          accept:'application/json,text/plain,*/*'
        }
      });
      if (r.ok) {
        const json = await r.json();
        return json;
      }
    } catch(fetchErr) {
      // fall through to GM_xmlhttpRequest
    }
    } // end if (!isWbiReplyApi)
    // Fallback: GM_xmlhttpRequest with proper headers
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      console.log('[BCS] Using GM_xmlhttpRequest');
      const resp = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          headers: {
            'accept': 'application/json,text/plain,*/*',
            'referer': 'https://www.bilibili.com',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'origin': 'https://www.bilibili.com'
          },
          onload: resolve,
          onerror: reject,
          ontimeout: () => reject(new Error('Request timeout'))
        });
      });
      console.log('[BCS] GM_xmlhttpRequest status:', resp.status, resp.statusText);
      // Retry on 412 with exponential backoff (5s, 15s, 30s)
      if (resp.status === 412) {
        const delays = [5000, 15000, 30000];
        for (let i = 0; i < delays.length; i++) {
          console.log(`[BCS] GM_xmlhttpRequest got 412, retry ${i+1}/${delays.length} after ${delays[i]/1000}s...`);
          await new Promise(r => setTimeout(r, delays[i]));
          const retryResp = await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
              method: 'GET',
              url: url,
              headers: {
                'accept': 'application/json,text/plain,*/*',
                'referer': 'https://www.bilibili.com',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'origin': 'https://www.bilibili.com'
              },
              onload: resolve,
              onerror: reject,
              ontimeout: () => reject(new Error('Request timeout'))
            });
          });
          console.log(`[BCS] GM_xmlhttpRequest retry ${i+1} status:`, retryResp.status);
          if (retryResp.status === 200) {
            const json = JSON.parse(retryResp.responseText);
            console.log('[BCS] fetchJSON response code:', json?.code, 'message:', json?.message);
            return json;
          }
        }
        throw new Error('412');
      }
      console.log('[BCS] GM_xmlhttpRequest responseText:', resp.responseText?.substring(0, 500));
      if (resp.status !== 200) throw new Error('HTTP ' + resp.status);
      const json = JSON.parse(resp.responseText);
      console.log('[BCS] fetchJSON response code:', json?.code, 'message:', json?.message);
      return json;
    }
    throw new Error('No available HTTP method');
  }

  async function resolveIds() {
    const init = getInitialState();
    const byPath = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
    S.bvid = byPath?.[1] || new URLSearchParams(location.search).get('bvid') || init.bvid || S.bvid;
    S.aid = init.aid || S.aid;
    if (S.aid) return;
    if (!S.bvid) throw new Error('No BV id');
    const v = await fetchJSON(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(S.bvid)}`);
    if (v?.code === 0 && v?.data?.aid) { S.aid = v.data.aid; return; }
    throw new Error('No AV id');
  }

  /* ── fetch user info for tooltip ─────────────────────── */
  async function fetchUserInfo(mid, tooltip) {
    try {
      // Try the simpler API endpoint without WBI signature
      const url = `https://api.bilibili.com/x/web-interface/card?mid=${mid}&photo=false`;
      const response = await fetch(url, { credentials: 'include' });
      const data = await response.json();

      if (data.code !== 0 || !data.data) {
        // Fallback to basic info from comment data
        tooltip.innerHTML = '<div class="bcs-tooltip-loading">暂无更多信息</div>';
        return;
      }

      const userInfo = data.data.card;

      const uname = userInfo.name || 'B站用户';
      const level = userInfo.level_info?.current_level || 0;
      const face = userInfo.face || '';
      const sign = userInfo.sign || '';
      const following = parseInt(userInfo.attention) || 0;
      const follower = parseInt(userInfo.fans) || 0;
      const videos = parseInt(userInfo.videos) || 0;
      const sex = userInfo.sex || '保密';
      const articleCount = parseInt(userInfo.article) || 0;

      // Check VIP status
      const isVip = userInfo.vip && (userInfo.vip.status === 1 || userInfo.vip.vipStatus === 1);
      const vipLabel = userInfo.vip?.label?.text || '';

      // Check official verification
      const isOfficial = userInfo.Official && userInfo.Official.role > 0;
      const officialTitle = userInfo.Official?.title || '';

      // Format numbers with Chinese units
      const formatNum = (num) => {
        if (num >= 10000) {
          return (num / 10000).toFixed(1) + '万';
        }
        return num.toString();
      };

      tooltip.innerHTML = `
        <div class="bcs-tooltip-header">
          <img class="bcs-tooltip-avatar" src="${esc(face)}" referrerpolicy="no-referrer" alt="">
          <div class="bcs-tooltip-info">
            <div class="bcs-tooltip-name-row">
              <span class="bcs-tooltip-name">${esc(uname)}</span>
              <span class="bcs-tooltip-level">LV${level}</span>
            </div>
            ${isVip ? `<div style="margin-top:4px;"><span style="display:inline-block;padding:2px 6px;background:#fb7299;color:#fff;font-size:10px;border-radius:3px;">${esc(vipLabel || '大会员')}</span></div>` : ''}
            ${isOfficial ? `<div style="margin-top:4px;font-size:11px;color:#ff6699;">🎓 ${esc(officialTitle)}</div>` : ''}
          </div>
        </div>
        <div class="bcs-tooltip-stats">
          <div class="bcs-tooltip-stat">
            <div class="bcs-tooltip-stat-value">${formatNum(videos)}</div>
            <div class="bcs-tooltip-stat-label">视频</div>
          </div>
          <div class="bcs-tooltip-stat">
            <div class="bcs-tooltip-stat-value">${formatNum(following)}</div>
            <div class="bcs-tooltip-stat-label">关注</div>
          </div>
          <div class="bcs-tooltip-stat">
            <div class="bcs-tooltip-stat-value">${formatNum(follower)}</div>
            <div class="bcs-tooltip-stat-label">粉丝</div>
          </div>
          ${articleCount > 0 ? `
          <div class="bcs-tooltip-stat">
            <div class="bcs-tooltip-stat-value">${formatNum(articleCount)}</div>
            <div class="bcs-tooltip-stat-label">获赞</div>
          </div>
          ` : ''}
        </div>
        ${sign ? `<div style="margin-top:8px;font-size:12px;color:#61666d;line-height:16px;">${esc(sign)}</div>` : ''}
        ${sex !== '保密' ? `<div style="margin-top:4px;font-size:11px;color:#9499a0;">性别: ${esc(sex === '男' ? '️ 男' : sex === '女' ? '♀️ 女' : sex)}</div>` : ''}
        <div class="bcs-tooltip-actions">
          <button class="bcs-btn-follow">+ 关注</button>
          <button class="bcs-btn-msg">发消息</button>
        </div>
      `;
    } catch(e) {
      console.error('Failed to fetch user info:', e);
      tooltip.innerHTML = '<div class="bcs-tooltip-loading">加载失败</div>';
    }
  }

  /* ── Shadow DOM sidecar ──────────────────────────────── */
  const SHADOW_CSS = `
    :host {
      position: fixed !important;
      z-index: 2147483640 !important;
      display: block !important;
    }
    .bcs-root {
      background: #fff; border: 1px solid #e3e5e7; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.08); box-sizing: border-box;
      color: #18191c; display: flex; flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      height: 100%; min-height: 320px; overflow: hidden;
    }
    .bcs-header { align-items:center;border-bottom:1px solid #e3e5e7;display:flex;flex:0 0 auto;justify-content:space-between;padding:12px 14px }
    .bcs-title { font-size:15px;font-weight:600;line-height:20px }
    .bcs-count { color:#9499a0;font-size:12px;line-height:18px }
    .bcs-list { box-sizing:border-box;flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:6px 14px 12px }
    /* Avatar hover tooltip */
    .bcs-avatar-wrapper { position:relative;display:inline-block }
    .bcs-avatar-tooltip { display:none;position:absolute;left:100%;top:0;margin-left:8px;background:#fff;border:1px solid #e3e5e7;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1);padding:16px;width:280px;z-index:9999 }
    .bcs-avatar-wrapper:hover .bcs-avatar-tooltip { display:block }
    .bcs-tooltip-header { display:flex;align-items:center;gap:12px;margin-bottom:12px }
    .bcs-tooltip-avatar { width:48px;height:48px;border-radius:50%;object-fit:cover }
    .bcs-tooltip-info { flex:1 }
    .bcs-tooltip-name-row { display:flex;align-items:center;gap:6px;margin-bottom:4px }
    .bcs-tooltip-name { font-weight:600;font-size:14px;color:#18191c }
    .bcs-tooltip-level { background:#ff6699;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;font-weight:600 }
    .bcs-tooltip-stats { display:flex;gap:16px;font-size:12px;color:#61666d }
    .bcs-tooltip-stat { display:flex;flex-direction:column;align-items:center }
    .bcs-tooltip-stat-value { font-weight:600;color:#18191c;font-size:14px }
    .bcs-tooltip-stat-label { color:#9499a0;font-size:11px }
    .bcs-tooltip-actions { display:flex;gap:8px;margin-top:12px }
    .bcs-btn-follow { flex:1;background:#00aeec;color:#fff;border:0;padding:8px 16px;border-radius:4px;cursor:pointer;font-size:13px }
    .bcs-btn-msg { flex:1;background:#fff;color:#61666d;border:1px solid #e3e5e7;padding:8px 16px;border-radius:4px;cursor:pointer;font-size:13px }
    .bcs-tooltip-loading { color:#9499a0;font-size:12px;text-align:center;padding:20px 0 }
    .bcs-item { border-bottom:1px solid #f1f2f3;display:grid;gap:0 10px;grid-template-columns:34px minmax(0,1fr);padding:12px 0;transition:background-color 0.2s ease;border-radius:6px;margin:0 -6px;padding-left:6px;padding-right:6px }
    .bcs-item:hover { background-color:#f6f7f8 }
    .bcs-avatar { background:#f1f2f3;border-radius:50%;grid-row:span 3;height:34px;object-fit:cover;width:34px;transition:transform 0.2s ease }
    .bcs-item:hover .bcs-avatar { transform:scale(1.05) }
    .bcs-name { color:#61666d;font-size:13px;font-weight:600;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:6px }
    .bcs-location-badge { display:inline-flex;align-items:center;padding:2px 6px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;font-size:10px;border-radius:10px;font-weight:500;letter-spacing:0.5px }
    .bcs-replied-badge { display:inline-flex;align-items:center;padding:1px 5px;background:#ff6699;color:#fff;font-size:9px;border-radius:8px;font-weight:500;margin-left:4px }
    .bcs-message { color:#18191c;font-size:13px;line-height:20px;margin-top:4px;overflow-wrap:anywhere;white-space:pre-wrap }
    .bcs-meta { color:#9499a0;font-size:12px;line-height:18px;margin-top:6px;display:flex;align-items:center;gap:12px }
    .bcs-actions { display:flex;align-items:center;gap:12px;margin-top:6px }
    .bcs-action-btn { background:none;border:0;color:#9499a0;cursor:pointer;display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:4px 8px;border-radius:4px;transition:all 0.2s ease }
    .bcs-action-btn:hover { color:#00aeec;background-color:rgba(0,174,236,0.1) }
    .bcs-action-btn.active { color:#00aeec }
    .bcs-action-btn:active { transform:scale(0.95) }
    /* Like button animation */
    .bcs-action-btn[data-action="like"].liked { color:#ff6699 }
    .bcs-action-btn[data-action="like"].liked svg { animation:bcs-like-pulse 0.4s ease }
    @keyframes bcs-like-pulse {
      0% { transform:scale(1); }
      50% { transform:scale(1.3); }
      100% { transform:scale(1); }
    }
    .bcs-action-icon { width:16px;height:16px;fill:currentColor }
    .bcs-reply-input { margin-top:8px;padding:8px;background:#f6f7f8;border-radius:6px }
    .bcs-reply-textarea { width:100%;border:1px solid #e3e5e7;border-radius:4px;padding:8px;font-size:12px;resize:vertical;min-height:60px;box-sizing:border-box }
    .bcs-reply-submit { margin-top:8px;background:#00aeec;color:#fff;border:0;padding:6px 16px;border-radius:4px;cursor:pointer;font-size:12px }
    .bcs-children { grid-column:2;margin-top:8px }
    .bcs-child { background:#f6f7f8;border-radius:6px;margin-top:6px;padding:8px 10px;display:flex;gap:8px;align-items:flex-start }
    .bcs-child-avatar { width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0 }
    .bcs-child-content { flex:1;min-width:0 }
    .bcs-child-name { color:#61666d;font-size:12px;font-weight:600;line-height:17px }
    .bcs-child-message { color:#18191c;font-size:12px;line-height:18px;margin-top:3px;overflow-wrap:anywhere;white-space:pre-wrap }
    .bcs-child-meta { color:#9499a0;font-size:11px;line-height:16px;margin-top:4px }
    .bcs-reply-toggle { background:transparent;border:0;color:#00aeec;cursor:pointer;display:inline-block;font-size:12px;line-height:18px;margin:8px 0 0;padding:0 }
    .bcs-reply-toggle[disabled] { color:#9499a0;cursor:default }
    .bcs-status { color:#9499a0;font-size:13px;line-height:20px;padding:18px 0;text-align:center }
    .bcs-load-more { background:#f1f2f3;border:0;border-radius:6px;color:#00aeec;cursor:pointer;display:block;font-size:13px;line-height:32px;margin:12px auto 0;padding:0 16px }
    .bcs-load-more[disabled] { color:#9499a0;cursor:default }
    /* Back to top button */
    .bcs-back-to-top { position:absolute;bottom:20px;right:20px;width:40px;height:40px;background:#00aeec;color:#fff;border:0;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.15);cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;visibility:hidden;transition:all 0.3s ease;z-index:100 }
    .bcs-back-to-top.visible { opacity:1;visibility:visible }
    .bcs-back-to-top:hover { background:#0099d6;transform:scale(1.1) }
    .bcs-back-to-top:active { transform:scale(0.95) }
    .bcs-back-to-top svg { width:20px;height:20px;fill:currentColor }
  `;

  function buildShadowDOM() {
    const host = document.createElement('div');
    host.id = 'bcs-shadow-host';
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    shadow.appendChild(style);

    const root = document.createElement('div');
    root.className = 'bcs-root';
    root.innerHTML = `
      <div class="bcs-header"><div class="bcs-title">评论</div><div class="bcs-count">全部评论</div></div>
      <div class="bcs-list" style="position:relative;"><div class="bcs-status">加载中...</div><button class="bcs-load-more" type="button" hidden>加载更多</button></div>
      <button class="bcs-back-to-top" type="button" title="回到顶部">
        <svg viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
      </button>`;
    shadow.appendChild(root);

    document.documentElement.appendChild(host);

    S.host = host;
    S.shadow = shadow;
    S.sidecar = root;
    S.list = shadow.querySelector('.bcs-list');
    S.status = shadow.querySelector('.bcs-status');
    S.count = shadow.querySelector('.bcs-count');
    S.loadMore = shadow.querySelector('.bcs-load-more');
    S.backToTop = shadow.querySelector('.bcs-back-to-top');
    S.loadMore.addEventListener('click', () => loadComments(false));
    S.backToTop.addEventListener('click', scrollToTop);

    // Add scroll listener for infinite scroll
    S.list.addEventListener('scroll', handleListScroll, { passive: true });
  }

  function handleListScroll() {
    if (S.loading || S.done) return;
    const threshold = 100; // px from bottom to trigger load
    const scrollTop = S.list.scrollTop;
    const scrollHeight = S.list.scrollHeight;
    const clientHeight = S.list.clientHeight;

    // Show/hide back to top button based on scroll position
    if (S.backToTop) {
      if (scrollTop > 300) {
        S.backToTop.classList.add('visible');
      } else {
        S.backToTop.classList.remove('visible');
      }
    }

    if (scrollHeight - scrollTop - clientHeight < threshold) {
      loadComments(false);
    }
  }

  function scrollToTop() {
    if (!S.list) return;
    S.list.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  }

  function ensureSidecar() {
    if (S.host) {
      if (!S.host.isConnected) document.documentElement.appendChild(S.host);
      S.host.style.display = '';
      return;
    }
    buildShadowDOM();
    applyNativeOverrides();
    placeSidecar();
  }

  function placeSidecar() {
    if (!S.host) return;
    const p = playerEl();
    const vw = innerWidth, vh = innerHeight;

    // Default position: left edge of viewport
    let left = 16;
    let top = CFG.topFallback;
    let w = CFG.maxWidth;
    let h = vh - top - CFG.bottomGap;

    if (p) {
      const r = p.getBoundingClientRect();
      // Place sidecar to the LEFT of player
      left = Math.max(16, r.left - CFG.gap - CFG.maxWidth);
      w = Math.min(CFG.maxWidth, r.left - CFG.gap - 16);
      top = Math.max(CFG.topFallback, r.top);
      h = vh - top - CFG.bottomGap;

      // Ensure minimum width
      if (w < CFG.minWidth) {
        // Not enough space on left, fall back to viewport left edge
        left = 16;
        w = Math.min(CFG.maxWidth, vw / 3); // Use up to 1/3 of viewport
      }
    }

    Object.assign(S.host.style, {
      left: Math.round(left)+'px',
      top: Math.round(top)+'px',
      width: Math.round(Math.max(CFG.minWidth, w))+'px',
      height: Math.round(Math.max(320, h))+'px'
    });
  }

  function setStatus(t) { if (!S.status) return; S.status.textContent = t; S.status.hidden = !t; }

  /* ── rendering (inside shadow DOM) ──────────────────── */
  function renderReply(r) {
    const m = r.member||{}, c = r.content||{}, cc = r.rcount||r.count||0;
    const replyControl = r.reply_control || {};
    const el = document.createElement('article');
    el.className = 'bcs-item';
    el.dataset.rpid = r.rpid_str || r.rpid || '';

    // Create avatar with hover tooltip
    const avatarWrapper = document.createElement('div');
    avatarWrapper.className = 'bcs-avatar-wrapper';
    const avatarImg = document.createElement('img');
    avatarImg.className = 'bcs-avatar';
    avatarImg.src = esc(m.avatar||'');
    avatarImg.referrerPolicy = 'no-referrer';
    avatarImg.loading = 'lazy';
    avatarImg.alt = '';
    avatarWrapper.appendChild(avatarImg);

    // Tooltip - will be populated on hover
    const tooltip = document.createElement('div');
    tooltip.className = 'bcs-avatar-tooltip';
    tooltip.dataset.mid = m.mid || '';
    tooltip.innerHTML = `
      <div class="bcs-tooltip-loading">加载中...</div>`;
    avatarWrapper.appendChild(tooltip);

    // Add hover event to fetch user info
    avatarWrapper.addEventListener('mouseenter', () => {
      if (m.mid && !tooltip.dataset.loaded) {
        fetchUserInfo(m.mid, tooltip);
        tooltip.dataset.loaded = '1';
      }
    });

    el.appendChild(avatarWrapper);

    const contentDiv = document.createElement('div');

    // Name with IP location and replied badge
    const nameDiv = document.createElement('div');
    nameDiv.className = 'bcs-name';
    let nameHtml = esc(m.uname||'B站用户');

    // Add IP location after username as a badge (B站API返回格式: "IP属地：吉林")
    if (replyControl.location) {
      const locationText = replyControl.location.replace(/^IP属地：/, '');
      nameHtml += `<span class="bcs-location-badge">${esc(locationText)}</span>`;
    }

    // Add "I replied" badge if user has replied to this comment
    const rpid = r.rpid_str || r.rpid || '';
    if (rpid && isCommentReplied(rpid)) {
      nameHtml += `<span class="bcs-replied-badge">我回复过</span>`;
    }

    nameDiv.innerHTML = nameHtml;
    contentDiv.appendChild(nameDiv);

    const msgDiv = document.createElement('div');
    msgDiv.className = 'bcs-message';
    // Render message with images and emojis using the emote data from API
    msgDiv.innerHTML = renderMessageContent(c.message || '', c.emote, c.pictures);
    contentDiv.appendChild(msgDiv);

    // Time and like count
    const metaDiv = document.createElement('div');
    metaDiv.className = 'bcs-meta';
    metaDiv.innerHTML = `<span>${esc(fmtTime(r.ctime))}</span>`;
    contentDiv.appendChild(metaDiv);

    // Action buttons: Like, Dislike, Reply
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'bcs-actions';

    // Like button
    const likeBtn = document.createElement('button');
    likeBtn.className = 'bcs-action-btn';
    likeBtn.dataset.action = 'like';
    likeBtn.dataset.rpid = r.rpid_str || r.rpid || '';
    likeBtn.dataset.likes = r.like || 0;
    likeBtn.innerHTML = `
      <svg class="bcs-action-icon" viewBox="0 0 24 24"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-1.91z"/></svg>
      <span>${r.like||0}</span>
    `;
    likeBtn.addEventListener('click', () => handleLike(likeBtn, r));
    actionsDiv.appendChild(likeBtn);

    // Dislike button (optional - B站有踩功能)
    const dislikeBtn = document.createElement('button');
    dislikeBtn.className = 'bcs-action-btn';
    dislikeBtn.dataset.action = 'dislike';
    dislikeBtn.dataset.rpid = r.rpid_str || r.rpid || '';
    dislikeBtn.innerHTML = `
      <svg class="bcs-action-icon" viewBox="0 0 24 24"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v1.91c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>
    `;
    actionsDiv.appendChild(dislikeBtn);

    // Reply button
    const replyBtn = document.createElement('button');
    replyBtn.className = 'bcs-action-btn';
    replyBtn.dataset.action = 'reply';
    replyBtn.dataset.rpid = r.rpid_str || r.rpid || '';
    replyBtn.dataset.uname = m.uname || '';
    replyBtn.innerHTML = `
      <svg class="bcs-action-icon" viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
      <span>回复</span>
    `;
    replyBtn.addEventListener('click', () => showReplyInput(replyBtn, el, r));
    actionsDiv.appendChild(replyBtn);

    contentDiv.appendChild(actionsDiv);
    el.appendChild(contentDiv);

    if (cc > 0) {
      const ch = document.createElement('div'); ch.className = 'bcs-children'; el.appendChild(ch);
      if (Array.isArray(r.replies) && r.replies.length)
        r.replies.slice(0,3).forEach(c => ch.appendChild(renderChild(c)));

      // Only show toggle button if there are more replies than displayed OR if we need to load more
      const displayedCount = Array.isArray(r.replies) ? r.replies.length : 0;
      const hasMoreReplies = cc > displayedCount;
      if (hasMoreReplies || cc > 1) {
        const btn = document.createElement('button');
        btn.className = 'bcs-reply-toggle'; btn.type = 'button';
        btn.textContent = `查看 ${cc} 条回复`;
        btn.addEventListener('click', () => toggleChildren(r, el, btn));
        ch.appendChild(btn);
      }
    }
    return el;
  }

  function renderChild(r) {
    const m = r.member||{}, c = r.content||{};
    const replyControl = r.reply_control || {};
    const el = document.createElement('div'); el.className = 'bcs-child';

    // Build child name with IP location badge
    let childNameHtml = esc(m.uname||'B站用户');
    if (replyControl.location) {
      const locationText = replyControl.location.replace(/^IP属地：/, '');
      childNameHtml += `<span class="bcs-location-badge" style="font-size:9px;padding:1px 5px;">${esc(locationText)}</span>`;
    }

    // Build child meta with time and like count
    const childMetaHtml = `${esc(fmtTime(r.ctime))} · ${r.like||0} 赞`;

    el.innerHTML = `<img class="bcs-child-avatar" src="${esc(m.avatar||'')}" referrerpolicy="no-referrer" loading="lazy" alt="">
      <div class="bcs-child-content">
        <div class="bcs-child-name">${childNameHtml}</div>
        <div class="bcs-child-message">${renderMessageContent(c.message || '', c.emote, c.pictures)}</div>
        <div class="bcs-child-meta">${childMetaHtml}</div>
      </div>`;
    return el;
  }

  /* ─ action handlers ─────────────────────────────────── */
  async function handleLike(btn, reply) {
    if (!S.aid) return;
    const rpid = reply.rpid_str || reply.rpid;
    const isLiked = btn.classList.contains('active');

    try {
      // Like: 1, Unlike: 0
      const action = isLiked ? 0 : 1;
      const csrf = getCookie('bili_jct') || '';

      // Try both methods: first with body params, then with URL params
      const url = `https://api.bilibili.com/x/v2/reply/action`;
      const params = new URLSearchParams({
        type: '1',
        oid: S.aid.toString(),
        rpid: rpid,
        action: action.toString(),
        csrf: csrf
      });

      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });

      const data = await response.json();
      console.log('Like response:', data);

      if (data.code === 0) {
        // Update UI
        let likes = parseInt(btn.dataset.likes) || 0;
        if (isLiked) {
          likes--;
          btn.classList.remove('active');
        } else {
          likes++;
          btn.classList.add('active');
        }
        btn.dataset.likes = likes;
        btn.querySelector('span').textContent = likes;
      } else {
        console.error('Like failed:', data.code, data.message);
        alert(`点赞失败: ${data.message || '未知错误'} (code: ${data.code})`);
      }
    } catch(e) {
      console.error('Like error:', e);
      alert('点赞请求失败，请检查网络或登录状态');
    }
  }

  function showReplyInput(btn, item, reply) {
    // Remove existing reply input if any
    const existing = item.querySelector('.bcs-reply-input');
    if (existing) {
      existing.remove();
      return;
    }

    // Create reply input
    const uname = btn.dataset.uname || '';
    const rpid = reply.rpid_str || reply.rpid;

    const inputDiv = document.createElement('div');
    inputDiv.className = 'bcs-reply-input';
    inputDiv.innerHTML = `
      <textarea class="bcs-reply-textarea" placeholder="回复 @${esc(uname)}..."></textarea>
      <button class="bcs-reply-submit" type="button">发送</button>
    `;

    // Insert after actions div
    const actionsDiv = item.querySelector('.bcs-actions');
    if (actionsDiv) {
      actionsDiv.insertAdjacentElement('afterend', inputDiv);
    }

    // Focus textarea
    const textarea = inputDiv.querySelector('.bcs-reply-textarea');
    textarea.focus();

    // Submit handler
    const submitBtn = inputDiv.querySelector('.bcs-reply-submit');
    submitBtn.addEventListener('click', () => submitReply(rpid, textarea.value, item, inputDiv));

    // Ctrl+Enter to submit
    textarea.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') {
        submitReply(rpid, textarea.value, item, inputDiv);
      }
    });
  }

  async function submitReply(parentRpid, message, item, inputDiv) {
    if (!S.aid || !message.trim()) return;

    try {
      const url = 'https://api.bilibili.com/x/v2/reply/add';
      const params = new URLSearchParams({
        type: '1',
        oid: S.aid,
        root: parentRpid,
        parent: parentRpid,
        message: message,
        csrf: getCookie('bili_jct') || ''
      });

      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });

      const data = await response.json();

      if (data.code === 0) {
        // Success - save to local storage
        saveRepliedComment(parentRpid);

        // Get the new reply from API response
        const newReply = data.data.reply;
        if (newReply) {
          // Insert the new reply into the DOM immediately
          insertNewReply(newReply, item);
        } else {
          // Fallback: reload comments if API doesn't return the new reply
          await loadComments(true);
        }

        inputDiv.remove();
      } else {
        alert('回复失败: ' + (data.message || '未知错误'));
      }
    } catch(e) {
      console.error('Submit reply error:', e);
      alert('回复失败，请重试');
    }
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : null;
  }

  /* ── insert new reply into DOM ─────────────────────── */
  function insertNewReply(reply, parentItem) {
    try {
      // Find or create children container
      let childrenDiv = parentItem.querySelector('.bcs-children');
      if (!childrenDiv) {
        childrenDiv = document.createElement('div');
        childrenDiv.className = 'bcs-children';
        parentItem.appendChild(childrenDiv);
      }

      // Render the new reply as a child comment
      const childEl = renderChild(reply);

      // Insert before the toggle button (if exists)
      const toggleBtn = childrenDiv.querySelector('.bcs-reply-toggle');
      if (toggleBtn) {
        childrenDiv.insertBefore(childEl, toggleBtn);
      } else {
        childrenDiv.appendChild(childEl);
      }

      // Update reply count
      const rcount = parseInt(parentItem.dataset.rcount || '0') + 1;
      parentItem.dataset.rcount = String(rcount);

      // Count existing child elements (excluding toggle button)
      const existingChildren = Array.from(childrenDiv.querySelectorAll('.bcs-child')).length;

      // Only show toggle button if there are more replies than displayed
      const hasMoreReplies = rcount > (existingChildren + 1); // +1 for the new reply we just added

      // Update or create toggle button
      let toggleBtn2 = childrenDiv.querySelector('.bcs-reply-toggle');
      if (hasMoreReplies) {
        if (!toggleBtn2) {
          const btn = document.createElement('button');
          btn.className = 'bcs-reply-toggle';
          btn.type = 'button';
          btn.textContent = `查看 ${rcount} 条回复`;
          btn.addEventListener('click', () => toggleChildren({
            rpid_str: parentItem.dataset.rpid,
            rpid: parentItem.dataset.rpid
          }, parentItem, btn));
          childrenDiv.appendChild(btn);
        } else {
          toggleBtn2.textContent = `查看 ${rcount} 条回复`;
        }
      } else if (toggleBtn2) {
        // Remove toggle button if all replies are now visible
        toggleBtn2.remove();
      }

      // Add "I replied" badge to parent comment's name
      addRepliedBadgeToParent(parentItem);

      console.log('New reply inserted successfully');
    } catch(e) {
      console.error('Failed to insert new reply:', e);
      // Fallback: reload comments on error
      loadComments(true).catch(err => console.error('Fallback reload failed:', err));
    }
  }

  /* ── add replied badge to parent comment ────────────── */
  function addRepliedBadgeToParent(parentItem) {
    try {
      const nameDiv = parentItem.querySelector('.bcs-name');
      if (!nameDiv) return;

      // Check if badge already exists
      if (nameDiv.querySelector('.bcs-replied-badge')) return;

      // Create and append the badge
      const badge = document.createElement('span');
      badge.className = 'bcs-replied-badge';
      badge.textContent = '我回复过';
      nameDiv.appendChild(badge);
    } catch(e) {
      console.error('Failed to add replied badge:', e);
    }
  }

  /* ── render message with images and emojis ───────────── */
  function renderMessageContent(message, emote, pictures) {
    if (!message) return '';

    let html = esc(message);

    // Replace emoji codes with actual images using the emote data from API
    if (emote && typeof emote === 'object') {
      Object.keys(emote).forEach(emojiCode => {
        const emojiData = emote[emojiCode];
        if (emojiData && emojiData.url) {
          // Escape the emoji code for regex (e.g., [支持] -> \[支持\])
          const escapedCode = emojiCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escapedCode, 'g');
          // Enhanced emoji styling with better alignment and hover effect
          html = html.replace(regex, `<img src="${esc(emojiData.url)}" alt="${esc(emojiCode)}" style="width:22px;height:22px;vertical-align:text-bottom;margin:0 3px;border-radius:2px;transition:transform 0.15s ease;cursor:pointer;" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'" referrerpolicy="no-referrer">`);
        }
      });
    }

    // If there are attached pictures in the comment
    if (pictures && Array.isArray(pictures) && pictures.length > 0) {
      pictures.forEach(pic => {
        if (pic.img_src) {
          html += `<br><img src="${esc(pic.img_src)}" style="max-width:100%;height:auto;border-radius:4px;margin-top:8px;" referrerpolicy="no-referrer" loading="lazy">`;
        }
      });
    }

    return html;
  }

  function parseReplies(p) {
    console.log('[BCS] parseReplies input code:', p?.code);
    if (!p || p.code !== 0 || !p.data) throw new Error(p?.message || 'API failed');
    const d = p.data;
    console.log('[BCS] parseReplies - replies:', d.replies?.length, 'top_replies:', d.top_replies?.length, 'upper.top:', !!d.upper?.top);

    // Collect pinned comments: upper.top + top_replies
    const pinned = [];
    if (d.upper?.top) pinned.push(d.upper.top);
    for (const r of (d.top_replies || [])) {
      const id = r.rpid_str || r.rpid;
      if (!pinned.some(p => (p.rpid_str||p.rpid) === id)) pinned.push(r);
    }
    const regular = d.replies || [];
    // Deduplicate: pinned first, then regular
    const seen = new Set();
    const combined = [];
    for (const r of [...pinned, ...regular]) {
      const id = r.rpid_str || r.rpid;
      if (!seen.has(id)) { seen.add(id); combined.push(r); }
    }
    // Non-WBI endpoint returns cursor object (not page) for pagination info
    const cursor = d.cursor || {};
    const page = d.page || {};
    const count = cursor.all_count || page.count || 0;
    // isEnd: cursor.is_end, or fewer replies than pageSize, or no replies
    const isEnd = combined.length === 0 || cursor.is_end === true;
    const nextOffset = cursor.pagination_reply?.next_offset || '';
    console.log('[BCS] parseReplies result - combined:', combined.length, 'count:', count, 'cursor:', JSON.stringify(cursor), 'isEnd:', isEnd, 'nextOffset:', nextOffset);
    return {
      replies: combined,
      count,
      nextOffset,
      isEnd
    };
  }

  async function fetchReplies() {
    console.log('[BCS] fetchReplies - offset:', S.paginationOffset, 'aid:', S.aid);
    const baseParams = {
      oid: S.aid.toString(),
      type: '1',
      ps: CFG.pageSize.toString()
    };
    let url;
    if (S.paginationOffset) {
      // Page 2+: WBI endpoint with cursor pagination (non-WBI endpoint doesn't support pagination_str)
      baseParams.mode = '3';  // 3=hot comments (WBI endpoint uses mode, not sort)
      baseParams.pagination_str = JSON.stringify({ offset: S.paginationOffset });
      baseParams.dm_img_list = '[]';
      const biliJct = getCookie('bili_jct');
      if (biliJct) baseParams.bili_jct = biliJct;
      const buvid3 = getCookie('buvid3');
      if (buvid3) baseParams.buvid3 = buvid3;
      console.log('[BCS] fetchReplies - signing params with WBI for page 2+ (WBI endpoint)');
      const signedQs = await signWbiParams(baseParams);
      url = `https://api.bilibili.com/x/v2/reply/wbi/main?${signedQs}`;
    } else {
      // First page: non-WBI endpoint (no signing needed, avoids 412)
      baseParams.sort = '0';
      const params = new URLSearchParams(baseParams);
      url = `https://api.bilibili.com/x/v2/reply/main?${params.toString()}`;
    }
    console.log('[BCS] fetchReplies URL:', url);
    const resp = await fetchJSON(url);
    console.log('[BCS] fetchReplies response code:', resp?.code);
    if (resp && resp.code === 0) return parseReplies(resp);
    console.error('[BCS] fetchReplies API error:', resp?.code, resp?.message);
    throw new Error(resp?.message || 'API failed');
  }

  async function toggleChildren(root, item, btn) {
    const rid = root.rpid_str || root.rpid;
    const ch = item.querySelector('.bcs-children');
    if (!rid || !ch) return;
    if (item.dataset.chLoaded === '1') {
      // Toggle visibility of child comments
      const isHidden = item.dataset.chHidden === '1';
      const shouldHide = !isHidden; // If not hidden, we should hide it now
      
      // Use display style instead of hidden attribute for Shadow DOM compatibility
      ch.querySelectorAll('.bcs-child').forEach(c => {
        c.style.display = shouldHide ? 'none' : '';
      });
      item.dataset.chHidden = shouldHide ? '1' : '0';
      
      // Update button text based on new state
      const count = root.rcount || root.count || 0;
      btn.textContent = shouldHide ? `查看 ${count} 条回复` : '隐藏回复';
      return;
    }
    btn.disabled = true; btn.textContent = '加载中...';
    try {
      const u = `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${S.aid}&root=${rid}&pn=1&ps=${CFG.childPageSize}`;
      const p = await fetchJSON(u);
      if (!p || p.code !== 0 || !p.data) throw new Error(p?.message || 'Failed');
      ch.querySelectorAll('.bcs-child').forEach(c => c.remove());
      
      // Check if there are any replies to display
      const hasReplies = (p.data.page?.count > 0) || (p.data.replies && p.data.replies.length > 0);
      
      if (hasReplies) {
        // Insert child comments before the button
        const f = document.createDocumentFragment();
        p.data.replies.forEach(r => f.appendChild(renderChild(r)));
        ch.insertBefore(f, btn);
        item.dataset.chLoaded = '1'; item.dataset.chHidden = '0';
        btn.textContent = '隐藏回复';
      } else {
        // No replies - remove the button entirely
        btn.remove();
        item.dataset.chLoaded = '1';
        item.dataset.chHidden = '1'; // Mark as "hidden" so clicking again won't try to reload
      }
    } catch(e) { btn.textContent = `加载失败: ${e.message||e}`; }
    finally { btn.disabled = false; }
  }

  /* ── load comments (dynamic, one page at a time) ────── */
  async function loadComments(reset, _depth) {
    _depth = _depth || 0;
    console.log('[BCS] loadComments called - reset:', reset, 'loading:', S.loading, 'done:', S.done, 'offset:', S.paginationOffset, 'depth:', _depth);
    if (S.loading || S.done && !reset) {
      console.log('[BCS] loadComments early return');
      return false;
    }
    ensureSidecar();
    S.loading = true;
    S.loadMore.disabled = true;
    setStatus(reset ? '加载中...' : '加载更多...');
    try {
      if (reset) {
        S.paginationOffset = ''; S.done = false;
        S.list.querySelectorAll('.bcs-item').forEach(e => e.remove());
      }
      console.log('[BCS] loadComments - resolving IDs...');
      await resolveIds();
      console.log('[BCS] loadComments - aid:', S.aid, 'bvid:', S.bvid);
      if (!S.aid) { S.loading = false; setStatus('等待视频...'); return 'retry'; }
      console.log('[BCS] loadComments - fetching replies, offset:', S.paginationOffset);
      const { replies, count, nextOffset, isEnd } = await fetchReplies();
      console.log('[BCS] loadComments - got replies:', replies.length, 'count:', count, 'nextOffset:', nextOffset, 'isEnd:', isEnd);
      S.paginationOffset = nextOffset;
      // Update comment count display
      if (count && S.count) {
        S.count.textContent = `共 ${count} 条`;
      }
      if (!replies.length && !S.paginationOffset) {
        S.done = true; setStatus('没有评论'); S.loadMore.hidden = true; return true;
      }
      // Filter out duplicates already in the list
      const existingIds = new Set();
      S.list.querySelectorAll('.bcs-item').forEach(e => {
        if (e.dataset.rpid) existingIds.add(e.dataset.rpid);
      });
      console.log('[BCS] loadComments - existing items:', existingIds.size);
      const uniqueReplies = replies.filter(r => {
        const id = r.rpid_str || String(r.rpid);
        return !existingIds.has(id);
      });
      console.log('[BCS] loadComments - unique replies:', uniqueReplies.length, 'duplicates:', replies.length - uniqueReplies.length);
      // If all replies are duplicates, skip to next page automatically (max 10 retries)
      if (uniqueReplies.length === 0 && replies.length > 0 && !isEnd && _depth < 10) {
        console.log('[BCS] loadComments - all duplicates, auto-advancing, depth:', _depth);
        S.loading = false;
        S.loadMore.disabled = false;
        setStatus('加载中...');
        await new Promise(r => setTimeout(r, 1000)); // Delay to avoid rate limiting
        return loadComments(false, _depth + 1);
      }
      // If no unique replies after retries, mark as done
      if (_depth >= 10 && uniqueReplies.length === 0) {
        console.log('[BCS] loadComments - no unique replies after 10 retries, marking as done');
        S.done = true;
        setStatus('没有更多评论');
        S.loadMore.hidden = true;
        S.loadMore.disabled = false;
        return true;
      }
      const f = document.createDocumentFragment();
      uniqueReplies.forEach(r => f.appendChild(renderReply(r)));
      S.list.insertBefore(f, S.loadMore);
      S.done = isEnd || replies.length === 0;
      console.log('[BCS] loadComments - rendered, done:', S.done, 'offset:', S.paginationOffset);
      setStatus(''); S.loadMore.hidden = S.done; S.loadMore.disabled = false;
      return true;
    } catch(e) {
      console.error('[BCS] loadComments error:', e);
      if (e.message === '412') {
        setStatus('风控限制，请稍后重试');
      } else {
        setStatus(`加载失败: ${e.message||e}`);
      }
      S.loadMore.hidden = false; S.loadMore.disabled = false;
      return false;
    } finally { S.loading = false; }
  }

  /* ── navigation handling ─────────────────────────────── */
  function hideSidecar() {
    if (S.host) S.host.style.display = 'none';
    document.documentElement.classList.remove('bcs-active');
    updateLayout();
  }

  function showSidecar() {
    if (S.host) {
      if (!S.host.isConnected) document.documentElement.appendChild(S.host);
      S.host.style.display = '';
    }
    document.documentElement.classList.add('bcs-active');
    applyNativeOverrides();
    updateLayout();
  }

  function onUrlChange() {
    if (S.url === location.href) return;
    S.url = location.href;
    if (!isVideo()) {
      hideSidecar();
      return;
    }
    showSidecar();
    placeSidecar();
    // reset & reload
    S.aid = null; S.bvid = null; S.paginationOffset = ''; S.loading = false; S.done = false;
    S.repliedRpidSet.clear(); // Clear session replied set for new video
    if (S.list) S.list.querySelectorAll('.bcs-item').forEach(e => e.remove());
    setStatus('加载中...');
    if (S.count) S.count.textContent = '全部评论';
    if (S.loadMore) S.loadMore.hidden = true;
    loadComments(true).then(r => { if (r === 'retry') scheduleRetry(CFG.retryDelay); });
  }

  function patchHistory(name) {
    const orig = history[name];
    history[name] = function() {
      const r = orig.apply(this, arguments);
      dispatchEvent(new Event('bcs-urlchange'));
      return r;
    };
  }

  function scheduleRetry(delay) {
    clearTimeout(S.retryTimer);
    S.retryTimer = setTimeout(async () => {
      if (!isVideo()) { hideSidecar(); return; }
      ensureSidecar(); placeSidecar();
      const r = await loadComments(true);
      if (r === 'retry') scheduleRetry(Math.min(delay + 250, CFG.maxRetryDelay));
    }, delay);
  }

  /* ── start ───────────────────────────────────────────── */
  function start() {
    patchHistory('pushState');
    patchHistory('replaceState');
    addEventListener('popstate', () => dispatchEvent(new Event('bcs-urlchange')));
    addEventListener('bcs-urlchange', onUrlChange);
    addEventListener('resize', () => { placeSidecar(); updateLayout(); }, { passive:true });
    addEventListener('scroll', placeSidecar, { passive:true });

    // Initial load
    if (isVideo()) {
      ensureSidecar(); placeSidecar(); updateLayout();
      loadComments(true).then(r => { if (r === 'retry') scheduleRetry(CFG.retryDelay); });
    }

    // MutationObserver: URL change + host re-append
    const mo = new MutationObserver(() => {
      onUrlChange();
      if (S.host && !S.host.isConnected) {
        document.documentElement.appendChild(S.host);
      }
      if (isVideo()) { applyNativeOverrides(); placeSidecar(); updateLayout(); }
    });
    mo.observe(document.documentElement, { childList:true, subtree:true });

    // Guard interval: keep sidecar & layout alive
    S.guardTimer = setInterval(() => {
      if (!isVideo()) return;
      if (!S.host) { ensureSidecar(); placeSidecar(); updateLayout(); return; }
      if (!S.host.isConnected) {
        document.documentElement.appendChild(S.host);
        placeSidecar();
      }
      updateLayout();
      if (!S.done && !S.loading && !S.aid) {
        loadComments(true).then(r => { if (r === 'retry') scheduleRetry(CFG.retryDelay); });
      }
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once:true });
  } else {
    start();
  }
})();
