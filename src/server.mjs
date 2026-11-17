// The HTTP front end: a small HTTP/1.1 server written directly on node:net so that every reply is
// one socket write, with a whole-request response cache in front of the (synchronous, in-memory)
// handlers. Reads are pure functions of the forge state, so a cached reply stays valid until the
// next mutating request, which empties the cache.

import net from 'node:net';
import { writeSync } from 'node:fs';
import { ApiError, afterPush, errorBody, findRepo, rest } from './forge.mjs';
import { GitError, advertiseReceive, advertiseUploadV0, advertiseUploadV2, maybeGunzip, receivePack, uploadPack } from './git.mjs';
import { graphqlHttp } from './graphql.mjs';
import { mcpHttp } from './mcp.mjs';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN || '';
const MAX_HEAD = 64 * 1024;
const MAX_BODY = 512 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 20000;
const CACHE_MAX_BYTES = 96 * 1024 * 1024;
const CACHE_MAX_REQUEST = 8 * 1024;
const CACHE_MAX_RESPONSE = 1024 * 1024;

const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  411: 'Length Required',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
};

let cache = new Map();
let cacheBytes = 0;
let requestCounter = 0;

function dropCache() {
  if (cache.size > 0) {
    cache = new Map();
    cacheBytes = 0;
  }
}

function remember(key, response) {
  if (response.length > CACHE_MAX_RESPONSE) return;
  if (cache.size >= CACHE_MAX_ENTRIES || cacheBytes + response.length > CACHE_MAX_BYTES) dropCache();
  cache.set(key, response);
  cacheBytes += response.length;
}

function requestId() {
  requestCounter += 1;
  return `F0${requestCounter.toString(16).toUpperCase().padStart(6, '0')}:GITFORGE`;
}

// ---------------------------------------------------------------------------------------------
// replies
// ---------------------------------------------------------------------------------------------

function jsonReply(status, value, extra) {
  const body = value === undefined ? '' : JSON.stringify(value);
  let head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'OK'}\r\n`;
  if (body !== '') head += 'Content-Type: application/json; charset=utf-8\r\n';
  head += `Content-Length: ${Buffer.byteLength(body)}\r\nX-GitHub-Request-Id: ${requestId()}\r\n`;
  if (extra) head += extra;
  return Buffer.from(`${head}\r\n${body}`, 'utf8');
}

function bytesReply(status, type, body, extra) {
  let head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'OK'}\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\n`;
  if (extra) head += extra;
  const top = Buffer.from(`${head}\r\n`, 'latin1');
  if (body.length === 0) return top;
  return Buffer.concat([top, body], top.length + body.length);
}

function textReply(status, text) {
  return bytesReply(status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'), 'Cache-Control: no-cache\r\n');
}

const NOT_FOUND_DOC = { message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' };

// ---------------------------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------------------------

// 1 = a valid credential, 0 = none presented, -1 = a wrong one.
function authState(header) {
  if (header === undefined || header === '') return 0;
  const space = header.indexOf(' ');
  const scheme = space < 0 ? '' : header.slice(0, space).toLowerCase();
  let secret = space < 0 ? header : header.slice(space + 1).trim();
  if (scheme === 'basic') {
    const decoded = Buffer.from(secret, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const user = colon < 0 ? decoded : decoded.slice(0, colon);
    const pass = colon < 0 ? '' : decoded.slice(colon + 1);
    secret = pass === '' || pass === 'x-oauth-basic' ? user : pass;
  }
  if (secret === '') return 0;
  if (TOKEN === '' || secret === TOKEN) return 1;
  return -1;
}

function unauthorized(state) {
  return jsonReply(
    401,
    { message: state === 0 ? 'Requires authentication' : 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' },
    'WWW-Authenticate: Bearer realm="gitforge"\r\n',
  );
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

function parseJsonBody(body) {
  if (body === null || body.length === 0) return undefined;
  const text = body.toString('utf8');
  if (text.trim() === '') return undefined;
  return JSON.parse(text);
}

function handleRest(req, path, rawQuery) {
  const state = authState(req.headers.authorization);
  if (state !== 1) return unauthorized(state);
  const tail = path.length > 7 ? path.slice(8) : '';
  const segs = [];
  if (tail !== '') {
    for (const part of tail.split('/')) {
      if (part === '') continue;
      if (part.indexOf('%') < 0) segs.push(part);
      else {
        try {
          segs.push(decodeURIComponent(part));
        } catch {
          return jsonReply(404, NOT_FOUND_DOC);
        }
      }
    }
  }
  let body;
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = parseJsonBody(req.body);
    } catch {
      return jsonReply(400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/rest', status: '400' });
    }
  }
  const B = req.headers.host ? `http://${req.headers.host}` : 'http://localhost';
  try {
    const out = rest(method === 'HEAD' ? 'GET' : method, segs, rawQuery, body, B, path);
    let extra = '';
    if (out.link !== null) extra += `Link: ${out.link}\r\n`;
    if (segs.length === 0 || segs[0] === 'user') extra += 'X-OAuth-Scopes: repo, read:org, workflow\r\nX-Accepted-OAuth-Scopes: repo\r\nX-GitHub-Media-Type: github.v3; format=json\r\n';
    return jsonReply(out.status, out.json, extra);
  } catch (err) {
    if (err instanceof ApiError) return jsonReply(err.status, errorBody(err));
    throw err;
  }
}

const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function handleGit(req, match, rawQuery) {
  const repo = findRepo(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
  const action = match[3];
  if (repo === null) return textReply(404, 'Repository not found.\n');
  const noCache = 'Cache-Control: no-cache, max-age=0, must-revalidate\r\n';
  if (action === 'info/refs') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return textReply(405, 'Method Not Allowed\n');
    const service = /(?:^|&)service=([^&]*)/.exec(rawQuery);
    const name = service === null ? '' : service[1];
    if (name === 'git-upload-pack') {
      const proto = req.headers['git-protocol'] || '';
      const body = proto.includes('version=2') ? advertiseUploadV2() : advertiseUploadV0(repo.git);
      return bytesReply(200, 'application/x-git-upload-pack-advertisement', body, noCache);
    }
    if (name === 'git-receive-pack') {
      return bytesReply(200, 'application/x-git-receive-pack-advertisement', advertiseReceive(repo.git), noCache);
    }
    return textReply(403, 'Please upgrade your git client: only the smart HTTP protocol is served.\n');
  }
  if (req.method !== 'POST') return textReply(405, 'Method Not Allowed\n');
  let body = req.body === null ? Buffer.alloc(0) : req.body;
  try {
    body = maybeGunzip(body, req.headers['content-encoding']);
    if (action === 'git-upload-pack') {
      const proto = req.headers['git-protocol'] || '';
      const out = uploadPack(repo.git, body, proto.includes('version=2'));
      return bytesReply(200, 'application/x-git-upload-pack-result', out, noCache);
    }
    const result = receivePack(repo.git, body);
    afterPush(repo, result.changed);
    return bytesReply(200, 'application/x-git-receive-pack-result', result.response, noCache);
  } catch (err) {
    if (err instanceof GitError) return textReply(err.status, `${err.message}\n`);
    return textReply(400, 'malformed git request\n');
  }
}

// Answers one parsed request with a complete response buffer. `cacheable` is set on the request when
// the reply may be stored against the request's raw bytes.
function handle(req) {
  const url = req.url;
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const rawQuery = q < 0 ? '' : url.slice(q + 1);
  const method = req.method;

  if (path.startsWith('/api/v3') && (path.length === 7 || path.charCodeAt(7) === 47)) {
    if (method === 'GET') req.cacheable = true;
    return handleRest(req, path, rawQuery);
  }
  if (path === '/healthz') {
    req.cacheable = method === 'GET';
    return jsonReply(200, { ok: true });
  }
  if (path === '/api/graphql' || path === '/graphql' || path === '/api/v3/graphql') {
    if (method !== 'POST') return jsonReply(method === 'GET' ? 405 : 404, { message: method === 'GET' ? 'Method Not Allowed' : 'Not Found' });
    const state = authState(req.headers.authorization);
    if (state !== 1) return unauthorized(state);
    const B = req.headers.host ? `http://${req.headers.host}` : 'http://localhost';
    const out = graphqlHttp(req.body, B);
    return jsonReply(out.status, out.json);
  }
  if (path === '/mcp' || path === '/mcp/') {
    const state = authState(req.headers.authorization);
    if (state !== 1) return unauthorized(state);
    const B = req.headers.host ? `http://${req.headers.host}` : 'http://localhost';
    const out = mcpHttp(method, req.headers, req.body, B);
    return jsonReply(out.status, out.json, out.extra);
  }
  const git = GIT_PATH.exec(path);
  if (git !== null) {
    if (method === 'GET' || (method === 'POST' && git[3] === 'git-upload-pack')) req.cacheable = true;
    return handleGit(req, git, rawQuery);
  }
  if (method === 'GET') req.cacheable = true;
  return jsonReply(404, NOT_FOUND_DOC);
}

// ---------------------------------------------------------------------------------------------
// HTTP/1.1 framing
// ---------------------------------------------------------------------------------------------

const CRLF2 = Buffer.from('\r\n\r\n', 'latin1');
const CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');

function parseHead(head) {
  const lineEnd = head.indexOf('\r\n');
  const first = lineEnd < 0 ? head : head.slice(0, lineEnd);
  const sp1 = first.indexOf(' ');
  const sp2 = first.lastIndexOf(' ');
  if (sp1 <= 0 || sp2 <= sp1) return null;
  const headers = {};
  let pos = lineEnd < 0 ? head.length : lineEnd + 2;
  while (pos < head.length) {
    let end = head.indexOf('\r\n', pos);
    if (end < 0) end = head.length;
    const colon = head.indexOf(':', pos);
    if (colon > pos && colon < end) {
      const name = head.slice(pos, colon).toLowerCase();
      let from = colon + 1;
      while (from < end && head.charCodeAt(from) === 32) from += 1;
      headers[name] = head.slice(from, end);
    }
    pos = end + 2;
  }
  return { method: first.slice(0, sp1), url: first.slice(sp1 + 1, sp2), version: first.slice(sp2 + 1), headers, body: null, cacheable: false };
}

// Decodes a chunked body starting at `from`. Returns { body, next } or null when incomplete.
function readChunked(data, from) {
  const parts = [];
  let pos = from;
  for (;;) {
    const lineEnd = data.indexOf('\r\n', pos, 'latin1');
    if (lineEnd < 0) return null;
    const sizeText = data.toString('latin1', pos, lineEnd);
    const semi = sizeText.indexOf(';');
    const size = parseInt(semi < 0 ? sizeText : sizeText.slice(0, semi), 16);
    if (!Number.isFinite(size) || size < 0) return { body: null, next: data.length };
    pos = lineEnd + 2;
    if (size === 0) {
      // trailers end with an empty line
      for (;;) {
        const end = data.indexOf('\r\n', pos, 'latin1');
        if (end < 0) return null;
        if (end === pos) return { body: Buffer.concat(parts), next: end + 2 };
        pos = end + 2;
      }
    }
    if (pos + size + 2 > data.length) return null;
    parts.push(data.subarray(pos, pos + size));
    pos += size + 2;
  }
}

function serverError() {
  return jsonReply(500, { message: 'Server Error' });
}

// Writes a reply. A connection in fast mode (its fd is known and nothing is queued on the stream)
// gets one write(2) straight from here; anything the kernel will not take goes through the stream.
function send(socket, payload, closing) {
  let rest = payload;
  if (socket.fgFd >= 0 && socket.writableLength === 0) {
    let written = 0;
    try {
      written = writeSync(socket.fgFd, payload);
    } catch (err) {
      if (err.code !== 'EAGAIN') {
        socket.destroy();
        return;
      }
    }
    if (written >= payload.length) {
      if (closing) socket.end();
      return;
    }
    rest = payload.subarray(written);
  }
  if (closing) socket.end(rest);
  else socket.write(rest);
}

// Feeds received bytes through the request parser. `borrowed` says `chunk` is a view of the shared
// read buffer, which the next read overwrites: whatever must outlive this call is copied.
function onData(socket, chunk, borrowed) {
  let owned = !borrowed;
  let data = chunk;
  if (socket.fgBuf !== null) {
    data = Buffer.concat([socket.fgBuf, chunk]);
    owned = true;
  }
  socket.fgBuf = null;
  let out = null;
  let outList = null;
  let closing = false;
  while (data.length > 0) {
    const headEnd = data.indexOf(CRLF2);
    if (headEnd < 0) {
      if (data.length > MAX_HEAD) {
        socket.end(jsonReply(431, { message: 'Request header fields too large' }));
        return;
      }
      break;
    }
    const head = data.latin1Slice(0, headEnd);
    let response = cache.get(head);
    let consumed = headEnd + 4;
    if (response === undefined) {
      const req = parseHead(head);
      if (req === null) {
        socket.end(jsonReply(400, { message: 'Bad Request' }));
        return;
      }
      const headers = req.headers;
      let key = head;
      const lengthText = headers['content-length'];
      if (lengthText !== undefined) {
        const length = Number(lengthText);
        if (!Number.isInteger(length) || length < 0 || length > MAX_BODY) {
          socket.end(jsonReply(400, { message: 'Bad Request' }));
          return;
        }
        if (length > 0) {
          if (data.length < consumed + length) {
            if (headers.expect !== undefined && !socket.fgCont) {
              socket.fgCont = true;
              socket.write(CONTINUE);
            }
            break;
          }
          req.body = data.subarray(consumed, consumed + length);
          consumed += length;
          if (req.method === 'POST' && consumed <= CACHE_MAX_REQUEST) {
            key = data.latin1Slice(0, consumed);
            response = cache.get(key);
          } else key = null;
        }
      } else if (headers['transfer-encoding'] !== undefined && headers['transfer-encoding'].toLowerCase().includes('chunked')) {
        const decoded = readChunked(data, consumed);
        if (decoded === null) {
          if (headers.expect !== undefined && !socket.fgCont) {
            socket.fgCont = true;
            socket.write(CONTINUE);
          }
          break;
        }
        if (decoded.body === null) {
          socket.end(jsonReply(400, { message: 'Bad Request' }));
          return;
        }
        req.body = decoded.body;
        consumed = decoded.next;
        key = null;
      }
      socket.fgCont = false;
      if (response === undefined) {
        try {
          response = handle(req);
        } catch (err) {
          response = serverError();
        }
        if (req.cacheable) {
          if (key !== null && consumed <= CACHE_MAX_REQUEST) remember(key, response);
        } else {
          dropCache();
        }
        if (req.method === 'HEAD') {
          const cut = response.indexOf(CRLF2);
          if (cut >= 0) response = response.subarray(0, cut + 4);
        }
      }
      const connection = headers.connection;
      if ((connection !== undefined && connection.toLowerCase() === 'close') || (req.version === 'HTTP/1.0' && connection === undefined)) closing = true;
    }
    if (out === null) out = response;
    else {
      if (outList === null) outList = [out];
      outList.push(response);
    }
    data = consumed >= data.length ? Buffer.alloc(0) : data.subarray(consumed);
    if (closing) break;
  }
  if (data.length > 0 && !closing) socket.fgBuf = owned ? data : Buffer.from(data);
  if (out !== null) send(socket, outList === null ? out : Buffer.concat(outList), closing);
}

function feed(socket, chunk, borrowed) {
  try {
    onData(socket, chunk, borrowed);
  } catch {
    try {
      socket.end(serverError());
    } catch {
      socket.destroy();
    }
  }
}

// One read buffer for every fast-mode connection. A read is parsed (and anything kept is copied)
// before the next one lands, so the bytes never need a buffer of their own.
const READ_BUFFER = Buffer.allocUnsafeSlow(64 * 1024);
const FAST_IO = process.env.FORGE_FAST_IO !== '0';

// Re-wraps an accepted connection so that reads land in READ_BUFFER (net's `onread` option, which a
// server's own sockets cannot ask for) and replies can be written on the fd directly. On a sandboxed
// kernel the buffer net allocates for every read, and the stream machinery around every write, cost
// more than the request itself. Returns null when the handle cannot be taken over.
function fastSocket(accepted) {
  const tcp = accepted._handle;
  if (tcp === null || tcp === undefined || typeof tcp.fd !== 'number' || tcp.fd < 0) return null;
  const fd = tcp.fd;
  accepted._handle = null;
  const socket = new net.Socket({
    handle: tcp,
    onread: {
      buffer: READ_BUFFER,
      callback(size, buffer) {
        feed(socket, size === buffer.length ? buffer : buffer.subarray(0, size), true);
        return true;
      },
    },
  });
  socket.fgFd = fd;
  socket.on('close', () => {
    socket.fgFd = -1;
  });
  return socket;
}

export function createApp() {
  const server = net.createServer({ noDelay: true, pauseOnConnect: FAST_IO }, (accepted) => {
    let socket = null;
    if (FAST_IO) {
      try {
        socket = fastSocket(accepted);
      } catch {
        socket = null;
      }
    }
    const fast = socket !== null;
    if (!fast) {
      socket = accepted;
      socket.fgFd = -1;
    }
    socket.fgBuf = null;
    socket.fgCont = false;
    socket.on('error', () => socket.destroy());
    if (fast) {
      socket.setNoDelay(true);
      socket.resume();
    } else {
      socket.on('data', (chunk) => feed(socket, chunk, false));
      if (FAST_IO) socket.resume();
    }
  });
  server.on('error', () => undefined);
  return server;
}
