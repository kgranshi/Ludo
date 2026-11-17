/**
 * Nepali Ludo v4 — Social board + economy (soft currency only, no cash-out)
 * Fun tokens → coins → level | Personal room + avatar skins | Auto rooms | Reconnect 60s
 * Text free | Voice time-based | Admin panel APIs
 */

const HOUR = 3_600_000, DAY = 24 * HOUR;
const RECONNECT_MS = 60_000;

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function cors() { return new Response(null, { status: 204, headers: { 'Allow': 'GET, POST, OPTIONS' } }); }
function configuredSecret(env) { return typeof env.ADMIN_SECRET === 'string' && env.ADMIN_SECRET.length >= 24 ? env.ADMIN_SECRET : ''; }
function isInternal(request, env) { const secret = configuredSecret(env); return !!secret && request.headers.get('X-Internal-Secret') === secret; }
function internalHeaders(env) { const secret = configuredSecret(env); return { 'Content-Type': 'application/json', ...(secret ? { 'X-Internal-Secret': secret } : {}) }; }
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function rid(n = 12) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); }

function publicUser(u) {
  if (!u) return null;
  const now = Date.now();
  const voiceUntil = u.voiceUntil || 0;
  return {
    username: u.username,
    displayName: u.displayName,
    avatarPhoto: u.avatarPhoto || '',
    status: u.status || 'offline',
    lastSeen: u.lastSeen || 0,
    voiceActive: !u.banned && voiceUntil > now,
    voiceUntil,
    voiceRemainingMs: Math.max(0, voiceUntil - now),
    funTokens: u.funTokens || 0,
    dailyFunTokens: (u.dailyFunDate === new Date().toISOString().slice(0, 10) ? (u.dailyFunTokens || 0) : 0),
    coins: u.coins || 0,
    equippedMic: u.equippedMic || 'mic_default',
    ownedMics: u.ownedMics || ['mic_default'],
    level: u.level || 1,
    wins: u.wins || 0,
    games: u.games || 0,
    equippedSkin: u.equippedSkin || 'default',
    equippedAvatar: u.equippedAvatar || 'default',
    ownedSkins: u.ownedSkins || ['default'],
    ownedAvatars: u.ownedAvatars || ['default'],
    roomDecor: u.roomDecor || [],
    roomDecorEquipped: u.roomDecorEquipped || [],
    referralCode: u.referralCode,
    banned: !!u.banned,
    rankScore: (u.level || 1) * 1000 + (u.wins || 0)
  };
}

function applyLevelUps(u) {
  // 100 fun → 1 coin automatic conversion optional on win; 100 coins → level
  while ((u.coins || 0) >= 100) {
    u.coins -= 100;
    u.level = (u.level || 1) + 1;
    // level rewards applied by reading shop config externally when needed
  }
  return u;
}

// ===================== ShopConfig =====================
export class ShopConfig {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  defaultConfig() {
    return {
      voicePackages: [
        { id: 'v1h', label: '1 Hour Voice', ms: HOUR, priceNpr: 19 },
        { id: 'v1d', label: '1 Day Voice', ms: DAY, priceNpr: 49 },
        { id: 'v7d', label: '7 Days Voice', ms: 7 * DAY, priceNpr: 149 },
        { id: 'v30d', label: '30 Days Voice', ms: 30 * DAY, priceNpr: 299 }
      ],
      skins: [
        { id: 'default', label: 'Classic Board', priceCoins: 0, priceFun: 0, minLevel: 1 },
        { id: 'gold', label: 'Golden Board', priceCoins: 20, priceFun: 0, minLevel: 2 },
        { id: 'nepal', label: 'Nepal Theme', priceCoins: 30, priceFun: 0, minLevel: 3 },
        { id: 'neon', label: 'Neon Room', priceCoins: 50, priceFun: 0, minLevel: 5 }
      ],
      avatars: [
        { id: 'default', label: 'Default Avatar', priceCoins: 0, minLevel: 1 },
        { id: 'hero', label: 'Hero Avatar', priceCoins: 15, minLevel: 2 },
        { id: 'king', label: 'King Avatar', priceCoins: 40, minLevel: 4 }
      ],
      mics: [
        { id: 'mic_default', label: 'Default Mic', priceCoins: 0, minLevel: 1 },
        { id: 'mic_gold', label: 'Gold Mic', priceCoins: 25, minLevel: 2 },
        { id: 'mic_neon', label: 'Neon Mic', priceCoins: 40, minLevel: 4 }
      ],
      roomItems: [
        { id: 'lamp', label: 'Room Lamp', priceCoins: 10, minLevel: 1 },
        { id: 'trophy', label: 'Trophy Shelf', priceCoins: 25, minLevel: 3 },
        { id: 'sofa', label: 'VIP Sofa', priceCoins: 35, minLevel: 4 }
      ],
      levelRewards: {
        '2': { skinId: 'gold', funTokens: 50 },
        '3': { avatarId: 'hero', roomItem: 'lamp' },
        '5': { skinId: 'neon', funTokens: 100 }
      },
      paymentMethods: [
        { id: 'esewa', label: 'eSewa', detail: 'Set by admin', qrUrl: '' },
        { id: 'khalti', label: 'Khalti', detail: 'Set by admin', qrUrl: '' }
      ],
      dailyLoginVoiceMs: 0, // voice from referral/buy/gift primarily
      dailyLoginFunTokens: 50, // expires same calendar day
      referralRewardFunTokens: 100, // both sides
      referralRewardVoiceMs: 10 * DAY, // both sides
      starterFunTokens: 100,
      defaultStake: 20,
      stakes: [0, 10, 20, 50, 100],
      paymentEnabled: false, // real-money shop coming soon until admin enables
      updatedAt: Date.now()
    };
  }
  async getConfig() { return (await this.ctx.storage.get('config')) || this.defaultConfig(); }

  async fetch(request) {
    if (request.method === 'OPTIONS') return cors();
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//, '');
    const secret = configuredSecret(this.env);
    let body = {};
    if (request.method === 'POST') try { body = await request.json(); } catch {}

    if (path === 'get' || request.method === 'GET' && !path) return json({ ok: true, config: await this.getConfig() });

    if (path === 'set' && request.method === 'POST') {
      if (!secret || body.secret !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      const cur = await this.getConfig();
      const next = { ...cur, ...body.config, updatedAt: Date.now() };
      await this.ctx.storage.put('config', next);
      return json({ ok: true, config: next });
    }

    if (path === 'submit-proof' && request.method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || String(body.token || '');
      if (!username || !token) return json({ ok: false, error: 'auth' }, 401);
      const ur = await this.env.USERS.get(this.env.USERS.idFromName(username)).fetch(new Request('https://user/me', { headers: { Authorization: 'Bearer ' + token } }));
      if (!ur.ok) return json({ ok: false, error: 'auth' }, 401);
      const cfg = await this.getConfig();
      if (!cfg.paymentEnabled) return json({ ok: false, error: 'payments disabled' }, 403);
      const pack = (cfg.voicePackages || []).find(x => x.id === body.packageId);
      const method = (cfg.paymentMethods || []).find(x => x.id === body.methodId);
      const amount = Number(body.amount);
      if (!pack || !method || !Number.isFinite(amount) || amount !== Number(pack.priceNpr || pack.price) || amount <= 0) return json({ ok: false, error: 'invalid package, method or amount' }, 400);
      const proofData = String(body.proofData || '');
      const proofMime = String(body.proofMime || '');
      if (proofData.length > 200000 || (proofData && !['image/jpeg','image/png','image/webp','application/pdf'].includes(proofMime))) return json({ ok: false, error: 'invalid proof file' }, 400);
      if (!proofData && !String(body.note || '').trim()) return json({ ok: false, error: 'payment proof or note required' }, 400);
      const proofs = (await this.ctx.storage.get('proofs')) || [];
      const item = {
        id: rid(8), username,
        packageId: String(body.packageId), packageType: 'voice',
        methodId: String(body.methodId), amount,
        note: String(body.note || '').slice(0, 300),
        proofData, proofMime,
        status: 'pending', time: Date.now()
      };
      proofs.push(item); while (proofs.length > 200) proofs.shift();
      await this.ctx.storage.put('proofs', proofs);
      try {
        await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch(new Request('https://lobby/admin-msg', {
          method: 'POST', headers: internalHeaders(this.env),
          body: JSON.stringify({ from: item.username, type: 'payment_proof', text: `Proof ${item.packageType}/${item.packageId} Rs.${item.amount}`, time: Date.now(), meta: { proofId: item.id } })
        }));
      } catch {}
      return json({ ok: true, id: item.id });
    }

    if (path === 'proofs') {
      if (!secret || request.headers.get('X-Admin-Secret') !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      return json({ ok: true, proofs: ((await this.ctx.storage.get('proofs')) || []).slice().reverse() });
    }

    if (path === 'proof-action' && request.method === 'POST') {
      if (!secret || body.secret !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      const proofs = (await this.ctx.storage.get('proofs')) || [];
      const p = proofs.find(x => x.id === body.proofId);
      if (!p) return json({ ok: false, error: 'not found' }, 404);
      p.status = body.action === 'approve' ? 'approved' : 'rejected';
      await this.ctx.storage.put('proofs', proofs);
      if (body.action === 'approve') {
        const cfg = await this.getConfig();
        await this.env.USERS.get(this.env.USERS.idFromName(p.username.toLowerCase())).fetch(new Request('https://user/admin-fulfill', {
          method: 'POST', headers: internalHeaders(this.env),
          body: JSON.stringify({ secret, packageType: p.packageType, packageId: p.packageId, config: cfg })
        }));
      }
      return json({ ok: true, proof: p });
    }

    // Marketplace listings (soft currency only)
    if (path === 'market-list' && request.method === 'GET') {
      return json({ ok: true, listings: (await this.ctx.storage.get('market')) || [] });
    }
    if (path === 'market-add' && request.method === 'POST') {
      const seller = String(body.seller || '').toLowerCase();
      const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const ur = seller && token ? await this.env.USERS.get(this.env.USERS.idFromName(seller)).fetch(new Request('https://user/me', { headers: { Authorization: 'Bearer ' + token } })) : null;
      if (!ur || !ur.ok) return json({ ok: false, error: 'auth' }, 401);
      const sellerData = await ur.json();
      const itemType = String(body.itemType || ''), itemId = String(body.itemId || '');
      const priceFun = Number(body.priceFun) || 0, priceCoins = Number(body.priceCoins) || 0;
      const owned = itemType === 'skin' ? sellerData.user?.ownedSkins : itemType === 'avatar' ? sellerData.user?.ownedAvatars : itemType === 'mic' ? sellerData.user?.ownedMics : itemType === 'room' ? sellerData.user?.roomDecor : [];
      if (!['skin','avatar','mic','room'].includes(itemType) || !/^[a-z0-9_-]{1,40}$/i.test(itemId) || !(owned || []).includes(itemId) || priceFun < 0 || priceCoins < 0 || priceFun + priceCoins <= 0 || priceFun > 1000000 || priceCoins > 1000000) return json({ ok: false, error: 'invalid listing or item not owned' }, 400);
      const listings = (await this.ctx.storage.get('market')) || [];
      const item = { id: rid(6), seller, itemType, itemId, priceFun, priceCoins, time: Date.now() };
      listings.push(item); while (listings.length > 100) listings.shift();
      await this.ctx.storage.put('market', listings);
      return json({ ok: true, item });
    }
    if (path === 'market-buy' && request.method === 'POST') {
      // P2P: buyer pays seller in fun or coins for an item listing
      const listings = (await this.ctx.storage.get('market')) || [];
      const listing = listings.find(x => x.id === body.listingId);
      if (!listing) return json({ ok: false, error: 'listing not found' }, 404);
      if (listing.seller === body.buyer) return json({ ok: false, error: 'cannot buy own' }, 400);
      // deduct from buyer, credit seller, transfer item ownership via user DOs
      const pay = await this.env.USERS.get(this.env.USERS.idFromName(body.buyer)).fetch(new Request('https://user/market-pay', {
        method: 'POST', headers: internalHeaders(this.env),
        body: JSON.stringify({ token: body.token, priceFun: listing.priceFun, priceCoins: listing.priceCoins, itemType: listing.itemType, itemId: listing.itemId, seller: listing.seller })
      }));
      const pj = await pay.json();
      if (!pj.ok) return json(pj, 400);
      const next = listings.filter(x => x.id !== listing.id);
      await this.ctx.storage.put('market', next);
      return json({ ok: true });
    }

    return json({ ok: false, error: 'not found' }, 404);
  }
}

// ===================== UserAccount =====================
export class UserAccount {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async get() { return (await this.ctx.storage.get('user')) || null; }
  async put(u) { await this.ctx.storage.put('user', u); }

  async cfg() {
    try {
      const r = await this.env.SHOP.get(this.env.SHOP.idFromName('main')).fetch('https://shop/get');
      const j = await r.json(); return j.config;
    } catch { return null; }
  }

  async fetch(request) {
    if (request.method === 'OPTIONS') return cors();
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//, '');
    const secret = configuredSecret(this.env);
    let body = {};
    if (request.method === 'POST') try { body = await request.json(); } catch {}

    if (path === 'register' && request.method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase().slice(0, 20);
      const password = String(body.password || '');
      const displayName = String(body.displayName || username).trim().slice(0, 18);
      const ref = String(body.referral || body.ref || '').trim().toUpperCase().slice(0, 12);
      if (!/^[a-z0-9_]{3,20}$/.test(username)) return json({ ok: false, error: 'Username 3-20 a-z0-9_' }, 400);
      if (password.length < 10 || password.length > 128) return json({ ok: false, error: 'Password must be 10-128 characters' }, 400);
      if (await this.get()) return json({ ok: false, error: 'Username taken' }, 409);
      const cfg = await this.cfg();
      const salt = rid(8);
      const user = {
        username, displayName, salt, passHash: await hashPassword(password, salt), token: rid(24),
        created: Date.now(), voiceUntil: 0, status: 'offline', lastSeen: Date.now(),
        funTokens: cfg?.starterFunTokens ?? 100, dailyFunTokens: 0, dailyFunDate: '', coins: 0, level: 1, wins: 0, games: 0,
        banned: false, ownedSkins: ['default'], ownedAvatars: ['default'], ownedMics: ['mic_default'],
        equippedSkin: 'default', equippedAvatar: 'default', equippedMic: 'mic_default',
        roomDecor: [], referralCode: rid(4).toUpperCase(), referredBy: ref || null, referralRewarded: false,
        dailyLoginDate: '', active: false
      };
      await this.put(user);
      try {
        await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch(new Request('https://lobby/register-refcode', {
          method: 'POST', headers: internalHeaders(this.env),
          body: JSON.stringify({ code: user.referralCode, username })
        }));
        if (ref) {
          await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch(new Request('https://lobby/referral-pending', {
            method: 'POST', headers: internalHeaders(this.env),
            body: JSON.stringify({ code: ref, newUser: username })
          }));
        }
      } catch {}
      return json({ ok: true, token: user.token, user: publicUser(user) });
    }

    if (path === 'login' && request.method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = await this.get();
      if (!user) return json({ ok: false, error: 'User not found' }, 404);
      if (user.banned) return json({ ok: false, error: 'Banned' }, 403);
      if (await hashPassword(password, user.salt) !== user.passHash) return json({ ok: false, error: 'Wrong password' }, 401);
      user.token = rid(24); user.lastSeen = Date.now();
      if (!user.active) {
        user.active = true;
        if (user.referredBy && !user.referralRewarded) {
          user.referralRewarded = true;
          try {
            await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch(new Request('https://lobby/referral-complete', {
              method: 'POST', headers: internalHeaders(this.env),
              body: JSON.stringify({ code: user.referredBy, newUser: user.username })
            }));
          } catch {}
        }
      }
      await this.put(user);
      return json({ ok: true, token: user.token, user: publicUser(user) });
    }

    const user = await this.get();
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || body.token || url.searchParams.get('token') || '';
    const authed = user && token && user.token === token;
    const internalOnly = new Set(['receive-voice-gift','economy','market-pay','market-credit','receive-item-gift','add-referral-reward','admin-fulfill']);
    if (internalOnly.has(path) && !isInternal(request, this.env)) return json({ ok: false, error: 'internal only' }, 403);

    if (path === 'me') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'update-profile' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const displayName = String(body.displayName || user.displayName || user.username).trim().slice(0, 18);
      if (!displayName) return json({ ok: false, error: 'Display name required' }, 400);
      if (body.avatarPhoto !== undefined) {
        const photo = String(body.avatarPhoto || '');
        if (photo && (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 205000)) {
          return json({ ok: false, error: 'Photo must be PNG/JPG/WEBP/GIF and under 150KB' }, 400);
        }
        user.avatarPhoto = photo;
      }
      user.displayName = displayName;
      await this.put(user);
      await this.pushPresence(user);
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'public' && request.method === 'GET') {
      // visit someone's room (no secrets)
      if (!user) return json({ ok: false, error: 'not found' }, 404);
      return json({
        ok: true,
        profile: {
          username: user.username, displayName: user.displayName, avatarPhoto: user.avatarPhoto || '', level: user.level || 1, wins: user.wins || 0, games: user.games || 0,
          equippedAvatar: user.equippedAvatar, equippedSkin: user.equippedSkin, roomDecor: user.roomDecorEquipped || [],
          voiceActive: !user.banned && (user.voiceUntil || 0) > Date.now(), rankScore: (user.level || 1) * 1000 + (user.wins || 0)
        }
      });
    }

    if (path === 'heartbeat' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      user.lastSeen = Date.now();
      if (user.status === 'offline') user.status = 'online';
      await this.put(user); await this.pushPresence(user);
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'setstatus' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      if (!['online', 'busy', 'offline'].includes(body.status)) return json({ ok: false }, 400);
      user.status = body.status; user.lastSeen = Date.now();
      await this.put(user); await this.pushPresence(user);
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'daily-login' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const today = new Date().toISOString().slice(0, 10);
      if (user.dailyLoginDate === today) return json({ ok: true, already: true, user: publicUser(user) });
      const cfg = await this.cfg();
      const addFun = cfg?.dailyLoginFunTokens ?? 50;
      const addVoice = cfg?.dailyLoginVoiceMs || 0;
      const now = Date.now();
      user.dailyFunTokens = addFun;
      user.dailyFunDate = today;
      user.dailyLoginDate = today;
      if (addVoice > 0) user.voiceUntil = Math.max(user.voiceUntil || 0, now) + addVoice;
      await this.put(user); await this.pushPresence(user);
      return json({ ok: true, user: publicUser(user), addedFun: addFun, addedMs: addVoice });
    }

    if (path === 'gift-voice' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const to = String(body.to || '').trim().toLowerCase();
      const ms = Math.floor(Number(body.ms) || 0);
      if (!to || ms < 60_000) return json({ ok: false, error: 'min 1 min' }, 400);
      const now = Date.now();
      const remaining = Math.max(0, (user.voiceUntil || 0) - now);
      if (remaining < ms) return json({ ok: false, error: 'Not enough voice time' }, 400);
      user.voiceUntil = now + remaining - ms;
      await this.put(user);
      const gr = await this.env.USERS.get(this.env.USERS.idFromName(to)).fetch(new Request('https://user/receive-voice-gift', {
        method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ ms, from: user.username })
      }));
      const gj = await gr.json();
      if (!gj.ok) { user.voiceUntil = now + remaining; await this.put(user); return json({ ok: false, error: gj.error || 'fail' }, 400); }
      await this.pushPresence(user);
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'receive-voice-gift' && request.method === 'POST') {
      let u = await this.get(); if (!u) return json({ ok: false, error: 'not found' }, 404);
      const ms = Math.floor(Number(body.ms) || 0);
      const now = Date.now();
      u.voiceUntil = Math.max(u.voiceUntil || 0, now) + ms;
      await this.put(u); return json({ ok: true });
    }

    if (path === 'equip' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      if (body.skinId && (user.ownedSkins || []).includes(body.skinId)) user.equippedSkin = body.skinId;
      if (body.avatarId && (user.ownedAvatars || []).includes(body.avatarId)) user.equippedAvatar = body.avatarId;
      if (body.micId && (user.ownedMics || []).includes(body.micId)) user.equippedMic = body.micId;
      if (Array.isArray(body.roomDecor)) {
        const allowed = new Set(user.roomDecor || []);
        const requested = body.roomDecor.slice(0, 20).filter(id => allowed.has(id));
        user.roomDecorEquipped = requested;
      }
      await this.put(user); return json({ ok: true, user: publicUser(user) });
    }

    // Buy cosmetic with coins/fun (soft)
    if (path === 'buy-soft' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const cfg = await this.cfg();
      const kind = body.kind; // skin | avatar | room
      const id = body.id;
      let item = null;
      if (kind === 'skin') item = (cfg?.skins || []).find(x => x.id === id);
      if (kind === 'avatar') item = (cfg?.avatars || []).find(x => x.id === id);
      if (kind === 'room') item = (cfg?.roomItems || []).find(x => x.id === id);
      if (kind === 'mic') item = (cfg?.mics || []).find(x => x.id === id);
      if (!item) return json({ ok: false, error: 'item not found' }, 404);
      if ((user.level || 1) < (item.minLevel || 1)) return json({ ok: false, error: 'Level too low' }, 400);
      const pc = item.priceCoins || 0, pf = item.priceFun || 0;
      if ((user.coins || 0) < pc || (user.funTokens || 0) < pf) return json({ ok: false, error: 'Not enough coins/tokens' }, 400);
      user.coins = (user.coins || 0) - pc;
      user.funTokens = (user.funTokens || 0) - pf;
      if (kind === 'skin') user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), id]));
      if (kind === 'avatar') user.ownedAvatars = Array.from(new Set([...(user.ownedAvatars || []), id]));
      if (kind === 'room') user.roomDecor = Array.from(new Set([...(user.roomDecor || []), id]));
      if (kind === 'mic') user.ownedMics = Array.from(new Set([...(user.ownedMics || ['mic_default']), id]));
      await this.put(user);
      return json({ ok: true, user: publicUser(user) });
    }

    // Convert 100 fun → 1 coin manually
    if (path === 'convert-fun' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const times = Math.min(100, Math.floor(Number(body.times) || 1));
      const need = times * 100;
      if ((user.funTokens || 0) < need) return json({ ok: false, error: 'Need more fun tokens' }, 400);
      user.funTokens -= need;
      user.coins = (user.coins || 0) + times;
      applyLevelUps(user);
      // level rewards
      const cfg = await this.cfg();
      const lr = cfg?.levelRewards || {};
      const reward = lr[String(user.level)];
      if (reward && !user._lr || user._lr < user.level) {
        user._lr = user.level;
        if (reward.skinId) user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), reward.skinId]));
        if (reward.avatarId) user.ownedAvatars = Array.from(new Set([...(user.ownedAvatars || []), reward.avatarId]));
        if (reward.roomItem) user.roomDecor = Array.from(new Set([...(user.roomDecor || []), reward.roomItem]));
        if (reward.funTokens) user.funTokens = (user.funTokens || 0) + reward.funTokens;
      }
      await this.put(user);
      return json({ ok: true, user: publicUser(user) });
    }

    // Internal economy adjusts from room
    if (path === 'economy' && request.method === 'POST') {
      if (!user) return json({ ok: false }, 404);
      let funDelta = Number(body.funDelta) || 0;
      const win = !!body.win;
      const today = new Date().toISOString().slice(0, 10);
      if (user.dailyFunDate !== today) { user.dailyFunTokens = 0; user.dailyFunDate = today; }
      // spending (negative): use daily first, then permanent; winnings always permanent
      if (funDelta < 0) {
        let need = -funDelta;
        const available = (user.dailyFunTokens || 0) + (user.funTokens || 0);
        if (available < need) return json({ ok: false, error: 'insufficient balance' }, 400);
        const d = user.dailyFunTokens || 0;
        const fromDaily = Math.min(d, need);
        user.dailyFunTokens = d - fromDaily;
        need -= fromDaily;
        if (need > 0) user.funTokens = (user.funTokens || 0) - need;
      } else if (funDelta > 0) {
        user.funTokens = (user.funTokens || 0) + funDelta; // permanent winnings
      }
      user.games = (user.games || 0) + (body.game ? 1 : 0);
      if (win) user.wins = (user.wins || 0) + 1;
      // auto convert optional: every 100 fun → 1 coin on win path
      if (body.autoConvert) {
        const c = Math.floor((user.funTokens || 0) / 100);
        if (c > 0) { user.funTokens -= c * 100; user.coins = (user.coins || 0) + c; applyLevelUps(user); }
      }
      await this.put(user);
      return json({ ok: true, user: publicUser(user) });
    }

    
    if (path === 'market-pay' && request.method === 'POST') {
      if (!user) return json({ ok: false, error: 'no user' }, 404);
      if (body.token !== user.token) return json({ ok: false, error: 'auth' }, 401);
      const pf = Number(body.priceFun) || 0, pc = Number(body.priceCoins) || 0;
      if ((user.funTokens || 0) < pf || (user.coins || 0) < pc) return json({ ok: false, error: 'insufficient balance' }, 400);
      user.funTokens = (user.funTokens || 0) - pf;
      user.coins = (user.coins || 0) - pc;
      if (body.itemType === 'skin') user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), body.itemId]));
      if (body.itemType === 'avatar') user.ownedAvatars = Array.from(new Set([...(user.ownedAvatars || []), body.itemId]));
      if (body.itemType === 'mic') user.ownedMics = Array.from(new Set([...(user.ownedMics || []), body.itemId]));
      if (body.itemType === 'room') user.roomDecor = Array.from(new Set([...(user.roomDecor || []), body.itemId]));
      await this.put(user);
      await this.env.USERS.get(this.env.USERS.idFromName(body.seller)).fetch(new Request('https://user/market-credit', {
        method: 'POST', headers: internalHeaders(this.env),
        body: JSON.stringify({ fun: pf, coins: pc, itemType: body.itemType, itemId: body.itemId })
      }));
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'market-credit' && request.method === 'POST') {
      if (!user) return json({ ok: false }, 404);
      user.funTokens = (user.funTokens || 0) + (Number(body.fun) || 0);
      user.coins = (user.coins || 0) + (Number(body.coins) || 0);
      if (body.itemType === 'skin' && body.itemId && body.itemId !== 'default') {
        user.ownedSkins = (user.ownedSkins || []).filter(x => x !== body.itemId);
        if (user.equippedSkin === body.itemId) user.equippedSkin = 'default';
      }
      if (body.itemType === 'avatar' && body.itemId && body.itemId !== 'default') {
        user.ownedAvatars = (user.ownedAvatars || []).filter(x => x !== body.itemId);
        if (user.equippedAvatar === body.itemId) user.equippedAvatar = 'default';
      }
      if (body.itemType === 'mic' && body.itemId && body.itemId !== 'mic_default') {
        user.ownedMics = (user.ownedMics || []).filter(x => x !== body.itemId);
        if (user.equippedMic === body.itemId) user.equippedMic = 'mic_default';
      }
      await this.put(user);
      return json({ ok: true });
    }

    if (path === 'gift-item' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const to = String(body.to || '').toLowerCase();
      const itemType = body.itemType, itemId = body.itemId;
      if (!to || !itemType || !itemId) return json({ ok: false, error: 'bad request' }, 400);
      if (itemType === 'skin') {
        if (!(user.ownedSkins || []).includes(itemId) || itemId === 'default') return json({ ok: false, error: 'not owned' }, 400);
        user.ownedSkins = user.ownedSkins.filter(x => x !== itemId);
        if (user.equippedSkin === itemId) user.equippedSkin = 'default';
      } else if (itemType === 'mic') {
        if (!(user.ownedMics || []).includes(itemId) || itemId === 'mic_default') return json({ ok: false, error: 'not owned' }, 400);
        user.ownedMics = user.ownedMics.filter(x => x !== itemId);
        if (user.equippedMic === itemId) user.equippedMic = 'mic_default';
      } else return json({ ok: false, error: 'unsupported' }, 400);
      await this.put(user);
      await this.env.USERS.get(this.env.USERS.idFromName(to)).fetch(new Request('https://user/receive-item-gift', {
        method: 'POST', headers: internalHeaders(this.env),
        body: JSON.stringify({ itemType, itemId })
      }));
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'receive-item-gift' && request.method === 'POST') {
      if (!user) return json({ ok: false }, 404);
      if (body.itemType === 'skin') user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), body.itemId]));
      if (body.itemType === 'mic') user.ownedMics = Array.from(new Set([...(user.ownedMics || []), body.itemId]));
      if (body.itemType === 'avatar') user.ownedAvatars = Array.from(new Set([...(user.ownedAvatars || []), body.itemId]));
      await this.put(user);
      return json({ ok: true });
    }

    if (path === 'admin-ban' && request.method === 'POST') {
      if (!secret || body.secret !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!user) return json({ ok: false }, 404);
      user.banned = !!body.banned; await this.put(user); return json({ ok: true, user: publicUser(user) });
    }
    if (path === 'admin-grant-voice' && request.method === 'POST') {
      if (!secret || body.secret !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!user) return json({ ok: false }, 404);
      const ms = Math.floor(Number(body.ms) || (Number(body.days) || 0) * DAY);
      const now = Date.now(); user.voiceUntil = Math.max(user.voiceUntil || 0, now) + ms;
      await this.put(user); return json({ ok: true, user: publicUser(user) });
    }
    if (path === 'admin-grant-skin' && request.method === 'POST') {
      if (!secret || body.secret !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!user) return json({ ok: false }, 404);
      user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), body.skinId]));
      await this.put(user); return json({ ok: true, user: publicUser(user) });
    }
    if (path === 'admin-fulfill' && request.method === 'POST') {
      if (!secret || body.secret !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!user) return json({ ok: false }, 404);
      const cfg = body.config || {};
      const now = Date.now();
      if (body.packageType === 'voice') {
        const pack = (cfg.voicePackages || []).find(p => p.id === body.packageId);
        if (pack) user.voiceUntil = Math.max(user.voiceUntil || 0, now) + pack.ms;
      }
      await this.put(user); return json({ ok: true, user: publicUser(user) });
    }
    if (path === 'add-referral-reward' && request.method === 'POST') {
      if (!user) return json({ ok: false }, 404);
      const ms = Math.floor(Number(body.ms) || 0);
      const fun = Math.floor(Number(body.fun) || 0);
      const now = Date.now();
      if (ms > 0) user.voiceUntil = Math.max(user.voiceUntil || 0, now) + ms;
      if (fun > 0) user.funTokens = (user.funTokens || 0) + fun;
      await this.put(user); return json({ ok: true });
    }

    return json({ ok: false, error: 'not found' }, 404);
  }

  async pushPresence(user) {
    try {
      await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch(new Request('https://lobby/presence', {
        method: 'POST', headers: internalHeaders(this.env),
        body: JSON.stringify({
          username: user.username, displayName: user.displayName, status: user.status, lastSeen: user.lastSeen,
          voiceActive: !user.banned && (user.voiceUntil || 0) > Date.now(),
          level: user.level || 1, equippedAvatar: user.equippedAvatar, avatarPhoto: user.avatarPhoto || '', rankScore: (user.level || 1) * 1000 + (user.wins || 0)
        })
      }));
    } catch {}
  }
}

// ===================== Lobby =====================
export class Lobby {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    if (request.method === 'OPTIONS') return cors();
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//, '');
    let body = {};
    if (request.method === 'POST') try { body = await request.json(); } catch {}
    const secret = configuredSecret(this.env);
    const internalOnly = new Set(['presence','register-refcode','referral-pending','referral-complete','admin-msg']);
    if (internalOnly.has(path) && !isInternal(request, this.env)) return json({ ok: false, error: 'internal only' }, 403);
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const lobbyAuth = async (username) => {
      if (!username || !bearer) return false;
      try { const r = await this.env.USERS.get(this.env.USERS.idFromName(String(username).toLowerCase())).fetch(new Request('https://user/me', { headers: { Authorization: 'Bearer ' + bearer } })); return r.ok; } catch { return false; }
    };

    if (path === 'presence' && request.method === 'POST') {
      const list = (await this.ctx.storage.get('online')) || {};
      if (!body.username) return json({ ok: false }, 400);
      list[body.username] = {
        username: body.username, displayName: body.displayName, status: body.status || 'online',
        lastSeen: body.lastSeen || Date.now(), voiceActive: !!body.voiceActive,
        level: body.level || 1, equippedAvatar: body.equippedAvatar || 'default', avatarPhoto: body.avatarPhoto || '', rankScore: body.rankScore || 0
      };
      const now = Date.now();
      for (const k of Object.keys(list)) if (now - (list[k].lastSeen || 0) > 5 * 60 * 1000) delete list[k];
      await this.ctx.storage.put('online', list);
      return json({ ok: true });
    }

    if (path === 'online') {
      const list = (await this.ctx.storage.get('online')) || {};
      const now = Date.now();
      const out = Object.values(list).filter(u => now - (u.lastSeen || 0) <= 5 * 60 * 1000);
      out.sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0));
      return json({ ok: true, users: out });
    }

    // Play request → on accept create room code and return to both
    if (path === 'play-request' && request.method === 'POST') {
      const { from, to, fromName, stake } = body;
      if (!(await lobbyAuth(from))) return json({ ok: false, error: 'auth' }, 401);
      if (!from || !to) return json({ ok: false }, 400);
      const key = `req:${to}`;
      const reqs = (await this.ctx.storage.get(key)) || [];
      const id = rid(6);
      reqs.push({ from, fromName, stake: Number(stake) || 0, time: Date.now(), id });
      while (reqs.length > 20) reqs.shift();
      await this.ctx.storage.put(key, reqs);
      return json({ ok: true, id });
    }

    if (path === 'play-requests') {
      const username = url.searchParams.get('u') || '';
      if (!(await lobbyAuth(username))) return json({ ok: false, error: 'auth' }, 401);
      let reqs = (await this.ctx.storage.get(`req:${username}`)) || [];
      const now = Date.now();
      reqs = reqs.filter(r => now - r.time < 10 * 60 * 1000);
      await this.ctx.storage.put(`req:${username}`, reqs);
      return json({ ok: true, requests: reqs });
    }

    if (path === 'accept-request' && request.method === 'POST') {
      // creates room code, stores invite for both players
      const { username, id } = body;
      if (!(await lobbyAuth(username))) return json({ ok: false, error: 'auth' }, 401);
      let reqs = (await this.ctx.storage.get(`req:${username}`)) || [];
      const r = reqs.find(x => x.id === id);
      if (!r) return json({ ok: false, error: 'request gone' }, 404);
      reqs = reqs.filter(x => x.id !== id);
      await this.ctx.storage.put(`req:${username}`, reqs);
      const code = rid(3).toUpperCase().slice(0, 6);
      const roomCode = (code + rid(2)).toUpperCase().replace(/[^A-Z0-9]/g, 'A').slice(0, 6);
      const invites = (await this.ctx.storage.get('invites')) || {};
      const inv = { roomCode, host: username, guest: r.from, stake: r.stake || 0, time: Date.now() };
      invites[r.from] = inv;
      invites[username] = inv;
      await this.ctx.storage.put('invites', invites);
      return json({ ok: true, roomCode, stake: r.stake || 0, guest: r.from });
    }

    if (path === 'my-invite') {
      const u = url.searchParams.get('u') || '';
      if (!(await lobbyAuth(u))) return json({ ok: false, error: 'auth' }, 401);
      const invites = (await this.ctx.storage.get('invites')) || {};
      const inv = invites[u];
      if (inv && Date.now() - inv.time < 5 * 60 * 1000) return json({ ok: true, invite: inv });
      return json({ ok: true, invite: null });
    }

    if (path === 'clear-request' && request.method === 'POST') {
      if (!(await lobbyAuth(body.username))) return json({ ok: false, error: 'auth' }, 401);
      let reqs = (await this.ctx.storage.get(`req:${body.username}`)) || [];
      reqs = reqs.filter(r => r.id !== body.id);
      await this.ctx.storage.put(`req:${body.username}`, reqs);
      return json({ ok: true });
    }

    if (path === 'register-refcode' && request.method === 'POST') {
      const map = (await this.ctx.storage.get('refmap')) || {};
      map[body.code] = body.username;
      await this.ctx.storage.put('refmap', map);
      return json({ ok: true });
    }
    if (path === 'referral-pending' && request.method === 'POST') {
      const pending = (await this.ctx.storage.get('refpending')) || {};
      if (!pending[body.code]) pending[body.code] = [];
      pending[body.code].push(body.newUser);
      await this.ctx.storage.put('refpending', pending);
      return json({ ok: true });
    }
    if (path === 'referral-complete' && request.method === 'POST') {
      const map = (await this.ctx.storage.get('refmap')) || {};
      const owner = map[body.code];
      if (!owner) return json({ ok: true, skipped: true });
      let rewardMs = 10 * DAY, rewardFun = 100;
      try {
        const cr = await this.env.SHOP.get(this.env.SHOP.idFromName('main')).fetch('https://shop/get');
        const cj = await cr.json();
        rewardMs = cj.config?.referralRewardVoiceMs ?? rewardMs;
        rewardFun = cj.config?.referralRewardFunTokens ?? rewardFun;
      } catch {}
      // reward referrer
      await this.env.USERS.get(this.env.USERS.idFromName(owner)).fetch(new Request('https://user/add-referral-reward', {
        method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ ms: rewardMs, fun: rewardFun })
      }));
      // reward new user (already marked referralRewarded on their side)
      await this.env.USERS.get(this.env.USERS.idFromName(body.newUser)).fetch(new Request('https://user/add-referral-reward', {
        method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ ms: rewardMs, fun: rewardFun })
      }));
      return json({ ok: true, owner, rewardMs, rewardFun });
    }

    if (path === 'admin-msg' && request.method === 'POST') {
      const msgs = (await this.ctx.storage.get('admin_inbox')) || [];
      msgs.push({ id: rid(8), from: body.from || 'system', type: body.type || 'msg', text: String(body.text || '').slice(0, 500), time: body.time || Date.now(), meta: body.meta || null, read: false });
      while (msgs.length > 150) msgs.shift();
      await this.ctx.storage.put('admin_inbox', msgs);
      return json({ ok: true });
    }
    if (path === 'admin-inbox') {
      if (!secret || request.headers.get('X-Admin-Secret') !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      return json({ ok: true, messages: ((await this.ctx.storage.get('admin_inbox')) || []).slice().reverse() });
    }

    return json({ ok: false, error: 'not found' }, 404);
  }
}

// ===================== LudoRoom =====================
export class LudoRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const url = new URL(request.url);
    const username = (url.searchParams.get('u') || '').toLowerCase();
    const name = (url.searchParams.get('name') || username).slice(0, 18);
    const token = url.searchParams.get('token') || '';
    const create = url.searchParams.get('create') === '1';
    const requestedStake = Number(url.searchParams.get('stake') || 0);
    const stake = Number.isSafeInteger(requestedStake) && requestedStake >= 0 ? requestedStake : -1;
    if (!username || !token) return new Response('auth required', { status: 401 });
    if (stake < 0 || stake > 100000) return new Response('Invalid stake', { status: 400 });

    const userRes = await this.env.USERS.get(this.env.USERS.idFromName(username)).fetch(new Request('https://user/me', { headers: { Authorization: 'Bearer ' + token } }));
    const userJson = await userRes.json();
    if (!userJson.ok) return new Response('invalid token', { status: 401 });
    if (userJson.user.banned) return new Response('banned', { status: 403 });
    const voiceActive = !!userJson.user.voiceActive;
    const avatar = userJson.user.equippedAvatar || 'default';
    const avatarPhoto = userJson.user.avatarPhoto || '';
    const skin = userJson.user.equippedSkin || 'default';
    const equippedMic = userJson.user.equippedMic || 'mic_default';
    const roomDecorEquipped = userJson.user.roomDecorEquipped || [];

    let room = await this.ctx.storage.get('room');
    if (!room && !create) return new Response('Room not found', { status: 404 });
    if (!room) {
      const cfgRes = await this.env.SHOP.get(this.env.SHOP.idFromName('main')).fetch('https://shop/get');
      const cfgJson = await cfgRes.json().catch(() => ({}));
      const allowedStakes = cfgJson.config?.stakes || [0, 10, 20, 50, 100];
      if (!Array.isArray(allowedStakes) || !allowedStakes.includes(stake)) return new Response('Stake not allowed', { status: 400 });
      room = { host: username, players: [], state: null, chat: [], stake, pot: 0, paid: false, locked: false, disconnects: {} };
    }

    // locked after start
    let player = room.players.find(p => p.username === username);
    if (!player) {
      if (room.locked || room.state) return new Response('Room locked (game in progress)', { status: 409 });
      if (room.players.length >= 4) return new Response('Room full', { status: 409 });
      if (room.stake > 0 && (userJson.user.funTokens || 0) < room.stake) return new Response('Not enough fun tokens', { status: 402 });
      const seat = [0, 1, 2, 3].find(i => !room.players.some(p => p.seat === i));
      player = { username, name, seat, tokens: [-1, -1, -1, -1], voiceActive, avatar, avatarPhoto, skin, equippedMic, roomDecorEquipped, connected: true };
      room.players.push(player);
    } else {
      // reconnect
      player.name = name; player.voiceActive = voiceActive; player.avatar = avatar; player.avatarPhoto = avatarPhoto; player.skin = skin; player.equippedMic = equippedMic; player.roomDecorEquipped = roomDecorEquipped; player.connected = true;
      if (room.disconnects?.[username]) delete room.disconnects[username];
    }
    await this.ctx.storage.put('room', room);

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ username, voiceActive });

    server.send(JSON.stringify({
      type: 'state', room: pubRoom(room), message: 'Joined room',
      peers: room.players.filter(p => p.username !== username).map(p => ({ username: p.username, name: p.name, seat: p.seat, voiceActive: p.voiceActive, avatar: p.avatar, avatarPhoto: p.avatarPhoto || '' }))
    }));
    this.broadcast(room, 'Player joined', username);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data; try { data = JSON.parse(message); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    const username = att.username;
    let room = await this.ctx.storage.get('room');
    if (!room) return;
    const seat = room.players.findIndex(p => p.username === username);
    if (seat < 0) return;
    const reply = (text) => ws.send(JSON.stringify({ type: 'error', message: text }));

    if (data.type === 'webrtc-offer' || data.type === 'webrtc-answer' || data.type === 'webrtc-ice') {
      if (!att.voiceActive) return reply('Voice required');
      for (const peer of this.ctx.getWebSockets()) {
        try {
          const pa = peer.deserializeAttachment() || {};
          if (pa.username === data.to) {
            if (!pa.voiceActive) return reply('Other has no Voice');
            peer.send(JSON.stringify({ ...data, from: username, fromName: room.players[seat]?.name }));
            break;
          }
        } catch {}
      }
      return;
    }

    if (data.type === 'chat') {
      const text = String(data.text || '').trim().slice(0, 200); if (!text) return;
      const msg = { from: username, name: room.players[seat].name, text, time: Date.now() };
      room.chat = room.chat || []; room.chat.push(msg); if (room.chat.length > 50) room.chat.shift();
      await this.ctx.storage.put('room', room);
      const packet = JSON.stringify({ type: 'chat', msg });
      for (const peer of this.ctx.getWebSockets()) try { peer.send(packet); } catch {}
      return;
    }

    if (data.type === 'mic-state') {
      // broadcast who muted/unmuted for UI
      const packet = JSON.stringify({ type: 'mic-state', username, on: !!data.on });
      for (const peer of this.ctx.getWebSockets()) try { peer.send(packet); } catch {}
      return;
    }

    if (data.type === 'leave') {
      if (room.state && room.locked) {
        // soft disconnect instead of remove
        room.players[seat].connected = false;
        room.disconnects = room.disconnects || {};
        room.disconnects[username] = Date.now();
        await this.ctx.storage.put('room', room);
        this.broadcast(room, username + ' disconnected (60s to return)');
        this.broadcastRaw({ type: 'peer-left', username, soft: true });
        return;
      }
      room.players = room.players.filter(p => p.username !== username);
      if (room.host === username) room.host = room.players[0]?.username || null;
      if (!room.players.length) { room.state = null; room.locked = false; room.paid = false; room.pot = 0; }
      await this.ctx.storage.put('room', room);
      this.broadcast(room, 'Player left');
      this.broadcastRaw({ type: 'peer-left', username });
      return;
    }

    if (data.type === 'vote-continue') {
      // after 60s disconnect, remaining players vote to drop disconnected seats and continue
      room.votes = room.votes || {};
      room.votes[username] = true;
      const connected = room.players.filter(p => p.connected !== false);
      const need = Math.ceil(connected.length * 0.5);
      const yes = Object.keys(room.votes).filter(u => room.votes[u] && connected.some(p => p.username === u)).length;
      if (yes >= need) {
        const now = Date.now();
        room.players = room.players.filter(p => {
          if (p.connected === false && room.disconnects?.[p.username] && now - room.disconnects[p.username] >= RECONNECT_MS) return false;
          return true;
        });
        // reindex seats
        room.players.forEach((p, i) => p.seat = i);
        if (room.state && room.state.turn >= room.players.length) room.state.turn = 0;
        room.votes = {};
        await this.ctx.storage.put('room', room);
        this.broadcast(room, 'Game continues without disconnected players');
      } else {
        await this.ctx.storage.put('room', room);
        this.broadcast(room, `Continue votes: ${yes}/${need}`);
      }
      return;
    }

    if (data.type === 'start' || data.type === 'rematch') {
      if (room.host !== username) return reply('Only host');
      if (room.players.length < 2) return reply('Need 2+ players');
      // collect stake
      if (room.stake > 0 && !room.paid) {
        const charged = [];
        for (const p of room.players) {
          const res = await this.env.USERS.get(this.env.USERS.idFromName(p.username)).fetch(new Request('https://user/economy', {
            method: 'POST', headers: internalHeaders(this.env),
            body: JSON.stringify({ funDelta: -room.stake, game: false })
          }));
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok) {
            // Refund every player already charged; do not start a partially-funded game.
            for (const chargedUser of charged) {
              await this.env.USERS.get(this.env.USERS.idFromName(chargedUser)).fetch(new Request('https://user/economy', {
                method: 'POST', headers: internalHeaders(this.env),
                body: JSON.stringify({ funDelta: room.stake, game: false })
              })).catch(() => null);
            }
            return reply('Stake collection failed; all collected stakes were refunded.');
          }
          charged.push(p.username);
        }
        room.pot = room.stake * room.players.length;
        room.paid = true;
      } else if (!room.paid) { room.pot = 0; room.paid = true; }

      room.players.sort((a, b) => a.seat - b.seat);
      room.players.forEach(p => { p.tokens = [-1, -1, -1, -1]; p.connected = true; });
      room.state = { turn: 0, dice: 0, rolled: false, streak: 0, finished: false, winner: null };
      room.locked = true;
      room.disconnects = {};
      room.votes = {};
    } else if (data.type === 'roll') {
      const s = room.state;
      if (!s || s.finished || s.turn !== seat || s.rolled) return reply('Not your roll');
      if (room.players[seat].connected === false) return reply('Disconnected');
      const d = 1 + Math.floor(Math.random() * 6);
      s.streak = d === 6 ? (s.streak || 0) + 1 : 0;
      if (s.streak >= 3) { s.streak = 0; s.dice = 0; s.rolled = false; s.turn = (s.turn + 1) % room.players.length; }
      else {
        s.dice = d; s.rolled = true;
        const can = room.players[seat].tokens.some(p => p < 0 ? d === 6 : (p < 58 && p + d <= 58));
        if (!can) { s.rolled = false; if (d !== 6) s.turn = (s.turn + 1) % room.players.length; else s.dice = 0; }
      }
    } else if (data.type === 'move') {
      const s = room.state;
      if (!s || s.finished || s.turn !== seat || !s.rolled) return reply('Not your move');
      const i = Number(data.token);
      if (!Number.isInteger(i) || i < 0 || i > 3) return reply('Bad token');
      const p = room.players[seat].tokens[i], d = s.dice;
      if (p < 0 && d !== 6) return reply('Need a 6 to bring a token out');
      if (p >= 0 && (p === 58 || p + d > 58)) return reply('Cannot move');
      const next = p < 0 ? 0 : p + d;
      room.players[seat].tokens[i] = next;
      let captured = false;
      if (next <= 51) {
        const idx = (seat * 13 + next) % 52;
        const safeSquares = [0, 8, 13, 21, 26, 34, 39, 47];
        if (!safeSquares.includes(idx)) {
          for (let j = 0; j < room.players.length; j++) {
            if (j === seat) continue;
            const opponents = room.players[j].tokens
              .map((q, qi) => ({ q, qi }))
              .filter(x => x.q >= 0 && x.q <= 51 && (room.players[j].seat * 13 + x.q) % 52 === idx);
            // A pair of tokens forms a block and cannot be captured.
            if (opponents.length === 1) {
              room.players[j].tokens[opponents[0].qi] = -1;
              captured = true;
            }
          }
        }
      }
      if (room.players[seat].tokens.every(x => x === 58)) {
        s.finished = true; s.winner = seat; s.rolled = false; s.dice = 0; room.locked = false;
        // pay pot
        if (room.paid && room.pot > 0) {
          const w = room.players[seat].username;
          await this.env.USERS.get(this.env.USERS.idFromName(w)).fetch(new Request('https://user/economy', {
            method: 'POST', headers: internalHeaders(this.env),
            body: JSON.stringify({ funDelta: room.pot, win: true, game: true, autoConvert: true })
          }));
          for (const p of room.players) {
            if (p.username === w) continue;
            await this.env.USERS.get(this.env.USERS.idFromName(p.username)).fetch(new Request('https://user/economy', {
              method: 'POST', headers: internalHeaders(this.env),
              body: JSON.stringify({ funDelta: 0, win: false, game: true })
            }));
          }
          room.lastPot = room.pot; room.pot = 0; room.paid = false;
        }
      } else {
        s.rolled = false; s.dice = 0;
        if (!captured && next !== 58 && d !== 6) s.turn = (s.turn + 1) % room.players.length;
      }
    } else return reply('Unknown');

    await this.ctx.storage.put('room', room);
    this.broadcast(room, room.state?.finished ? `Winner: ${room.players[room.state.winner]?.name || ''} (+${room.lastPot || 0} fun)` : 'Update');
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (!att.username) return;
    let room = await this.ctx.storage.get('room');
    if (!room) return;
    const p = room.players.find(x => x.username === att.username);
    if (p && room.locked && room.state && !room.state.finished) {
      p.connected = false;
      room.disconnects = room.disconnects || {};
      room.disconnects[att.username] = Date.now();
      await this.ctx.storage.put('room', room);
      this.broadcast(room, att.username + ' disconnected');
      this.broadcastRaw({ type: 'peer-left', username: att.username, soft: true });
    }
  }
  async webSocketError() {}

  broadcast(room, message, exclude = null) {
    const packet = JSON.stringify({ type: 'state', room: pubRoom(room), message });
    for (const peer of this.ctx.getWebSockets()) {
      try {
        const a = peer.deserializeAttachment() || {};
        if (exclude && a.username === exclude) continue;
        peer.send(packet);
      } catch {}
    }
  }
  broadcastRaw(obj) {
    const packet = JSON.stringify(obj);
    for (const peer of this.ctx.getWebSockets()) try { peer.send(packet); } catch {}
  }
}

function pubRoom(room) {
  return {
    host: room.host, players: room.players, state: room.state, chat: (room.chat || []).slice(-30),
    stake: room.stake || 0, pot: room.pot || 0, locked: !!room.locked, lastPot: room.lastPot || 0,
    disconnects: room.disconnects || {}
  };
}

// ===================== Router =====================
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors();
    const url = new URL(request.url);

    const userMatch = url.pathname.match(/^\/api\/user\/([a-z0-9_]+)(?:\/([a-z0-9-]+))?$/i);
    if (userMatch) {
      const newUrl = new URL(request.url);
      newUrl.pathname = '/' + (userMatch[2] || (request.method === 'GET' ? 'me' : ''));
      return env.USERS.get(env.USERS.idFromName(userMatch[1].toLowerCase())).fetch(new Request(newUrl, request));
    }
    if (url.pathname.startsWith('/api/lobby/')) {
      const newUrl = new URL(request.url); newUrl.pathname = '/' + url.pathname.replace('/api/lobby/', '');
      return env.LOBBY.get(env.LOBBY.idFromName('main')).fetch(new Request(newUrl, request));
    }
    if (url.pathname.startsWith('/api/shop/')) {
      const newUrl = new URL(request.url); newUrl.pathname = '/' + url.pathname.replace('/api/shop/', '');
      return env.SHOP.get(env.SHOP.idFromName('main')).fetch(new Request(newUrl, request));
    }
    if (url.pathname === '/health') return json({ ok: true, app: 'nepali-ludo-v4' });
    const roomMatch = url.pathname.match(/^\/room\/([A-Z0-9]{6})$/i);
    if (roomMatch) return env.LUDO_ROOMS.get(env.LUDO_ROOMS.idFromName(roomMatch[1].toUpperCase())).fetch(request);
    return env.ASSETS.fetch(request);
  }
};