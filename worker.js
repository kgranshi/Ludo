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

function syncUserCoins(u) {
  if (!u) return u;
  if (u.silverCoins === undefined) u.silverCoins = Number(u.coins) || 0;
  if (u.goldCoins === undefined) u.goldCoins = 0;
  u.coins = u.silverCoins;
  return u;
}

function publicUser(u) {
  if (!u) return null;
  const now = Date.now();
  const voiceUntil = u.voiceUntil || 0;
  const silverCoins = u.silverCoins !== undefined ? Number(u.silverCoins) || 0 : (Number(u.coins) || 0);
  const goldCoins = Number(u.goldCoins) || 0;
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
    silverCoins,
    goldCoins,
    coins: silverCoins,
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

function genRemarkCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return 'LUDO-' + [...arr].map(b => chars[b % chars.length]).join('');
}

function applyLevelReward(user, cfg) {
  const lr = cfg?.levelRewards || {};
  const reward = lr[String(user.level)];
  if (reward && (!user._lr || user._lr < user.level)) {
    user._lr = user.level;
    if (reward.skinId) user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), reward.skinId]));
    if (reward.avatarId) user.ownedAvatars = Array.from(new Set([...(user.ownedAvatars || []), reward.avatarId]));
    if (reward.roomItem) user.roomDecor = Array.from(new Set([...(user.roomDecor || []), reward.roomItem]));
    if (reward.funTokens) user.funTokens = (user.funTokens || 0) + reward.funTokens;
  }
}

// ===================== Web Push (RFC 8291 + VAPID ES256) & Email Helpers =====================
function b64uEnc(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDec(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob((str + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

async function sendWebPushRFC8291(subscription, payloadObj, vapid, contactEmail) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return { ok: false, status: 400, error: 'Invalid subscription' };
  }
  const enc = new TextEncoder();
  const uaPubRaw = b64uDec(subscription.keys.p256dh);
  const authSecret = b64uDec(subscription.keys.auth);

  // Ephemeral ECDH keypair
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));

  // PRK & IKM (RFC 8291 Section 3.3)
  const sharedKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const webPushInfo = concatBytes(enc.encode('WebPush: info\0'), uaPubRaw, asPubRaw);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: webPushInfo }, sharedKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cekBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('Content-Encoding: aes128gcm\0') }, ikmKey, 128);
  const nonce = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('Content-Encoding: nonce\0') }, ikmKey, 96));

  const aesKey = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
  const plaintext = concatBytes(enc.encode(JSON.stringify(payloadObj)), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  // Content-Coding header: salt(16) + rs(4 BE = 4096) + idlen(1 = 65) + keyid(65)
  const hdr = new Uint8Array(16 + 4 + 1 + asPubRaw.length);
  hdr.set(salt, 0);
  new DataView(hdr.buffer).setUint32(16, 4096, false);
  hdr[20] = asPubRaw.length;
  hdr.set(asPubRaw, 21);
  const bodyBytes = concatBytes(hdr, ciphertext);

  // VAPID JWT (ES256)
  const endpointUrl = new URL(subscription.endpoint);
  const jwtHeader = b64uEnc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const jwtPayload = b64uEnc(enc.encode(JSON.stringify({
    aud: endpointUrl.origin,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: 'mailto:' + (contactEmail || 'kgranshi@gmail.com')
  })));
  const unsigned = jwtHeader + '.' + jwtPayload;
  const signKey = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, enc.encode(unsigned)));
  const jwt = unsigned + '.' + b64uEnc(sig);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${vapid.publicKey}`,
      'TTL': '300',
      'Urgency': 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream'
    },
    body: bodyBytes
  });
  return { ok: res.ok, status: res.status };
}

async function sendAdminEmailAlert({ to, subject, text, html, env }) {
  const recipient = String(to || 'kgranshi@gmail.com').trim();
  if (!recipient || !recipient.includes('@')) return { ok: false, configured: false, reason: 'Invalid admin email' };

  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.EMAIL_FROM || 'Nepali Ludo <onboarding@resend.dev>',
          to: [recipient],
          subject,
          text,
          html
        })
      });
      return { ok: res.ok, configured: true, provider: 'resend', status: res.status };
    } catch (e) {
      return { ok: false, configured: true, provider: 'resend', error: String(e?.message || e) };
    }
  }
  if (env.BREVO_API_KEY) {
    try {
      const fromEmail = env.EMAIL_FROM || recipient;
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: { name: 'Nepali Ludo Admin', email: fromEmail },
          to: [{ email: recipient }],
          subject,
          textContent: text,
          htmlContent: html
        })
      });
      return { ok: res.ok, configured: true, provider: 'brevo', status: res.status };
    } catch (e) {
      return { ok: false, configured: true, provider: 'brevo', error: String(e?.message || e) };
    }
  }
  if (env.ADMIN_ALERT_WEBHOOK_URL) {
    try {
      const res = await fetch(env.ADMIN_ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: recipient, subject, text, html, time: Date.now() })
      });
      return { ok: res.ok, configured: true, provider: 'webhook', status: res.status };
    } catch (e) {
      return { ok: false, configured: true, provider: 'webhook', error: String(e?.message || e) };
    }
  }
  return { ok: false, configured: false, reason: 'Email API key (RESEND_API_KEY / BREVO_API_KEY / ADMIN_ALERT_WEBHOOK_URL) not set in environment.' };
}

async function verifyProofWorkerRest({ imageBase64, mimeType, remarkCode, expectedAmount, methodLabel, apiKey }) {
  if (!apiKey) {
    return {
      ok: false, unavailable: true, codeFound: false, appearsEditedOrAI: false,
      reason: 'स्वचालित AI प्रमाण जाँचको लागि GEMINI_API_KEY सेट नभएकोले एडमिन स्वीकृति पेन्डिङमा राखियो।'
    };
  }
  try {
    const prompt = [
      'You are verifying a Nepali digital wallet / bank payment screenshot (eSewa, Khalti, Fonepay, IME Pay, or Bank Transfer).',
      `Expected Remark / Reference Code: "${remarkCode}"`,
      `Expected Payment Method: "${methodLabel || 'Wallet/Bank'}"`,
      `Expected Amount: Rs. ${expectedAmount}`,
      'Check if the exact remarkCode is genuinely in Remarks/Reference, amount matches, and image is NOT edited/photoshopped/AI-generated.',
      'Return JSON with keys: codeFound (boolean), detectedRemarks (string), amountMatches (boolean), appearsEditedOrAI (boolean), reasonNe (brief Nepali explanation).'
    ].join('\n');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
    if (!res.ok) throw new Error('Gemini REST HTTP ' + res.status);
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(raw.trim());
    const codeFound = !!parsed.codeFound;
    const appearsEditedOrAI = !!parsed.appearsEditedOrAI;
    const amountMatches = parsed.amountMatches !== false;
    const verified = codeFound && !appearsEditedOrAI && amountMatches;
    const reason = String(parsed.reasonNe || '').trim() || (
      appearsEditedOrAI ? 'रसिद फोटोमा एडिट वा AI बनावटको शंका देखिएकोले एडमिन जाँच पेन्डिङमा छ।'
      : !codeFound ? `अपलोड गरिएको रसिदको रिमार्क्समा कोड (${remarkCode}) भेटिएन।`
      : !amountMatches ? `रसिदमा रकम Rs. ${expectedAmount} सँग मेल खाएन।`
      : 'स्वचालित जाँच सफल भयो।'
    );
    return { ok: true, verified, codeFound, appearsEditedOrAI, amountMatches, detectedRemarks: String(parsed.detectedRemarks || ''), reason };
  } catch (e) {
    return {
      ok: false, unavailable: true, codeFound: false, appearsEditedOrAI: false,
      reason: 'स्वचालित AI जाँच सेवामा अस्थायी समस्या आएकोले एडमिन स्वीकृति पेन्डिङमा राखियो।'
    };
  }
}

// ===================== ShopConfig =====================
export class ShopConfig {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  defaultConfig() {
    return {
      goldPackages: [
        { id: 'g5', label: '5 Gold Coins', goldAmount: 5, priceNpr: 50 },
        { id: 'g12', label: '12 Gold Coins (+2 Bonus)', goldAmount: 12, priceNpr: 100 },
        { id: 'g32', label: '32 Gold Coins', goldAmount: 32, priceNpr: 250 },
        { id: 'g70', label: '70 Gold Coins', goldAmount: 70, priceNpr: 500 },
        { id: 'g150', label: '150 Gold Coins', goldAmount: 150, priceNpr: 1000 }
      ],
      voicePackages: [
        { id: 'v1h', label: '1 Hour Voice', ms: HOUR, priceNpr: 19, priceSilver: 100, priceGold: 0 },
        { id: 'v1d', label: '1 Day Voice', ms: DAY, priceNpr: 49, priceSilver: 0, priceGold: 3 },
        { id: 'v7d', label: '7 Days Voice', ms: 7 * DAY, priceNpr: 149, priceSilver: 0, priceGold: 8 },
        { id: 'v30d', label: '30 Days Voice', ms: 30 * DAY, priceNpr: 299, priceSilver: 0, priceGold: 15 }
      ],
      skins: [
        { id: 'default', label: 'Classic Durbar (परम्परागत)', priceCoins: 0, priceSilver: 0, priceGold: 0, priceFun: 0, minLevel: 1 },
        { id: 'gold', label: 'Dhaka Gold (ढाका र सुन)', priceCoins: 20, priceSilver: 20, priceGold: 0, priceFun: 0, minLevel: 1 },
        { id: 'nepal', label: 'Nepal Flag (नेपाल झण्डा)', priceCoins: 30, priceSilver: 30, priceGold: 0, priceFun: 0, minLevel: 1 },
        { id: 'neon', label: 'Tihar Glow (तिहार झिलिमिली)', priceCoins: 50, priceSilver: 50, priceGold: 0, priceFun: 0, minLevel: 2 },
        { id: 'himal', label: 'Himal Sagarmatha (हिमाल)', priceCoins: 25, priceSilver: 25, priceGold: 0, priceFun: 0, minLevel: 1 },
        { id: 'pahad', label: 'Pahad Laligurans (पहाड)', priceCoins: 25, priceSilver: 25, priceGold: 0, priceFun: 0, minLevel: 1 },
        { id: 'terai', label: 'Terai Lumbini (तराई)', priceCoins: 30, priceSilver: 30, priceGold: 0, priceFun: 0, minLevel: 2 },
        { id: 'durbar', label: 'Malla Durbar (दरबार)', priceCoins: 45, priceSilver: 45, priceGold: 0, priceFun: 0, minLevel: 2 }
      ],
      avatars: [
        { id: 'default', label: 'Default Avatar', priceCoins: 0, priceSilver: 0, priceGold: 0, minLevel: 1, emoji: '🙂' },
        { id: 'hero', label: 'Himalayan Hero (हिमाली नायक)', priceCoins: 15, priceSilver: 15, priceGold: 0, minLevel: 1, imageUrl: '/assets/avatar_himal_hero.jpg' },
        { id: 'king', label: 'Durbar Royal (दरबार राज)', priceCoins: 40, priceSilver: 40, priceGold: 0, minLevel: 2, imageUrl: '/assets/avatar_durbar_royal.jpg' }
      ],
      mics: [
        { id: 'mic_default', label: 'Default Mic', priceCoins: 0, priceSilver: 0, priceGold: 0, minLevel: 1, emoji: '🎤' },
        { id: 'mic_gold', label: 'Gold Mic', priceCoins: 25, priceSilver: 25, priceGold: 0, minLevel: 1, emoji: '🎙️' },
        { id: 'mic_neon', label: 'Brass Mic', priceCoins: 40, priceSilver: 40, priceGold: 0, minLevel: 2, emoji: '📯' }
      ],
      roomItems: [
        { id: 'diyo', label: 'Tihar Diyo (दियो)', priceCoins: 8, priceSilver: 8, priceGold: 0, minLevel: 1, emoji: '🪔' },
        { id: 'lamp', label: 'Durbar Lamp', priceCoins: 10, priceSilver: 10, priceGold: 0, minLevel: 1, emoji: '💡' },
        { id: 'dhaka', label: 'Dhaka Topi (ढाका टोपी)', priceCoins: 15, priceSilver: 15, priceGold: 0, minLevel: 1, emoji: '🧢' },
        { id: 'sarangi', label: 'Sarangi (सारङ्गी)', priceCoins: 20, priceSilver: 20, priceGold: 0, minLevel: 2, emoji: '🎻' },
        { id: 'trophy', label: 'Trophy Shelf', priceCoins: 25, priceSilver: 25, priceGold: 0, minLevel: 2, emoji: '🏆' },
        { id: 'sofa', label: 'VIP Baithak', priceCoins: 35, priceSilver: 35, priceGold: 0, minLevel: 3, emoji: '🛋️' }
      ],
      levelRewards: {
        '2': { skinId: 'gold', funTokens: 50 },
        '3': { avatarId: 'hero', roomItem: 'diyo' },
        '5': { skinId: 'neon', funTokens: 100 }
      },
      paymentMethods: [
        { id: 'esewa', label: 'eSewa', detail: '9800000000 (Admin ले सेट गर्नुहोस्)', qrUrl: '' },
        { id: 'khalti', label: 'Khalti', detail: '9800000000 (Admin ले सेट गर्नुहोस्)', qrUrl: '' },
        { id: 'bank', label: 'Bank / FonePay QR', detail: 'Bank A/C (Admin ले सेट गर्नुहोस्)', qrUrl: '' }
      ],
      dailyLoginVoiceMs: 0,
      dailyBaseFunTokens: 30,
      dailyPerLevelFunTokens: 20,
      dailyLoginFunTokens: 30,
      levelUpGoldCost: 10,
      referralRewardFunTokens: 100,
      referralRewardVoiceMs: 10 * DAY,
      starterFunTokens: 100,
      defaultStake: 20,
      stakes: [0, 10, 20, 50, 100],
      goldRechargeEnabled: true,
      paymentEnabled: true,
      adminNotifyEmail: 'kgranshi@gmail.com',
      adminLockPin: '1122',
      updatedAt: Date.now()
    };
  }
  async getConfig() {
    const def = this.defaultConfig();
    const stored = await this.ctx.storage.get('config');
    if (!stored) return def;
    return {
      ...def,
      ...stored,
      adminNotifyEmail: stored.adminNotifyEmail || def.adminNotifyEmail,
      adminLockPin: stored.adminLockPin || def.adminLockPin,
      goldPackages: (stored.goldPackages && stored.goldPackages.length) ? stored.goldPackages : def.goldPackages,
      voicePackages: (stored.voicePackages && stored.voicePackages.length) ? stored.voicePackages : def.voicePackages,
      paymentMethods: (stored.paymentMethods && stored.paymentMethods.length) ? stored.paymentMethods : def.paymentMethods
    };
  }

  async getVapidKeys() {
    if (this.env.VAPID_PUBLIC_KEY && this.env.VAPID_PRIVATE_JWK) {
      try {
        const jwk = typeof this.env.VAPID_PRIVATE_JWK === 'string' ? JSON.parse(this.env.VAPID_PRIVATE_JWK) : this.env.VAPID_PRIVATE_JWK;
        return { publicKey: this.env.VAPID_PUBLIC_KEY, privateJwk: jwk };
      } catch {}
    }
    let stored = await this.ctx.storage.get('vapid');
    if (stored?.publicKey && stored?.privateJwk) return stored;
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    stored = { publicKey: b64uEnc(pubRaw), privateJwk };
    await this.ctx.storage.put('vapid', stored);
    return stored;
  }

  async dispatchPendingAlerts({ title, body, tag = 'ludo-pending-order' }) {
    const cfg = await this.getConfig();
    const subs = (await this.ctx.storage.get('pushSubscriptions')) || [];
    const vapid = await this.getVapidKeys();
    const alive = [];
    let pushSent = 0, pushFailed = 0;
    for (const sub of subs) {
      try {
        const res = await sendWebPushRFC8291(sub, { title, body, url: '/admin.html#proofs', tag }, vapid, cfg.adminNotifyEmail);
        if (res.ok) { pushSent++; alive.push(sub); }
        else if (res.status === 404 || res.status === 410) { pushFailed++; }
        else { pushFailed++; alive.push(sub); }
      } catch {
        pushFailed++;
        alive.push(sub);
      }
    }
    if (alive.length !== subs.length) {
      await this.ctx.storage.put('pushSubscriptions', alive);
    }
    const emailRes = await sendAdminEmailAlert({
      to: cfg.adminNotifyEmail || 'kgranshi@gmail.com',
      subject: title,
      text: `${body}\n\nAdmin Panel: /admin.html`,
      html: `<div style="font-family:sans-serif;padding:16px"><h3>${title}</h3><p>${body}</p><p>कृपया Admin Panel खोलेर रसिद जाँच गर्नुहोस्।</p></div>`,
      env: this.env
    });
    return { pushSent, pushFailed, totalSubs: alive.length, emailRes };
  }

  async alarm() {
    const orders = (await this.ctx.storage.get('orders')) || [];
    const now = Date.now();
    const pending = orders.filter(o => o.status === 'pending_admin');
    if (!pending.length) return;
    const due = pending.filter(o => !o.lastNotifiedAt || (now - o.lastNotifiedAt) >= 270000);
    if (due.length) {
      for (const o of pending) o.lastNotifiedAt = now;
      await this.ctx.storage.put('orders', orders);
      const first = due[0];
      await this.dispatchPendingAlerts({
        title: `🔔 ${pending.length} पेन्डिङ Gold अर्डर बाँकी छ!`,
        body: `@${first.username} — ${first.goldAmount} Gold (Rs.${first.amountNpr}) · कोड: ${first.remarkCode}`,
        tag: 'ludo-pending-reminder'
      });
    }
    if (typeof this.ctx.storage.setAlarm === 'function') {
      await this.ctx.storage.setAlarm(now + 300000);
    }
  }

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

    // Step 1 of Gold Coin Recharge: Create order + generate remark code BEFORE showing account/QR
    if (path === 'create-order' && request.method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || String(body.token || '');
      if (!username || !token) return json({ ok: false, error: 'auth' }, 401);
      const ur = await this.env.USERS.get(this.env.USERS.idFromName(username)).fetch(new Request('https://user/me', { headers: { Authorization: 'Bearer ' + token } }));
      if (!ur.ok) return json({ ok: false, error: 'auth' }, 401);
      const cfg = await this.getConfig();
      if (cfg.goldRechargeEnabled === false) return json({ ok: false, error: 'Gold recharge currently disabled' }, 403);
      const pack = (cfg.goldPackages || []).find(x => x.id === body.packageId);
      const method = (cfg.paymentMethods || []).find(x => x.id === body.methodId);
      if (!pack || !method) return json({ ok: false, error: 'Invalid package or payment method' }, 400);

      const orders = (await this.ctx.storage.get('orders')) || [];
      const order = {
        id: rid(8),
        username,
        packageType: 'gold',
        packageId: pack.id,
        packageLabel: pack.label,
        goldAmount: Number(pack.goldAmount) || 0,
        amountNpr: Number(pack.priceNpr) || 0,
        methodId: method.id,
        methodLabel: method.label,
        methodDetail: method.detail || '',
        methodQrUrl: method.qrUrl || '',
        remarkCode: genRemarkCode(),
        status: 'awaiting_proof',
        statusReason: 'भुक्तानी गर्दा Remarks मा यही कोड पेस्ट गरी रसिद अपलोड गर्नुहोस्।',
        aiCheck: null,
        proofData: '',
        proofMime: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastNotifiedAt: 0
      };
      orders.push(order);
      while (orders.length > 300) orders.shift();
      await this.ctx.storage.put('orders', orders);
      return json({ ok: true, order, method });
    }

    if (path === 'my-orders' && request.method === 'GET') {
      const username = String(url.searchParams.get('u') || '').trim().toLowerCase();
      const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || String(url.searchParams.get('token') || '');
      if (!username || !token) return json({ ok: false, error: 'auth' }, 401);
      const ur = await this.env.USERS.get(this.env.USERS.idFromName(username)).fetch(new Request('https://user/me', { headers: { Authorization: 'Bearer ' + token } }));
      if (!ur.ok) return json({ ok: false, error: 'auth' }, 401);
      const orders = ((await this.ctx.storage.get('orders')) || [])
        .filter(o => o.username === username)
        .slice(-25)
        .reverse()
        .map(o => ({ ...o, hasProof: !!o.proofData, proofData: undefined }));
      return json({ ok: true, orders });
    }

    if (path === 'submit-order-proof' && request.method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || String(body.token || '');
      if (!username || !token) return json({ ok: false, error: 'auth' }, 401);
      const ur = await this.env.USERS.get(this.env.USERS.idFromName(username)).fetch(new Request('https://user/me', { headers: { Authorization: 'Bearer ' + token } }));
      if (!ur.ok) return json({ ok: false, error: 'auth' }, 401);

      const orders = (await this.ctx.storage.get('orders')) || [];
      const order = orders.find(o => o.id === body.orderId && o.username === username);
      if (!order) return json({ ok: false, error: 'Order not found' }, 404);
      if (order.status === 'approved') return json({ ok: false, error: 'Order already approved' }, 400);

      const proofData = String(body.proofData || '');
      const proofMime = String(body.proofMime || 'image/jpeg');
      if (!proofData || proofData.length > 350000 || !proofMime.startsWith('image/')) {
        return json({ ok: false, error: 'Valid compressed payment screenshot required' }, 400);
      }
      order.proofData = proofData;
      order.proofMime = proofMime;
      order.note = String(body.note || '').slice(0, 300);
      order.updatedAt = Date.now();

      let verifyRes = {
        ok: false,
        verified: false,
        codeFound: false,
        appearsEditedOrAI: false,
        reason: 'स्वचालित जाँच उपलब्ध नभएकोले एडमिन स्वीकृति पेन्डिङमा राखियो।'
      };
      if (typeof this.env.verifyPaymentProof === 'function') {
        verifyRes = await this.env.verifyPaymentProof({
          imageBase64: proofData,
          mimeType: proofMime,
          remarkCode: order.remarkCode,
          expectedAmount: order.amountNpr,
          methodLabel: order.methodLabel
        });
      } else if (this.env.GEMINI_API_KEY) {
        verifyRes = await verifyProofWorkerRest({
          imageBase64: proofData,
          mimeType: proofMime,
          remarkCode: order.remarkCode,
          expectedAmount: order.amountNpr,
          methodLabel: order.methodLabel,
          apiKey: this.env.GEMINI_API_KEY
        });
      }

      order.aiCheck = {
        checkedAt: Date.now(),
        codeFound: !!verifyRes.codeFound,
        appearsEditedOrAI: !!verifyRes.appearsEditedOrAI,
        amountMatches: !!verifyRes.amountMatches,
        detectedRemarks: String(verifyRes.detectedRemarks || ''),
        reason: String(verifyRes.reason || '')
      };

      let updatedUser = null;
      if (verifyRes.verified) {
        order.status = 'approved';
        order.statusReason = verifyRes.reason || 'स्वचालित जाँच पास भयो! Gold Coins तुरुन्त थपियो।';
        order.approvedBy = 'auto';
        const fulfillRes = await this.env.USERS.get(this.env.USERS.idFromName(username)).fetch(new Request('https://user/admin-fulfill', {
          method: 'POST', headers: internalHeaders(this.env),
          body: JSON.stringify({ secret, packageType: 'gold', goldAmount: order.goldAmount })
        }));
        const fj = await fulfillRes.json().catch(() => null);
        if (fj?.ok) updatedUser = fj.user;
      } else {
        order.status = 'pending_admin';
        order.statusReason = verifyRes.reason || `कोड (${order.remarkCode}) रसिदमा पुष्टि नभएकाले एडमिन स्वीकृति पेन्डिङ छ।`;
        order.lastNotifiedAt = Date.now();
        try {
          await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).fetch(new Request('https://lobby/admin-msg', {
            method: 'POST', headers: internalHeaders(this.env),
            body: JSON.stringify({
              from: order.username,
              type: 'gold_order_pending',
              text: `Pending Gold Order ${order.remarkCode}: Rs.${order.amountNpr} (${order.goldAmount} Gold) — ${order.statusReason}`,
              time: Date.now(),
              meta: { orderId: order.id }
            })
          }));
        } catch {}
      }

      await this.ctx.storage.put('orders', orders);
      if (order.status === 'pending_admin') {
        await this.dispatchPendingAlerts({
          title: `🔔 नयाँ Gold Order स्वीकृति पेन्डिङ (${order.remarkCode})`,
          body: `@${order.username} ले ${order.goldAmount} Gold (Rs.${order.amountNpr}) को रसिद पठाएका छन् — ${order.statusReason}`,
          tag: 'ludo-order-' + order.id
        }).catch(() => null);
        if (typeof this.ctx.storage.setAlarm === 'function') {
          await this.ctx.storage.setAlarm(Date.now() + 300000).catch(() => null);
        }
      }
      return json({
        ok: true,
        order: { ...order, hasProof: true, proofData: undefined },
        user: updatedUser
      });
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
      if (proofData.length > 350000 || (proofData && !proofMime.startsWith('image/') && proofMime !== 'application/pdf')) return json({ ok: false, error: 'invalid proof file' }, 400);
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
      const orders = (await this.ctx.storage.get('orders')) || [];
      const proofs = (await this.ctx.storage.get('proofs')) || [];
      const now = Date.now();
      let dirty = false;
      let needsReminder = false;
      const pendingOrders = orders.filter(o => o.status === 'pending_admin');
      for (const o of pendingOrders) {
        if (!o.lastNotifiedAt || (now - o.lastNotifiedAt) >= 300000) {
          o.lastNotifiedAt = now;
          dirty = true;
          needsReminder = true;
        }
      }
      if (dirty) await this.ctx.storage.put('orders', orders);
      const normalizedOrders = orders
        .filter(o => o.status !== 'awaiting_proof' || o.proofData)
        .map(o => ({
          id: o.id, kind: 'gold_order', username: o.username,
          packageType: 'gold', packageId: o.packageId, packageLabel: o.packageLabel,
          goldAmount: o.goldAmount, amount: o.amountNpr, methodId: o.methodId, methodLabel: o.methodLabel,
          remarkCode: o.remarkCode, status: o.status, statusReason: o.statusReason,
          aiCheck: o.aiCheck, note: o.note || '', proofData: o.proofData, proofMime: o.proofMime,
          time: o.updatedAt || o.createdAt
        }));
      const normalizedLegacy = proofs.map(p => ({ ...p, kind: 'legacy_proof', status: p.status === 'pending' ? 'pending_admin' : p.status }));
      const combined = [...normalizedOrders, ...normalizedLegacy].sort((a, b) => (b.time || 0) - (a.time || 0));
      const pendingCount = combined.filter(x => x.status === 'pending_admin').length;
      return json({ ok: true, proofs: combined, pendingCount, needsReminder });
    }

    if (path === 'proof-action' && request.method === 'POST') {
      if (!secret || (body.secret !== secret && request.headers.get('X-Admin-Secret') !== secret)) return json({ ok: false, error: 'unauthorized' }, 403);
      const orders = (await this.ctx.storage.get('orders')) || [];
      const order = orders.find(x => x.id === body.proofId);
      if (order) {
        if (order.status === 'approved') return json({ ok: false, error: 'Already approved' }, 400);
        if (body.action === 'approve') {
          order.status = 'approved';
          order.approvedBy = 'admin';
          order.statusReason = String(body.reason || 'एडमिनद्वारा स्वीकृत — Gold Coins थपियो।');
          order.updatedAt = Date.now();
          await this.ctx.storage.put('orders', orders);
          await this.env.USERS.get(this.env.USERS.idFromName(order.username.toLowerCase())).fetch(new Request('https://user/admin-fulfill', {
            method: 'POST', headers: internalHeaders(this.env),
            body: JSON.stringify({ secret, packageType: 'gold', goldAmount: order.goldAmount })
          }));
        } else {
          order.status = 'rejected';
          order.statusReason = String(body.reason || 'एडमिनद्वारा अस्वीकृत (रसिद मान्य देखिएन)।');
          order.updatedAt = Date.now();
          await this.ctx.storage.put('orders', orders);
        }
        return json({ ok: true, proof: { ...order, proofData: undefined } });
      }
      const proofs = (await this.ctx.storage.get('proofs')) || [];
      const p = proofs.find(x => x.id === body.proofId);
      if (!p) return json({ ok: false, error: 'not found' }, 404);
      if (p.status === 'approved') return json({ ok: false, error: 'Already approved' }, 400);
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

    // Marketplace listings (Admin sells items to players for Fun Tokens or Silver/Gold Coins)
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
      const priceFun = Number(body.priceFun) || 0;
      const priceSilver = Number(body.priceSilver !== undefined ? body.priceSilver : body.priceCoins) || 0;
      const priceGold = Number(body.priceGold) || 0;
      if (!['skin','avatar','mic','room'].includes(itemType) || !/^[a-z0-9_-]{1,40}$/i.test(itemId) || priceFun < 0 || priceSilver < 0 || priceGold < 0 || (priceFun + priceSilver + priceGold) <= 0 || priceFun > 1000000 || priceSilver > 1000000 || priceGold > 100000) {
        return json({ ok: false, error: 'Invalid listing parameters' }, 400);
      }
      const listings = (await this.ctx.storage.get('market')) || [];
      const item = { id: rid(6), seller: 'admin', isAdminListing: true, itemType, itemId, label, emoji, priceFun, priceSilver, priceCoins: priceSilver, priceGold, time: Date.now() };
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
        body: JSON.stringify({
          token: body.token,
          priceFun: listing.priceFun || 0,
          priceSilver: listing.priceSilver !== undefined ? listing.priceSilver : (listing.priceCoins || 0),
          priceGold: listing.priceGold || 0,
          itemType: listing.itemType, itemId: listing.itemId, seller: listing.seller
        })
      }));
      const pj = await pay.json();
      if (!pj.ok) return json(pj, 400);
      if (!listing.isAdminListing && listing.seller !== 'admin') {
        const next = listings.filter(x => x.id !== listing.id);
        await this.ctx.storage.put('market', next);
      }
      return json({ ok: true, user: pj.user });
    }

    // Admin Web Push & Alert Notification endpoints
    if (path === 'push-public-key' && request.method === 'GET') {
      if (!secret || request.headers.get('X-Admin-Secret') !== secret) return json({ ok: false, error: 'unauthorized' }, 403);
      const vapid = await this.getVapidKeys();
      const subs = (await this.ctx.storage.get('pushSubscriptions')) || [];
      const cfg = await this.getConfig();
      const emailConfigured = !!(this.env.RESEND_API_KEY || this.env.BREVO_API_KEY || this.env.ADMIN_ALERT_WEBHOOK_URL);
      return json({
        ok: true,
        publicKey: vapid.publicKey,
        subscriptionCount: subs.length,
        adminNotifyEmail: cfg.adminNotifyEmail || 'kgranshi@gmail.com',
        emailConfigured
      });
    }
    if (path === 'push-subscribe' && request.method === 'POST') {
      if (!secret || (body.secret !== secret && request.headers.get('X-Admin-Secret') !== secret)) return json({ ok: false, error: 'unauthorized' }, 403);
      const sub = body.subscription;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json({ ok: false, error: 'Invalid PushSubscription' }, 400);
      const subs = (await this.ctx.storage.get('pushSubscriptions')) || [];
      const filtered = subs.filter(x => x.endpoint !== sub.endpoint);
      filtered.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, addedAt: Date.now() });
      while (filtered.length > 20) filtered.shift();
      await this.ctx.storage.put('pushSubscriptions', filtered);
      return json({ ok: true, subscriptionCount: filtered.length });
    }
    if (path === 'push-unsubscribe' && request.method === 'POST') {
      if (!secret || (body.secret !== secret && request.headers.get('X-Admin-Secret') !== secret)) return json({ ok: false, error: 'unauthorized' }, 403);
      const subs = (await this.ctx.storage.get('pushSubscriptions')) || [];
      const next = subs.filter(x => x.endpoint !== body.endpoint);
      await this.ctx.storage.put('pushSubscriptions', next);
      return json({ ok: true, subscriptionCount: next.length });
    }
    if (path === 'test-alert' && request.method === 'POST') {
      if (!secret || (body.secret !== secret && request.headers.get('X-Admin-Secret') !== secret)) return json({ ok: false, error: 'unauthorized' }, 403);
      const res = await this.dispatchPendingAlerts({
        title: '🔔 नेपाली लुडो — Test Admin Notification',
        body: 'PWA Web Push र Email सूचना परीक्षण सफल भयो!',
        tag: 'ludo-test-' + Date.now()
      });
      return json({ ok: true, ...res });
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
        funTokens: cfg?.starterFunTokens ?? 100, dailyFunTokens: 0, dailyFunDate: '',
        silverCoins: 0, goldCoins: 0, coins: 0, level: 1, wins: 0, games: 0,
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
      syncUserCoins(user);
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

    const user = syncUserCoins(await this.get());
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || body.token || url.searchParams.get('token') || '';
    const authed = user && token && user.token === token;
    const internalOnly = new Set([
      'receive-voice-gift','economy','market-pay','market-credit','receive-item-gift','add-referral-reward','admin-fulfill',
      'receive-friend-request','confirm-friend','unfriend-internal','receive-currency'
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
      const baseDaily = cfg?.dailyBaseFunTokens ?? cfg?.dailyLoginFunTokens ?? 30;
      const perLv = cfg?.dailyPerLevelFunTokens ?? 20;
      const lv = Math.max(1, Number(user.level) || 1);
      const addFun = baseDaily + (lv - 1) * perLv;
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

    // Buy ANY item (skin | avatar | room | mic | voice) directly using Silver / Gold Coins
    if (path === 'buy-soft' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const cfg = await this.cfg();
      const kind = body.kind; // skin | avatar | room | mic | voice
      const id = body.id;
      let item = null;
      if (kind === 'skin') item = (cfg?.skins || []).find(x => x.id === id);
      if (kind === 'avatar') item = (cfg?.avatars || []).find(x => x.id === id);
      if (kind === 'room') item = (cfg?.roomItems || []).find(x => x.id === id);
      if (kind === 'mic') item = (cfg?.mics || []).find(x => x.id === id);
      if (kind === 'voice') item = (cfg?.voicePackages || []).find(x => x.id === id);
      if (!item) return json({ ok: false, error: 'item not found' }, 404);
      if ((user.level || 1) < (item.minLevel || 1)) return json({ ok: false, error: 'Level too low' }, 400);

      let ps = Number(item.priceSilver !== undefined ? item.priceSilver : item.priceCoins) || 0;
      let pg = Number(item.priceGold) || 0;
      const pf = Number(item.priceFun) || 0;
      // Optional payWith preference ('gold' or 'silver') when equivalent conversion applies
      if (body.payWith === 'gold') {
        pg = pg > 0 ? pg : Math.ceil(ps / 100);
        ps = 0;
      } else if (body.payWith === 'silver') {
        ps = ps > 0 ? ps : pg * 100;
        pg = 0;
      }

      if ((user.silverCoins || 0) < ps || (user.goldCoins || 0) < pg || (user.funTokens || 0) < pf) {
        return json({ ok: false, error: 'पर्याप्त Coin / Token ब्यालेन्स छैन' }, 400);
      }
      user.silverCoins = (user.silverCoins || 0) - ps;
      user.goldCoins = (user.goldCoins || 0) - pg;
      user.coins = user.silverCoins;
      user.funTokens = (user.funTokens || 0) - pf;

      if (kind === 'skin') user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), id]));
      if (kind === 'avatar') user.ownedAvatars = Array.from(new Set([...(user.ownedAvatars || []), id]));
      if (kind === 'room') user.roomDecor = Array.from(new Set([...(user.roomDecor || []), id]));
      if (kind === 'mic') user.ownedMics = Array.from(new Set([...(user.ownedMics || ['mic_default']), id]));
      if (kind === 'voice') user.voiceUntil = Math.max(user.voiceUntil || 0, Date.now()) + (Number(item.ms) || HOUR);

      await this.put(user);
      await this.pushPresence(user);
      await this.pushDirectory(user);
      return json({ ok: true, user: publicUser(user) });
    }

    // Buy +1 Level using 10 Gold Coins
    if (path === 'buy-level' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const cfg = await this.cfg();
      const costGold = Number(cfg?.levelUpGoldCost) || 10;
      if ((user.goldCoins || 0) < costGold) {
        return json({ ok: false, error: `${costGold} Gold Coin आवश्यक छ (अहिले: ${user.goldCoins || 0})` }, 400);
      }
      user.goldCoins -= costGold;
      user.level = (user.level || 1) + 1;
      applyLevelReward(user, cfg);
      await this.put(user);
      await this.pushDirectory(user);
      await this.pushPresence(user);
      const baseDaily = cfg?.dailyBaseFunTokens ?? 30;
      const perLv = cfg?.dailyPerLevelFunTokens ?? 20;
      return json({
        ok: true,
        user: publicUser(user),
        dailyRateNow: baseDaily + (user.level - 1) * perLv
      });
    }

    // Convert currencies: 100 Fun <-> 1 Silver <-> 100 Silver = 1 Gold
    if ((path === 'convert-fun' || path === 'convert-currency') && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const direction = String(body.direction || 'fun_to_silver');
      const times = Math.min(1000, Math.max(1, Math.floor(Number(body.times) || 1)));
      if (direction === 'fun_to_silver') {
        const need = times * 100;
        if ((user.funTokens || 0) < need) return json({ ok: false, error: 'पर्याप्त Fun Token छैन (१०० Fun = १ Silver)' }, 400);
        user.funTokens -= need;
        user.silverCoins = (user.silverCoins || 0) + times;
      } else if (direction === 'silver_to_gold') {
        const need = times * 100;
        if ((user.silverCoins || 0) < need) return json({ ok: false, error: 'पर्याप्त Silver Coin छैन (१०० Silver = १ Gold)' }, 400);
        user.silverCoins -= need;
        user.goldCoins = (user.goldCoins || 0) + times;
      } else if (direction === 'gold_to_silver') {
        if ((user.goldCoins || 0) < times) return json({ ok: false, error: 'पर्याप्त Gold Coin छैन' }, 400);
        user.goldCoins -= times;
        user.silverCoins = (user.silverCoins || 0) + times * 100;
      } else {
        return json({ ok: false, error: 'Invalid conversion direction' }, 400);
      }
      user.coins = user.silverCoins;
      await this.put(user);
      return json({ ok: true, user: publicUser(user) });
    }

    // Player-to-Player Currency Transfer / Exchange (Fun Token, Silver Coin, Gold Coin)
    if (path === 'transfer-currency' && request.method === 'POST') {
      if (!authed) return json({ ok: false, error: 'auth' }, 401);
      const to = String(body.to || '').trim().toLowerCase();
      const currency = String(body.currency || '').trim().toLowerCase();
      const amount = Math.floor(Number(body.amount) || 0);
      if (!to || to === user.username) return json({ ok: false, error: 'मान्य साथी/प्रयोगकर्ता नाम राख्नुहोस्' }, 400);
      if (!['fun', 'silver', 'gold'].includes(currency) || amount < 1 || amount > 1000000) {
        return json({ ok: false, error: 'मान्य रकम र प्रकार (Fun/Silver/Gold) छान्नुहोस्' }, 400);
      }
      if (currency === 'fun' && (user.funTokens || 0) < amount) return json({ ok: false, error: 'पर्याप्त स्थायी Fun Token छैन' }, 400);
      if (currency === 'silver' && (user.silverCoins || 0) < amount) return json({ ok: false, error: 'पर्याप्त Silver Coin छैन' }, 400);
      if (currency === 'gold' && (user.goldCoins || 0) < amount) return json({ ok: false, error: 'पर्याप्त Gold Coin छैन' }, 400);

      if (currency === 'fun') user.funTokens -= amount;
      if (currency === 'silver') { user.silverCoins -= amount; user.coins = user.silverCoins; }
      if (currency === 'gold') user.goldCoins -= amount;
      await this.put(user);

      const rr = await this.env.USERS.get(this.env.USERS.idFromName(to)).fetch(new Request('https://user/receive-currency', {
        method: 'POST', headers: internalHeaders(this.env),
        body: JSON.stringify({ from: user.username, currency, amount })
      }));
      const rj = await rr.json().catch(() => ({ ok: false, error: 'User not found' }));
      if (!rr.ok || !rj.ok) {
        if (currency === 'fun') user.funTokens += amount;
        if (currency === 'silver') { user.silverCoins += amount; user.coins = user.silverCoins; }
        if (currency === 'gold') user.goldCoins += amount;
        await this.put(user);
        return json({ ok: false, error: rj.error || 'Transfer failed' }, 400);
      }
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'receive-currency' && request.method === 'POST') {
      if (!user) return json({ ok: false, error: 'प्रयोगकर्ता भेटिएन' }, 404);
      if (user.banned) return json({ ok: false, error: 'Recipient banned' }, 403);
      const currency = String(body.currency || '');
      const amount = Math.floor(Number(body.amount) || 0);
      if (amount <= 0) return json({ ok: false, error: 'invalid amount' }, 400);
      if (currency === 'fun') user.funTokens = (user.funTokens || 0) + amount;
      if (currency === 'silver') { user.silverCoins = (user.silverCoins || 0) + amount; user.coins = user.silverCoins; }
      if (currency === 'gold') user.goldCoins = (user.goldCoins || 0) + amount;
      await this.put(user);
      return json({ ok: true });
    }

    // Internal economy adjusts from room
    if (path === 'economy' && request.method === 'POST') {
      if (!user) return json({ ok: false }, 404);
      let funDelta = Number(body.funDelta) || 0;
      const win = !!body.win;
      const today = new Date().toISOString().slice(0, 10);
      if (user.dailyFunDate !== today) { user.dailyFunTokens = 0; user.dailyFunDate = today; }
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
        user.funTokens = (user.funTokens || 0) + funDelta;
      }
      user.games = (user.games || 0) + (body.game ? 1 : 0);
      if (win) user.wins = (user.wins || 0) + 1;
      await this.put(user);
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'market-pay' && request.method === 'POST') {
      if (!user) return json({ ok: false, error: 'no user' }, 404);
      if (body.token !== user.token) return json({ ok: false, error: 'auth' }, 401);
      const pf = Number(body.priceFun) || 0;
      const ps = Number(body.priceSilver !== undefined ? body.priceSilver : body.priceCoins) || 0;
      const pg = Number(body.priceGold) || 0;
      const today = new Date().toISOString().slice(0, 10);
      if (user.dailyFunDate !== today) { user.dailyFunTokens = 0; user.dailyFunDate = today; }
      const totalFun = (user.dailyFunTokens || 0) + (user.funTokens || 0);
      if (totalFun < pf || (user.silverCoins || 0) < ps || (user.goldCoins || 0) < pg) {
        return json({ ok: false, error: 'पर्याप्त Token / Silver / Gold ब्यालेन्स छैन' }, 400);
      }
      const owned = body.itemType === 'skin' ? (user.ownedSkins || []) : body.itemType === 'avatar' ? (user.ownedAvatars || []) : body.itemType === 'mic' ? (user.ownedMics || []) : (user.roomDecor || []);
      if (owned.includes(body.itemId)) return json({ ok: false, error: 'You already own this item' }, 400);
      if (pf > 0) {
        const fromDaily = Math.min(user.dailyFunTokens || 0, pf);
        user.dailyFunTokens = (user.dailyFunTokens || 0) - fromDaily;
        const rem = pf - fromDaily;
        if (rem > 0) user.funTokens = (user.funTokens || 0) - rem;
      }
      user.silverCoins = (user.silverCoins || 0) - ps;
      user.coins = user.silverCoins;
      user.goldCoins = (user.goldCoins || 0) - pg;
      if (body.itemType === 'skin') user.ownedSkins = Array.from(new Set([...(user.ownedSkins || []), body.itemId]));
      if (body.itemType === 'avatar') user.ownedAvatars = Array.from(new Set([...(user.ownedAvatars || []), body.itemId]));
      if (body.itemType === 'mic') user.ownedMics = Array.from(new Set([...(user.ownedMics || []), body.itemId]));
      if (body.itemType === 'room') user.roomDecor = Array.from(new Set([...(user.roomDecor || []), body.itemId]));
      await this.put(user);
      if (body.seller && body.seller !== 'admin') {
        await this.env.USERS.get(this.env.USERS.idFromName(body.seller)).fetch(new Request('https://user/market-credit', {
          method: 'POST', headers: internalHeaders(this.env),
          body: JSON.stringify({ fun: pf, silver: ps, gold: pg, itemType: body.itemType, itemId: body.itemId })
        })).catch(() => null);
      }
      return json({ ok: true, user: publicUser(user) });
    }

    if (path === 'market-credit' && request.method === 'POST') {
      if (!user) return json({ ok: false }, 404);
      user.funTokens = (user.funTokens || 0) + (Number(body.fun) || 0);
      user.silverCoins = (user.silverCoins || 0) + (Number(body.silver !== undefined ? body.silver : body.coins) || 0);
      user.coins = user.silverCoins;
      user.goldCoins = (user.goldCoins || 0) + (Number(body.gold) || 0);
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
      const addSilv = body.addSilver !== undefined ? Number(body.addSilver) : Number(body.addCoins);
      if (Number.isFinite(addSilv)) {
        user.silverCoins = Math.max(0, (user.silverCoins || 0) + addSilv);
        user.coins = user.silverCoins;
      }
      if (Number.isFinite(Number(body.addGold))) user.goldCoins = Math.max(0, (user.goldCoins || 0) + Number(body.addGold));
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
      } else if (body.packageType === 'gold') {
        const g = Math.max(0, Number(body.goldAmount) || 0);
        user.goldCoins = (user.goldCoins || 0) + g;
      }
      await this.put(user); await this.pushDirectory(user); await this.pushPresence(user);
      return json({ ok: true, user: publicUser(user) });
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