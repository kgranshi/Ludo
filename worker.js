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
    friends: u.friends || [],
    friendRequests: u.friendRequests || [],
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
        { id: 'default', label: 'Classic Durbar (परम्परागत)', priceCoins: 0, priceFun: 0, minLevel: 1 },
        { id: 'gold', label: 'Dhaka Gold (ढाका र सुन)', priceCoins: 20, priceFun: 0, minLevel: 2 },
        { id: 'nepal', label: 'Nepal Flag (नेपाल झण्डा)', priceCoins: 30, priceFun: 0, minLevel: 3 },
        { id: 'neon', label: 'Tihar Glow (तिहार झिलिमिली)', priceCoins: 50, priceFun: 0, minLevel: 5 },
        { id: 'himal', label: 'Himal Sagarmatha (हिमाल)', priceCoins: 25, priceFun: 0, minLevel: 2 },
        { id: 'pahad', label: 'Pahad Laligurans (पहाड)', priceCoins: 25, priceFun: 0, minLevel: 2 },
        { id: 'terai', label: 'Terai Lumbini (तराई)', priceCoins: 30, priceFun: 0, minLevel: 3 },
        { id: 'durbar', label: 'Malla Durbar (दरबार)', priceCoins: 45, priceFun: 0, minLevel: 4 }
      ],
      avatars: [
        { id: 'default', label: 'Default Avatar', priceCoins: 0, minLevel: 1, emoji: '🙂' },
        { id: 'hero', label: 'Himalayan Hero (हिमाली नायक)', priceCoins: 15, minLevel: 2, imageUrl: '/assets/avatar_himal_hero.jpg' },
        { id: 'king', label: 'Durbar Royal (दरबार राज)', priceCoins: 40, minLevel: 4, imageUrl: '/assets/avatar_durbar_royal.jpg' }
      ],
      mics: [
        { id: 'mic_default', label: 'Default Mic', priceCoins: 0, minLevel: 1, emoji: '🎤' },
        { id: 'mic_gold', label: 'Gold Mic', priceCoins: 25, minLevel: 2, emoji: '🎙️' },
        { id: 'mic_neon', label: 'Brass Mic', priceCoins: 40, minLevel: 4, emoji: '📯' }
      ],
      roomItems: [
        { id: 'diyo', label: 'Tihar Diyo (दियो)', priceCoins: 8, minLevel: 1, emoji: '🪔' },
        { id: 'lamp', label: 'Durbar Lamp', priceCoins: 10, minLevel: 1, emoji: '💡' },
        { id: 'dhaka', label: 'Dhaka Topi (ढाका टोपी)', priceCoins: 15, minLevel: 2, emoji: '🧢' },
        { id: 'sarangi', label: 'Sarangi (सारङ्गी)', priceCoins: 20, minLevel: 2, emoji: '🎻' },
        { id: 'trophy', label: 'Trophy Shelf', priceCoins: 25, minLevel: 3, emoji: '🏆' },
        { id: 'sofa', label: 'VIP Baithak', priceCoins: 35, minLevel: 4, emoji: '🛋️' }
      ],
      levelRewards: {
        '2': { skinId: 'gold', funTokens: 50 },
        '3': { avatarId: 'hero', roomItem: 'diyo' },
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

    // Marketplace listings (Admin sells items to players for Fun Tokens or Coins)
    if (path === 'market-list' && request.method === 'GET') {
      return json({ ok: true, listings: (await this.ctx.storage.get('market')) || [] });
    }
    if (path === 'market-add' && request.method === 'POST') {
      const admHeader = request.headers.get('X-Admin-Secret') || '';
      if (!secret || (body.secret !== secret && admHeader !== secret)) {
        return json({ ok: false, error: 'Only admin can sell items in the marketplace' }, 403);
      }
      const itemType = String(body.itemType || ''), itemId = String(body.itemId || '').trim();
      const label = String(body.label || `${itemType}:${itemId}`).trim().slice(0, 48);
      const emoji = String(body.emoji || '').trim().slice(0, 8);
      const priceFun = Number(body.priceFun) || 0, priceCoins = Number(body.priceCoins) || 0;
      if (!['skin','avatar','mic','room'].includes(itemType) || !/^[a-z0-9_-]{1,40}$/i.test(itemId) || priceFun < 0 || priceCoins < 0 || priceFun + priceCoins <= 0 || priceFun > 1000000 || priceCoins > 1000000) {
        return json({ ok: false, error: 'Invalid listing parameters' }, 400);
      }
      const listings = (await this.ctx.storage.get('market')) || [];
      const item = { id: rid(6), seller: 'admin', isAdminListing: true, itemType, itemId, label, emoji, priceFun, priceCoins, time: Date.now() };
      listings.push(item); while (listings.length > 100) listings.shift();
      await this.ctx.storage.put('market', listings);
      return json({ ok: true, item });
    }
    if (path === 'market-remove' && request.method === 'POST') {
      const admHeader = request.headers.get('X-Admin-Secret') || '';
      if (!secret || (body.secret !== secret && admHeader !== secret)) return json({ ok: false, error: 'unauthorized' }, 403);
      const listings = (await this.ctx.storage.get('market')) || [];
      const next = listings.filter(x => x.id !== body.listingId);
      await this.ctx.storage.put('market', next);
      return json({ ok: true, listings: next });
    }
    if (path === 'market-buy' && request.method === 'POST') {
      const listings = (await this.ctx.storage.get('market')) || [];
      const listing = listings.find(x => x.id === body.listingId);
      if (!listing) return json({ ok: false, error: 'listing not found' }, 404);
      const buyer = String(body.buyer || '').trim().toLowerCase();
      if (!buyer) return json({ ok: false, error: 'buyer required' }, 400);
      if (listing.seller === buyer) return json({ ok: false, error: 'cannot buy own' }, 400);
      const pay = await this.env.USERS.get(this.env.USERS.idFromName(buyer)).fetch(new Request('https://user/market-pay', {
        method: 'POST', headers: internalHeaders(this.env),
        body: JSON.stringify({ token: body.token, priceFun: listing.priceFun, priceCoins: listing.priceCoins, itemType: listing.itemType, itemId: listing.itemId, seller: listing.seller })
      }));
      const pj = await pay.json();
      if (!pj.ok) return json(pj, 400);
      if (!listing.isAdminListing && listing.seller !== 'admin') {
        const next = listings.filter(x => x.id !== listing.id);
        await this.ctx.storage.put('market', next);
      }
      return json({ ok: true, user: pj.user });
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
        ownedSkins: ['default'], ownedAvatars: ['default'], ownedMics: ['mic_default'],
        equippedSkin: 'default', equippedAvatar: 'default', equippedMic: 'mic_default',
        roomDecor: [], roomDecorEquipped: [], friends: [], friendRequests: [],
        referralCode: rid(4).toUpperCase(), referredBy: ref || null, referralRewarded: false,
        dailyLoginDate: '', active: false
      };
      await this.put(user);
      try {
        await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch(new Request('https://lobby/register-refcode', {
          method: 'POST', headers: internalHeaders(this.env),
          body: JSON.stringify({ code: user.referralCode, username })
        }));
        await this.pushDirectory(user);
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
      await this.pushDirectory(user);
      return json({ ok: true, token: user.token, user: publicUser(user) });
    }

    const user = await this.get();
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || body.token || url.searchParams.get('token') || '';
    const authed = user && token && user.token === token;
    const internalOnly = new Set([
      'receive-voice-gift','economy','market-pay','market-credit','receive-item-gift','add-referral-reward','admin-fulfill',
      'receive-friend-request','confirm-friend','unfriend-internal'
    ]);
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
      await this.pushDirectory(user);
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
      const today = new Date().toISOString().slice(0, 10);
      if (user.dailyFunDate !== today) { user.dailyFunTokens = 0; user.dailyFunDate = today; }
      const totalFun = (user.dailyFunTokens || 0) + (user.funTokens || 0);
      if (totalFun < pf || (user.coins || 0) < pc) return json({ ok: false, error: 'insufficient balance' }, 400);
      const owned = body.itemType === 'skin' ? (user.ownedSkins || []) : body.itemType === 'avatar' ? (user.ownedAvatars || []) : body.itemType === 'mic' ? (user.ownedMics || []) : (user.roomDecor || []);
      if (owned.includes(body.itemId)) return json({ ok: false, error: 'You already own this item' }, 400);
      if (pf > 0) {
        const fromDaily = Math.min(user.dailyFunTokens || 0, pf);
        user.dailyFunTokens = (user.dailyFunTokens || 0) - fromDaily;
        const rem = pf - fromDaily;
        if (rem > 0) user.funTokens = (user.funTokens || 0) - rem;
      }
      user.coins = (user.coins || 0) - pc;
      if (body.itemType === 'skin') user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), body.itemId]));
      if (body.itemType === 'avatar') user.ownedAvatars = Array.from(new Set([...(user.ownedAvatars || []), body.itemId]));
      if (body.itemType === 'mic') user.ownedMics = Array.from(new Set([...(user.ownedMics || []), body.itemId]));
      if (body.itemType === 'room') user.roomDecor = Array.from(new Set([...(user.roomDecor || []), body.itemId]));
      await this.put(user);
      if (body.seller && body.seller !== 'admin') {
        await this.env.USERS.get(this.env.USERS.idFromName(body.seller)).fetch(new Request('https://user/market-credit', {
          method: 'POST', headers: internalHeaders(this.env),
          body: JSON.stringify({ fun: pf, coins: pc, itemType: body.itemType, itemId: body.itemId })
        })).catch(() => null);
      }
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

    // ---- Friends endpoints ----
    if (path === 'friends') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const friendsList = user.friends || [];
      let onlineMap = {}, dirMap = {};
      try {
        const [or, dr] = await Promise.all([
          this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch('https://lobby/online'),
          this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch('https://lobby/directory', { headers: internalHeaders(this.env) })
        ]);
        const oj = await or.json().catch(() => ({}));
        const dj = await dr.json().catch(() => ({}));
        (oj.users || []).forEach(u => { onlineMap[u.username] = u; });
        dirMap = dj.directory || {};
      } catch {}
      const enriched = friendsList.map(fname => {
        const on = onlineMap[fname];
        const dr = dirMap[fname];
        return {
          username: fname,
          displayName: on?.displayName || dr?.displayName || fname,
          avatarPhoto: on?.avatarPhoto || dr?.avatarPhoto || '',
          level: on?.level || dr?.level || 1,
          wins: on?.wins || dr?.wins || 0,
          voiceActive: !!on?.voiceActive,
          status: on ? (on.status === 'busy' ? 'busy' : 'online') : 'offline',
          lastSeen: on?.lastSeen || dr?.lastSeen || 0
        };
      });
      enriched.sort((a, b) => {
        const rank = s => s === 'online' ? 0 : s === 'busy' ? 1 : 2;
        return rank(a.status) - rank(b.status) || (b.level - a.level);
      });
      return json({ ok: true, friends: enriched, requests: user.friendRequests || [] });
    }

    if (path === 'friend-request' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const to = String(body.to || '').trim().toLowerCase();
      if (!to || to === user.username) return json({ ok: false, error: 'Invalid username' }, 400);
      if ((user.friends || []).includes(to)) return json({ ok: true, alreadyFriends: true, user: publicUser(user) });
      // If target already requested us, auto-accept
      if ((user.friendRequests || []).some(r => r.from === to)) {
        user.friendRequests = (user.friendRequests || []).filter(r => r.from !== to);
        user.friends = Array.from(new Set([...(user.friends || []), to]));
        await this.put(user);
        await this.env.USERS.get(this.env.USERS.idFromName(to)).fetch(new Request('https://user/confirm-friend', {
          method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ friend: user.username })
        })).catch(() => null);
        return json({ ok: true, accepted: true, user: publicUser(user) });
      }
      const res = await this.env.USERS.get(this.env.USERS.idFromName(to)).fetch(new Request('https://user/receive-friend-request', {
        method: 'POST', headers: internalHeaders(this.env),
        body: JSON.stringify({ from: user.username, fromName: user.displayName || user.username, avatarPhoto: user.avatarPhoto || '' })
      }));
      const rj = await res.json().catch(() => ({ ok: false, error: 'User not found' }));
      if (!res.ok || !rj.ok) return json(rj, res.status || 404);
      return json({ ok: true, sent: true });
    }

    if (path === 'receive-friend-request' && request.method === 'POST') {
      if (!user) return json({ ok: false, error: 'User not found' }, 404);
      const from = String(body.from || '').trim().toLowerCase();
      if (!from || from === user.username) return json({ ok: false, error: 'Invalid sender' }, 400);
      if ((user.friends || []).includes(from)) return json({ ok: true, alreadyFriends: true });
      const reqs = user.friendRequests || [];
      if (!reqs.some(r => r.from === from)) {
        reqs.push({ from, fromName: String(body.fromName || from).slice(0, 18), avatarPhoto: String(body.avatarPhoto || ''), time: Date.now() });
        while (reqs.length > 50) reqs.shift();
        user.friendRequests = reqs;
        await this.put(user);
      }
      return json({ ok: true });
    }

    if (path === 'accept-friend' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const from = String(body.from || '').trim().toLowerCase();
      if (!from) return json({ ok: false, error: 'Missing username' }, 400);
      user.friendRequests = (user.friendRequests || []).filter(r => r.from !== from);
      user.friends = Array.from(new Set([...(user.friends || []), from]));
      await this.put(user);
      await this.env.USERS.get(this.env.USERS.idFromName(from)).fetch(new Request('https://user/confirm-friend', {
        method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ friend: user.username })
      })).catch(() => null);
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'decline-friend' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const from = String(body.from || '').trim().toLowerCase();
      user.friendRequests = (user.friendRequests || []).filter(r => r.from !== from);
      await this.put(user);
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'remove-friend' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const friend = String(body.friend || '').trim().toLowerCase();
      user.friends = (user.friends || []).filter(f => f !== friend);
      await this.put(user);
      await this.env.USERS.get(this.env.USERS.idFromName(friend)).fetch(new Request('https://user/unfriend-internal', {
        method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ friend: user.username })
      })).catch(() => null);
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'confirm-friend' && request.method === 'POST') {
      if (!user) return json({ ok: false, error: 'not found' }, 404);
      const friend = String(body.friend || '').trim().toLowerCase();
      if (friend && friend !== user.username) {
        user.friends = Array.from(new Set([...(user.friends || []), friend]));
        user.friendRequests = (user.friendRequests || []).filter(r => r.from !== friend);
        await this.put(user);
      }
      return json({ ok: true });
    }

    if (path === 'unfriend-internal' && request.method === 'POST') {
      if (!user) return json({ ok: false, error: 'not found' }, 404);
      const friend = String(body.friend || '').trim().toLowerCase();
      user.friends = (user.friends || []).filter(f => f !== friend);
      await this.put(user);
      return json({ ok: true });
    }

    if (path === 'admin-ban' && request.method === 'POST') {
      if (!secret || (body.secret !== secret && request.headers.get('X-Admin-Secret') !== secret)) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!user) return json({ ok: false }, 404);
      user.banned = !!body.banned; await this.put(user); await this.pushDirectory(user); return json({ ok: true, user: publicUser(user) });
    }
    if (path === 'admin-grant-voice' && request.method === 'POST') {
      if (!secret || (body.secret !== secret && request.headers.get('X-Admin-Secret') !== secret)) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!user) return json({ ok: false }, 404);
      const ms = Math.floor(Number(body.ms) || (Number(body.days) || 0) * DAY);
      const now = Date.now(); user.voiceUntil = Math.max(user.voiceUntil || 0, now) + ms;
      await this.put(user); await this.pushDirectory(user); return json({ ok: true, user: publicUser(user) });
    }
    if (path === 'admin-grant-skin' && request.method === 'POST') {
      if (!secret || (body.secret !== secret && request.headers.get('X-Admin-Secret') !== secret)) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!user) return json({ ok: false }, 404);
      user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), body.skinId]));
      await this.put(user); return json({ ok: true, user: publicUser(user) });
    }
    if (path === 'admin-adjust' && request.method === 'POST') {
      if (!secret || (body.secret !== secret && request.headers.get('X-Admin-Secret') !== secret)) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!user) return json({ ok: false, error: 'User not found' }, 404);
      if (Number.isFinite(Number(body.addFun))) user.funTokens = Math.max(0, (user.funTokens || 0) + Number(body.addFun));
      if (Number.isFinite(Number(body.addCoins))) user.coins = Math.max(0, (user.coins || 0) + Number(body.addCoins));
      if (Number.isFinite(Number(body.setLevel)) && Number(body.setLevel) >= 1) user.level = Math.floor(Number(body.setLevel));
      if (Number.isFinite(Number(body.voiceDays)) && Number(body.voiceDays) > 0) {
        user.voiceUntil = Math.max(user.voiceUntil || 0, Date.now()) + Math.floor(Number(body.voiceDays) * DAY);
      }
      if (body.grantType && body.grantId) {
        if (body.grantType === 'skin') user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), body.grantId]));
        if (body.grantType === 'avatar') user.ownedAvatars = Array.from(new Set([...(user.ownedAvatars || []), body.grantId]));
        if (body.grantType === 'mic') user.ownedMics = Array.from(new Set([...(user.ownedMics || []), body.grantId]));
        if (body.grantType === 'room') user.roomDecor = Array.from(new Set([...(user.roomDecor || []), body.grantId]));
      }
      await this.put(user); await this.pushDirectory(user); await this.pushPresence(user);
      return json({ ok: true, user: publicUser(user) });
    }
    if (path === 'admin-user' && request.method === 'GET') {
      if (!secret || request.headers.get('X-Admin-Secret') !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!user) return json({ ok: false, error: 'User not found' }, 404);
      return json({ ok: true, user: publicUser(user) });
    }
    if (path === 'admin-fulfill' && request.method === 'POST') {
      if (!secret || (body.secret !== secret && request.headers.get('X-Admin-Secret') !== secret)) return json({ ok: false, error: 'unauthorized' }, 403);
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

  async pushDirectory(user) {
    try {
      await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch(new Request('https://lobby/directory-upsert', {
        method: 'POST', headers: internalHeaders(this.env),
        body: JSON.stringify({
          username: user.username, displayName: user.displayName, avatarPhoto: user.avatarPhoto || '',
          level: user.level || 1, wins: user.wins || 0, equippedAvatar: user.equippedAvatar || 'default',
          banned: !!user.banned, lastSeen: user.lastSeen || Date.now(),
          voiceActive: !user.banned && (user.voiceUntil || 0) > Date.now()
        })
      }));
    } catch {}
  }

  async pushPresence(user) {
    try {
      await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch(new Request('https://lobby/presence', {
        method: 'POST', headers: internalHeaders(this.env),
        body: JSON.stringify({
          username: user.username, displayName: user.displayName, status: user.status, lastSeen: user.lastSeen,
          voiceActive: !user.banned && (user.voiceUntil || 0) > Date.now(),
          level: user.level || 1, wins: user.wins || 0, equippedAvatar: user.equippedAvatar, avatarPhoto: user.avatarPhoto || '', rankScore: (user.level || 1) * 1000 + (user.wins || 0)
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
    const internalOnly = new Set(['presence','register-refcode','referral-pending','referral-complete','admin-msg','directory-upsert','directory']);
    if (internalOnly.has(path) && !isInternal(request, this.env)) return json({ ok: false, error: 'internal only' }, 403);
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const lobbyAuth = async (username) => {
      if (!username || !bearer) return false;
      try { const r = await this.env.USERS.get(this.env.USERS.idFromName(String(username).toLowerCase())).fetch(new Request('https://user/me', { headers: { Authorization: 'Bearer ' + bearer } })); return r.ok; } catch { return false; }
    };

    if (path === 'directory-upsert' && request.method === 'POST') {
      if (!body.username) return json({ ok: false }, 400);
      const dir = (await this.ctx.storage.get('directory')) || {};
      dir[body.username] = {
        username: body.username, displayName: body.displayName || body.username,
        avatarPhoto: body.avatarPhoto || '', level: body.level || 1, wins: body.wins || 0,
        equippedAvatar: body.equippedAvatar || 'default', banned: !!body.banned,
        voiceActive: !!body.voiceActive, lastSeen: body.lastSeen || Date.now()
      };
      await this.ctx.storage.put('directory', dir);
      return json({ ok: true });
    }

    if (path === 'directory') {
      return json({ ok: true, directory: (await this.ctx.storage.get('directory')) || {} });
    }

    if (path === 'search-users') {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const dir = (await this.ctx.storage.get('directory')) || {};
      const online = (await this.ctx.storage.get('online')) || {};
      const now = Date.now();
      const out = Object.values(dir)
        .filter(u => !q || u.username.includes(q) || String(u.displayName || '').toLowerCase().includes(q))
        .slice(0, 25)
        .map(u => {
          const on = online[u.username] && now - (online[u.username].lastSeen || 0) <= 5 * 60 * 1000 ? online[u.username] : null;
          return {
            username: u.username, displayName: on?.displayName || u.displayName,
            avatarPhoto: on?.avatarPhoto || u.avatarPhoto || '',
            level: on?.level || u.level || 1, wins: on?.wins || u.wins || 0,
            status: on ? (on.status === 'busy' ? 'busy' : 'online') : 'offline'
          };
        });
      return json({ ok: true, users: out });
    }

    if (path === 'presence' && request.method === 'POST') {
      const list = (await this.ctx.storage.get('online')) || {};
      if (!body.username) return json({ ok: false }, 400);
      list[body.username] = {
        username: body.username, displayName: body.displayName, status: body.status || 'online',
        lastSeen: body.lastSeen || Date.now(), voiceActive: !!body.voiceActive,
        level: body.level || 1, wins: body.wins || 0, equippedAvatar: body.equippedAvatar || 'default', avatarPhoto: body.avatarPhoto || '', rankScore: body.rankScore || 0
      };
      const now = Date.now();
      for (const k of Object.keys(list)) if (now - (list[k].lastSeen || 0) > 5 * 60 * 1000) delete list[k];
      await this.ctx.storage.put('online', list);
      const lb = (await this.ctx.storage.get('leaderboard')) || {};
      lb[body.username] = {
        username: body.username, displayName: body.displayName, level: body.level || 1,
        wins: body.wins || 0, equippedAvatar: body.equippedAvatar || 'default',
        avatarPhoto: body.avatarPhoto || '', rankScore: body.rankScore || 0, updatedAt: now
      };
      await this.ctx.storage.put('leaderboard', lb);
      return json({ ok: true });
    }

    if (path === 'online') {
      const list = (await this.ctx.storage.get('online')) || {};
      const now = Date.now();
      const out = Object.values(list).filter(u => now - (u.lastSeen || 0) <= 5 * 60 * 1000);
      out.sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0));
      return json({ ok: true, users: out });
    }

    if (path === 'leaderboard') {
      const lb = (await this.ctx.storage.get('leaderboard')) || {};
      const out = Object.values(lb).sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0)).slice(0, 30);
      return json({ ok: true, players: out });
    }

    if (path === 'quick-match' && request.method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      if (!(await lobbyAuth(username))) return json({ ok: false, error: 'auth' }, 401);
      const stake = Number.isSafeInteger(Number(body.stake)) ? Number(body.stake) : 0;
      const mode = body.mode === 'quick' ? 'quick' : 'classic';
      const maxPlayers = Number(body.maxPlayers) === 4 ? 4 : 2;
      const qKey = `${mode}:${stake}:${maxPlayers}`;
      const queues = (await this.ctx.storage.get('quick_queues')) || {};
      const now = Date.now();
      let entry = queues[qKey];
      if (entry && now - entry.createdAt < 90_000 && entry.players.length < maxPlayers && !entry.players.includes(username)) {
        entry.players.push(username);
        await this.ctx.storage.put('quick_queues', queues);
        return json({ ok: true, roomCode: entry.roomCode, create: false, stake, mode, playersCount: entry.players.length });
      }
      if (entry && entry.players.includes(username) && now - entry.createdAt < 90_000) {
        return json({ ok: true, roomCode: entry.roomCode, create: entry.players[0] === username, stake, mode, playersCount: entry.players.length });
      }
      const roomCode = rid(3).toUpperCase().replace(/[^A-Z0-9]/g, 'A').slice(0, 6);
      queues[qKey] = { roomCode, players: [username], createdAt: now };
      await this.ctx.storage.put('quick_queues', queues);
      return json({ ok: true, roomCode, create: true, stake, mode, playersCount: 1 });
    }

    // Play request → preserves sender profile + shared roomCode, or creates room on accept
    if (path === 'play-request' && request.method === 'POST') {
      const from = String(body.from || '').trim().toLowerCase();
      const to = String(body.to || '').trim().toLowerCase();
      if (!(await lobbyAuth(from))) return json({ ok: false, error: 'auth' }, 401);
      if (!from || !to || from === to) return json({ ok: false, error: 'Invalid player' }, 400);
      const dir = (await this.ctx.storage.get('directory')) || {};
      const online = (await this.ctx.storage.get('online')) || {};
      const senderInfo = online[from] || dir[from] || {};
      const key = `req:${to}`;
      let reqs = (await this.ctx.storage.get(key)) || [];
      const now = Date.now();
      reqs = reqs.filter(r => now - r.time < 3 * 60 * 1000 && r.from !== from);
      const id = rid(6);
      const cleanRoom = /^[A-Z0-9]{6}$/.test(String(body.roomCode || '').toUpperCase()) ? String(body.roomCode).toUpperCase() : '';
      reqs.push({
        id, from,
        fromName: String(body.fromName || senderInfo.displayName || from).slice(0, 18),
        avatarPhoto: String(body.avatarPhoto || senderInfo.avatarPhoto || ''),
        level: Number(body.level || senderInfo.level || 1),
        wins: Number(body.wins || senderInfo.wins || 0),
        stake: Number(body.stake) || 0,
        mode: body.mode === 'quick' ? 'quick' : 'classic',
        roomCode: cleanRoom,
        time: now
      });
      while (reqs.length > 20) reqs.shift();
      await this.ctx.storage.put(key, reqs);
      return json({ ok: true, id, roomCode: cleanRoom });
    }

    if (path === 'play-requests') {
      const username = String(url.searchParams.get('u') || '').trim().toLowerCase();
      if (!(await lobbyAuth(username))) return json({ ok: false, error: 'auth' }, 401);
      let reqs = (await this.ctx.storage.get(`req:${username}`)) || [];
      const now = Date.now();
      reqs = reqs.filter(r => now - r.time < 3 * 60 * 1000);
      await this.ctx.storage.put(`req:${username}`, reqs);
      return json({ ok: true, requests: reqs.slice().reverse() });
    }

    if (path === 'accept-request' && request.method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      const id = body.id;
      if (!(await lobbyAuth(username))) return json({ ok: false, error: 'auth' }, 401);
      let reqs = (await this.ctx.storage.get(`req:${username}`)) || [];
      const r = reqs.find(x => x.id === id);
      if (!r) return json({ ok: false, error: 'request gone' }, 404);
      reqs = reqs.filter(x => x.id !== id);
      await this.ctx.storage.put(`req:${username}`, reqs);
      if (r.roomCode) {
        return json({ ok: true, roomCode: r.roomCode, stake: r.stake || 0, mode: r.mode || 'classic', hasHostRoom: true, guest: r.from });
      }
      const code = rid(3).toUpperCase().slice(0, 6);
      const roomCode = (code + rid(2)).toUpperCase().replace(/[^A-Z0-9]/g, 'A').slice(0, 6);
      const invites = (await this.ctx.storage.get('invites')) || {};
      const inv = { id: rid(4), roomCode, host: username, guest: r.from, stake: r.stake || 0, mode: r.mode || 'classic', time: Date.now() };
      invites[r.from] = inv;
      await this.ctx.storage.put('invites', invites);
      return json({ ok: true, roomCode, stake: r.stake || 0, mode: r.mode || 'classic', hasHostRoom: false, guest: r.from });
    }

    if (path === 'my-invite') {
      const u = String(url.searchParams.get('u') || '').trim().toLowerCase();
      if (!(await lobbyAuth(u))) return json({ ok: false, error: 'auth' }, 401);
      const invites = (await this.ctx.storage.get('invites')) || {};
      const inv = invites[u];
      if (inv && Date.now() - inv.time < 5 * 60 * 1000) {
        delete invites[u];
        await this.ctx.storage.put('invites', invites);
        return json({ ok: true, invite: inv });
      }
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
      // Automatically connect referrer and newly created user as friends
      const map = (await this.ctx.storage.get('refmap')) || {};
      const owner = map[body.code];
      if (owner && body.newUser && owner !== body.newUser) {
        await Promise.all([
          this.env.USERS.get(this.env.USERS.idFromName(owner)).fetch(new Request('https://user/confirm-friend', {
            method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ friend: body.newUser })
          })).catch(() => null),
          this.env.USERS.get(this.env.USERS.idFromName(body.newUser)).fetch(new Request('https://user/confirm-friend', {
            method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ friend: owner })
          })).catch(() => null)
        ]);
      }
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
      // reward referrer & new user + ensure mutual friendship
      await Promise.all([
        this.env.USERS.get(this.env.USERS.idFromName(owner)).fetch(new Request('https://user/add-referral-reward', {
          method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ ms: rewardMs, fun: rewardFun })
        })),
        this.env.USERS.get(this.env.USERS.idFromName(body.newUser)).fetch(new Request('https://user/add-referral-reward', {
          method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ ms: rewardMs, fun: rewardFun })
        })),
        this.env.USERS.get(this.env.USERS.idFromName(owner)).fetch(new Request('https://user/confirm-friend', {
          method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ friend: body.newUser })
        })).catch(() => null),
        this.env.USERS.get(this.env.USERS.idFromName(body.newUser)).fetch(new Request('https://user/confirm-friend', {
          method: 'POST', headers: internalHeaders(this.env), body: JSON.stringify({ friend: owner })
        })).catch(() => null)
      ]);
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
    if (path === 'admin-overview') {
      if (!secret || request.headers.get('X-Admin-Secret') !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      const dir = (await this.ctx.storage.get('directory')) || {};
      const online = (await this.ctx.storage.get('online')) || {};
      const now = Date.now();
      const users = Object.values(dir).map(u => {
        const on = online[u.username] && now - (online[u.username].lastSeen || 0) <= 5 * 60 * 1000 ? online[u.username] : null;
        return {
          ...u,
          displayName: on?.displayName || u.displayName,
          level: on?.level || u.level || 1,
          wins: on?.wins || u.wins || 0,
          status: on ? (on.status === 'busy' ? 'busy' : 'online') : 'offline'
        };
      });
      users.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      return json({
        ok: true,
        users,
        onlineCount: users.filter(u => u.status !== 'offline').length,
        totalUsers: users.length
      });
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
    const mode = url.searchParams.get('mode') === 'quick' ? 'quick' : 'classic';
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
      room = { host: username, players: [], state: null, chat: [], stake, mode, pot: 0, paid: false, locked: false, disconnects: {} };
    }

    // locked after start
    let player = room.players.find(p => p.username === username);
    if (!player) {
      if (room.locked || room.state) return new Response('Room locked (game in progress)', { status: 409 });
      if (room.players.length >= 4) return new Response('Room full', { status: 409 });
      if (room.stake > 0 && (userJson.user.funTokens || 0) < room.stake) return new Response('Not enough fun tokens', { status: 402 });
      // Seat order [0, 2, 1, 3] ensures 2-player matches sit diagonally opposite (Red vs Yellow)
      const seat = [0, 2, 1, 3].find(i => !room.players.some(p => p.seat === i));
      player = { username, name, seat, tokens: [-1, -1, -1, -1], voiceActive, avatar, avatarPhoto, skin, equippedMic, roomDecorEquipped, connected: true, isBot: false };
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

    if (data.type === 'emote') {
      const text = String(data.text || '').trim().slice(0, 60);
      const emoji = String(data.emoji || '').trim().slice(0, 8);
      if (!text && !emoji) return;
      this.broadcastRaw({ type: 'emote', username, seat: room.players[seat].seat, text, emoji });
      return;
    }

    if (data.type === 'mic-state') {
      const packet = JSON.stringify({ type: 'mic-state', username, on: !!data.on });
      for (const peer of this.ctx.getWebSockets()) try { peer.send(packet); } catch {}
      return;
    }

    if (data.type === 'add-bot') {
      if (room.host !== username) return reply('Only host');
      if (room.locked || room.state) return reply('Game already started');
      if (room.players.length >= 4) return reply('Room full');
      if (room.stake > 0) return reply('Bots only allowed in 0-stake rooms');
      const botNames = ['सगरमाथा (Bot)', 'मकालु (Bot)', 'फेवा (Bot)', 'रारा (Bot)'];
      const seatNum = [0, 2, 1, 3].find(i => !room.players.some(p => p.seat === i));
      const botName = botNames[seatNum] || `Bot ${seatNum + 1}`;
      room.players.push({
        username: `bot_${seatNum}`, name: botName, seat: seatNum,
        tokens: [-1, -1, -1, -1], voiceActive: false, avatar: 'hero',
        avatarPhoto: '/assets/avatar_himal_hero.jpg', skin: 'nepal',
        equippedMic: 'mic_default', roomDecorEquipped: ['diyo'], connected: true, isBot: true
      });
      await this.ctx.storage.put('room', room);
      this.broadcast(room, `${botName} joined`);
      return;
    }

    if (data.type === 'remove-bot') {
      if (room.host !== username) return reply('Only host');
      if (room.locked || room.state) return reply('Game already started');
      const targetSeat = Number(data.seat);
      room.players = room.players.filter(p => !(p.isBot && p.seat === targetSeat));
      await this.ctx.storage.put('room', room);
      this.broadcast(room, 'Bot removed');
      return;
    }

    if (data.type === 'leave') {
      const wasActive = !!(room.state && !room.state.finished && room.locked);
      const leavingName = room.players[seat]?.name || username;
      const leavingIdx = seat;
      room.players = room.players.filter(p => p.username !== username);
      if (room.disconnects?.[username]) delete room.disconnects[username];
      if (room.votes?.[username]) delete room.votes[username];
      if (room.host === username) {
        const nextHost = room.players.find(p => !p.isBot);
        room.host = nextHost?.username || null;
      }
      att.explicitLeave = true;
      ws.serializeAttachment(att);

      const humansLeft = room.players.filter(p => !p.isBot);
      if (humansLeft.length === 0) {
        room.players = []; room.state = null; room.locked = false; room.paid = false; room.pot = 0;
        await this.ctx.storage.put('room', room);
        this.broadcastRaw({ type: 'peer-left', username });
        return;
      }

      let msgText = `${leavingName} बाहिरिनुभयो`;
      if (wasActive) {
        if (room.players.length === 1) {
          const lastPl = room.players[0];
          room.state.finished = true; room.state.winner = 0; room.state.rolled = false; room.state.dice = 0;
          room.locked = false;
          const winBonus = room.paid && room.pot > 0 ? room.pot : 10;
          if (!lastPl.isBot) {
            await this.env.USERS.get(this.env.USERS.idFromName(lastPl.username)).fetch(new Request('https://user/economy', {
              method: 'POST', headers: internalHeaders(this.env),
              body: JSON.stringify({ funDelta: winBonus, win: true, game: true, autoConvert: true })
            })).catch(() => null);
          }
          room.lastPot = room.paid && room.pot > 0 ? room.pot : winBonus;
          room.pot = 0; room.paid = false;
          msgText = `Winner: ${lastPl.name} (opponent left)`;
        } else {
          if (leavingIdx < room.state.turn) {
            room.state.turn = Math.max(0, room.state.turn - 1);
          } else if (leavingIdx === room.state.turn) {
            room.state.turn = room.state.turn % room.players.length;
            room.state.rolled = false; room.state.dice = 0; room.state.streak = 0;
          } else if (room.state.turn >= room.players.length) {
            room.state.turn = 0;
          }
          msgText = `${leavingName} खेलबाट बाहिरिनुभयो — बाँकी खेल जारी छ`;
        }
      }

      await this.ctx.storage.put('room', room);
      this.broadcast(room, msgText);
      this.broadcastRaw({ type: 'peer-left', username });
      if (wasActive && room.state && !room.state.finished) {
        this.scheduleBotIfNeeded(room);
      }
      return;
    }

    if (data.type === 'vote-continue') {
      room.votes = room.votes || {};
      room.votes[username] = true;
      const connected = room.players.filter(p => p.connected !== false && !p.isBot);
      const need = Math.ceil(connected.length * 0.5);
      const yes = Object.keys(room.votes).filter(u => room.votes[u] && connected.some(p => p.username === u)).length;
      if (yes >= need) {
        const now = Date.now();
        room.players = room.players.filter(p => {
          if (p.connected === false && room.disconnects?.[p.username] && now - room.disconnects[p.username] >= RECONNECT_MS) return false;
          return true;
        });
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

    let lastEvent = null;

    if (data.type === 'start' || data.type === 'rematch') {
      if (room.host !== username) return reply('Only host');
      if (room.players.length < 2) return reply('Need 2+ players');
      if (data.mode === 'classic' || data.mode === 'quick') room.mode = data.mode;
      if (room.stake > 0 && !room.paid) {
        const charged = [];
        for (const p of room.players) {
          if (p.isBot) continue;
          const res = await this.env.USERS.get(this.env.USERS.idFromName(p.username)).fetch(new Request('https://user/economy', {
            method: 'POST', headers: internalHeaders(this.env),
            body: JSON.stringify({ funDelta: -room.stake, game: false })
          }));
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok) {
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
        room.pot = room.stake * charged.length;
        room.paid = true;
      } else if (!room.paid) { room.pot = 0; room.paid = true; }

      room.players.sort((a, b) => a.seat - b.seat);
      room.players.forEach(p => { p.tokens = [-1, -1, -1, -1]; p.connected = true; });
      room.state = { turn: 0, dice: 0, rolled: false, streak: 0, finished: false, winner: null };
      room.locked = true;
      room.disconnects = {};
      room.votes = {};
      lastEvent = { kind: 'start' };
    } else if (data.type === 'roll') {
      const s = room.state;
      if (!s || s.finished || s.turn !== seat || s.rolled) return reply('Not your roll');
      if (room.players[seat].connected === false) return reply('Disconnected');
      lastEvent = this.applyRoll(room, seat);
    } else if (data.type === 'move') {
      const s = room.state;
      if (!s || s.finished || s.turn !== seat || !s.rolled) return reply('Not your move');
      const i = Number(data.token);
      if (!Number.isInteger(i) || i < 0 || i > 3) return reply('Bad token');
      const p = room.players[seat].tokens[i], d = s.dice;
      if (p < 0 && d !== 6) return reply('Need a 6 to bring a token out');
      if (p >= 0 && (p === 56 || p + d > 56)) return reply('Cannot move');
      lastEvent = await this.applyMove(room, seat, i);
    } else return reply('Unknown');

    await this.ctx.storage.put('room', room);
    const msgText = room.state?.finished
      ? `Winner: ${room.players[room.state.winner]?.name || ''}${room.lastPot ? ` (+${room.lastPot} fun)` : ''}`
      : (lastEvent?.kind === 'foul' ? 'Three 6s! Turn forfeited' : 'Update');
    this.broadcast(room, msgText, null, lastEvent);
    this.scheduleBotIfNeeded(room);
  }

  applyRoll(room, seatIdx) {
    const s = room.state;
    const pl = room.players[seatIdx];
    const d = 1 + Math.floor(Math.random() * 6);
    s.streak = d === 6 ? (s.streak || 0) + 1 : 0;
    if (s.streak >= 3) {
      s.streak = 0; s.dice = 0; s.rolled = false;
      s.turn = (s.turn + 1) % room.players.length;
      return { kind: 'foul', seat: pl.seat, dice: d };
    }
    s.dice = d; s.rolled = true;
    const can = pl.tokens.some(p => p < 0 ? d === 6 : (p < 56 && p + d <= 56));
    if (!can) {
      s.rolled = false;
      if (d !== 6) s.turn = (s.turn + 1) % room.players.length;
      else s.dice = 0;
      return { kind: 'pass', seat: pl.seat, dice: d };
    }
    return { kind: 'roll', seat: pl.seat, dice: d };
  }

  async applyMove(room, seatIdx, tokenIdx) {
    const s = room.state;
    const pl = room.players[seatIdx];
    const p = pl.tokens[tokenIdx], d = s.dice;
    const next = p < 0 ? 0 : p + d;
    pl.tokens[tokenIdx] = next;
    let captured = false;
    let capturedInfo = null;
    if (next <= 50) {
      const idx = (pl.seat * 13 + next) % 52;
      const safeSquares = [0, 8, 13, 21, 26, 34, 39, 47];
      if (!safeSquares.includes(idx)) {
        for (let j = 0; j < room.players.length; j++) {
          if (j === seatIdx) continue;
          const opp = room.players[j];
          const opponents = opp.tokens
            .map((q, qi) => ({ q, qi }))
            .filter(x => x.q >= 0 && x.q <= 50 && (opp.seat * 13 + x.q) % 52 === idx);
          if (opponents.length === 1) {
            opp.tokens[opponents[0].qi] = -1;
            captured = true;
            capturedInfo = { seat: opp.seat, token: opponents[0].qi };
          }
        }
      }
    }
    const winNeeded = room.mode === 'quick' ? 1 : 4;
    const homeCount = pl.tokens.filter(x => x === 56).length;
    if (homeCount >= winNeeded) {
      s.finished = true; s.winner = seatIdx; s.rolled = false; s.dice = 0; room.locked = false;
      const winBonus = room.paid && room.pot > 0 ? room.pot : 10;
      if (!pl.isBot) {
        await this.env.USERS.get(this.env.USERS.idFromName(pl.username)).fetch(new Request('https://user/economy', {
          method: 'POST', headers: internalHeaders(this.env),
          body: JSON.stringify({ funDelta: winBonus, win: true, game: true, autoConvert: true })
        })).catch(() => null);
      }
      for (const other of room.players) {
        if (other.username === pl.username || other.isBot) continue;
        await this.env.USERS.get(this.env.USERS.idFromName(other.username)).fetch(new Request('https://user/economy', {
          method: 'POST', headers: internalHeaders(this.env),
          body: JSON.stringify({ funDelta: 0, win: false, game: true })
        })).catch(() => null);
      }
      room.lastPot = room.paid && room.pot > 0 ? room.pot : winBonus;
      room.pot = 0; room.paid = false;
      return { kind: 'win', seat: pl.seat, token: tokenIdx, from: p, to: next, dice: d, captured: capturedInfo, home: next === 56 };
    }
    s.rolled = false; s.dice = 0;
    if (!captured && next !== 56 && d !== 6) s.turn = (s.turn + 1) % room.players.length;
    return { kind: 'move', seat: pl.seat, token: tokenIdx, from: p, to: next, dice: d, captured: capturedInfo, home: next === 56 };
  }

  pickBotMove(room, seatIdx) {
    const pl = room.players[seatIdx];
    const d = room.state.dice;
    const legal = pl.tokens.map((p, i) => (p < 0 ? (d === 6 ? i : -1) : (p < 56 && p + d <= 56 ? i : -1))).filter(i => i >= 0);
    if (!legal.length) return -1;
    const safeSquares = [0, 8, 13, 21, 26, 34, 39, 47];
    let best = legal[0], bestScore = -999;
    for (const ti of legal) {
      const p = pl.tokens[ti];
      const next = p < 0 ? 0 : p + d;
      let score = next;
      if (next === 56) score += 500;
      if (p < 0 && d === 6) score += 160;
      if (next <= 50) {
        const gIdx = (pl.seat * 13 + next) % 52;
        if (safeSquares.includes(gIdx)) score += 90;
        else {
          for (let j = 0; j < room.players.length; j++) {
            if (j === seatIdx) continue;
            const opp = room.players[j];
            const hits = opp.tokens.filter(q => q >= 0 && q <= 50 && (opp.seat * 13 + q) % 52 === gIdx);
            if (hits.length === 1) score += 320;
          }
        }
      }
      if (next > 50 && p <= 50) score += 120;
      if (score > bestScore) { bestScore = score; best = ti; }
    }
    return best;
  }

  scheduleBotIfNeeded(room) {
    const s = room?.state;
    if (!s || s.finished) return;
    const cur = room.players[s.turn];
    if (!cur || !cur.isBot) return;
    setTimeout(async () => {
      try {
        const latest = await this.ctx.storage.get('room');
        if (!latest?.state || latest.state.finished) return;
        const turnIdx = latest.state.turn;
        const bot = latest.players[turnIdx];
        if (!bot || !bot.isBot) return;
        if (!latest.state.rolled) {
          const ev = this.applyRoll(latest, turnIdx);
          await this.ctx.storage.put('room', latest);
          this.broadcast(latest, ev.kind === 'foul' ? 'Three 6s! Turn forfeited' : 'Update', null, ev);
          if (latest.state.rolled) this.scheduleBotIfNeeded(latest);
          else if (latest.players[latest.state.turn]?.isBot) this.scheduleBotIfNeeded(latest);
          return;
        }
        const ti = this.pickBotMove(latest, turnIdx);
        if (ti >= 0) {
          const ev = await this.applyMove(latest, turnIdx, ti);
          await this.ctx.storage.put('room', latest);
          this.broadcast(latest, latest.state.finished ? `Winner: ${bot.name}` : 'Update', null, ev);
          this.scheduleBotIfNeeded(latest);
        }
      } catch {}
    }, 650);
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (!att.username || att.explicitLeave) return;
    let room = await this.ctx.storage.get('room');
    if (!room) return;
    const p = room.players.find(x => x.username === att.username);
    if (!p) return;
    if (room.locked && room.state && !room.state.finished) {
      p.connected = false;
      room.disconnects = room.disconnects || {};
      room.disconnects[att.username] = Date.now();
      await this.ctx.storage.put('room', room);
      this.broadcast(room, att.username + ' disconnected');
      this.broadcastRaw({ type: 'peer-left', username: att.username, soft: true });
    } else if (!room.locked) {
      room.players = room.players.filter(x => x.username !== att.username);
      if (room.host === att.username) {
        const nextHost = room.players.find(x => !x.isBot);
        room.host = nextHost?.username || null;
      }
      if (!room.players.some(x => !x.isBot)) { room.players = []; room.state = null; room.locked = false; room.paid = false; room.pot = 0; }
      await this.ctx.storage.put('room', room);
      this.broadcast(room, 'Player left');
      this.broadcastRaw({ type: 'peer-left', username: att.username });
    }
  }
  async webSocketError() {}

  broadcast(room, message, exclude = null, lastEvent = null) {
    const packet = JSON.stringify({ type: 'state', room: pubRoom(room), message, lastEvent });
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
    stake: room.stake || 0, mode: room.mode || 'classic', pot: room.pot || 0, locked: !!room.locked, lastPot: room.lastPot || 0,
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