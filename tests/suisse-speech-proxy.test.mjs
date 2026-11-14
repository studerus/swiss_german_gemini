import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createHTTPServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile } from 'vite';

for (const service of ['tts', 'stt']) test(`Vite forwards the ${service} WebSocket upgrade, rewrites the path and authenticates on the server`, { timeout: 15000 }, async () => {
  const previousKey = process.env.SUISSE_SPEECH_API_KEY;
  process.env.SUISSE_SPEECH_API_KEY = 'offline-test-key';
  const upstream = createHTTPServer();
  let upstreamSocket;
  let request;
  let vite;
  let client;
  upstream.on('upgrade', (req, socket) => {
    request = { url: req.url, key: req.headers['x-api-key'] };
    upstreamSocket = socket;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  try {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, fileURLToPath(new URL('../vite.config.ts', import.meta.url)));
    assert(loaded);
    const path = `/api/suisse-speech/${service}/stream`;
    const proxy = loaded.config.server.proxy[path];
    assert.equal(proxy.target, 'https://api.suisse-speech.ch');
    assert.equal(proxy.ws, true);
    assert.equal(proxy.secure, true);
    assert.equal(loaded.config.preview.proxy[path].headers['X-API-Key'], 'offline-test-key');
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    vite = await createServer({
      ...loaded.config, configFile: false, mode: 'test', logLevel: 'silent',
      server: {
        ...loaded.config.server, host: '127.0.0.1', port: 0, open: false, hmr: false,
        proxy: { [path]: { ...proxy, target: `http://127.0.0.1:${upstream.address().port}` } }
      }
    });
    await vite.listen();
    await new Promise((resolve, reject) => {
      const upgrade = httpRequest({
        hostname: '127.0.0.1', port: vite.httpServer.address().port, path,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }
      });
      upgrade.on('upgrade', (_response, socket) => { client = socket; resolve(); });
      upgrade.on('response', response => reject(new Error(`Local WebSocket proxy returned HTTP ${response.statusCode}`)));
      upgrade.on('error', reject);
      upgrade.end();
    });
    assert.deepEqual(request, { url: `/v1/${service}/stream`, key: 'offline-test-key' });
  } finally {
    client?.destroy();
    upstreamSocket?.destroy();
    await vite?.close();
    await new Promise(resolve => upstream.close(resolve));
    if (previousKey === undefined) delete process.env.SUISSE_SPEECH_API_KEY;
    else process.env.SUISSE_SPEECH_API_KEY = previousKey;
  }
});
