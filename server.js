import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

// Shim Cloudflare Response(null, { status: 101, webSocket }) before importing worker.js
const OriginalResponse = globalThis.Response;
globalThis.Response = class CloudflareCompatResponse extends OriginalResponse {
  constructor(body, init) {
    if (init && init.status === 101 && init.webSocket) {
      return {
        status: 101,
        statusText: 'Switching Protocols',
        webSocket: init.webSocket,
        headers: new Headers(init.headers || {})
      };
    }
    super(body, init);
  }
};

class ShimWebSocket {
  constructor() {
    this._peer = null;
    this._attachment = null;
    this._outbox = [];
    this._realWs = null;
    this._closed = false;
    this._doWrapper = null;
  }

  serializeAttachment(val) {
    this._attachment = val === undefined ? null : structuredClone(val);
  }

  deserializeAttachment() {
    return this._attachment ? structuredClone(this._attachment) : null;
  }

  send(data) {
    if (this._closed) return;
    const peer = this._peer;
    if (!peer) return;
    if (peer._realWs && peer._realWs.readyState === 1) {
      peer._realWs.send(data);
    } else {
      peer._outbox.push(data);
    }
  }

  close(code, reason) {
    this._closed = true;
    if (this._peer?._realWs) {
      try {
        this._peer._realWs.close(code, reason);
      } catch {}
    }
  }

  _attachRealWs(realWs) {
    this._realWs = realWs;
    while (this._outbox.length > 0 && realWs.readyState === 1) {
      realWs.send(this._outbox.shift());
    }
    const serverWs = this._peer;
    const doWrapper = serverWs?._doWrapper;

    realWs.on('message', (raw, isBinary) => {
      if (!doWrapper?.instance?.webSocketMessage) return;
      const msg = isBinary ? raw : raw.toString('utf8');
      Promise.resolve(doWrapper.instance.webSocketMessage(serverWs, msg)).catch((err) => {
        console.error('WebSocket message error:', err);
      });
    });

    realWs.on('close', (code, reason) => {
      if (serverWs) {
        serverWs._closed = true;
        doWrapper?.sockets.delete(serverWs);
        if (doWrapper?.instance?.webSocketClose) {
          Promise.resolve(
            doWrapper.instance.webSocketClose(serverWs, code, reason?.toString(), true)
          ).catch((err) => {
            console.error('WebSocket close error:', err);
          });
        }
      }
    });

    realWs.on('error', (err) => {
      if (serverWs && doWrapper?.instance?.webSocketError) {
        Promise.resolve(doWrapper.instance.webSocketError(serverWs, err)).catch(() => {});
      }
    });
  }
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    const client = new ShimWebSocket();
    const server = new ShimWebSocket();
    client._peer = server;
    server._peer = client;
    return [client, server];
  }
};

class InMemoryStorage {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    if (!this.map.has(key)) return undefined;
    return structuredClone(this.map.get(key));
  }
  async put(key, val) {
    this.map.set(key, structuredClone(val));
  }
  async delete(key) {
    return this.map.delete(key);
  }
}

function createNamespace(DOClass, getEnv) {
  const instances = new Map();
  return {
    idFromName(name) {
      return String(name);
    },
    get(id) {
      const key = String(id);
      if (!instances.has(key)) {
        const sockets = new Set();
        const storage = new InMemoryStorage();
        let wrapper;
        const ctx = {
          storage,
          acceptWebSocket(ws) {
            ws._doWrapper = wrapper;
            sockets.add(ws);
          },
          getWebSockets() {
            return [...sockets].filter((s) => !s._closed);
          }
        };
        const instance = new DOClass(ctx, getEnv());
        wrapper = { instance, ctx, sockets };
        instances.set(key, wrapper);
      }
      const entry = instances.get(key);
      return {
        fetch(input, init) {
          const req = input instanceof Request ? input : new Request(input, init);
          return entry.instance.fetch(req);
        }
      };
    }
  };
}

const workerModule = await import('./worker.js');
const worker = workerModule.default;
const { UserAccount, LudoRoom, Lobby, ShopConfig } = workerModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

const adminSecret =
  typeof process.env.ADMIN_SECRET === 'string' && process.env.ADMIN_SECRET.length >= 24
    ? process.env.ADMIN_SECRET
    : crypto.randomBytes(24).toString('hex');

const env = {
  ADMIN_SECRET: adminSecret,
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      let relPath = decodeURIComponent(url.pathname);
      if (relPath === '/') relPath = '/index.html';
      const resolved = path.resolve(publicDir, '.' + relPath);
      if (!resolved.startsWith(publicDir + path.sep) && resolved !== publicDir) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        const data = await fs.readFile(resolved);
        const ext = path.extname(resolved).toLowerCase();
        const mime =
          ext === '.html'
            ? 'text/html; charset=utf-8'
            : ext === '.js'
              ? 'application/javascript; charset=utf-8'
              : ext === '.css'
                ? 'text/css; charset=utf-8'
                : ext === '.json'
                  ? 'application/json; charset=utf-8'
                  : ext === '.png'
                    ? 'image/png'
                    : ext === '.jpg' || ext === '.jpeg'
                      ? 'image/jpeg'
                      : ext === '.webp'
                        ? 'image/webp'
                        : ext === '.svg'
                          ? 'image/svg+xml'
                          : 'application/octet-stream';
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()'
          }
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
  }
};

env.USERS = createNamespace(UserAccount, () => env);
env.LUDO_ROOMS = createNamespace(LudoRoom, () => env);
env.LOBBY = createNamespace(Lobby, () => env);
env.SHOP = createNamespace(ShopConfig, () => env);

function toWebHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, String(v));
    }
  }
  return headers;
}

const app = express();
app.disable('x-powered-by');
app.use(express.raw({ type: '*/*', limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  next();
});

app.use(async (req, res, next) => {
  try {
    const host = req.headers.host || 'localhost:3000';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const fullUrl = `${proto}://${host}${req.originalUrl}`;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = hasBody && Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
    const webReq = new Request(fullUrl, {
      method: req.method,
      headers: toWebHeaders(req.headers),
      body
    });
    const webRes = await worker.fetch(webReq, env);
    res.status(webRes.status);
    webRes.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const buf = Buffer.from(await webRes.arrayBuffer());
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  try {
    const host = req.headers.host || 'localhost:3000';
    const fullUrl = `http://${host}${req.url || '/'}`;
    const webReq = new Request(fullUrl, {
      method: 'GET',
      headers: toWebHeaders(req.headers)
    });
    const webRes = await worker.fetch(webReq, env);
    if (webRes && webRes.status === 101 && webRes.webSocket) {
      const clientPairWs = webRes.webSocket;
      wss.handleUpgrade(req, socket, head, (realWs) => {
        clientPairWs._attachRealWs(realWs);
      });
    } else {
      const status = webRes?.status || 400;
      const bodyText = webRes ? await webRes.text().catch(() => '') : 'Upgrade failed';
      socket.write(
        `HTTP/1.1 ${status} Error\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${bodyText}`
      );
      socket.destroy();
    }
  } catch (err) {
    console.error('WebSocket upgrade error:', err);
    socket.destroy();
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`G Ludo server listening on http://0.0.0.0:${PORT}`);
});
