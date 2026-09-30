import mongoose from 'mongoose';
import SocialMediaConnection from '../models/social-media-connection.model.js';
import SocialMediaPost from '../models/social-media-post.model.js';
import AIModel from '../models/ai-model.model.js';
import socialMediaService from '../services/social-media.service.js';
import axios from 'axios';
import { decrypt } from '../utils/encryption-utils.js';

const getDecryptedToken = (token) => {
  if (token && token.includes(':')) {
    try {
      return decrypt(token);
    } catch (e) {
      return token;
    }
  }
  return token;
};

const PLATFORM_CONTENT_TYPES = {
  facebook: ['post', 'story', 'reel', 'feed', 'video'],
  instagram: ['post', 'story', 'reel'],
  linkedin: ['post'],
  twitter: ['post'],
  youtube: ['videos', 'shorts'],
  threads: ['post'],
  tiktok: ['post']
};

const ALL_CONTENT_TYPES = [...new Set(Object.values(PLATFORM_CONTENT_TYPES).flat())];

export const publishContent = async (req, res) => {
  try {
    const {
      accountIds,
      mediaUrls,
      mediaUrl,
      caption,
      contentTypes,
      contentTypesMap,
      scheduled_at
    } = req.body;

    const userId = req.user?.owner_id || req.user?.id;
    const workspaceId = req.body?.workspace_id || req.query?.workspace_id || req.headers['x-workspace-id'];

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ success: false, error: 'accountIds must be a non-empty array' });
    }

    let scheduledDate = null;
    let isScheduled = false;
    if (scheduled_at) {
      scheduledDate = new Date(scheduled_at);
      if (isNaN(scheduledDate.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid scheduled_at date format' });
      }
      if (scheduledDate <= new Date(Date.now() - 60000)) {
        return res.status(400).json({ success: false, error: 'scheduled_at must be a future date/time' });
      }
      isScheduled = true;
    }

    // Fetch accounts from SocialMediaConnection, FacebookConnection pages, and InstagramConnection pages
    const { default: FacebookConnection } = await import('../models/facebook-connection.model.js');
    const { default: InstagramConnection } = await import('../models/instagram-connection.model.js');

    const accounts = [];

    // 1. Fetch from SocialMediaConnection
    const smAccounts = await SocialMediaConnection.find({
      _id: { $in: accountIds },
      workspace_id: workspaceId,
      is_active: true
    }).lean();
    accounts.push(...smAccounts);

    // 2. Fetch from FacebookConnection pages
    const fbConnections = await FacebookConnection.find({
      workspace_id: workspaceId,
      is_active: true,
      'pages._id': { $in: accountIds }
    }).lean();
    for (const conn of fbConnections) {
      if (conn.pages) {
        for (const page of conn.pages) {
          if (accountIds.includes(page._id.toString()) && page.is_active !== false) {
            accounts.push({
              _id: page._id,
              workspace_id: conn.workspace_id,
              platform: 'facebook',
              account_id: page.page_id,
              account_name: page.page_name,
              profile_picture: null,
              is_active: true
            });
          }
        }
      }
    }

    // 3. Fetch from InstagramConnection pages
    const igConnections = await InstagramConnection.find({
      workspace_id: workspaceId,
      is_active: true,
      'pages._id': { $in: accountIds }
    }).lean();
    for (const conn of igConnections) {
      if (conn.pages) {
        for (const page of conn.pages) {
          if (accountIds.includes(page._id.toString()) && page.is_active !== false) {
            accounts.push({
              _id: page._id,
              workspace_id: conn.workspace_id,
              platform: 'instagram',
              account_id: page.instagram_account_id,
              account_name: page.instagram_username || page.page_name,
              profile_picture: null,
              is_active: true
            });
          }
        }
      }
    }

    if (accounts.length === 0) {
      return res.status(404).json({ success: false, error: 'No active social accounts found' });
    }

    // Resolve and validate content types per account
    const postsToCreate = [];
    for (const account of accounts) {
      let types = (contentTypesMap && (contentTypesMap[account._id.toString()] || contentTypesMap[account._id])) || contentTypes;
      if (!types || (Array.isArray(types) && types.length === 0)) {
        return res.status(400).json({ success: false, error: `Content type is required for account: ${account.account_name}` });
      }
      const typesArray = Array.isArray(types) ? types : [types];
      for (const type of typesArray) {
        if (!ALL_CONTENT_TYPES.includes(type)) {
          return res.status(400).json({ success: false, error: `Invalid content type: ${type}` });
        }
        const allowed = PLATFORM_CONTENT_TYPES[account.platform] || [];
        if (!allowed.includes(type)) {
          return res.status(400).json({
            success: false,
            error: `${account.platform} account (${account.account_name}) does not support content type: ${type}`
          });
        }
        postsToCreate.push({ account, type });
      }
    }

    const finalMediaUrls = [];
    if (mediaUrls && Array.isArray(mediaUrls)) {
      finalMediaUrls.push(...mediaUrls);
    } else if (mediaUrl) {
      finalMediaUrls.push(mediaUrl);
    }

    if (finalMediaUrls.length === 0 && !caption) {
      return res.status(400).json({ success: false, error: 'Either mediaUrls or caption is required' });
    }

    const postHistoryRecords = [];

    for (const { account, type } of postsToCreate) {
      const socialPost = new SocialMediaPost({
        user_id: userId,
        workspace_id: workspaceId,
        connection_id: account._id,
        platform: account.platform,
        media_id: 'PENDING',
        content_type: type,
        caption: caption || '',
        media_urls: finalMediaUrls,
        media_url: finalMediaUrls[0] || null,
        status: isScheduled ? 'scheduled' : 'pending',
        scheduled_at: scheduledDate,
        published_at: isScheduled ? null : new Date(),
      });

      await socialPost.save();
      postHistoryRecords.push(socialPost);
    }

    if (isScheduled) {
      return res.status(202).json({
        success: true,
        message: `Post(s) scheduled successfully for ${scheduledDate.toISOString()}`,
        data: postHistoryRecords
      });
    }

    res.status(202).json({
      success: true,
      message: 'Publishing started in the background.',
      data: postHistoryRecords
    });

    const baseUrl = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
    (async () => {
      await Promise.allSettled(
        postHistoryRecords.map(async (record) => {
          try {
            await socialMediaService.publishContent(
              record._id,
              userId,
              record.media_urls,
              record.caption,
              record.content_type,
              record.platform,
              baseUrl
            );
          } catch (err) {
            console.error(`Background publish failed for post ${record._id}:`, err);
          }
        })
      );
    })();

  } catch (error) {
    console.error('[publishContent] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to publish content' });
  }
};

export const cancelScheduledPost = async (req, res) => {
  try {
    const { historyId } = req.params;
    const workspaceId = req.body?.workspace_id || req.query?.workspace_id || req.headers['x-workspace-id'];

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const post = await SocialMediaPost.findOne({ _id: historyId, workspace_id: workspaceId });
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post not found' });
    }

    if (post.status !== 'scheduled') {
      return res.status(400).json({ success: false, error: `Cannot cancel a post with status: ${post.status}` });
    }

    post.status = 'cancelled';
    await post.save();

    res.status(200).json({ success: true, message: 'Scheduled post cancelled successfully', data: post });
  } catch (error) {
    console.error('[cancelScheduledPost] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getPostHistory = async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.headers['x-workspace-id'];
    const { platform, status, content_type, search, page = 1, limit = 10 } = req.query;

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const query = {
      workspace_id: workspaceId,
      is_imported: { $ne: true },
      status: { $in: ['pending', 'scheduled', 'published', 'failed', 'cancelled'] }
    };
    if (platform) query.platform = { $in: platform.split(',') };
    if (status && status !== 'all') {
      query.status = { $in: status.split(',') };
    }
    if (content_type) query.content_type = { $in: content_type.split(',') };
    if (search) {
      query.$or = [
        { caption: { $regex: search, $options: 'i' } },
        { platform: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const posts = await SocialMediaPost.find(query)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const { default: FacebookConnection } = await import('../models/facebook-connection.model.js');
    const { default: InstagramConnection } = await import('../models/instagram-connection.model.js');

    const mappedPosts = [];
    for (const p of posts) {
      let accountInfo = null;

      if (p.platform === 'facebook') {
        const fbConn = await FacebookConnection.findOne({ 'pages._id': p.connection_id }).lean();
        if (fbConn && fbConn.pages) {
          const page = fbConn.pages.find(pg => pg._id.toString() === p.connection_id.toString());
          if (page) {
            accountInfo = {
              _id: page._id,
              account_name: page.page_name,
              account_username: page.page_name,
              platform: 'facebook',
              profile_picture: null
            };
          }
        }
      } else if (p.platform === 'instagram') {
        const igConn = await InstagramConnection.findOne({ 'pages._id': p.connection_id }).lean();
        if (igConn && igConn.pages) {
          const page = igConn.pages.find(pg => pg._id.toString() === p.connection_id.toString());
          if (page) {
            accountInfo = {
              _id: page._id,
              account_name: page.instagram_username || page.page_name,
              account_username: page.instagram_username || null,
              platform: 'instagram',
              profile_picture: null
            };
          }
        }
      } else {
        accountInfo = await SocialMediaConnection.findById(p.connection_id)
          .select('account_name account_username platform profile_picture')
          .lean();
      }

      mappedPosts.push({
        ...p,
        connection_id: accountInfo,
        account: accountInfo
      });
    }

    const total = await SocialMediaPost.countDocuments(query);

    res.status(200).json({
      success: true,
      data: mappedPosts,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('[getPostHistory] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch post history' });
  }
};

export const getPostById = async (req, res) => {
  try {
    const { historyId } = req.params;
    const workspaceId = req.query.workspace_id || req.headers['x-workspace-id'];

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const post = await SocialMediaPost.findOne({ _id: historyId, workspace_id: workspaceId })
      .populate('connection_id', 'account_name account_username platform profile_picture')
      .lean();

    if (!post) {
      return res.status(404).json({ success: false, error: 'Post not found' });
    }

    const mappedPost = {
      ...post,
      account: post.connection_id
    };

    res.status(200).json({ success: true, data: mappedPost });
  } catch (error) {
    console.error('[getPostById] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const deletePost = async (req, res) => {
  try {
    const { historyId } = req.params;
    const userId = req.user?.owner_id || req.user?.id;
    const workspaceId = req.body?.workspace_id || req.query?.workspace_id || req.headers['x-workspace-id'];

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const post = await SocialMediaPost.findOne({ _id: historyId, workspace_id: workspaceId });
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post not found' });
    }

    const result = await socialMediaService.deleteSocialPost(historyId, userId);
    res.status(200).json(result);
  } catch (error) {
    console.error('[deletePost] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to delete post' });
  }
};

export const validateMedia = async (req, res) => {
  try {
    const { mediaUrl, platform, contentType, contentTypes } = req.body;

    if (!mediaUrl) return res.status(400).json({ success: false, error: 'Media URL is required' });
    if (!platform) return res.status(400).json({ success: false, error: 'Platform is required' });

    const typesToValidate = contentTypes && Array.isArray(contentTypes)
      ? contentTypes
      : (contentType ? [contentType] : []);

    const validation = { valid: true, warnings: [], errors: [] };

    if (!/^https?:\/\/.+/i.test(mediaUrl)) {
      validation.valid = false;
      validation.errors.push('Invalid URL format');
    }

    const urlLower = mediaUrl.toLowerCase();
    const isImage = urlLower.match(/\.(jpg|jpeg|png|gif|webp)$/);
    const isVideo = urlLower.match(/\.(mp4|mov|avi|mkv|webm)$/);

    for (const type of typesToValidate) {
      if (platform === 'instagram') {
        if (type === 'story') validation.warnings.push('[Story] Instagram stories require 9:16 aspect ratio (1080x1920px)');
        else if (type === 'reel') {
          if (!isVideo) { validation.errors.push('[Reel] Instagram reels must be video files'); validation.valid = false; }
          validation.warnings.push('[Reel] Instagram reels require 9:16 aspect ratio and max 90 seconds');
        } else if (type === 'post') validation.warnings.push('[Post] Instagram posts support: 1:1, 4:5, or 1.91:1 aspect ratios');
      }
      if (platform === 'facebook') {
        if (type === 'story') validation.warnings.push('[Story] Facebook stories require 9:16 aspect ratio');
      }
      if (platform === 'linkedin') {
        if (isVideo) validation.warnings.push('[LinkedIn] Video posts on LinkedIn require MP4 format, max 5GB');
      }
    }

    res.status(200).json({ success: true, data: validation });
  } catch (error) {
    console.error('Error validating media:', error);
    res.status(500).json({ success: false, error: 'Failed to validate media' });
  }
};

export const getSupportedPlatforms = async (req, res) => {
  try {
    const platforms = {
      facebook: {
        name: 'Facebook',
        contentTypes: ['post', 'story', 'feed', 'reel', 'video'],
        mediaTypes: ['image', 'video', 'text'],
        maxCaptionLength: 63206
      },
      instagram: {
        name: 'Instagram',
        contentTypes: ['post', 'story', 'reel'],
        mediaTypes: ['image', 'video'],
        maxCaptionLength: 2000
      },
      linkedin: {
        name: 'LinkedIn',
        contentTypes: ['post'],
        mediaTypes: ['image', 'text'],
        maxCaptionLength: 3000
      },
      twitter: {
        name: 'Twitter / X',
        contentTypes: ['post'],
        mediaTypes: ['image', 'video', 'text'],
        maxCaptionLength: 280
      },
      youtube: {
        name: 'YouTube',
        contentTypes: ['videos', 'shorts'],
        mediaTypes: ['video'],
        maxCaptionLength: 5000
      },
      threads: {
        name: 'Threads',
        contentTypes: ['post'],
        mediaTypes: ['image', 'video', 'text'],
        maxCaptionLength: 500
      },
      tiktok: {
        name: 'TikTok',
        contentTypes: ['post'],
        mediaTypes: ['video'],
        maxCaptionLength: 2000
      }
    };

    res.status(200).json({ success: true, data: platforms });
  } catch (error) {
    console.error('Error getting supported platforms:', error);
    res.status(500).json({ success: false, error: 'Failed to get supported platforms' });
  }
};

export const generateCaption = async (req, res) => {
  try {
    const { platform, content_type, tone, language, character_limit, keywords, custom_prompt, num_captions } = req.body;
    const resolvedPlatform = platform || 'instagram';

    const defaultModel = await AIModel.findOne({ is_default: true, status: 'active' });
    if (!defaultModel) {
      return res.status(503).json({
        success: false,
        message: 'No default AI model configured for caption generation. Please contact admin.'
      });
    }

    const numCaptions = Math.min(parseInt(num_captions || 3), 5);
    const charLimit = character_limit || 2000;
    const postTone = tone || 'engaging and professional';
    const lang = language || 'English';

    let prompt = `Generate ${numCaptions} different social media captions for ${resolvedPlatform.charAt(0).toUpperCase() + resolvedPlatform.slice(1)}.\n`;
    prompt += `Content type: ${content_type || 'post'}\n`;
    prompt += `Tone: ${postTone}\n`;
    prompt += `Language: ${lang}\n`;
    prompt += `Character limit: ${charLimit} characters per caption\n`;
    if (keywords) prompt += `Keywords/topics to include: ${keywords}\n`;
    if (custom_prompt) prompt += `User's custom instructions: ${custom_prompt}\n`;
    prompt += `\nFormat your response strictly as a JSON array of strings, like this:\n["caption 1", "caption 2", "caption 3"]\n`;
    prompt += `Return ONLY the JSON array, no explanation or other text.`;

    const apiKey = getDecryptedToken(defaultModel.config?.api_key || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
    if (!apiKey) {
      return res.status(500).json({ success: false, error: 'AI provider API key not configured' });
    }

    let responseText = '';
    if (defaultModel.provider === 'google' || defaultModel.provider === 'gemini') {
      const response = await axios.post(`https://generativelanguage.googleapis.com/v1/models/${defaultModel.model_id}:generateContent?key=${apiKey}`, {
        contents: [{ parts: [{ text: prompt }] }]
      });
      responseText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (defaultModel.provider === 'openai') {
      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: defaultModel.model_id,
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      responseText = response.data.choices?.[0]?.message?.content || '';
    } else {
      throw new Error(`Unsupported AI model provider: ${defaultModel.provider}`);
    }

    let captions = [];
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        captions = JSON.parse(jsonMatch[0]);
      } else {
        captions = [responseText.trim()];
      }
    } catch (e) {
      captions = [responseText.trim()];
    }

    res.status(200).json({
      success: true,
      data: {
        captions,
        platform: resolvedPlatform,
        content_type: content_type || 'post'
      }
    });
  } catch (error) {
    console.error('Error generating caption:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to generate captions' });
  }
};

export const saveDraft = async (req, res) => {
  try {
    const {
      accountIds,
      mediaUrls,
      mediaUrl,
      caption,
      contentTypes,
      scheduled_at,
      title
    } = req.body;

    const userId = req.user?.owner_id || req.user?.id;
    const workspaceId = req.body?.workspace_id || req.query?.workspace_id || req.headers['x-workspace-id'];

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ success: false, error: 'accountIds must be a non-empty array' });
    }

    if (!contentTypes || !Array.isArray(contentTypes) || contentTypes.length === 0) {
      return res.status(400).json({ success: false, error: 'contentTypes must be a non-empty array' });
    }

    // Fetch accounts from SocialMediaConnection, FacebookConnection pages, and InstagramConnection pages
    const { default: FacebookConnection } = await import('../models/facebook-connection.model.js');
    const { default: InstagramConnection } = await import('../models/instagram-connection.model.js');

    const accounts = [];

    // 1. Fetch from SocialMediaConnection
    const smAccounts = await SocialMediaConnection.find({
      _id: { $in: accountIds },
      workspace_id: workspaceId,
      is_active: true
    }).lean();
    accounts.push(...smAccounts);

    // 2. Fetch from FacebookConnection pages
    const fbConnections = await FacebookConnection.find({
      workspace_id: workspaceId,
      is_active: true,
      'pages._id': { $in: accountIds }
    }).lean();
    for (const conn of fbConnections) {
      if (conn.pages) {
        for (const page of conn.pages) {
          if (accountIds.includes(page._id.toString()) && page.is_active !== false) {
            accounts.push({
              _id: page._id,
              workspace_id: conn.workspace_id,
              platform: 'facebook',
              account_id: page.page_id,
              account_name: page.page_name,
              profile_picture: null,
              is_active: true
            });
          }
        }
      }
    }

    // 3. Fetch from InstagramConnection pages
    const igConnections = await InstagramConnection.find({
      workspace_id: workspaceId,
      is_active: true,
      'pages._id': { $in: accountIds }
    }).lean();
    for (const conn of igConnections) {
      if (conn.pages) {
        for (const page of conn.pages) {
          if (accountIds.includes(page._id.toString()) && page.is_active !== false) {
            accounts.push({
              _id: page._id,
              workspace_id: conn.workspace_id,
              platform: 'instagram',
              account_id: page.instagram_account_id,
              account_name: page.instagram_username || page.page_name,
              profile_picture: null,
              is_active: true
            });
          }
        }
      }
    }

    if (accounts.length === 0) {
      return res.status(404).json({ success: false, error: 'No active social accounts found' });
    }

    const finalMediaUrls = [];
    if (mediaUrls && Array.isArray(mediaUrls)) {
      finalMediaUrls.push(...mediaUrls);
    } else if (mediaUrl) {
      finalMediaUrls.push(mediaUrl);
    }

    let scheduledDate = null;
    if (scheduled_at) {
      scheduledDate = new Date(scheduled_at);
    }

    const draftRecords = [];

    for (const type of contentTypes) {
      for (const account of accounts) {
        const socialPost = new SocialMediaPost({
          user_id: userId,
          workspace_id: workspaceId,
          connection_id: account._id,
          platform: account.platform,
          media_id: 'PENDING',
          content_type: type,
          caption: caption || '',
          media_urls: finalMediaUrls,
          media_url: finalMediaUrls[0] || null,
          status: 'draft',
          scheduled_at: scheduledDate,
          metadata: { title }
        });

        await socialPost.save();
        draftRecords.push(socialPost);
      }
    }

    res.status(201).json({ success: true, message: 'Draft saved successfully', data: draftRecords });
  } catch (error) {
    console.error('Error saving draft:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to save draft' });
  }
};

export const getDrafts = async (req, res) => {
  try {
    const workspaceId = req.query.workspace_id || req.headers['x-workspace-id'];
    const { search, page = 1, limit = 20 } = req.query;

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const query = { workspace_id: workspaceId, status: 'draft' };
    if (search) {
      query.$or = [
        { caption: { $regex: search, $options: 'i' } },
        { platform: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const drafts = await SocialMediaPost.find(query)
      .populate('connection_id', 'account_name account_username platform profile_picture')
      .sort({ updated_at: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const mappedDrafts = drafts.map(d => ({
      ...d,
      account: d.connection_id
    }));

    const total = await SocialMediaPost.countDocuments(query);

    res.status(200).json({
      success: true,
      data: mappedDrafts,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('Error fetching drafts:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch drafts' });
  }
};

export const getDraftById = async (req, res) => {
  try {
    const { draftId } = req.params;
    const workspaceId = req.query.workspace_id || req.headers['x-workspace-id'];

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const draft = await SocialMediaPost.findOne({ _id: draftId, workspace_id: workspaceId, status: 'draft' })
      .populate('connection_id', 'account_name account_username platform profile_picture')
      .lean();

    if (!draft) return res.status(404).json({ success: false, error: 'Draft not found' });

    const mappedDraft = {
      ...draft,
      account: draft.connection_id
    };

    res.status(200).json({ success: true, data: mappedDraft });
  } catch (error) {
    console.error('Error fetching draft:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch draft' });
  }
};

export const updateDraft = async (req, res) => {
  try {
    const { draftId } = req.params;
    const workspaceId = req.body?.workspace_id || req.query?.workspace_id || req.headers['x-workspace-id'];
    const { accountIds, caption, mediaUrls, mediaUrl, contentTypes, scheduled_at, title } = req.body;

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const finalMediaUrls = [];
    if (mediaUrls && Array.isArray(mediaUrls)) {
      finalMediaUrls.push(...mediaUrls);
    } else if (mediaUrl) {
      finalMediaUrls.push(mediaUrl);
    }

    const updateFields = {
      caption,
      media_urls: finalMediaUrls,
      media_url: finalMediaUrls[0] || null,
      scheduled_at: scheduled_at ? new Date(scheduled_at) : null,
      metadata: { title }
    };

    if (accountIds && accountIds.length > 0) {
      updateFields.connection_id = accountIds[0];
    }
    if (contentTypes && contentTypes.length > 0) {
      updateFields.content_type = contentTypes[0];
    }

    const draft = await SocialMediaPost.findOneAndUpdate(
      { _id: draftId, workspace_id: workspaceId, status: 'draft' },
      updateFields,
      { new: true, runValidators: true }
    ).populate('connection_id', 'account_name account_username platform profile_picture')
      .lean();

    if (!draft) return res.status(404).json({ success: false, error: 'Draft not found' });

    const mappedDraft = {
      ...draft,
      account: draft.connection_id
    };

    res.status(200).json({ success: true, message: 'Draft updated successfully', data: mappedDraft });
  } catch (error) {
    console.error('Error updating draft:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to update draft' });
  }
};

export const deleteDraft = async (req, res) => {
  try {
    const { draftId } = req.params;
    const workspaceId = req.body?.workspace_id || req.query?.workspace_id || req.headers['x-workspace-id'];

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    const draft = await SocialMediaPost.findOneAndDelete({ _id: draftId, workspace_id: workspaceId, status: 'draft' });
    if (!draft) return res.status(404).json({ success: false, error: 'Draft not found' });

    res.status(200).json({ success: true, message: 'Draft deleted successfully' });
  } catch (error) {
    console.error('Error deleting draft:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to delete draft' });
  }
};

export const bulkPublish = async (req, res) => {
  try {
    const { posts, settings } = req.body;
    const userId = req.user?.owner_id || req.user?.id;
    const workspaceId = req.body?.workspace_id || req.query?.workspace_id || req.headers['x-workspace-id'];

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }

    if (!posts || !Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ success: false, error: 'posts must be a non-empty array' });
    }

    if (posts.length > 100) {
      return res.status(400).json({ success: false, error: 'Maximum 100 posts allowed per bulk request' });
    }

    const results = [];
    const errors = [];
    const { stopOnError = true } = settings || {};

    const baseUrl = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000';

    for (let i = 0; i < posts.length; i++) {
      const postItem = posts[i];
      const { accountIds, caption, contentTypes, scheduled_at, mediaUrls, mediaUrl } = postItem;

      try {
        if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
          throw new Error('accountIds is required');
        }

        const types = contentTypes && Array.isArray(contentTypes) && contentTypes.length > 0
          ? contentTypes
          : ['post'];

        for (const type of types) {
          if (!ALL_CONTENT_TYPES.includes(type)) {
            throw new Error(`Invalid content type: ${type}`);
          }
        }

        let scheduledDate = null;
        let isScheduled = false;
        if (scheduled_at) {
          scheduledDate = new Date(scheduled_at);
          if (isNaN(scheduledDate.getTime())) {
            throw new Error('Invalid scheduled_at date format');
          }
          if (scheduledDate <= new Date(Date.now() - 60000)) {
            throw new Error('scheduled_at must be a future date/time');
          }
          isScheduled = true;
        }

        const accounts = await SocialMediaConnection.find({
          _id: { $in: accountIds },
          workspace_id: workspaceId,
          is_active: true
        });

        if (accounts.length === 0) {
          throw new Error('No active social accounts found');
        }

        const finalMediaUrls = [];
        if (mediaUrls && Array.isArray(mediaUrls)) {
          finalMediaUrls.push(...mediaUrls);
        } else if (mediaUrl) {
          finalMediaUrls.push(mediaUrl);
        }

        if (finalMediaUrls.length === 0 && !caption) {
          throw new Error('Either mediaUrls or caption is required');
        }

        const postHistoryRecords = [];

        for (const type of types) {
          for (const account of accounts) {
            const socialPost = new SocialMediaPost({
              user_id: userId,
              workspace_id: workspaceId,
              connection_id: account._id,
              platform: account.platform,
              media_id: 'PENDING',
              content_type: type,
              caption: caption || '',
              media_urls: finalMediaUrls,
              media_url: finalMediaUrls[0] || null,
              status: isScheduled ? 'scheduled' : 'pending',
              scheduled_at: scheduledDate,
              published_at: isScheduled ? null : new Date(),
            });

            await socialPost.save();
            postHistoryRecords.push(socialPost);
          }
        }

        if (!isScheduled) {
          (async () => {
            for (const record of postHistoryRecords) {
              try {
                await socialMediaService.publishContent(
                  record._id,
                  userId,
                  record.media_urls,
                  record.caption,
                  record.content_type,
                  record.platform,
                  baseUrl
                );
              } catch (err) {
                console.error(`Bulk background publish failed for post ${record._id}:`, err);
              }
            }
          })();
        }

        results.push({ index: i, success: true, posts: postHistoryRecords });

      } catch (itemError) {
        errors.push({ index: i, error: itemError.message, item: postItem });
        if (stopOnError) break;
      }
    }

    return res.status(200).json({
      success: true,
      message: `Bulk publish completed: ${results.length} succeeded, ${errors.length} failed.`,
      data: {
        succeeded: results,
        failed: errors,
        summary: { total: posts.length, succeeded: results.length, failed: errors.length }
      }
    });

  } catch (error) {
    console.error('Error in bulk publish:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to process bulk publish' });
  }
};

