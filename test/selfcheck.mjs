// 最小自测（无框架）：node test/selfcheck.mjs
// 覆盖链接识别、并发限制、画质选择、内存/磁盘上传、流式落盘和 API 上限判断。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProgressReporter,
  downloadFileToDisk,
  extractBroadcastUrls,
  getMaxVideoSize,
  requestRemoteNative,
  runWithLimit,
  selectVideoVariant,
  uploadMultipart,
  sendPhoto
} from '../src/index.js';
import { Semaphore } from '../src/limiter.js';

// 1) extractBroadcastUrls：命中 broadcasts，不误匹配普通 status
{
  const text = '看这个 https://x.com/i/broadcasts/1mxPaaPbwyZKN 还有 https://x.com/user/status/123';
  const got = extractBroadcastUrls(text);
  assert.deepEqual(got, ['https://x.com/i/broadcasts/1mxPaaPbwyZKN'], 'broadcast 链接识别错误');
  assert.equal(extractBroadcastUrls('https://x.com/user/status/123').length, 0, 'status 不应被当作 broadcast');
}

// 2) runWithLimit：并发不超上限，且全部跑完
{
  let active = 0, peak = 0, done = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await runWithLimit(items, 3, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 10));
    active--; done++;
  });
  assert.equal(done, 10, '未全部执行');
  assert.ok(peak <= 3, `并发峰值 ${peak} 超过上限 3`);
  assert.ok(peak >= 2, `并发未生效（峰值仅 ${peak}）`);

  // 非法/零并发也应安全退化为 1，而不是完全不执行。
  let fallbackDone = 0;
  await runWithLimit([1, 2], 0, async () => { fallbackDone++; });
  assert.equal(fallbackDone, 2, '非法并发值不应跳过任务');
}

// 3) selectVideoVariant：用 mock HEAD 返回真实大小，按画质选对档位
{
  const sizes = {
    'http://v/high.mp4': 100 * 1024 * 1024,
    'http://v/mid.mp4': 30 * 1024 * 1024,
    'http://v/low.mp4': 5 * 1024 * 1024,
  };
  const realFetch = globalThis.fetch;
  const previousPrivateDownloads = process.env.ALLOW_PRIVATE_DOWNLOADS;
  process.env.ALLOW_PRIVATE_DOWNLOADS = 'true';
  globalThis.fetch = async (url, opts) => {
    assert.equal(opts?.method, 'HEAD', 'selectVideoVariant 应发 HEAD');
    return { ok: true, headers: { get: (k) => (k === 'Content-Length' ? String(sizes[url]) : null) } };
  };
  try {
    const video = {
      duration: '60秒',
      variants: [
        { url: 'http://v/high.mp4', bitrate: 5_000_000, content_type: 'video/mp4' },
        { url: 'http://v/mid.mp4', bitrate: 2_000_000, content_type: 'video/mp4' },
        { url: 'http://v/low.mp4', bitrate: 500_000, content_type: 'video/mp4' },
      ],
    };
    const big = 2 * 1024 * 1024 * 1024; // 2GB，全都放得下

    const hi = await selectVideoVariant(video, 'high', big);
    assert.equal(hi.url, 'http://v/high.mp4', 'high 应选最高码率');
    assert.equal(hi.sizeAccurate, true, '应标记为真实大小');
    assert.equal(hi.estimatedSize, sizes['http://v/high.mp4'], '应使用 HEAD 真实大小');

    const lo = await selectVideoVariant(video, 'low', big);
    assert.equal(lo.url, 'http://v/low.mp4', 'low 应选最低码率');

    const md = await selectVideoVariant(video, 'medium', big);
    assert.equal(md.url, 'http://v/mid.mp4', 'medium 应选中档');

    // high 但限制 50MB：高档(100M)放不下，应降到能放下的中档(30M)
    const capped = await selectVideoVariant(video, 'high', 50 * 1024 * 1024);
    assert.equal(capped.url, 'http://v/mid.mp4', 'high 超限时应降到能放下的最高档');
    assert.deepEqual(capped.fallbacks, ['http://v/low.mp4'], '回退列表不应重新包含已知超限的高档');

    // 限制 1MB：全部超限，应报最小真实大小(5MB)
    const tooBig = await selectVideoVariant(video, 'high', 1 * 1024 * 1024);
    assert.equal(tooBig.reason, 'all_too_large', '应判定全部超限');
    assert.equal(tooBig.minEstimatedSize, sizes['http://v/low.mp4'], '应报最小真实大小');
  } finally {
    globalThis.fetch = realFetch;
    if (previousPrivateDownloads === undefined) delete process.env.ALLOW_PRIVATE_DOWNLOADS;
    else process.env.ALLOW_PRIVATE_DOWNLOADS = previousPrivateDownloads;
  }
}

// 4) uploadMultipart：本地 http 服务器验证 Content-Length 正确、multipart 完整、进度单调到 total
{
  const progresses = [];
  const fileData = new TextEncoder().encode('HELLODATA'.repeat(20000)); // ~180KB，跨多个块
  const server = createServer();
  const result = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const cl = parseInt(req.headers['content-length'] || '0');
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        resolve({ cl, received: body.length, body: body.toString('latin1') });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        const res = await uploadMultipart(
          `http://127.0.0.1:${port}/`,
          { chat_id: '123', caption: 'hi', skip: '' },
          { field: 'document', filename: 't.bin', contentType: 'application/octet-stream', data: fileData },
          (sent, total) => progresses.push([sent, total])
        );
        assert.equal(JSON.parse(res.body).ok, true, 'uploadMultipart 应解析到 ok');
      } catch (e) { reject(e); }
    });
  });
  server.close();
  assert.equal(result.cl, result.received, 'Content-Length 应等于实际收到字节数');
  assert.ok(result.body.includes('filename="t.bin"'), 'multipart 应含文件名');
  assert.ok(result.body.includes('HELLODATA'), 'multipart 应含文件数据');
  assert.ok(!result.body.includes('name="skip"'), '空字段应被跳过');
  assert.ok(progresses.length > 0, '应有上传进度回调');
  const lastP = progresses[progresses.length - 1];
  assert.equal(lastP[0], lastP[1], '最终进度应等于 total');
  for (let k = 1; k < progresses.length; k++) {
    assert.ok(progresses[k][0] >= progresses[k - 1][0], '进度应单调不减');
  }
}

// 5) uploadMultipart：支持直接从磁盘流式上传
{
  const dir = await mkdtemp(join(tmpdir(), 'xbot-upload-'));
  const filePath = join(dir, 'disk.bin');
  const fileData = Buffer.from('DISKDATA'.repeat(100000));
  await writeFile(filePath, fileData);
  const server = createServer();

  try {
    const received = await new Promise((resolve, reject) => {
      server.on('request', (req, res) => {
        let bytes = 0;
        req.on('data', chunk => { bytes += chunk.length; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          resolve({ bytes, declared: Number(req.headers['content-length']) });
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', async () => {
        try {
          const port = server.address().port;
          await uploadMultipart(
            `http://127.0.0.1:${port}/`,
            { chat_id: '123' },
            { field: 'document', filename: 'disk.bin', contentType: 'application/octet-stream', path: filePath }
          );
        } catch (error) { reject(error); }
      });
    });
    assert.equal(received.bytes, received.declared, '磁盘上传长度应与 Content-Length 一致');
    assert.ok(received.bytes > fileData.length, 'multipart 应包含文件以外的边界和字段');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

// 6) downloadFileToDisk：流式落盘、拦截私网，并在超限时删除残留文件
{
  const dir = await mkdtemp(join(tmpdir(), 'xbot-download-'));
  const output = join(dir, 'video.bin');
  const oversized = join(dir, 'oversized.bin');
  const payload = Buffer.from('STREAM'.repeat(50000));
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': payload.length
    });
    res.end(payload);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const previousPrivateDownloads = process.env.ALLOW_PRIVATE_DOWNLOADS;

  try {
    const url = `http://127.0.0.1:${server.address().port}/video`;
    delete process.env.ALLOW_PRIVATE_DOWNLOADS;
    await assert.rejects(
      downloadFileToDisk(url, output, payload.length + 1),
      /UNSAFE_URL/,
      '默认应阻止访问本机或私网地址'
    );

    process.env.ALLOW_PRIVATE_DOWNLOADS = 'true';
    const result = await downloadFileToDisk(url, output, payload.length + 1);
    assert.equal(result.size, payload.length, '落盘大小错误');
    assert.deepEqual(await readFile(output), payload, '落盘内容错误');

    await assert.rejects(
      downloadFileToDisk(url, oversized, payload.length - 1),
      /SIZE_EXCEEDED/,
      '超过限制时应拒绝下载'
    );
    await assert.rejects(stat(oversized), /ENOENT/, '超限文件不应残留在磁盘');

    // 原生安全请求适配器必须支持 HEAD/GET、Web ReadableStream 和自定义 socket lookup。
    const publicTestUrl = `http://public.test:${server.address().port}/video`;
    const localTestLookup = (_hostname, options, callback) => {
      if (options?.all) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
      callback(null, '127.0.0.1', 4);
    };
    const nativeResponse = await requestRemoteNative(publicTestUrl, {}, localTestLookup);
    assert.equal(nativeResponse.ok, true);
    assert.equal(nativeResponse.headers.get('content-length'), String(payload.length));
    const reader = nativeResponse.body.getReader();
    let nativeBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      nativeBytes += value.length;
    }
    assert.equal(nativeBytes, payload.length, '原生安全请求必须完整流式读取响应');
  } finally {
    if (previousPrivateDownloads === undefined) delete process.env.ALLOW_PRIVATE_DOWNLOADS;
    else process.env.ALLOW_PRIVATE_DOWNLOADS = previousPrivateDownloads;
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

// 7) 官方 API 按 50MB；local-api profile 自动切换到本地 API 的 2GB
{
  const previous = process.env.TELEGRAM_API_URL;
  const previousProfiles = process.env.COMPOSE_PROFILES;
  try {
    delete process.env.TELEGRAM_API_URL;
    delete process.env.COMPOSE_PROFILES;
    assert.equal(getMaxVideoSize(), 50 * 1024 * 1024);

    process.env.COMPOSE_PROFILES = 'local-api';
    assert.equal(getMaxVideoSize(), 2 * 1024 * 1024 * 1024);

    process.env.TELEGRAM_API_URL = '';
    assert.equal(getMaxVideoSize(), 2 * 1024 * 1024 * 1024, '空 URL 应跟随 local-api profile');

    process.env.TELEGRAM_API_URL = 'https://api.telegram.org/';
    assert.equal(getMaxVideoSize(), 50 * 1024 * 1024);
    process.env.TELEGRAM_API_URL = 'http://api:8081';
    assert.equal(getMaxVideoSize(), 2 * 1024 * 1024 * 1024);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_API_URL;
    else process.env.TELEGRAM_API_URL = previous;
    if (previousProfiles === undefined) delete process.env.COMPOSE_PROFILES;
    else process.env.COMPOSE_PROFILES = previousProfiles;
  }
}

// 8) 上传完成事件不能被节流，并能持续显示 Telegram 处理等待状态
{
  const messages = [];
  const report = createProgressReporter('上传视频', '📤', text => messages.push(text), 60000);
  report(1, 100);
  report(50, 100); // 应被 60 秒节流
  report(100, 100, { phase: 'processing', elapsedSeconds: 0 });
  report(100, 100, { phase: 'processing', elapsedSeconds: 5 });

  assert.equal(messages.length, 3, '完成和等待事件不应被普通进度节流');
  assert.match(messages[1], /100%.*Telegram 处理中/, '完成传输后应显示 Telegram 处理阶段');
  assert.match(messages[2], /已等待 5 秒/, '等待阶段应显示已等待时间');
}

// 9) 全局信号量：跨任务共享并发上限
{
  const limiter = new Semaphore(2);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 8 }, (_, i) => limiter.run(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5 + i));
    active--;
  })));
  assert.equal(peak, 2, '全局信号量应严格限制并发');
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0, limit: 2 });
}

// 10) sendPhoto：下载模式下远程发送失败必须返回 false，不能被文字回退伪装成成功
{
  const previousToken = process.env.BOT_TOKEN;
  const realFetch = globalThis.fetch;
  process.env.BOT_TOKEN = '123:test';
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, description: 'remote photo rejected' })
    });
    assert.equal(await sendPhoto(1, 'https://example.com/a.jpg', 'caption', 2, false), false);

    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1
        ? { ok: true, status: 200, json: async () => ({ ok: false, description: 'rejected' }) }
        : { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 42 } }) };
    };
    assert.equal(await sendPhoto(1, 'https://example.com/a.jpg', 'caption'), true);
    assert.equal(calls, 2, '链接模式仍应在图片失败后回退到文字');
  } finally {
    globalThis.fetch = realFetch;
    if (previousToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = previousToken;
  }
}

// 11) SQLite update 队列：update_id 幂等、持久化并由 worker 完成
{
  const dir = await mkdtemp(join(tmpdir(), 'xbot-jobs-'));
  const previousDb = process.env.JOB_DB_FILE;
  process.env.JOB_DB_FILE = join(dir, 'jobs.sqlite');
  let queue = await import(`../src/job-queue.js?test=${Date.now()}`);
  let reopened;
  try {
    const first = { update_id: 100, message: { chat: { id: 1 }, text: '/start' } };
    const second = { update_id: 101, message: { chat: { id: 1 }, text: '/mode' } };
    assert.equal(queue.enqueueTelegramUpdate(first).inserted, true);
    assert.equal(queue.enqueueTelegramUpdate(first).inserted, false);
    assert.equal(queue.enqueueTelegramUpdate(second).inserted, true);
    await queue.closeJobQueue();
    queue = null;

    reopened = await import(`../src/job-queue.js?reopen=${Date.now()}`);
    assert.equal(reopened.getJobQueueStats().pending, 2, '重启后应保留未处理任务');
    const processed = [];
    let sameChatActive = false;
    reopened.startUpdateWorkers(async update => {
      assert.equal(sameChatActive, false, '同一 chat 的 update 不应并行');
      sameChatActive = true;
      processed.push(update.update_id);
      await new Promise(resolve => setTimeout(resolve, 30));
      sameChatActive = false;
    }, 2);
    const deadline = Date.now() + 3000;
    while (reopened.getJobQueueStats().completed !== 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(processed, [100, 101]);
    assert.equal(reopened.getJobQueueStats().completed, 2);
  } finally {
    if (reopened) await reopened.closeJobQueue();
    else if (queue) await queue.closeJobQueue();
    await rm(dir, { recursive: true, force: true });
    if (previousDb === undefined) delete process.env.JOB_DB_FILE;
    else process.env.JOB_DB_FILE = previousDb;
  }
}

// 12) 下载目录维护：删除超过保留时间的文件
{
  const dir = await mkdtemp(join(tmpdir(), 'xbot-storage-'));
  const oldFile = join(dir, 'old.mp4');
  const newFile = join(dir, 'new.mp4');
  await writeFile(oldFile, 'old');
  await writeFile(newFile, 'new');
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(oldFile, oldTime, oldTime);
  const storage = await import(`../src/storage.js?test=${Date.now()}`);
  try {
    assert.equal(await storage.cleanupExpiredDownloads(dir), 1);
    await assert.rejects(stat(oldFile), /ENOENT/);
    assert.equal((await stat(newFile)).isFile(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 13) 访问控制：chat 白名单、幂等计数、频率限制和链接数量限制
{
  const previous = {
    allowed: process.env.ALLOWED_CHAT_IDS,
    requests: process.env.MAX_REQUESTS_PER_MINUTE,
    links: process.env.MAX_LINKS_PER_MESSAGE
  };
  process.env.ALLOWED_CHAT_IDS = '1,2';
  process.env.MAX_REQUESTS_PER_MINUTE = '2';
  process.env.MAX_LINKS_PER_MESSAGE = '2';
  const access = await import(`../src/access.js?test=${Date.now()}`);
  try {
    assert.equal(access.checkChatAccess(3, 1).reason, 'not_allowed');
    assert.equal(access.checkChatAccess(1, 10).allowed, true);
    assert.equal(access.checkChatAccess(1, 10).allowed, true, '同一 update 重试不应重复计数');
    assert.equal(access.checkChatAccess(1, 11).allowed, true);
    assert.equal(access.checkChatAccess(1, 12).reason, 'rate_limited');
    assert.deepEqual(access.capLinks(['a', 'b', 'c']), { urls: ['a', 'b'], dropped: 1, limit: 2 });
  } finally {
    if (previous.allowed === undefined) delete process.env.ALLOWED_CHAT_IDS;
    else process.env.ALLOWED_CHAT_IDS = previous.allowed;
    if (previous.requests === undefined) delete process.env.MAX_REQUESTS_PER_MINUTE;
    else process.env.MAX_REQUESTS_PER_MINUTE = previous.requests;
    if (previous.links === undefined) delete process.env.MAX_LINKS_PER_MESSAGE;
    else process.env.MAX_LINKS_PER_MESSAGE = previous.links;
  }
}

console.log('✅ selfcheck passed');
