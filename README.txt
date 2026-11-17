NEPALI LUDO — COMPLETE GUIDE (A to Z)
=====================================

1. WHAT THIS APP IS
------------------
Multiplayer Ludo with:
• Login (username + password), works on any phone
• Online / Busy status
• Play request → auto room (no code share needed)
• Text chat = free
• Live Voice = time-based (referral / gift / buy)
• Fun tokens (daily + permanent), coins, levels
• Personal cosmetics: board skin, avatar, mic skin, room decor
• Marketplace (player-to-player, soft currency only)
• Real money only to Admin for Voice packages (optional, no cash-out)
• Admin panel at /admin.html

LEGAL: No cash-out of tokens/coins. Soft currency + cosmetics only.


2. DEPLOY (GitHub + Cloudflare, mobile OK)
------------------------------------------
A) Upload the complete project structure to the GitHub repository:
   worker.js
   wrangler.toml
   README.txt
   public/index.html
   public/admin.html
   public/_headers
   (optional) public/assets/ folder for skin images

   Keep worker.js and wrangler.toml at repository root. The public/ folder
   contains only browser-facing static files; server source stays private.

B) Cloudflare Dashboard → Workers & Pages → Create
   - Connect the GitHub repo
   OR use Wrangler from a computer:
     npm i -g wrangler
     wrangler login
     wrangler secret put ADMIN_SECRET
        (use a random secret of at least 24 characters; keep it private)
     wrangler deploy

C) After deploy open:
   https://YOUR-WORKER.workers.dev/          → game
   https://YOUR-WORKER.workers.dev/admin.html → admin


3. ADMIN LOGIN
--------------
• Admin does NOT use the game register form.
• Open /admin.html
• Enter the same ADMIN_SECRET you set in Cloudflare
• Click Save secret (stored in that browser only)

Cloudflare side: Workers → your worker → Settings → Variables → Secrets
Name: ADMIN_SECRET
Value: random secret, minimum 24 characters (required for internal service calls too)


4. ECONOMY RULES (defaults, change in Admin)
--------------------------------------------
Daily login:     +50 daily fun (expires next calendar day)
Stake order:     daily fun first, then permanent fun
Winnings:        always permanent fun
Convert:         100 permanent fun = 1 coin
Level up:        100 coins → level +1, coins reset to 0
Referral:        BOTH users get 100 fun + 10 days voice
Starter:         100 permanent fun
Real-money shop: OFF until paymentEnabled = true


5. HOW ADMIN SETS REWARDS / PRICES
---------------------------------
Admin → Shop config (JSON merge) → paste only fields you want to change:

{
  "dailyLoginFunTokens": 50,
  "referralRewardFunTokens": 100,
  "referralRewardVoiceMs": 864000000,
  "starterFunTokens": 100,
  "paymentEnabled": false,
  "paymentMethods": [
    { "id": "esewa", "label": "eSewa", "detail": "98XXXXXXXX", "qrUrl": "" },
    { "id": "khalti", "label": "Khalti", "detail": "98XXXXXXXX", "qrUrl": "" }
  ],
  "voicePackages": [
    { "id": "v1d", "label": "1 Day Voice", "ms": 86400000, "priceNpr": 49 },
    { "id": "v7d", "label": "7 Days Voice", "ms": 604800000, "priceNpr": 149 }
  ],
  "skins": [
    { "id": "default", "label": "Classic", "priceCoins": 0, "minLevel": 1, "preview": "#c41e3a" },
    { "id": "gold", "label": "Golden", "priceCoins": 20, "minLevel": 2, "preview": "#d4a017" }
  ],
  "avatars": [
    { "id": "default", "label": "Default", "priceCoins": 0, "minLevel": 1, "emoji": "🙂" },
    { "id": "hero", "label": "Hero", "priceCoins": 15, "minLevel": 2, "emoji": "🦸" }
  ],
  "mics": [
    { "id": "mic_default", "label": "Default Mic", "priceCoins": 0, "minLevel": 1, "emoji": "🎤" },
    { "id": "mic_gold", "label": "Gold Mic", "priceCoins": 25, "minLevel": 2, "emoji": "🎙️" }
  ]
}

Click Save config.


6. SKINS / AVATARS / MIC — HOW TO “UPLOAD”
------------------------------------------
Cloudflare Free Workers do not give free large image hosting.
Use ONE of these methods:

METHOD A — Emoji / color themes (recommended start, zero upload)
  In config, set "emoji" or "preview" (CSS color).
  App shows emoji or colored pieces. No files needed.

METHOD B — Image URL (any public host)
  1. Upload PNG/WebP to:
     - Cloudflare Images / R2
     - imgur, postimages, GitHub raw, etc.
  2. Copy public HTTPS URL
  3. Put in config:
     { "id": "neon", "label": "Neon", "priceCoins": 50, "minLevel": 3, "imageUrl": "https://..." }

METHOD C — Ship files in the repo
  1. Create folder assets/skins/
  2. Add files e.g. assets/skins/gold.png
  3. After deploy URL is:
     https://YOUR-DOMAIN/assets/skins/gold.png
  4. Set imageUrl to that path in config

RECOMMENDED SIZES
  Avatar:     128 x 128 px, PNG or WebP, transparent OK, < 80 KB
  Mic icon:    64 x 64 px, PNG/WebP, < 40 KB
  Board skin: 512 x 512 px tile or full board art, < 200 KB
  Room decor: 128 x 128 px, < 80 KB

FORMATS: PNG or WebP only. Avoid huge JPG photos.
NAMES: use simple ids: gold, neon, hero, mic_gold (a-z, 0-9, _)


7. PAYMENT (REAL MONEY) FLOW
----------------------------
1. Admin sets paymentMethods + paymentEnabled: true
2. User chooses Voice package → sees wallet number/QR
3. User pays outside app → uploads proof in app
4. Admin → Proofs → Approve
5. System grants voice time automatically

If paymentEnabled is false, app shows “Coming soon”.


8. USER FEATURES (FRONTEND)
---------------------------
• Register / Login (+ optional referral from ?ref=CODE)
• Lobby: online list with voice badge, level
• Play request / Accept → auto join room
• Board: each seat mic button (if has voice)
• Text chat free
• Daily login reward
• Profile: fun (daily+permanent), coins, level, referral share link
• Shop: soft cosmetics with coins; voice real-money if enabled
• Marketplace: list item / buy with fun or coins
• Gift voice time or items
• Language: English default, switch to Nepali
• Reconnect window 60s; vote continue


9. ADMIN CHECKLIST
------------------
[ ] Set ADMIN_SECRET (random, 24+ characters; required for all protected/admin/internal routes)
[ ] Open admin.html and save secret
[ ] Set eSewa/Khalti numbers when ready
[ ] Keep paymentEnabled false until ready
[ ] Tune referral and daily rewards
[ ] Add skins via emoji or imageUrl
[ ] Approve payment proofs regularly
[ ] Ban abusers if needed


10. TROUBLESHOOTING
-------------------
Mic not working: need HTTPS + browser mic permission + voice time active
Room not joining: both must be logged in; accept creates room for both
Daily tokens 0 next day: expected (daily expires)
Cannot buy voice: paymentEnabled false → Coming soon
Wrong admin secret: 403 unauthorized


11. FILES
---------
public/index.html   Game UI
public/admin.html   Admin panel
public/_headers    Browser security / permission headers
worker.js          Server logic (Durable Objects)
wrangler.toml      Cloudflare config (assets served only from public/)
README.txt         This guide


11. SECURITY HARDENING NOTES (v4.1)
---------------------------------
This build includes a security pass while preserving the existing game features:
- Removed the hard-coded fallback admin secret. Set ADMIN_SECRET before deployment.
- Internal Durable Object routes require the shared X-Internal-Secret header.
- User passwords require 10-128 characters.
- Payment proof submission requires a valid signed-in user, enabled payments, a real package/payment method, and the exact configured amount.
- Marketplace listings require ownership of the item and bounded non-negative prices.
- Lobby play actions require the signed-in user's bearer token.
- Stake debits reject insufficient balances and refund players already charged if a later debit fails.
- Removed wildcard CORS headers; serve the game and API from the same Worker origin.
- Escaped user-controlled names and marketplace labels before inserting them into HTML.
- Protected the internal marketplace payment endpoint against direct user calls.
- Restricted room stakes to the configured allowed stake list.
- Admin inbox/proof reads use a request header instead of putting the admin secret in URL query strings.
- Admin UI renders untrusted inbox/proof content as text and keeps the admin secret in tab-scoped session storage.
- Static assets are served only from public/, avoiding accidental exposure of worker source/config files.

IMPORTANT: Set ADMIN_SECRET to a random value of at least 24 characters before deploying.
This is a static/source-level hardening pass. Complete live testing (Cloudflare deployment, two-device multiplayer, WebRTC voice, payment proof approval, and Durable Object behavior) is still required before production use.