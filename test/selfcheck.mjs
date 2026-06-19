// 最小自测（无框架）：node test/selfcheck.mjs
// 覆盖三处新逻辑：直播回放链接识别、并发上限执行器、按真实大小选 variant。
import assert from 'node:assert/strict';
import { extractBroadcastUrls, runWithLimit, selectVideoVariant } from '../src/index.js';

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
}

// 3) selectVideoVariant：用 mock HEAD 返回真实大小，按画质选对档位
{
  const sizes = {
    'http://v/high.mp4': 100 * 1024 * 1024,
    'http://v/mid.mp4': 30 * 1024 * 1024,
    'http://v/low.mp4': 5 * 1024 * 1024,
  };
  const realFetch = globalThis.fetch;
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

    // 限制 1MB：全部超限，应报最小真实大小(5MB)
    const tooBig = await selectVideoVariant(video, 'high', 1 * 1024 * 1024);
    assert.equal(tooBig.reason, 'all_too_large', '应判定全部超限');
    assert.equal(tooBig.minEstimatedSize, sizes['http://v/low.mp4'], '应报最小真实大小');
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('✅ selfcheck passed');
