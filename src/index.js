// X Downloader Bot for Telegram — Docker 部署版
// 使用 fxtwitter 和 vxtwitter API 提取视频和图片

import { writeFile, readFile, mkdir, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { getUserMode, setUserMode, getUserQuality, setUserQuality } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || join(__dirname, '..', 'downloads');
const CLEANUP_VIDEOS = process.env.CLEANUP_VIDEOS !== 'false';  // 默认 true

// 版本号（从 package.json 读取一次，用于 /start 展示）
const VERSION = (() => {
  try { return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version; }
  catch { return 'unknown'; }
})();

// ==================== 工具函数 ====================

function getBotToken() {
  return process.env.BOT_TOKEN || '';
}

function getTelegramApiUrl() {
  return process.env.TELEGRAM_API_URL || 'https://api.telegram.org';
}

function getMaxVideoSize() {
  // 本地 Bot API 支持 2GB，云端仅 50MB
  return process.env.TELEGRAM_API_URL ? 2 * 1024 * 1024 * 1024 : 50 * 1024 * 1024;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ==================== 状态页 ====================

export async function getStatusHtml() {
  const token = getBotToken();
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>X 媒体机器人</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
    .btn { background: #0088cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; }
    .btn:hover { background: #006699; }
  </style>
</head>
<body>
  <h1>🤖 X 媒体机器人</h1>
  <p>机器人运行中！</p>
  <p>时间: ${time}</p>
  <p>BOT_TOKEN 配置状态: ${token ? '已配置' : '未配置'}</p>
  <h2>🔧 设置</h2>
  ${token ? `
    <p><a href="/setup-webhook" class="btn">🚀 设置 Webhook</a></p>
  ` : `
    <p>请在 .env 文件中配置 BOT_TOKEN</p>
  `}
</body>
</html>`;
}

// ==================== Webhook 处理 ====================

export async function handleTelegramWebhook(update) {
  try {
    console.log('Received update:', JSON.stringify(update));

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const messageText = update.message.text;
      const replyToMessageId = update.message.message_id;

      console.log(`Message from ${chatId}: ${messageText}`);

      // 处理 /start 命令
      if (messageText === '/start') {
        await sendMessage(chatId,
          '🤖 X Downloader Bot\n\n' +
          '直接发送 Twitter/X 链接，我帮你下载最高清视频！\n\n' +
          '📋 使用方法：\n' +
          '1️⃣ 复制 Twitter/X 推文链接\n' +
          '2️⃣ 粘贴发给我\n' +
          '3️⃣ 等待下载上传，接收视频文件\n\n' +
          '🔗 支持格式：\n' +
          '• x.com/用户/status/推文ID\n' +
          '• twitter.com/用户/status/推文ID\n' +
          '• x.com/i/broadcasts/ID（直播回放）\n\n' +
          '⚙️ 命令：\n' +
          '/mode — 切换下载/链接模式\n' +
          '/quality — 调整视频画质（高/中/低）\n\n' +
          '💡 默认：📥下载模式 + 🎯最高清\n' +
          `🏷️ 版本：v${VERSION}`
        );
        return;
      }

      // 处理 /mode 命令
      if (messageText.startsWith('/mode')) {
        await handleModeCommand(chatId, messageText);
        return;
      }

      // 处理 /quality 命令
      if (messageText.startsWith('/quality')) {
        await handleQualityCommand(chatId, messageText);
        return;
      }

      // 检查是否包含直播回放链接（x.com/i/broadcasts/ID）— 需 yt-dlp/ffmpeg 合并 HLS
      const broadcastUrls = extractBroadcastUrls(messageText);
      if (broadcastUrls.length > 0) {
        console.log('Found broadcast URLs:', broadcastUrls);
        processBroadcastUrls(broadcastUrls, chatId, replyToMessageId).catch(error => {
          console.error('Error in broadcast processing:', error);
          sendMessage(chatId, `❌ 直播回放处理出错: ${error.message}`, replyToMessageId).catch(() => {});
        });
        return;
      }

      // 检查是否包含视频直链（如 video.twimg.com/xxx.mp4）
      const directUrls = extractDirectVideoUrls(messageText);
      if (directUrls.length > 0) {
        console.log('Found direct video URLs:', directUrls);
        const mode = await getUserMode(chatId);
        if (mode === 'download') {
          const statusMsgId = await sendMessage(chatId, '🔍 检测到视频直链，正在下载...', replyToMessageId);
          processDirectVideoUrls(directUrls, chatId, statusMsgId, replyToMessageId).catch(error => {
            console.error('Error processing direct URLs:', error);
            sendMessage(chatId, `❌ 处理出错: ${error.message}`, replyToMessageId).catch(() => {});
          });
        } else {
          await sendMessage(chatId, '🔗 检测到视频直链：\n' + directUrls.join('\n'), replyToMessageId);
        }
        return;
      }

      // 检查是否包含 Twitter/X 链接
      const twitterUrls = extractTwitterUrls(messageText);

      if (twitterUrls.length > 0) {
        console.log('Found Twitter URLs:', twitterUrls);

        // 获取用户模式偏好
        const mode = await getUserMode(chatId);
        console.log(`User mode: ${mode}`);

        if (mode === 'download') {
          // 下载模式：每个链接独立状态消息 + 并发处理（见 processUrlsDownload），立即返回保证回复迅速
          const urlsCopy = [...twitterUrls];
          processUrlsDownload(urlsCopy, chatId, replyToMessageId).catch(error => {
            console.error('Error in download processing:', error);
            sendMessage(chatId, `❌ 处理过程中出错: ${error.message}`, replyToMessageId).catch(() => {});
          });
        } else {
          // 链接模式：同步处理（现有逻辑）
          await sendMessage(chatId, '🔍 检测到 Twitter/X 链接，正在处理...', replyToMessageId);

          for (const twitterUrl of twitterUrls) {
            await processTwitterUrl(twitterUrl, chatId);
          }
        }
      } else {
        // 如果没有找到 Twitter 链接，给出提示
        await sendMessage(chatId,
          '❌ 未检测到有效链接。\n\n' +
          '支持的格式：\n' +
          '• Twitter/X 链接：x.com/用户/status/123\n' +
          '• 直播回放：x.com/i/broadcasts/xxx\n' +
          '• 视频直链：video.twimg.com/xxx.mp4\n\n' +
          '💡 默认 📥下载+🎯最高清模式',
          replyToMessageId
        );
      }
    }

  } catch (error) {
    console.error('Error handling webhook:', error);
  }
}

function extractTwitterUrls(text) {
  const twitterRegex = /https?:\/\/(twitter\.com|x\.com)\/\w+\/status\/\d+/g;
  return text.match(twitterRegex) || [];
}

// 匹配直播回放链接：x.com/i/broadcasts/ID
export function extractBroadcastUrls(text) {
  const broadcastRegex = /https?:\/\/(?:twitter\.com|x\.com)\/i\/broadcasts\/[A-Za-z0-9]+/g;
  return [...new Set(text.match(broadcastRegex) || [])];
}

// 从 URL 中提取分辨率（如 .../1280x720/...）
function extractResolutionFromUrl(url) {
  const match = url.match(/(\d{2,4})x(\d{2,4})/);
  if (match) {
    const w = parseInt(match[1]);
    const h = parseInt(match[2]);
    if (w > 0 && h > 0) return [w, h];
  }
  return [0, 0];
}

// 匹配视频直链：video.twimg.com、.mp4、.mov 等
function extractDirectVideoUrls(text) {
  const patterns = [
    /https?:\/\/[^\s]+\.(mp4|mov|avi|webm|mkv)(\?[^\s]*)?/gi,
    /https?:\/\/video\.twimg\.com\/[^\s]+/gi,
    /https?:\/\/[^\s]*twitter[^\s]*\.(mp4|m3u8)(\?[^\s]*)?/gi,
  ];
  const urls = [];
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) urls.push(...matches);
  }
  return [...new Set(urls)]; // 去重
}

// 处理视频直链：直接下载上传，跳过 API 解析
async function processDirectVideoUrls(urls, chatId, statusMsgId, replyToMessageId) {
  const MAX_SIZE = getMaxVideoSize();

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const label = urls.length > 1 ? ` [${i + 1}/${urls.length}]` : '';

    await updateStatusMessage(chatId, statusMsgId,
      `📥 下载视频${label}...`);

    try {
      const onProg = makeProgress(chatId, statusMsgId, `下载视频${label}`);
      const file = await downloadFile(url, MAX_SIZE, onProg);

      // 从 URL 提取文件名
      const urlPath = new URL(url).pathname;
      const filename = urlPath.split('/').pop() || `video_${Date.now()}.mp4`;

      // 尝试从 URL 中提取分辨率（如 /1280x720/）
      const [dw, dh] = extractResolutionFromUrl(url);
      const dimInfo = dw ? ` ${dw}x${dh}` : '';

      const savedPath = await saveToDisk(filename, file.buffer);

      await updateStatusMessage(chatId, statusMsgId,
        `📤 上传视频${label}${dimInfo} (${formatFileSize(file.size)})...`);

      const onUp = makeProgress(chatId, statusMsgId, `上传视频${label}`, '📤');
      let videoSent = await uploadVideoFile(
        chatId, file.buffer, file.contentType,
        `🎬 视频直链${label}${dimInfo}`, null, dw, dh, replyToMessageId, onUp
      );

      if (!videoSent) {
        videoSent = await uploadDocumentFile(
          chatId, file.buffer, filename, file.contentType,
          `🎬 视频直链${label}`, replyToMessageId, onUp
        );
      }

      if (videoSent && CLEANUP_VIDEOS && savedPath) {
        await cleanupFile(savedPath);
      }

      if (!videoSent) {
        await sendMessage(chatId, `⚠️ 上传失败，直链：${url}`, replyToMessageId);
      }
    } catch (err) {
      console.error('Direct video download failed:', err.message);
      await sendMessage(chatId, `❌ 下载失败: ${err.message}\n直链：${url}`, replyToMessageId);
    }
  }

  await updateStatusMessage(chatId, statusMsgId, '✅ 处理完成！');
}

async function processTwitterUrl(originalUrl, chatId) {
  try {
    console.log('Processing URL:', originalUrl);

    // 从原始 URL 提取用户名和状态 ID
    const urlMatch = originalUrl.match(/https?:\/\/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/);
    if (!urlMatch) {
      await sendMessage(chatId, '❌ 无法解析 Twitter/X 链接');
      return;
    }

    const [, username, statusId] = urlMatch;
    console.log(`Extracted: username=${username}, statusId=${statusId}`);

    // 优先使用 fxtwitter API（支持多种清晰度）
    console.log(`Fetching from fxtwitter: ${username}/${statusId}`);
    await sendMessage(chatId, '🔄 正在从 fxtwitter 获取资源（支持多清晰度）...');

    let mediaData = await fetchFromFxTwitter(username, statusId);
    console.log('FxTwitter result:', mediaData ? 'SUCCESS' : 'FAILED');

    // 如果 fxtwitter 失败，尝试 vxtwitter（仅最高画质）
    if (!mediaData) {
      console.log(`Fetching from vxtwitter: ${username}/${statusId}`);
      await sendMessage(chatId, '🔄 尝试备用 API（最高画质）...');
      mediaData = await fetchFromVxTwitter(username, statusId);
      console.log('VxTwitter result:', mediaData ? 'SUCCESS' : 'FAILED');
    }

    if (mediaData) {
      console.log('Sending media response:', mediaData);
      await sendMediaResponse(chatId, mediaData);
    } else {
      console.log('No media data found from both APIs');
      await sendMessage(chatId, '❌ 未找到媒体内容或获取失败\n\n可能原因：\n• 推文不包含视频或图片\n• 推文已被删除\n• API 暂时不可用');
    }

  } catch (error) {
    console.error('Error processing Twitter URL:', error);
    await sendMessage(chatId, `❌ 处理链接时出错: ${error.message}`);
  }
}

async function fetchFromFxTwitter(username, statusId) {
  try {
    const apiUrl = `https://api.fxtwitter.com/${username}/status/${statusId}`;
    console.log('FxTwitter API URL:', apiUrl);

    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    console.log('FxTwitter API response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.log('FxTwitter API failed:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    console.log('FxTwitter API response keys:', Object.keys(data));

    // 检查推文内容
    if (data.tweet) {
      const tweet = data.tweet;
      const baseData = {
        text: tweet.text || '',
        author: tweet.author?.name || username,
        source: 'fxtwitter'
      };

      let videos = [];
      let photos = [];

      // 检查媒体内容
      if (tweet.media) {
        const media = tweet.media;
        console.log('Media structure:', Object.keys(media));

        // 收集视频 - 直接使用所有视频，简单去重
        if (media.videos && media.videos.length > 0) {
          console.log('Found videos:', media.videos.length);

          // 使用 Map 来去重，基于完整 URL
          const uniqueVideos = new Map();

          media.videos.forEach(video => {
            if (video.url && !uniqueVideos.has(video.url)) {
              uniqueVideos.set(video.url, {
                url: video.url,
                thumbnailUrl: video.thumbnail_url,
                quality: `${video.width}x${video.height}`,
                duration: video.duration ? `${Math.round(video.duration)}秒` : '未知',
                variants: video.variants ? video.variants
                  .filter(variant => variant.content_type === 'video/mp4')
                  .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)) : []
              });
            }
          });

          videos = Array.from(uniqueVideos.values());
          console.log('Unique videos after deduplication:', videos.length);
          console.log('Videos with variants:', videos.filter(v => v.variants.length > 0).length);
        }

        // 收集图片 - 直接使用 photos 标签，避免重复
        if (media.photos && media.photos.length > 0) {
          console.log('Found photos:', media.photos.length);

          // 使用 Set 来去重，基于 URL
          const uniquePhotos = new Map();

          media.photos.forEach(photo => {
            if (photo.url && !uniquePhotos.has(photo.url)) {
              uniquePhotos.set(photo.url, {
                url: photo.url,
                width: photo.width,
                height: photo.height
              });
            }
          });

          photos = Array.from(uniquePhotos.values());
          console.log('Unique photos after deduplication:', photos.length);
        }
      }

      // 根据媒体内容返回不同类型
      if (videos.length > 0 && photos.length > 0) {
        // 情况4: 既有视频也有图片
        return {
          type: 'mixed',
          videos: videos,
          photos: photos,
          ...baseData
        };
      } else if (videos.length > 0) {
        // 情况3: 只有视频
        return {
          type: 'videos',
          videos: videos,
          ...baseData
        };
      } else if (photos.length > 0) {
        // 情况2: 只有图片
        return {
          type: 'photos',
          photos: photos,
          ...baseData
        };
      } else {
        // 情况1: 既没有图片也没有视频
        return {
          type: 'text',
          ...baseData
        };
      }
    }

    return null;
  } catch (error) {
    console.error('FxTwitter API error:', error);
    return null;
  }
}

async function fetchFromVxTwitter(username, statusId) {
  try {
    const apiUrl = `https://api.vxtwitter.com/${username}/status/${statusId}`;
    console.log('VxTwitter API URL:', apiUrl);

    const response = await fetch(apiUrl);
    console.log('VxTwitter API response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.log('VxTwitter API failed:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    console.log('VxTwitter API response keys:', Object.keys(data));

    // 检查推文内容
    const baseData = {
      text: data.text || '',
      author: data.user_name || username,
      source: 'vxtwitter'
    };

    let videos = [];
    let photos = [];

    // 检查媒体内容
    if (data.media_extended && data.media_extended.length > 0) {
      console.log('Found media_extended:', data.media_extended.length);

      // 收集视频 - 收集所有视频并去重
      const videoMedia = data.media_extended.filter(media =>
        media.type === 'video' && media.url
      );

      if (videoMedia.length > 0) {
        console.log('Found video media:', videoMedia.length);

        // 使用 Map 来去重，基于 URL
        const uniqueVideos = new Map();

        videoMedia.forEach(video => {
          if (video.url && !uniqueVideos.has(video.url)) {
            uniqueVideos.set(video.url, {
              url: video.url,
              thumbnailUrl: video.thumbnail_url,
              quality: video.width && video.height ? `${video.width}x${video.height}` : 'unknown',
              duration: video.duration ? `${Math.round(video.duration)}秒` : '未知'
            });
          }
        });

        videos = Array.from(uniqueVideos.values());
        console.log('Unique videos after deduplication:', videos.length);
      }

      // 收集图片 - 使用去重逻辑
      const photoMedia = data.media_extended.filter(media =>
        media.type === 'image' && media.url
      );

      if (photoMedia.length > 0) {
        console.log('Found photo media:', photoMedia.length);

        // 使用 Set 来去重，基于 URL
        const uniquePhotos = new Map();

        photoMedia.forEach(photo => {
          if (photo.url && !uniquePhotos.has(photo.url)) {
            uniquePhotos.set(photo.url, {
              url: photo.url,
              width: photo.width,
              height: photo.height
            });
          }
        });

        photos = Array.from(uniquePhotos.values());
        console.log('Unique photos after deduplication:', photos.length);
      }
    }

    // 根据媒体内容返回不同类型
    if (videos.length > 0 && photos.length > 0) {
      // 情况4: 既有视频也有图片
      return {
        type: 'mixed',
        videos: videos,
        photos: photos,
        ...baseData
      };
    } else if (videos.length > 0) {
      // 情况3: 只有视频
      return {
        type: 'videos',
        videos: videos,
        ...baseData
      };
    } else if (photos.length > 0) {
      // 情况2: 只有图片
      return {
        type: 'photos',
        photos: photos,
        ...baseData
      };
    } else {
      // 情况1: 既没有图片也没有视频
      return {
        type: 'text',
        ...baseData
      };
    }

  } catch (error) {
    console.error('VxTwitter API error:', error);
    return null;
  }
}

async function sendMediaResponse(chatId, mediaData) {
  try {
    const baseText = `📄 资源提取成功\n` +
      `👤 作者: ${mediaData.author}\n` +
      `🔗 来源: ${mediaData.source}\n\n` +
      `💬 内容: ${mediaData.text.substring(0, 200)}${mediaData.text.length > 200 ? '...' : ''}`;

    if (mediaData.type === 'text') {
      // 情况1: 既没有图片也没有视频，直接返回帖文
      await sendMessage(chatId, baseText, replyToMessageId);

    } else if (mediaData.type === 'photos') {
      // 情况2: 只有图片，先返回帖文，再分别发送图片
      await sendMessage(chatId, baseText, replyToMessageId);

      // 发送所有图片
      for (let i = 0; i < mediaData.photos.length; i++) {
        const photo = mediaData.photos[i];
        const caption = `📸 图片 ${i + 1}/${mediaData.photos.length}`;

        await sendPhoto(chatId, photo.url, caption);

        // 添加小延迟避免发送过快
        if (i < mediaData.photos.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

    } else if (mediaData.type === 'videos') {
      // 情况3: 只有视频，先发送预览图，再依次发送视频链接
      const videoCaption = `📹 视频资源\n` +
        `👤 作者: ${mediaData.author}\n` +
        `� 视频:数量: ${mediaData.videos.length}\n` +
        `🔗 来源: ${mediaData.source}\n\n` +
        `� 内容:  ${mediaData.text.substring(0, 200)}${mediaData.text.length > 200 ? '...' : ''}`;

      // 先发送基本信息
      await sendMessage(chatId, videoCaption);

      // 发送所有视频的封面图
      for (let i = 0; i < mediaData.videos.length; i++) {
        const video = mediaData.videos[i];
        if (video.thumbnailUrl) {
          const thumbnailCaption = `📸 视频封面 ${i + 1}/${mediaData.videos.length}\n📐 质量: ${video.quality}\n⏱️ 时长: ${video.duration}`;
          await sendPhoto(chatId, video.thumbnailUrl, thumbnailCaption);

          // 添加小延迟避免发送过快
          if (i < mediaData.videos.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        }
      }

      // 依次发送所有视频链接
      for (let i = 0; i < mediaData.videos.length; i++) {
        const video = mediaData.videos[i];
        let caption = `🎬 视频 ${i + 1}/${mediaData.videos.length}\n📐 质量: ${video.quality}\n⏱️ 时长: ${video.duration}\n`;

        // 如果有多种清晰度选择（fxtwitter API 的优势）
        if (video.variants && video.variants.length > 0) {
          caption += `\n📱 多清晰度选择：\n`;
          video.variants.forEach((variant, index) => {
            const bitrate = variant.bitrate ? `${Math.round(variant.bitrate / 1000)}k` : '未知';
            caption += `${index + 1}. ${bitrate} - ${variant.url}\n`;
          });
        } else {
          caption += `🔗 链接: ${video.url}`;
        }

        await sendMessage(chatId, caption);

        // 添加小延迟避免发送过快
        if (i < mediaData.videos.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

    } else if (mediaData.type === 'mixed') {
      // 情况4: 既有图片也有视频，返回视频封面+帖文，再分别发送视频和图片
      const mixedCaption = `📹 混合资源 (视频+图片)\n` +
        `👤 作者: ${mediaData.author}\n` +
        `📊 视频数量: ${mediaData.videos.length}\n` +
        `📊 图片数量: ${mediaData.photos.length}\n` +
        `🔗 来源: ${mediaData.source}\n\n` +
        `💬 内容: ${mediaData.text.substring(0, 200)}${mediaData.text.length > 200 ? '...' : ''}`;

      // 先发送基本信息
      await sendMessage(chatId, mixedCaption);

      // 发送所有视频的封面图
      for (let i = 0; i < mediaData.videos.length; i++) {
        const video = mediaData.videos[i];
        if (video.thumbnailUrl) {
          const thumbnailCaption = `📸 视频封面 ${i + 1}/${mediaData.videos.length}\n📐 质量: ${video.quality}\n⏱️ 时长: ${video.duration}`;
          await sendPhoto(chatId, video.thumbnailUrl, thumbnailCaption);

          // 添加小延迟避免发送过快
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      // 依次发送所有视频链接
      for (let i = 0; i < mediaData.videos.length; i++) {
        const video = mediaData.videos[i];
        let caption = `🎬 视频 ${i + 1}/${mediaData.videos.length}\n📐 质量: ${video.quality}\n⏱️ 时长: ${video.duration}\n`;

        // 如果有多种清晰度选择（fxtwitter API 的优势）
        if (video.variants && video.variants.length > 0) {
          caption += `\n📱 多清晰度选择：\n`;
          video.variants.forEach((variant, index) => {
            const bitrate = variant.bitrate ? `${Math.round(variant.bitrate / 1000)}k` : '未知';
            caption += `${index + 1}. ${bitrate} - ${variant.url}\n`;
          });
        } else {
          caption += `🔗 链接: ${video.url}`;
        }

        await sendMessage(chatId, caption);

        // 添加小延迟避免发送过快
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // 发送所有图片
      for (let i = 0; i < mediaData.photos.length; i++) {
        const photo = mediaData.photos[i];
        const caption = `📸 图片 ${i + 1}/${mediaData.photos.length}`;

        await sendPhoto(chatId, photo.url, caption);

        // 添加小延迟避免发送过快
        if (i < mediaData.photos.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

  } catch (error) {
    console.error('Error sending media response:', error);
    await sendMessage(chatId, '发送资源信息时出错');
  }
}

async function sendPhoto(chatId, photoUrl, caption, replyToMessageId) {
  try {
    const botToken = getBotToken();
    if (!botToken) {
      console.error('BOT_TOKEN not configured');
      return false;
    }

    const telegramApiUrl = `${getTelegramApiUrl()}/bot${botToken}/sendPhoto`;

    console.log(`Sending photo to ${chatId}: ${photoUrl}`);

    const response = await fetch(telegramApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: caption,
        parse_mode: 'HTML',
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {})
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Telegram sendPhoto API error:', response.status, errorText);
      // 如果发送图片失败，回退到发送文本
      console.log('Falling back to text message');
      return await sendMessage(chatId, caption, replyToMessageId);
    }

    console.log('Photo sent successfully');
    return true;

  } catch (error) {
    console.error('Error sending photo:', error);
    // 如果发送图片失败，回退到发送文本
    return await sendMessage(chatId, caption, replyToMessageId);
  }
}

async function sendMessage(chatId, text, replyToMessageId) {
  try {
    const botToken = getBotToken();
    if (!botToken) {
      console.error('BOT_TOKEN not configured');
      return false;
    }

    const telegramApiUrl = `${getTelegramApiUrl()}/bot${botToken}/sendMessage`;

    console.log(`Sending message to ${chatId}: ${text.substring(0, 100)}...`);

    const response = await fetch(telegramApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {})
      })
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error('Telegram API error:', response.status, JSON.stringify(result));
      return null;
    }

    console.log('Message sent successfully');
    return result.result.message_id || null;
  } catch (error) {
    console.error('Error sending message:', error);
    return null;
  }
}

// ==================== 命令处理 ====================

async function handleModeCommand(chatId, messageText) {
  const parts = messageText.trim().split(/\s+/);
  const currentMode = await getUserMode(chatId);

  if (parts.length === 1) {
    const modeLabel = currentMode === 'download' ? '📥 下载模式' : '🔗 链接模式';
    await sendMessage(chatId,
      `${modeLabel}\n\n` +
      '使用以下命令切换模式：\n' +
      '• /mode download - 下载模式（下载并发送视频文件）\n' +
      '• /mode link - 链接模式（发送视频链接）\n\n' +
      '💡 下载模式下会尝试下载视频并作为文件发送'
    );
  } else if (parts[1] === 'download') {
    await setUserMode(chatId, 'download');
    await sendMessage(chatId,
      '✅ 已切换到 📥 下载模式\n\n' +
      '视频将直接下载并作为文件发送。\n' +
      '• 使用 /quality 调整画质\n' +
      '• 使用 /mode link 切回链接模式'
    );
  } else if (parts[1] === 'link') {
    await setUserMode(chatId, 'link');
    await sendMessage(chatId, '✅ 已切换到 🔗 链接模式\n\n视频将以链接形式发送。');
  } else {
    await sendMessage(chatId, '❌ 未知模式。请使用 /mode download 或 /mode link');
  }
}

async function handleQualityCommand(chatId, messageText) {
  const parts = messageText.trim().split(/\s+/);
  const currentQuality = await getUserQuality(chatId);
  const qualityLabels = { high: '🔴 高画质', medium: '🟡 中画质', low: '🟢 低画质' };

  if (parts.length === 1) {
    await sendMessage(chatId,
      `当前画质: ${qualityLabels[currentQuality]}\n\n` +
      '使用以下命令调整画质：\n' +
      '• /quality high - 最高码率（文件较大）\n' +
      '• /quality medium - 均衡画质和大小\n' +
      '• /quality low - 最小文件（适合快速下载）\n\n' +
      '💡 仅在下载模式 (/mode download) 下生效'
    );
  } else if (['high', 'medium', 'low'].includes(parts[1])) {
    await setUserQuality(chatId, parts[1]);
    await sendMessage(chatId, `✅ 已切换到 ${qualityLabels[parts[1]]}`);
  } else {
    await sendMessage(chatId,
      '❌ 未知画质。请使用 /quality high、/quality medium 或 /quality low'
    );
  }
}

// ==================== 下载模式核心 ====================

// 简单并发上限执行器（无依赖）：最多 limit 个 worker 同时跑，全部完成后返回
export async function runWithLimit(items, limit, worker) {
  const queue = items.map((item, i) => ({ item, i }));
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const { item, i } = queue.shift();
      try { await worker(item, i); } catch (e) { console.error('Task failed:', e); }
    }
  });
  await Promise.all(runners);
}

async function processUrlsDownload(twitterUrls, chatId, replyToMessageId) {
  const limit = parseInt(process.env.DOWNLOAD_CONCURRENCY) || 3;

  // 立即为每个链接各发一条独立状态消息（引用原始消息）——保证回复迅速且能对应到具体链接
  const tasks = await Promise.all(twitterUrls.map(async (url) => {
    const statusId = await sendMessage(chatId, `🔍 排队中：${url}`, replyToMessageId);
    return { url, statusId };
  }));

  // ponytail: downloadFile 把整文件读进内存，并发×2GB 会爆内存，故设上限；要再省内存就改成下载落盘后从磁盘上传
  await runWithLimit(tasks, limit, ({ url, statusId }) =>
    processTwitterUrlDownload(url, chatId, statusId, replyToMessageId));
}

// ==================== 直播回放（broadcasts）====================

// 用 yt-dlp 下载直播回放到本地 mp4（自带 X broadcast extractor，调 ffmpeg 合并 HLS 切片）
function downloadBroadcastWithYtDlp(broadcastUrl, outPath, maxSizeBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      broadcastUrl,
      '-o', outPath,
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--newline',
      '--merge-output-format', 'mp4',
      '--max-filesize', String(maxSizeBytes)
    ];
    console.log(`[yt-dlp] start: ${broadcastUrl} -> ${outPath}`);
    const proc = spawn('yt-dlp', args, { windowsHide: true });
    let stderr = '';
    // 进度和报错都透传到容器日志，并把下载百分比回调给上层更新 Telegram
    const handle = (buf) => {
      const s = buf.toString();
      stderr += s;
      for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        console.log('[yt-dlp]', t);
        const m = t.match(/\[download\]\s+([\d.]+)%/);
        if (m && onProgress) onProgress(parseFloat(m[1]));
      }
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);
    proc.on('error', err => reject(new Error(`yt-dlp 不可用: ${err.message}`)));
    // 直播回放可能很长，给 30 分钟超时
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('yt-dlp 超时(30分钟)')); }, 30 * 60 * 1000);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp 退出码 ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// 用 ffprobe 读取视频真实宽高（ffmpeg 自带），失败返回 [0,0]
function getVideoDimensions(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      filePath
    ], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('error', () => resolve([0, 0]));
    proc.on('close', () => {
      const m = out.trim().match(/(\d+)x(\d+)/);
      resolve(m ? [parseInt(m[1]), parseInt(m[2])] : [0, 0]);
    });
  });
}

// 兜底：可选第三方解析。设置 BROADCAST_RESOLVER_URL（含 {url} 占位）即启用，
// 期望返回的文本/JSON 中包含直链 mp4。未配置或失败则返回 null（降级为手动提示）。
async function resolveBroadcastViaThirdParty(broadcastUrl) {
  const tpl = process.env.BROADCAST_RESOLVER_URL;
  if (!tpl) return null;
  try {
    const api = tpl.replace('{url}', encodeURIComponent(broadcastUrl));
    const res = await fetch(api, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return null;
    const text = await res.text();
    // downloadFile 只能处理直链 mp4，HLS(m3u8) 留给 yt-dlp，所以只抓 mp4
    const m = text.match(/https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/i);
    return m ? m[0].replace(/\\u002[fF]/g, '/') : null;
  } catch (e) {
    console.error('Third-party broadcast resolver failed:', e.message);
    return null;
  }
}

async function processBroadcastUrls(urls, chatId, replyToMessageId) {
  const limit = parseInt(process.env.DOWNLOAD_CONCURRENCY) || 3;
  const tasks = await Promise.all(urls.map(async (url) => {
    const statusId = await sendMessage(chatId, `🔴 排队中（直播回放）：${url}`, replyToMessageId);
    return { url, statusId };
  }));
  await runWithLimit(tasks, limit, ({ url, statusId }) =>
    processBroadcastUrl(url, chatId, statusId, replyToMessageId));
}

async function processBroadcastUrl(broadcastUrl, chatId, statusMessageId, replyToMessageId) {
  const MAX_SIZE = getMaxVideoSize();
  const SIZE_LABEL = MAX_SIZE > 100 * 1024 * 1024 ? '2GB' : '50MB';
  const bid = (broadcastUrl.match(/broadcasts\/([A-Za-z0-9]+)/) || [])[1] || `bc_${Date.now()}`;
  const caption = `🎬 直播回放\n🔗 源链接: ${broadcastUrl}`;

  // 主路径：yt-dlp（+ffmpeg）
  await updateStatusMessage(chatId, statusMessageId, `🔴 解析直播回放 ${bid}（yt-dlp）...`);
  const outPath = join(DOWNLOADS_DIR, `broadcast_${bid}_${Date.now()}.mp4`);
  try {
    await mkdir(DOWNLOADS_DIR, { recursive: true });
    let lastEdit = 0;
    await downloadBroadcastWithYtDlp(broadcastUrl, outPath, MAX_SIZE, (pct) => {
      const now = Date.now();
      if (now - lastEdit >= 5000) {
        lastEdit = now;
        updateStatusMessage(chatId, statusMessageId, `🔴 下载直播回放 ${bid}… ${pct.toFixed(1)}%`).catch(() => {});
      }
    });
    const st = await stat(outPath);
    if (st.size > MAX_SIZE) {
      await sendMessage(chatId, `⚠️ 直播回放过大（${formatFileSize(st.size)} > ${SIZE_LABEL}），无法上传`, replyToMessageId);
      await cleanupFile(outPath);
      await updateStatusMessage(chatId, statusMessageId, '✅ 处理完成！');
      return;
    }
    const [bw, bh] = await getVideoDimensions(outPath);
    await updateStatusMessage(chatId, statusMessageId, `📤 上传直播回放${bw ? ` ${bw}x${bh}` : ''}（${formatFileSize(st.size)}）...`);
    const buffer = await readFile(outPath);
    const onUp = makeProgress(chatId, statusMessageId, `上传直播回放 ${bid}`, '📤');
    let sent = await uploadVideoFile(chatId, buffer, 'video/mp4', caption, null, bw, bh, replyToMessageId, onUp);
    if (!sent) sent = await uploadDocumentFile(chatId, buffer, `${bid}.mp4`, 'video/mp4', caption, replyToMessageId, onUp);
    if (sent && CLEANUP_VIDEOS) await cleanupFile(outPath);
    if (sent) {
      await updateStatusMessage(chatId, statusMessageId, '✅ 处理完成！');
      return;
    }
  } catch (err) {
    console.error('yt-dlp broadcast failed:', err.message);
    await cleanupFile(outPath).catch(() => {});
  }

  // 兜底：第三方解析直链 mp4
  await updateStatusMessage(chatId, statusMessageId, '🔁 yt-dlp 未成功，尝试第三方解析...');
  const directUrl = await resolveBroadcastViaThirdParty(broadcastUrl);
  if (directUrl) {
    try {
      const file = await downloadFile(directUrl, MAX_SIZE);
      await updateStatusMessage(chatId, statusMessageId, `📤 上传直播回放（${formatFileSize(file.size)}）...`);
      const onUp = makeProgress(chatId, statusMessageId, `上传直播回放 ${bid}`, '📤');
      let sent = await uploadVideoFile(chatId, file.buffer, file.contentType, caption, null, null, null, replyToMessageId, onUp);
      if (!sent) sent = await uploadDocumentFile(chatId, file.buffer, `${bid}.mp4`, file.contentType, caption, replyToMessageId, onUp);
      if (sent) {
        await updateStatusMessage(chatId, statusMessageId, '✅ 处理完成！');
        return;
      }
    } catch (e) {
      console.error('Third-party broadcast download failed:', e.message);
    }
  }

  // 全部失败：给手动提示（始终有用、不崩）
  await sendMessage(chatId,
    `❌ 暂时无法自动解析该直播回放。\n🔗 ${broadcastUrl}\n\n可用以下站点手动解析后把直链发给我：\n• https://www.kedou.life/extract/twitter\n• https://save.tube`,
    replyToMessageId);
  await updateStatusMessage(chatId, statusMessageId, '✅ 处理完成（见提示）');
}


async function processTwitterUrlDownload(originalUrl, chatId, statusMessageId, replyToMessageId) {
  try {
    console.log('Processing URL (download mode):', originalUrl);

    const urlMatch = originalUrl.match(/https?:\/\/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/);
    if (!urlMatch) {
      await sendMessage(chatId, '❌ 无法解析 Twitter/X 链接', replyToMessageId);
      return;
    }

    const [, username, statusId] = urlMatch;
    console.log(`Extracted: username=${username}, statusId=${statusId}`);

    // 获取媒体数据
    await updateStatusMessage(chatId, statusMessageId, '🔄 正在获取推文信息...');

    let mediaData = await fetchFromFxTwitter(username, statusId);
    console.log('FxTwitter result:', mediaData ? 'SUCCESS' : 'FAILED');

    if (!mediaData) {
      mediaData = await fetchFromVxTwitter(username, statusId);
      console.log('VxTwitter result:', mediaData ? 'SUCCESS' : 'FAILED');
    }

    if (!mediaData) {
      await sendMessage(chatId, '❌ 未找到媒体内容或获取失败\n\n可能原因：\n• 推文不包含视频或图片\n• 推文已被删除\n• API 暂时不可用', replyToMessageId);
      return;
    }

    // 获取画质偏好
    const qualityPreference = await getUserQuality(chatId);
    const MAX_VIDEO_SIZE = getMaxVideoSize();
    const SIZE_LABEL = MAX_VIDEO_SIZE > 100 * 1024 * 1024 ? '2GB' : '50MB';

    // 构建基础信息文本
    const baseText = `📄 资源提取成功\n` +
      `👤 作者: ${mediaData.author}\n` +
      `🔗 来源: ${mediaData.source}\n\n` +
      `💬 内容: ${mediaData.text ? mediaData.text.substring(0, 200) : '(无文本)'}` +
      `${mediaData.text && mediaData.text.length > 200 ? '...' : ''}`;

    if (mediaData.type === 'text') {
      await sendMessage(chatId, baseText, replyToMessageId);
      return;
    }

    const isMixed = mediaData.type === 'mixed';

    // 混合内容：先单独发送推文文本
    if (isMixed) {
      await sendMessage(chatId, baseText, replyToMessageId);
    }

    // 处理图片
    if (mediaData.photos && mediaData.photos.length > 0) {
      const photoLabel = isMixed
        ? `🖼️ 图片 (${mediaData.photos.length}张) + 🎬 视频 (${mediaData.videos?.length || 0}个)`
        : `🖼️ 正在发送 ${mediaData.photos.length} 张图片...`;
      await updateStatusMessage(chatId, statusMessageId, photoLabel);

      for (let i = 0; i < mediaData.photos.length; i++) {
        const photo = mediaData.photos[i];
        const caption = isMixed
          ? `📸 图片 ${i + 1}/${mediaData.photos.length}`
          : mediaData.photos.length === 1
            ? `📸 ${baseText}`
            : `📸 图片 ${i + 1}/${mediaData.photos.length}`;

        await sendChatAction(chatId, 'upload_photo');

        const sent = await sendPhoto(chatId, photo.url, caption, replyToMessageId);
        if (!sent) {
          await updateStatusMessage(chatId, statusMessageId,
            `📥 下载图片 ${i + 1}/${mediaData.photos.length}...`);
          try {
            const file = await downloadFile(photo.url, 10 * 1024 * 1024);
            await uploadPhotoFile(chatId, file.buffer, file.contentType, caption);
          } catch (downloadErr) {
            console.error('Photo download failed:', downloadErr);
            await sendMessage(chatId, caption, replyToMessageId);
          }
        }
      }
    }

    // 处理视频
    if (mediaData.videos && mediaData.videos.length > 0) {
      const videoLabel = isMixed
        ? `🎬 视频 (${mediaData.videos.length}个) + 🖼️ 图片 (${mediaData.photos?.length || 0}张)`
        : `🎬 正在处理 ${mediaData.videos.length} 个视频...`;
      await updateStatusMessage(chatId, statusMessageId, videoLabel);

      for (let i = 0; i < mediaData.videos.length; i++) {
        const video = mediaData.videos[i];

        // 解析视频尺寸（如 "1280x2778"）
        const [vidW, vidH] = video.quality
          ? video.quality.split('x').map(Number)
          : [0, 0];

        const videoCaption = `🎬 视频 ${i + 1}/${mediaData.videos.length}\n` +
          `📐 质量: ${video.quality || '未知'}\n` +
          `⏱️ 时长: ${video.duration || '未知'}\n` +
          `🔗 源链接: ${originalUrl}` +
          `${(mediaData.videos.length === 1 && !isMixed) ? '\n\n' + baseText : ''}`;

        await sendChatAction(chatId, 'upload_video');

        // 选择最佳 video variant（HEAD 取真实大小）
        const selected = await selectVideoVariant(video, qualityPreference, MAX_VIDEO_SIZE);

        if (selected.url && !selected.reason) {
          const urlsToTry = [selected.url, ...(selected.fallbacks || [])];
          let videoSent = false;
          let triedUrl = '';

          for (const tryUrl of urlsToTry) {
            triedUrl = tryUrl;
            const tryInfo = tryUrl === selected.url && selected.estimatedSize
              ? ` (${selected.sizeAccurate ? '' : '约 '}${formatFileSize(selected.estimatedSize)})`
              : '';

            // 策略1: URL 直传
            await updateStatusMessage(chatId, statusMessageId,
              `📤 上传视频 ${i + 1}/${mediaData.videos.length}${tryInfo}...`);
            videoSent = await sendVideoByUrl(chatId, tryUrl, videoCaption, vidW, vidH, replyToMessageId);
            if (videoSent) break;

            // 策略2: 下载后上传
            await updateStatusMessage(chatId, statusMessageId,
              `📥 下载视频 ${i + 1}/${mediaData.videos.length}${tryInfo}...`);
            let savedPath = null;
            try {
              const onProg = makeProgress(chatId, statusMessageId, `下载视频 ${i + 1}/${mediaData.videos.length}`);
              const file = await downloadFile(tryUrl, MAX_VIDEO_SIZE, onProg);

              const timestamp = Date.now();
              const filename = `twitter_${username}_${statusId}_${timestamp}.mp4`;
              savedPath = await saveToDisk(filename, file.buffer);

              await updateStatusMessage(chatId, statusMessageId,
                `📤 上传视频 ${i + 1}/${mediaData.videos.length} ` +
                `(${formatFileSize(file.size)})...`);
              const onUp = makeProgress(chatId, statusMessageId, `上传视频 ${i + 1}/${mediaData.videos.length}`, '📤');
              videoSent = await uploadVideoFile(
                chatId, file.buffer, file.contentType, videoCaption, video.thumbnailUrl, vidW, vidH, replyToMessageId, onUp
              );

              if (videoSent) {
                // 上传成功，根据 CLEANUP_VIDEOS 决定是否删除本地文件
                if (CLEANUP_VIDEOS && savedPath) {
                  await cleanupFile(savedPath);
                }
                break;
              }

              // 策略3: 作为文档上传
              videoSent = await uploadDocumentFile(
                chatId, file.buffer, 'video.mp4', file.contentType, videoCaption, replyToMessageId, onUp
              );
              if (videoSent && CLEANUP_VIDEOS && savedPath) {
                await cleanupFile(savedPath);
              }
            } catch (downloadErr) {
              console.error('Video attempt failed:', downloadErr);
              // 下载/上传失败，保留文件不删除
            }
          }

          if (!videoSent) {
            // 所有尝试都失败，发送链接
            await sendVideoLinks(chatId, video, i, mediaData.videos.length, replyToMessageId);
          } else if (video.variants && video.variants.length > 1) {
            // 上传成功，附带多清晰度链接
            await sendVideoLinks(chatId, video, i, mediaData.videos.length, replyToMessageId);
          }
        } else if (selected.reason === 'all_too_large') {
          await sendMessage(chatId,
            `⚠️ 视频文件过大（最小 ${formatFileSize(selected.minEstimatedSize)}，限制 ${SIZE_LABEL}）\n\n` +
            '正在发送链接，你可以在浏览器中下载...', replyToMessageId);
          await sendVideoLinks(chatId, video, i, mediaData.videos.length, replyToMessageId);
        } else {
          await sendMessage(chatId,
            '⚠️ 无法获取可用的视频下载链接\n\n正在发送链接...', replyToMessageId);
          await sendVideoLinks(chatId, video, i, mediaData.videos.length, replyToMessageId);
        }

        // 多视频时发送缩略图预览
        if (video.thumbnailUrl && mediaData.videos.length > 1) {
          await sendPhoto(chatId, video.thumbnailUrl,
            `📸 视频 ${i + 1}/${mediaData.videos.length} 封面`, replyToMessageId);
        }
      }
    }

    await updateStatusMessage(chatId, statusMessageId, '✅ 处理完成！');

  } catch (error) {
    console.error('Error in download mode:', error);
    await sendMessage(chatId, `❌ 下载模式处理出错: ${error.message}`);
  }
}

// ==================== 视频 Variant 选择 ====================

// HEAD 请求获取远程文件真实大小（Content-Length），失败返回 null
async function getRemoteFileSize(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const len = res.headers.get('Content-Length');
    return len ? parseInt(len) : null;
  } catch {
    return null;
  }
}

// 选择视频 variant：bitrate 估算做免费排序，再对候选发 HEAD 拿真实大小（更准的展示与超限判断）
export async function selectVideoVariant(video, qualityPreference, maxSizeBytes) {
  let candidates = [];

  if (video.variants && video.variants.length > 0) {
    // fxtwitter 已按 bitrate 降序排列 variants
    const durationSeconds = parseFloat(video.duration) || 0;

    candidates = video.variants
      .filter(v => v.bitrate && v.bitrate > 0)
      .map(v => ({
        url: v.url,
        bitrate: v.bitrate || 0,
        // 粗估仅用于排序/兜底：bitrate(bps) × duration(s) ÷ 8，加 15% 容器开销
        estimatedSize: durationSeconds > 0
          ? Math.ceil((v.bitrate * durationSeconds) / 8 * 1.15)
          : null
      }));
  } else if (video.url) {
    // vxtwitter 单一 URL：HEAD 拿真实大小展示
    const realSize = await getRemoteFileSize(video.url);
    return { url: video.url, reason: null, estimatedSize: realSize, sizeAccurate: realSize != null };
  } else {
    return { url: null, reason: 'no_variants' };
  }

  if (candidates.length === 0) {
    return { url: null, reason: 'no_variants' };
  }

  // 按画质偏好决定尝试顺序（高=最高码率优先，低=最低优先，中=中档起逐级降）
  let order;
  switch (qualityPreference) {
    case 'low':
      order = [...candidates].reverse();
      break;
    case 'medium': {
      const mid = Math.floor(candidates.length / 2);
      order = [...candidates.slice(mid), ...candidates.slice(0, mid).reverse()];
      break;
    }
    case 'high':
    default:
      order = candidates;
  }

  // 逐个 HEAD 取真实大小，选第一个不超限的（HEAD 次数通常 1~3）
  let minSeen = Infinity;
  for (const c of order) {
    const realSize = await getRemoteFileSize(c.url);
    const size = realSize != null ? realSize : c.estimatedSize;
    if (size != null && size < minSeen) minSeen = size;
    if (size == null || size <= maxSizeBytes) {
      return {
        url: c.url,
        reason: null,
        estimatedSize: size,
        sizeAccurate: realSize != null,
        availableCount: candidates.length,
        // 高画质：保留其余 variant 作为上传失败时的回退
        fallbacks: qualityPreference === 'high'
          ? order.filter(x => x.url !== c.url).map(x => x.url)
          : []
      };
    }
  }

  // 全部超限：报告最小的那个真实大小
  const minEstimated = Math.min(...order.map(c => c.estimatedSize || Infinity));
  return { url: null, reason: 'all_too_large', minEstimatedSize: Number.isFinite(minSeen) ? minSeen : minEstimated };
}

// ==================== 文件下载 ====================

// 生成节流的进度回调：每 ~4 秒把百分比刷到状态消息（emoji 区分下载/上传）
function makeProgress(chatId, statusMessageId, label, emoji = '📥') {
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (now - last < 4000) return;
    last = now;
    const pct = total ? ` ${(done / total * 100).toFixed(0)}%` : '';
    const info = total
      ? ` (${formatFileSize(done)}/${formatFileSize(total)})`
      : ` (${formatFileSize(done)})`;
    updateStatusMessage(chatId, statusMessageId, `${emoji} ${label}${pct}${info}...`).catch(() => {});
  };
}

async function downloadFile(url, maxSizeBytes, onProgress) {
  console.log(`Downloading: ${url.substring(0, 80)}... (max: ${formatFileSize(maxSizeBytes)})`);

  // HEAD 预检查大小
  try {
    const headResponse = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(15000)
    });

    if (headResponse.ok) {
      const contentLength = headResponse.headers.get('Content-Length');
      if (contentLength && parseInt(contentLength) > maxSizeBytes) {
        throw new Error(`SIZE_EXCEEDED: ${formatFileSize(parseInt(contentLength))} > ${formatFileSize(maxSizeBytes)}`);
      }
    }
  } catch (error) {
    if (error.message.startsWith('SIZE_EXCEEDED')) throw error;
    console.log('HEAD request failed, proceeding with GET:', error.message);
  }

  // GET 下载（大文件给 10 分钟，避免被 60s 总超时打断）
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    signal: AbortSignal.timeout(600000)
  });

  if (!response.ok) {
    throw new Error(`DOWNLOAD_FAILED: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('Content-Type') || 'application/octet-stream';

  // 检查 Content-Length
  const contentLength = response.headers.get('Content-Length');
  const totalBytes = contentLength ? parseInt(contentLength) : 0;
  if (totalBytes && totalBytes > maxSizeBytes) {
    throw new Error(`SIZE_EXCEEDED: ${formatFileSize(totalBytes)} > ${formatFileSize(maxSizeBytes)}`);
  }

  // 流式读取，超过限制时中止，并上报进度
  const reader = response.body.getReader();
  const chunks = [];
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalSize += value.length;
    if (totalSize > maxSizeBytes) {
      reader.cancel();
      throw new Error(`SIZE_EXCEEDED: File exceeds ${formatFileSize(maxSizeBytes)}`);
    }
    chunks.push(value);
    if (onProgress) onProgress(totalSize, totalBytes);
  }

  // 合并 chunks
  const buffer = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  console.log(`Downloaded: ${formatFileSize(totalSize)} (${contentType})`);
  return { buffer: buffer.buffer, contentType, size: totalSize };
}

// 保存下载的文件到磁盘
async function saveToDisk(filename, buffer) {
  try {
    await mkdir(DOWNLOADS_DIR, { recursive: true });
    const filepath = join(DOWNLOADS_DIR, filename);
    await writeFile(filepath, new Uint8Array(buffer));
    console.log(`Saved: ${filepath}`);
    return filepath;
  } catch (err) {
    console.error('Failed to save file to disk:', err.message);
    return null;
  }
}

async function cleanupFile(filepath) {
  try {
    await rm(filepath);
    console.log(`Cleaned up: ${filepath}`);
  } catch (err) {
    console.error('Failed to delete file:', err.message);
  }
}

// ==================== 文件上传 (Telegram) ====================

// 流式 multipart 上传：用 http/https 手写请求，带 Content-Length，按块写文件并上报进度
// （Node 的 fetch/FormData 无法获取上传进度，故走底层请求）
export function uploadMultipart(urlStr, fields, file, onProgress, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const boundary = '----xbot' + Date.now().toString(16) + Math.floor(Math.random() * 1e9).toString(16);
    const enc = new TextEncoder();

    const fieldParts = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === '') continue;
      fieldParts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    const fileHeader = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`
    );
    const fileData = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);

    const headerBytes = fieldParts.reduce((s, p) => s + p.length, 0) + fileHeader.length;
    const total = headerBytes + fileData.length + tail.length;

    const req = reqFn({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': total
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upload timeout')));

    for (const p of fieldParts) req.write(p);
    req.write(fileHeader);

    // 文件分块写入 + 进度，遵守背压（write 返回 false 时等 drain）
    let sent = headerBytes;
    const CHUNK = 512 * 1024;
    let i = 0;
    const pump = () => {
      while (i < fileData.length) {
        const slice = fileData.subarray(i, Math.min(i + CHUNK, fileData.length));
        i += slice.length;
        sent += slice.length;
        if (onProgress) onProgress(sent, total);
        if (!req.write(slice)) { req.once('drain', pump); return; }
      }
      req.write(tail);
      sent += tail.length;
      if (onProgress) onProgress(sent, total);
      req.end();
    };
    pump();
  });
}

// fetch 回退（无进度），仅在流式上传抛传输错误时兜底，保证核心上传不被新代码破坏
async function uploadViaFetch(endpoint, fields, fileField, filename, buffer, contentType, timeoutMs = 120000) {
  const formData = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') formData.append(k, String(v));
  }
  formData.append(fileField, new Blob([buffer], { type: contentType }), filename);
  const response = await fetch(endpoint, { method: 'POST', body: formData, signal: AbortSignal.timeout(timeoutMs) });
  return await response.json();
}

async function uploadVideoFile(chatId, buffer, contentType, caption, thumbnailUrl, width, height, replyToMessageId, onProgress) {
  const botToken = getBotToken();
  if (!botToken) return false;

  const endpoint = `${getTelegramApiUrl()}/bot${botToken}/sendVideo`;
  const fields = { chat_id: String(chatId), supports_streaming: 'true' };
  if (caption) fields.caption = caption;
  if (thumbnailUrl) fields.thumb = thumbnailUrl;
  if (width) fields.width = String(width);
  if (height) fields.height = String(height);
  if (replyToMessageId) { fields.reply_to_message_id = String(replyToMessageId); fields.allow_sending_without_reply = 'true'; }

  console.log(`Uploading video: ${formatFileSize(buffer.byteLength)} ${width ? `${width}x${height}` : ''}`);
  try {
    const res = await uploadMultipart(endpoint, fields, { field: 'video', filename: 'video.mp4', contentType, data: buffer }, onProgress);
    const result = JSON.parse(res.body);
    if (!result.ok) { console.error('sendVideo (stream) failed:', result.description); return false; }
    console.log('Video uploaded successfully');
    return true;
  } catch (error) {
    console.error('Video upload (stream) error, fallback to fetch:', error.message);
    try {
      const result = await uploadViaFetch(endpoint, fields, 'video', 'video.mp4', buffer, contentType);
      if (!result.ok) { console.error('sendVideo (fetch) failed:', result.description); return false; }
      return true;
    } catch (e2) { console.error('Video upload fallback error:', e2); return false; }
  }
}

async function uploadPhotoFile(chatId, buffer, contentType, caption) {
  try {
    const botToken = getBotToken();
    if (!botToken) return false;

    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    formData.append('photo', new Blob([buffer], { type: contentType }), 'photo.jpg');
    if (caption) formData.append('caption', caption);

    console.log(`Uploading photo: ${formatFileSize(buffer.byteLength)}`);

    const response = await fetch(`${getTelegramApiUrl()}/bot${botToken}/sendPhoto`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(60000)
    });

    const result = await response.json();

    if (!result.ok) {
      console.error('sendPhoto (multipart) failed:', result.description);
      return false;
    }

    console.log('Photo uploaded successfully');
    return true;
  } catch (error) {
    console.error('Error uploading photo:', error);
    return false;
  }
}

async function uploadDocumentFile(chatId, buffer, filename, contentType, caption, replyToMessageId, onProgress) {
  const botToken = getBotToken();
  if (!botToken) return false;

  const endpoint = `${getTelegramApiUrl()}/bot${botToken}/sendDocument`;
  const fields = { chat_id: String(chatId) };
  if (caption) fields.caption = caption;
  if (replyToMessageId) { fields.reply_to_message_id = String(replyToMessageId); fields.allow_sending_without_reply = 'true'; }

  console.log(`Uploading document: ${formatFileSize(buffer.byteLength)}`);
  try {
    const res = await uploadMultipart(endpoint, fields, { field: 'document', filename, contentType, data: buffer }, onProgress);
    const result = JSON.parse(res.body);
    if (!result.ok) { console.error('sendDocument (stream) failed:', result.description); return false; }
    console.log('Document uploaded successfully');
    return true;
  } catch (error) {
    console.error('Document upload (stream) error, fallback to fetch:', error.message);
    try {
      const result = await uploadViaFetch(endpoint, fields, 'document', filename, buffer, contentType);
      if (!result.ok) { console.error('sendDocument (fetch) failed:', result.description); return false; }
      return true;
    } catch (e2) { console.error('Document upload fallback error:', e2); return false; }
  }
}

async function sendVideoByUrl(chatId, videoUrl, caption, width, height, replyToMessageId) {
  try {
    const botToken = getBotToken();
    if (!botToken) return false;

    console.log(`Sending video by URL: ${videoUrl.substring(0, 80)}... ${width ? `${width}x${height}` : ''}`);

    const body = {
      chat_id: chatId,
      video: videoUrl,
      caption: caption,
      supports_streaming: true
    };
    if (width) { body.width = width; body.height = height; }
    if (replyToMessageId) { body.reply_to_message_id = replyToMessageId; body.allow_sending_without_reply = true; }

    const response = await fetch(`${getTelegramApiUrl()}/bot${botToken}/sendVideo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });

    const result = await response.json();

    if (!result.ok) {
      console.error('sendVideo (URL) failed:', result.description);
      return false;
    }

    console.log('Video sent by URL successfully');
    return true;
  } catch (error) {
    console.error('Error sending video by URL:', error);
    return false;
  }
}

async function sendVideoLinks(chatId, video, index, total, replyToMessageId) {
  let caption = `🔗 视频 ${index + 1}/${total}\n` +
    `📐 质量: ${video.quality || 'N/A'}\n` +
    `⏱️ 时长: ${video.duration || '未知'}\n`;

  if (video.variants && video.variants.length > 0) {
    caption += '\n📱 多清晰度链接：\n';
    video.variants.forEach((variant, i) => {
      const bitrate = variant.bitrate
        ? `${Math.round(variant.bitrate / 1000)}k`
        : '未知';
      caption += `${i + 1}. ${bitrate} - ${variant.url}\n`;
    });
  } else if (video.url) {
    caption += `\n🔗 链接: ${video.url}`;
  }

  await sendMessage(chatId, caption, replyToMessageId);
}

// ==================== 状态反馈 ====================

async function updateStatusMessage(chatId, messageId, text, replyToMessageId) {
  try {
    const botToken = getBotToken();
    if (!botToken) return messageId;

    if (messageId) {
      // 编辑已有消息
      const response = await fetch(
        `${getTelegramApiUrl()}/bot${botToken}/editMessageText`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: text
          })
        }
      );
      const result = await response.json();
      if (!result.ok) {
        console.log('Edit message failed (may be unchanged):', result.description);
      }
      return messageId;
    } else {
      // 发送新消息
      return await sendMessage(chatId, text, replyToMessageId);
    }
  } catch (error) {
    console.error('Status message error:', error);
    return messageId;
  }
}

async function sendChatAction(chatId, action) {
  try {
    const botToken = getBotToken();
    if (!botToken) return;

    await fetch(`${getTelegramApiUrl()}/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: action })
    });
  } catch (error) {
    console.error('Chat action error:', error);
  }
}

export async function setupWebhook(req) {
  try {
    if (!getBotToken()) {
      return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>配置错误</title></head>
<body>
  <h1>❌ 机器人令牌未配置</h1>
  <p>请在 <code>.env</code> 文件中配置 BOT_TOKEN</p>
  <a href="/">返回首页</a>
</body>
</html>`;
    }

    const origin = `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${origin}/webhook`;

    const telegramUrl = `${getTelegramApiUrl()}/bot${getBotToken()}/setWebhook`;
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });

    const result = await response.json();

    if (result.ok) {
      return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>设置成功</title></head>
<body>
  <h1>✅ Webhook 设置成功！</h1>
  <p>Webhook 地址: <code>${webhookUrl}</code></p>
  <p>现在可以在 Telegram 中测试机器人了</p>
  <a href="/">返回首页</a>
</body>
</html>`;
    } else {
      return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>设置失败</title></head>
<body>
  <h1>❌ Webhook 设置失败</h1>
  <p>错误信息: ${result.description}</p>
  <a href="/">返回首页</a>
</body>
</html>`;
    }

  } catch (error) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>设置错误</title></head>
<body>
  <h1>❌ 设置过程中出错</h1>
  <p>错误信息: ${error.message}</p>
  <a href="/">返回首页</a>
</body>
</html>`;
  }
}