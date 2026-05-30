// X Downloader Bot for Telegram — Docker 部署版
// 使用 fxtwitter 和 vxtwitter API 提取视频和图片

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUserMode, setUserMode, getUserQuality, setUserQuality } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || join(__dirname, '..', 'downloads');
const CLEANUP_VIDEOS = process.env.CLEANUP_VIDEOS !== 'false';  // 默认 true

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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

      console.log(`Message from ${chatId}: ${messageText}`);

      // 处理 /start 命令
      if (messageText === '/start') {
        await sendMessage(chatId,
          '🤖 X 媒体机器人已启动！\n\n' +
          '发送包含 Twitter/X 链接的消息，我会帮你提取视频和图片。\n\n' +
          '支持的命令：\n' +
          '• /mode - 查看或切换模式（链接/下载）\n' +
          '• /quality - 查看或设置视频画质\n\n' +
          '支持的链接格式：\n' +
          '• https://twitter.com/username/status/123\n' +
          '• https://x.com/username/status/123\n\n' +
          '💡 默认使用 📥下载+最高清 模式，直接发送 /mode 查看'
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

      // 检查是否包含 Twitter/X 链接
      const twitterUrls = extractTwitterUrls(messageText);

      if (twitterUrls.length > 0) {
        console.log('Found Twitter URLs:', twitterUrls);

        // 获取用户模式偏好
        const mode = await getUserMode(chatId);
        console.log(`User mode: ${mode}`);

        if (mode === 'download') {
          // 下载模式：异步处理
          const statusMsgId = await sendMessage(chatId, '🔍 检测到 Twitter/X 链接，正在分析...');

          const urlsCopy = [...twitterUrls];
          // Docker 环境不需要 ctx.waitUntil，直接异步处理
          processUrlsDownload(urlsCopy, chatId, statusMsgId).catch(error => {
            console.error('Error in download processing:', error);
            sendMessage(chatId, `❌ 处理过程中出错: ${error.message}`).catch(() => {});
          });
        } else {
          // 链接模式：同步处理（现有逻辑）
          await sendMessage(chatId, '🔍 检测到 Twitter/X 链接，正在处理...');

          for (const twitterUrl of twitterUrls) {
            await processTwitterUrl(twitterUrl, chatId);
          }
        }
      } else {
        // 如果没有找到 Twitter 链接，给出提示
        await sendMessage(chatId,
          '❌ 未检测到 Twitter/X 链接。\n\n' +
          '请发送包含以下格式的链接：\n' +
          '• https://twitter.com/用户名/status/123\n' +
          '• https://x.com/用户名/status/123\n\n' +
          '💡 使用 /mode 切换下载模式，可直接获取视频文件！'
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
      await sendMessage(chatId, baseText);

    } else if (mediaData.type === 'photos') {
      // 情况2: 只有图片，先返回帖文，再分别发送图片
      await sendMessage(chatId, baseText);

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

async function sendPhoto(chatId, photoUrl, caption) {
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
        parse_mode: 'HTML'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Telegram sendPhoto API error:', response.status, errorText);
      // 如果发送图片失败，回退到发送文本
      console.log('Falling back to text message');
      return await sendMessage(chatId, caption);
    }

    console.log('Photo sent successfully');
    return true;

  } catch (error) {
    console.error('Error sending photo:', error);
    // 如果发送图片失败，回退到发送文本
    return await sendMessage(chatId, caption);
  }
}

async function sendMessage(chatId, text) {
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
        parse_mode: 'HTML'
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

async function processUrlsDownload(twitterUrls, chatId, statusMessageId) {
  let currentStatusId = statusMessageId;

  for (let i = 0; i < twitterUrls.length; i++) {
    const twitterUrl = twitterUrls[i];

    if (twitterUrls.length > 1) {
      currentStatusId = await updateStatusMessage(
        chatId, currentStatusId,
        `🔍 处理第 ${i + 1}/${twitterUrls.length} 个链接...`
      );
    }

    await processTwitterUrlDownload(twitterUrl, chatId, currentStatusId);
  }
}

async function processTwitterUrlDownload(originalUrl, chatId, statusMessageId) {
  try {
    console.log('Processing URL (download mode):', originalUrl);

    const urlMatch = originalUrl.match(/https?:\/\/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/);
    if (!urlMatch) {
      await sendMessage(chatId, '❌ 无法解析 Twitter/X 链接');
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
      await sendMessage(chatId, '❌ 未找到媒体内容或获取失败\n\n可能原因：\n• 推文不包含视频或图片\n• 推文已被删除\n• API 暂时不可用');
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
      await sendMessage(chatId, baseText);
      return;
    }

    // 处理图片
    if (mediaData.photos && mediaData.photos.length > 0) {
      await updateStatusMessage(chatId, statusMessageId,
        `🖼️ 正在发送 ${mediaData.photos.length} 张图片...`);

      for (let i = 0; i < mediaData.photos.length; i++) {
        const photo = mediaData.photos[i];
        const caption = mediaData.photos.length === 1
          ? `📸 ${baseText}`
          : `📸 图片 ${i + 1}/${mediaData.photos.length}`;

        await sendChatAction(chatId, 'upload_photo');

        // 图片优先 URL 直传
        const sent = await sendPhoto(chatId, photo.url, caption);
        if (!sent) {
          // URL 直传失败，下载后上传
          await updateStatusMessage(chatId, statusMessageId,
            `📥 下载图片 ${i + 1}/${mediaData.photos.length}...`);
          try {
            const file = await downloadFile(photo.url, 10 * 1024 * 1024);
            await uploadPhotoFile(chatId, file.buffer, file.contentType, caption);
          } catch (downloadErr) {
            console.error('Photo download failed:', downloadErr);
            await sendMessage(chatId, caption);
          }
        }
      }
    }

    // 处理视频
    if (mediaData.videos && mediaData.videos.length > 0) {
      await updateStatusMessage(chatId, statusMessageId,
        `🎬 正在处理 ${mediaData.videos.length} 个视频...`);

      for (let i = 0; i < mediaData.videos.length; i++) {
        const video = mediaData.videos[i];
        const videoCaption = `🎬 视频 ${i + 1}/${mediaData.videos.length}\n` +
          `📐 质量: ${video.quality || '未知'}\n` +
          `⏱️ 时长: ${video.duration || '未知'}` +
          `${mediaData.videos.length === 1 ? '\n\n' + baseText : ''}`;

        await sendChatAction(chatId, 'upload_video');

        // 选择最佳 video variant（含预估算过滤）
        const selected = selectVideoVariant(video, qualityPreference, MAX_VIDEO_SIZE);

        if (selected.url && !selected.reason) {
          const urlsToTry = [selected.url, ...(selected.fallbacks || [])];
          let videoSent = false;
          let triedUrl = '';

          for (const tryUrl of urlsToTry) {
            triedUrl = tryUrl;
            const tryInfo = tryUrl === selected.url && selected.estimatedSize
              ? ` (约 ${formatFileSize(selected.estimatedSize)})`
              : '';

            // 策略1: URL 直传
            await updateStatusMessage(chatId, statusMessageId,
              `📤 上传视频 ${i + 1}/${mediaData.videos.length}${tryInfo}...`);
            videoSent = await sendVideoByUrl(chatId, tryUrl, videoCaption);
            if (videoSent) break;

            // 策略2: 下载后上传
            await updateStatusMessage(chatId, statusMessageId,
              `📥 下载视频 ${i + 1}/${mediaData.videos.length}${tryInfo}...`);
            let savedPath = null;
            try {
              const file = await downloadFile(tryUrl, MAX_VIDEO_SIZE);

              const timestamp = Date.now();
              const filename = `twitter_${username}_${statusId}_${timestamp}.mp4`;
              savedPath = await saveToDisk(filename, file.buffer);

              await updateStatusMessage(chatId, statusMessageId,
                `📤 上传视频 ${i + 1}/${mediaData.videos.length} ` +
                `(${formatFileSize(file.size)})...`);
              videoSent = await uploadVideoFile(
                chatId, file.buffer, file.contentType, videoCaption, video.thumbnailUrl
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
                chatId, file.buffer, 'video.mp4', file.contentType, videoCaption
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
            await sendVideoLinks(chatId, video, i, mediaData.videos.length);
          } else if (video.variants && video.variants.length > 1) {
            // 上传成功，附带多清晰度链接
            await sendVideoLinks(chatId, video, i, mediaData.videos.length);
          }
        } else if (selected.reason === 'all_too_large') {
          await sendMessage(chatId,
            `⚠️ 视频文件过大（预估最小 ${formatFileSize(selected.minEstimatedSize)}，限制 ${SIZE_LABEL}）\n\n` +
            '正在发送链接，你可以在浏览器中下载...');
          await sendVideoLinks(chatId, video, i, mediaData.videos.length);
        } else {
          await sendMessage(chatId,
            '⚠️ 无法获取可用的视频下载链接\n\n正在发送链接...');
          await sendVideoLinks(chatId, video, i, mediaData.videos.length);
        }

        // 多视频时发送缩略图预览
        if (video.thumbnailUrl && mediaData.videos.length > 1) {
          await sendPhoto(chatId, video.thumbnailUrl,
            `📸 视频 ${i + 1}/${mediaData.videos.length} 封面`);
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

function selectVideoVariant(video, qualityPreference, maxSizeBytes) {
  let candidates = [];

  if (video.variants && video.variants.length > 0) {
    // fxtwitter 已按 bitrate 降序排列 variants
    const durationSeconds = parseFloat(video.duration) || 0;

    candidates = video.variants
      .filter(v => v.bitrate && v.bitrate > 0)
      .map(v => {
        // 预估文件大小: bitrate(bps) × duration(s) ÷ 8 = bytes
        // 加 15% 的容器/元数据开销
        const estimatedSize = durationSeconds > 0
          ? Math.ceil((v.bitrate * durationSeconds) / 8 * 1.15)
          : null;

        return {
          url: v.url,
          bitrate: v.bitrate || 0,
          estimatedSize
        };
      });

    // 高画质：取最高码率，不预过滤（由下载层实际检测大小）
    // 中/低画质：预过滤掉明显超限的 variant
    if (qualityPreference !== 'high') {
      const fittingCandidates = candidates.filter(c => {
        if (c.estimatedSize === null) return true;
        return c.estimatedSize <= maxSizeBytes;
      });

      if (candidates.length > 0 && fittingCandidates.length === 0) {
        const minEstimated = Math.min(...candidates.map(c => c.estimatedSize || Infinity));
        console.log(`All variants estimated too large. Min estimated: ${formatFileSize(minEstimated)}, max allowed: ${formatFileSize(maxSizeBytes)}`);
        return { url: null, reason: 'all_too_large', minEstimatedSize: minEstimated };
      }

      candidates = fittingCandidates.length > 0 ? fittingCandidates : candidates;
    }

  } else if (video.url) {
    // vxtwitter 单一 URL，无法预估大小
    return { url: video.url, reason: null };
  } else {
    return { url: null, reason: 'no_variants' };
  }

  if (candidates.length === 0) {
    return { url: null, reason: 'no_variants' };
  }

  // 根据画质偏好选择索引
  let selectedIndex;
  switch (qualityPreference) {
    case 'high':
      selectedIndex = 0;
      break;
    case 'medium':
      selectedIndex = Math.floor(candidates.length / 2);
      break;
    case 'low':
      selectedIndex = candidates.length - 1;
      break;
    default:
      selectedIndex = 0;
  }

  const selected = candidates[selectedIndex] || candidates[0];
  return {
    url: selected.url,
    reason: null,
    estimatedSize: selected.estimatedSize,
    availableCount: candidates.length,
    // 高画质模式：如果首选失败，提供其他 variant 供回退
    fallbacks: qualityPreference === 'high'
      ? candidates.slice(1).map(c => c.url)
      : []
  };
}

// ==================== 文件下载 ====================

async function downloadFile(url, maxSizeBytes) {
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

  // GET 下载
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error(`DOWNLOAD_FAILED: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('Content-Type') || 'application/octet-stream';

  // 检查 Content-Length
  const contentLength = response.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength) > maxSizeBytes) {
    throw new Error(`SIZE_EXCEEDED: ${formatFileSize(parseInt(contentLength))} > ${formatFileSize(maxSizeBytes)}`);
  }

  // 流式读取，超过限制时中止
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

async function uploadVideoFile(chatId, buffer, contentType, caption, thumbnailUrl) {
  try {
    const botToken = getBotToken();
    if (!botToken) return false;

    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    formData.append('video', new Blob([buffer], { type: contentType }), 'video.mp4');
    if (caption) formData.append('caption', caption);
    if (thumbnailUrl) formData.append('thumb', thumbnailUrl);
    formData.append('supports_streaming', 'true');

    console.log(`Uploading video: ${formatFileSize(buffer.byteLength)}`);

    const response = await fetch(`${getTelegramApiUrl()}/bot${botToken}/sendVideo`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(120000)
    });

    const result = await response.json();

    if (!result.ok) {
      console.error('sendVideo (multipart) failed:', result.description);
      return false;
    }

    console.log('Video uploaded successfully');
    return true;
  } catch (error) {
    console.error('Error uploading video:', error);
    return false;
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

async function uploadDocumentFile(chatId, buffer, filename, contentType, caption) {
  try {
    const botToken = getBotToken();
    if (!botToken) return false;

    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    formData.append('document', new Blob([buffer], { type: contentType }), filename);
    if (caption) formData.append('caption', caption);

    console.log(`Uploading document: ${formatFileSize(buffer.byteLength)}`);

    const response = await fetch(`${getTelegramApiUrl()}/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(120000)
    });

    const result = await response.json();

    if (!result.ok) {
      console.error('sendDocument failed:', result.description);
      return false;
    }

    console.log('Document uploaded successfully');
    return true;
  } catch (error) {
    console.error('Error uploading document:', error);
    return false;
  }
}

async function sendVideoByUrl(chatId, videoUrl, caption) {
  try {
    const botToken = getBotToken();
    if (!botToken) return false;

    console.log(`Sending video by URL: ${videoUrl.substring(0, 80)}...`);

    const response = await fetch(`${getTelegramApiUrl()}/bot${botToken}/sendVideo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        video: videoUrl,
        caption: caption,
        supports_streaming: true
      }),
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

async function sendVideoLinks(chatId, video, index, total) {
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

  await sendMessage(chatId, caption);
}

// ==================== 状态反馈 ====================

async function updateStatusMessage(chatId, messageId, text) {
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
      return await sendMessage(chatId, text);
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