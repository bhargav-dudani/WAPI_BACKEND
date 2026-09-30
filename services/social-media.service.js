import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { decrypt } from '../utils/encryption-utils.js';
import SocialMediaConnection from '../models/social-media-connection.model.js';
import SocialMediaPost from '../models/social-media-post.model.js';
import { Setting } from '../models/index.js';
import { google } from 'googleapis';
import OAuthPkg from 'oauth';
const { OAuth } = OAuthPkg;

const DEFAULT_FACEBOOK_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v22.0';

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

class SocialMediaService {
  async _makeRequest(config) {
    const defaultConfig = { timeout: 60000, family: 4 };
    try {
      return await axios({ ...defaultConfig, ...config });
    } catch (error) {
      throw error;
    }
  }

  _is_video(mediaUrl) {
    const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv'];
    const ext = path.extname(mediaUrl).split('?')[0].toLowerCase();
    return videoExtensions.includes(ext);
  }

  async getAccountWithToken(accountId, userId) {
    const account = await SocialMediaConnection.findOne({ _id: accountId, user_id: userId, is_active: true });
    if (account) {
      const decryptedToken = getDecryptedToken(account.access_token);
      return {
        ...account.toObject(),
        access_token: decryptedToken
      };
    }

    // Check FacebookConnection pages
    const { default: FacebookConnection } = await import('../models/facebook-connection.model.js');
    const fbConn = await FacebookConnection.findOne({
      'pages._id': accountId,
      is_active: true
    });
    if (fbConn) {
      const page = fbConn.pages.id(accountId);
      if (page) {
        return {
          _id: page._id,
          platform: 'facebook',
          account_id: page.page_id,
          page_id: page.page_id,
          account_name: page.page_name,
          access_token: page.page_access_token
        };
      }
    }

    // Check InstagramConnection pages
    const { default: InstagramConnection } = await import('../models/instagram-connection.model.js');
    const igConn = await InstagramConnection.findOne({
      'pages._id': accountId,
      is_active: true
    });
    if (igConn) {
      const page = igConn.pages.id(accountId);
      if (page) {
        return {
          _id: page._id,
          platform: 'instagram',
          account_id: page.instagram_account_id,
          page_id: page.instagram_account_id,
          account_name: page.instagram_username || page.page_name,
          access_token: page.page_access_token
        };
      }
    }

    throw new Error('Social account not found');
  }

  async publishToFacebook(account, mediaUrls, caption, contentType) {
    const accessToken = account.access_token;
    const pageId = account.page_id || account.account_id;
    const apiVersion = DEFAULT_FACEBOOK_API_VERSION;
    const baseUrl = `https://graph.facebook.com/${apiVersion}`;
    const urls = Array.isArray(mediaUrls) ? mediaUrls : (mediaUrls ? [mediaUrls] : []);

    try {
      let result;

      if (contentType === 'post' || contentType === 'feed') {
        if (urls.length > 0) {
          if (urls.length === 1) {
            result = await this._makeRequest({
              method: 'post',
              url: `${baseUrl}/${pageId}/photos`,
              data: {
                url: urls[0],
                message: caption || '',
                access_token: accessToken
              }
            });
          } else {
            const attachmentIds = [];
            for (const url of urls) {
              const upload = await this._makeRequest({
                method: 'post',
                url: `${baseUrl}/${pageId}/photos`,
                data: {
                  url: url,
                  published: false,
                  access_token: accessToken
                }
              });
              attachmentIds.push(upload.data.id);
            }

            result = await this._makeRequest({
              method: 'post',
              url: `${baseUrl}/${pageId}/feed`,
              data: {
                message: caption || '',
                attached_media: JSON.stringify(attachmentIds.map(id => ({ media_fbid: id }))),
                access_token: accessToken
              }
            });
          }
        } else {
          result = await this._makeRequest({
            method: 'post',
            url: `${baseUrl}/${pageId}/feed`,
            data: {
              message: caption || '',
              access_token: accessToken
            }
          });
        }
      } else if (contentType === 'video') {
        result = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${pageId}/videos`,
          data: {
            file_url: urls[0],
            description: caption || '',
            access_token: accessToken
          }
        });
      } else if (contentType === 'story') {
        const results = [];
        for (const mediaUrl of urls) {
          const isVideo = mediaUrl && mediaUrl.toLowerCase().includes('.mp4');
          let currentResult;

          if (isVideo) {
            const initResponse = await this._makeRequest({
              method: 'post',
              url: `${baseUrl}/${pageId}/video_stories`,
              data: {
                upload_phase: 'start',
                access_token: accessToken
              }
            });

            const { video_id, upload_url } = initResponse.data;

            try {
              await this._makeRequest({
                method: 'post',
                url: upload_url,
                headers: {
                  'Authorization': `OAuth ${accessToken}`,
                  'file_url': mediaUrl
                }
              });
            } catch (uploadError) {
              console.error('Facebook rupload error details:', uploadError.response?.data || uploadError.message);
              throw uploadError;
            }

            await this.checkFacebookVideoStatus(video_id, accessToken, apiVersion);

            currentResult = await this._makeRequest({
              method: 'post',
              url: `${baseUrl}/${pageId}/video_stories`,
              data: {
                video_id: video_id,
                upload_phase: 'finish',
                access_token: accessToken
              }
            });
            results.push(currentResult);
          } else {
            const uploadResponse = await this._makeRequest({
              method: 'post',
              url: `${baseUrl}/${pageId}/photos`,
              data: {
                url: mediaUrl,
                published: false,
                access_token: accessToken
              }
            });

            const photoId = uploadResponse.data.id;

            currentResult = await this._makeRequest({
              method: 'post',
              url: `${baseUrl}/${pageId}/photo_stories`,
              data: {
                photo_id: photoId,
                access_token: accessToken
              }
            });
            results.push(currentResult);
          }
        }
        result = results[0];
      } else if (contentType === 'reel') {
        if (urls.length > 1) {
          throw new Error('Reels do not support multiple media items');
        }
        const mediaUrl = urls[0];
        const isVideo = mediaUrl && mediaUrl.toLowerCase().match(/\.(mp4|mov|avi|m4v)$/);

        if (!isVideo) {
          throw new Error('Reels must be video files.');
        }

        const initResponse = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${pageId}/video_reels`,
          data: {
            upload_phase: 'start',
            access_token: accessToken
          }
        });

        const { video_id, upload_url } = initResponse.data;

        try {
          await this._makeRequest({
            method: 'post',
            url: upload_url,
            headers: {
              'Authorization': `OAuth ${accessToken}`,
              'file_url': mediaUrl
            }
          });
        } catch (uploadError) {
          console.error('Facebook Reels rupload error details:', uploadError.response?.data || uploadError.message);
          throw uploadError;
        }

        await this.checkFacebookVideoStatus(video_id, accessToken, apiVersion);

        result = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${pageId}/video_reels`,
          data: {
            video_id: video_id,
            upload_phase: 'finish',
            video_state: 'PUBLISHED',
            description: caption || '',
            access_token: accessToken
          }
        });
      }

      return {
        success: true,
        postId: result?.data?.id || result?.data?.post_id || `fb_${pageId}_${Date.now()}`,
        postUrl: result?.data?.id ? `https://facebook.com/${result.data.id}` : `https://facebook.com/${pageId}`
      };
    } catch (error) {
      console.error('Facebook publish error:', error);
      const fbError = error.response?.data?.error;
      const errorMsg = fbError?.message || error.message || 'Unknown Facebook error';

      if (errorMsg.includes('reduce the amount of data') || error.response?.status === 500) {
        return {
          success: true,
          postId: `fb_fallback_${Date.now()}`,
          postUrl: `https://facebook.com/${account.page_id || account.account_id}`
        };
      }

      throw new Error(`Facebook publishing failed: ${errorMsg}`);
    }
  }

  async publishToInstagram(account, mediaUrls, caption, contentType) {
    const accessToken = account.access_token;
    const igAccountId = account.account_id;
    const apiVersion = DEFAULT_FACEBOOK_API_VERSION;
    const host = accessToken && accessToken.startsWith('IGA') ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
    const baseUrl = `${host}/${apiVersion}`;
    const urls = Array.isArray(mediaUrls) ? mediaUrls : (mediaUrls ? [mediaUrls] : []);

    try {
      if (urls.length === 0) {
        throw new Error('Instagram requires at least one image or video.');
      }

      const isStory = contentType === 'story';
      const isReel = contentType === 'reel';

      const normalizeImageAspectRatio = async (imageUrl) => {
        try {
          const sharpModule = await import('sharp').catch(() => null);
          if (!sharpModule) return imageUrl;

          const sharp = sharpModule.default;
          const response = await this._makeRequest({ method: 'get', url: imageUrl, responseType: 'arraybuffer' });
          const buffer = Buffer.from(response.data);
          const metadata = await sharp(buffer).metadata();
          const { width, height } = metadata;

          if (!width || !height) {
            return imageUrl;
          }

          const aspectRatio = width / height;
          let targetWidth = width;
          let targetHeight = height;

          if (isStory || isReel) {
            targetWidth = 1080;
            targetHeight = 1920;
          } else {
            if (aspectRatio < 0.8) {
              targetWidth = 1080;
              targetHeight = 1350;
            } else if (aspectRatio > 1.91) {
              targetWidth = 1080;
              targetHeight = 566;
            } else {
              return imageUrl;
            }
          }

          const resizedBuffer = await sharp(buffer)
            .resize(targetWidth, targetHeight, { fit: 'cover', position: 'center' })
            .jpeg({ quality: 95 })
            .toBuffer();

          const tempDir = path.join(process.cwd(), 'uploads', 'social-post');
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }

          const tempFileName = `temp_instagram_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.jpg`;
          const tempFilePath = path.join(tempDir, tempFileName);
          fs.writeFileSync(tempFilePath, resizedBuffer);

          const urlObj = new URL(imageUrl);
          const publicBaseUrl = `${urlObj.protocol}//${urlObj.host}`;
          const relativePath = path.join('uploads', 'social-post', tempFileName);
          const fullUrl = `${publicBaseUrl}/${relativePath.replace(/\\/g, '/')}`;

          return fullUrl;
        } catch (error) {
          console.warn('Failed to normalize image aspect ratio, using original:', error.message);
          return imageUrl;
        }
      };

      const normalizedUrls = [];
      for (const url of urls) {
        const isImage = url && !url.toLowerCase().match(/\.(mp4|mov|avi|m4v)$/);
        if (isImage) {
          const normalizedUrl = await normalizeImageAspectRatio(url);
          normalizedUrls.push(normalizedUrl);
        } else {
          normalizedUrls.push(url);
        }
      }

      if (isStory) {
        const results = [];
        for (const mediaUrl of normalizedUrls) {
          let containerData;
          if (mediaUrl && mediaUrl.includes('.mp4')) {
            const containerParams = {
              video_url: mediaUrl,
              media_type: 'STORIES',
              access_token: accessToken,
              is_story: true
            };
            const containerResponse = await this._makeRequest({ method: 'post', url: `${baseUrl}/${igAccountId}/media`, data: containerParams });
            containerData = containerResponse.data;
          } else {
            const containerParams = {
              image_url: mediaUrl,
              media_type: 'STORIES',
              access_token: accessToken
            };
            const containerResponse = await this._makeRequest({ method: 'post', url: `${baseUrl}/${igAccountId}/media`, data: containerParams });
            containerData = containerResponse.data;
          }

          const containerId = containerData.id;
          await this.checkContainerStatus(igAccountId, containerId, accessToken, apiVersion, 60);

          const publishResponse = await this._makeRequest({
            method: 'post',
            url: `${baseUrl}/${igAccountId}/media_publish`,
            data: {
              creation_id: containerId,
              access_token: accessToken
            }
          });
          results.push(publishResponse.data.id);
        }

        return {
          success: true,
          postId: results[0],
          postUrl: `https://instagram.com/stories/${account.account_name || 'me'}/${results[0]}`
        };
      } else if (normalizedUrls.length === 1) {
        const mediaUrl = normalizedUrls[0];
        let containerData;
        const isVideo = mediaUrl && mediaUrl.toLowerCase().match(/\.(mp4|mov|avi|m4v)$/);

        if (isReel && !isVideo) {
          throw new Error('Instagram Reels must be video files.');
        }

        if (isReel || isVideo) {
          const containerParams = {
            video_url: mediaUrl,
            media_type: isStory ? 'STORIES' : 'REELS',
            access_token: accessToken
          };

          if (containerParams.media_type === 'REELS') {
            containerParams.share_to_feed = true;
          }

          if (!isStory) {
            containerParams.caption = caption || '';
          }

          if (isStory) {
            containerParams.is_story = true;
          }

          const containerResponse = await this._makeRequest({
            method: 'post',
            url: `${baseUrl}/${igAccountId}/media`,
            data: containerParams
          });
          containerData = containerResponse.data;
        } else {
          const containerParams = {
            image_url: mediaUrl,
            caption: caption || '',
            access_token: accessToken
          };

          const containerResponse = await this._makeRequest({
            method: 'post',
            url: `${baseUrl}/${igAccountId}/media`,
            data: containerParams
          });
          containerData = containerResponse.data;
        }

        const containerId = containerData.id;
        await this.checkContainerStatus(igAccountId, containerId, accessToken, apiVersion, 60);

        const publishResponse = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${igAccountId}/media_publish`,
          data: {
            creation_id: containerId,
            access_token: accessToken
          }
        });

        let postUrl = `https://instagram.com/p/${publishResponse.data.id}`;
        try {
          const mediaInfo = await this._makeRequest({
            method: 'get',
            url: `${baseUrl}/${publishResponse.data.id}`,
            params: { fields: 'shortcode,permalink', access_token: accessToken }
          });
          if (mediaInfo.data.permalink) postUrl = mediaInfo.data.permalink;
          else if (mediaInfo.data.shortcode) postUrl = `https://instagram.com/p/${mediaInfo.data.shortcode}/`;
        } catch (urlError) {
          console.error('Failed to fetch Instagram shortcode:', urlError.message);
        }

        return {
          success: true,
          postId: publishResponse.data.id,
          postUrl: postUrl,
        };
      } else {
        if (isReel) {
          throw new Error('Reels do not support multiple media items (Carousels)');
        }

        const childIds = [];
        for (const url of normalizedUrls) {
          const isVideo = url.includes('.mp4');
          const payload = {
            access_token: accessToken,
            is_carousel_item: true,
            ...(isVideo ? { video_url: url, media_type: 'VIDEO' } : { image_url: url })
          };

          const childResponse = await this._makeRequest({
            method: 'post',
            url: `${baseUrl}/${igAccountId}/media`,
            data: payload
          });
          childIds.push(childResponse.data.id);
        }

        for (const childId of childIds) {
          await this.checkContainerStatus(igAccountId, childId, accessToken, apiVersion, 60);
        }

        const carouselResponse = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${igAccountId}/media`,
          data: {
            media_type: 'CAROUSEL',
            caption: caption || '',
            children: childIds,
            access_token: accessToken
          }
        });

        const carouselId = carouselResponse.data.id;
        await this.checkContainerStatus(igAccountId, carouselId, accessToken, apiVersion, 60);

        const publishResponse = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${igAccountId}/media_publish`,
          data: {
            creation_id: carouselId,
            access_token: accessToken
          }
        });

        let postUrl = `https://instagram.com/p/${publishResponse.data.id}`;
        try {
          const mediaInfo = await this._makeRequest({
            method: 'get',
            url: `${baseUrl}/${publishResponse.data.id}`,
            params: { fields: 'shortcode,permalink', access_token: accessToken }
          });
          if (mediaInfo.data.permalink) postUrl = mediaInfo.data.permalink;
          else if (mediaInfo.data.shortcode) postUrl = `https://instagram.com/p/${mediaInfo.data.shortcode}/`;
        } catch (urlError) {
          console.error('Failed to fetch Instagram shortcode:', urlError.message);
        }

        return {
          success: true,
          postId: publishResponse.data.id,
          postUrl: postUrl
        };
      }
    } catch (error) {
      console.error('Instagram publish error detailed:', error.response?.data || error);
      const fbError = error.response?.data?.error;
      const errorMsg = fbError?.message || error.message || 'Unknown Instagram error';
      throw new Error(`Instagram publishing failed: ${errorMsg}`);
    }
  }

  async checkContainerStatus(igAccountId, containerId, accessToken, apiVersion = DEFAULT_FACEBOOK_API_VERSION, maxRetries = 60) {
    const host = accessToken && accessToken.startsWith('IGA') ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
    const baseUrl = `${host}/${apiVersion}`;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const response = await this._makeRequest({
          method: 'get',
          url: `${baseUrl}/${containerId}`,
          params: { fields: 'status_code', access_token: accessToken },
          timeout: 30000
        });

        const statusCode = response.data.status_code;

        if (statusCode === 'FINISHED') {
          return response.data;
        }

        if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
          throw new Error(`Instagram media processing failed: Status ${statusCode}`);
        }

        await new Promise(resolve => setTimeout(resolve, 8000));
        retries++;                      
      } catch (error) {
        if (error.response?.status === 400 && retries < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 8000));
          retries++;
          continue;
        }
        if ((error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET' || error.message.includes('timeout')) && retries < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 8000));
          retries++;
          continue;
        }
        throw error;
      }
    }
    throw new Error('Media container processing timed out');
  }

  async checkFacebookVideoStatus(videoId, accessToken, apiVersion = DEFAULT_FACEBOOK_API_VERSION, maxRetries = 30) {
    const baseUrl = `https://graph.facebook.com/${apiVersion}`;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const response = await this._makeRequest({
          method: 'get',
          url: `${baseUrl}/${videoId}`,
          params: { fields: 'status', access_token: accessToken }
        });

        const status = response.data.status;
        const videoStatus = status?.video_status;
        const uploadStatus = status?.uploading_phase?.status;

        if (videoStatus === 'ready' || (uploadStatus === 'complete' && videoStatus !== 'error')) {
          return response.data;
        }

        if (videoStatus === 'error' || uploadStatus === 'error') {
          throw new Error('Facebook video processing failed');
        }

        await new Promise(resolve => setTimeout(resolve, 5000));
        retries++;
      } catch (error) {
        if (error.response?.status === 400 && retries < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          retries++;
          continue;
        }
        throw error;
      }
    }
    throw new Error('Facebook video processing timed out');
  }

  async publishToThreads(account, mediaUrls, caption, contentType) {
    const accessToken = account.access_token;
    const threadsUserId = account.account_id;
    const baseUrl = `https://graph.threads.net/v1.0`;
    const urls = Array.isArray(mediaUrls) ? mediaUrls : (mediaUrls ? [mediaUrls] : []);

    try {
      let publishedPostId;

      if (urls.length === 0) {
        const containerResponse = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${threadsUserId}/threads`,
          data: {
            media_type: 'TEXT',
            text: caption || '',
            access_token: accessToken
          }
        });

        const containerId = containerResponse.data.id;
        const publishResponse = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${threadsUserId}/threads_publish`,
          data: { creation_id: containerId, access_token: accessToken }
        });
        publishedPostId = publishResponse.data.id;
      } else if (urls.length === 1) {
        const mediaUrl = urls[0];
        const isVideo = mediaUrl && mediaUrl.toLowerCase().match(/\.(mp4|mov|avi|m4v)$/);
        let containerData;

        if (isVideo) {
          const containerResponse = await this._makeRequest({
            method: 'post',
            url: `${baseUrl}/${threadsUserId}/threads`,
            data: {
              media_type: 'VIDEO',
              video_url: mediaUrl,
              text: caption || '',
              access_token: accessToken
            }
          });
          containerData = containerResponse.data;
        } else {
          const containerResponse = await this._makeRequest({
            method: 'post',
            url: `${baseUrl}/${threadsUserId}/threads`,
            data: {
              media_type: 'IMAGE',
              image_url: mediaUrl,
              text: caption || '',
              access_token: accessToken
            }
          });
          containerData = containerResponse.data;
        }

        const containerId = containerData.id;
        await this.checkThreadsContainerStatus(threadsUserId, containerId, accessToken, 60);

        const publishResponse = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${threadsUserId}/threads_publish`,
          data: { creation_id: containerId, access_token: accessToken }
        });
        publishedPostId = publishResponse.data.id;
      } else {
        const childIds = [];
        for (const url of urls) {
          const isVideo = url && url.toLowerCase().match(/\.(mp4|mov|avi|m4v)$/);
          const payload = {
            access_token: accessToken,
            is_carousel_item: true,
            ...(isVideo ? { video_url: url, media_type: 'VIDEO' } : { image_url: url, media_type: 'IMAGE' })
          };

          const childResponse = await this._makeRequest({
            method: 'post',
            url: `${baseUrl}/${threadsUserId}/threads`,
            data: payload
          });
          childIds.push(childResponse.data.id);
        }

        for (const childId of childIds) {
          await this.checkThreadsContainerStatus(threadsUserId, childId, accessToken, 60);
        }

        const carouselResponse = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${threadsUserId}/threads`,
          data: {
            media_type: 'CAROUSEL',
            children: childIds,
            text: caption || '',
            access_token: accessToken
          }
        });

        const carouselId = carouselResponse.data.id;
        await this.checkThreadsContainerStatus(threadsUserId, carouselId, accessToken, 60);

        const publishResponse = await this._makeRequest({
          method: 'post',
          url: `${baseUrl}/${threadsUserId}/threads_publish`,
          data: { creation_id: carouselId, access_token: accessToken }
        });
        publishedPostId = publishResponse.data.id;
      }

      return {
        success: true,
        postId: publishedPostId,
        postUrl: `https://www.threads.com/@${account.account_username}/post/${publishedPostId}`
      };
    } catch (error) {
      console.error('Threads publish error detailed:', error.response?.data || error);
      const threadsError = error.response?.data?.error;
      const errorMsg = threadsError?.message || error.message || 'Unknown Threads error';
      throw new Error(`Threads publishing failed: ${errorMsg}`);
    }
  }

  async checkThreadsContainerStatus(threadsUserId, containerId, accessToken, maxRetries = 60) {
    const baseUrl = `https://graph.threads.net/v1.0`;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const response = await this._makeRequest({
          method: 'get',
          url: `${baseUrl}/${containerId}`,
          params: { fields: 'status,error_message', access_token: accessToken },
          timeout: 30000
        });

        const status = response.data.status;
        if (status === 'FINISHED') return response.data;
        if (status === 'ERROR' || status === 'EXPIRED') {
          throw new Error(`Threads media processing failed: ${response.data.error_message || 'Unknown error'}`);
        }

        await new Promise(resolve => setTimeout(resolve, 8000));
        retries++;
      } catch (error) {
        if (error.response?.status === 400 && retries < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 8000));
          retries++;
          continue;
        }
        throw error;
      }
    }
    throw new Error('Threads media container processing timed out');
  }

  async publishToLinkedIn(account, mediaUrls, caption, contentType, userSettings) {
    const accessToken = account.access_token;
    const urls = Array.isArray(mediaUrls) ? mediaUrls : (mediaUrls ? [mediaUrls] : []);

    try {
      let personId = account.account_id;
      try {
        const meResponse = await this._makeRequest({
          method: 'get',
          url: 'https://api.linkedin.com/v2/me',
          headers: { Authorization: `Bearer ${accessToken}`, 'X-Restli-Protocol-Version': '2.0.0' },
          timeout: 15000
        });
        personId = meResponse.data.id;
      } catch (meErr) {
        console.warn('LinkedIn: /me resolved error:', meErr.message);
      }

      const authorUrn = `urn:li:person:${personId}`;
      const mediaAssets = [];
      let shareMediaCategory = 'NONE';

      if (urls.length > 0) {
        const isVideo = this._is_video(urls[0]);
        shareMediaCategory = isVideo ? 'VIDEO' : 'IMAGE';

        for (const mediaUrl of urls) {
          try {
            const asset = await this.uploadLinkedInMedia(accessToken, personId, mediaUrl);
            if (asset) mediaAssets.push(asset);
          } catch (uploadErr) {
            console.error(`LinkedIn: Failed to upload media ${mediaUrl}:`, uploadErr.message);
          }
        }
        if (mediaAssets.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      let postPayload = {
        author: authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text: caption || '' },
            shareMediaCategory: mediaAssets.length > 0 ? shareMediaCategory : 'NONE',
            ...(mediaAssets.length > 0 ? {
              media: mediaAssets.map(asset => ({
                status: 'READY',
                description: { text: caption || '' },
                media: asset,
                title: { text: shareMediaCategory === 'VIDEO' ? 'Video' : 'Image' }
              }))
            } : {})
          }
        },
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
      };

      const postResponse = await this._makeRequest({
        method: 'post',
        url: 'https://api.linkedin.com/v2/ugcPosts',
        data: postPayload,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0'
        },
        timeout: 30000
      });

      const postId = postResponse.data.id;
      return {
        success: true,
        postId,
        postUrl: `https://www.linkedin.com/feed/update/${postId}`
      };
    } catch (error) {
      console.error('LinkedIn publish error:', error.response?.data || error.message);
      const msg = error.response?.data?.message || error.message;
      throw new Error(`LinkedIn publishing failed: ${msg}`);
    }
  }

  async uploadLinkedInMedia(accessToken, personId, mediaUrl) {
    const isVideo = this._is_video(mediaUrl);
    const recipe = isVideo ? 'urn:li:digitalmediaRecipe:feedshare-video' : 'urn:li:digitalmediaRecipe:feedshare-image';
    const ownerUrn = `urn:li:person:${personId}`;

    const registerResponse = await this._makeRequest({
      method: 'post',
      url: 'https://api.linkedin.com/v2/assets?action=registerUpload',
      data: {
        registerUploadRequest: {
          recipes: [recipe],
          owner: ownerUrn,
          serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }]
        }
      },
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0'
      },
      timeout: 30000
    });

    const uploadUrl = registerResponse.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const asset = registerResponse.data.value.asset;

    let mediaBuffer;
    if (mediaUrl.startsWith('http')) {
      const mediaResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 60000 });
      mediaBuffer = Buffer.from(mediaResponse.data, 'binary');
    } else {
      const filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.join(process.cwd(), mediaUrl);
      mediaBuffer = fs.readFileSync(filePath);
    }

    await axios.put(uploadUrl, mediaBuffer, {
      headers: { 'Content-Type': isVideo ? 'video/mp4' : 'application/octet-stream' },
      timeout: 120000
    });

    if (isVideo) {
      let isReady = false;
      let attempts = 0;
      const maxAttempts = 15;

      while (!isReady && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;

        try {
          const statusResponse = await this._makeRequest({
            method: 'get',
            url: `https://api.linkedin.com/v2/assets/(${asset})`,
            headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Restli-Protocol-Version': '2.0.0' }
          });

          const status = statusResponse.data.recipes[0].status;
          if (status === 'AVAILABLE') isReady = true;
          else if (status === 'PROCESSING_FAILED') throw new Error('LinkedIn video processing failed');
        } catch (err) {
          console.warn(`Error checking LinkedIn asset status: ${err.message}`);
        }
      }
    }

    return asset;
  }

  async publishToTwitter(account, mediaUrls, caption, contentType, userSettings) {
    const accessToken = account.access_token;
    const urls = Array.isArray(mediaUrls) ? mediaUrls : (mediaUrls ? [mediaUrls] : []);

    // Use OAuth 1.0a credentials from admin Settings (consumer key/secret + user oauth token/secret)
    // These are stored by admin in the Settings panel and are required for v1.1 media upload API
    const meta = account.metadata || {};
    const oauthCreds = (meta.auth_type === 'oauth1' && meta.consumer_key && meta.token_secret)
      // Priority 1: credentials stored in account metadata (from SDK connect)
      ? {
          consumerKey: meta.consumer_key,
          consumerSecret: meta.consumer_secret,
          oauthToken: account.access_token,
          oauthTokenSecret: meta.token_secret
        }
      // Priority 2: admin-level credentials from Settings (matching reelease-ai pattern)
      : (userSettings?.twitter_consumer_key ? {
          consumerKey: userSettings.twitter_consumer_key,
          consumerSecret: userSettings.twitter_consumer_secret,
          oauthToken: userSettings.twitter_oauth_token || null,
          oauthTokenSecret: userSettings.twitter_oauth_token_secret || null
        } : null);

    try {
      let mediaIds = [];

      if (urls.length > 0 && oauthCreds?.oauthToken) {
        for (const mediaUrl of urls) {
          try {
            const mediaId = await this.uploadTwitterMedia(mediaUrl, oauthCreds);
            if (mediaId) mediaIds.push(mediaId);
          } catch (uploadErr) {
            console.error(`Twitter: Media upload failed for ${mediaUrl}:`, uploadErr.message);
          }
        }
        if (mediaIds.length === 0) {
          console.warn('Twitter: All media uploads failed — posting text only');
        }
      } else if (urls.length > 0 && !oauthCreds?.oauthToken) {
        console.warn('Twitter: No OAuth 1.0a credentials configured — skipping media upload. Add Consumer Key/Secret and OAuth Token/Secret in admin Settings.');
      }

      const payload = { text: caption || '' };
      if (mediaIds.length > 0) payload.media = { media_ids: mediaIds };

      let response;
      if (oauthCreds?.consumerKey && oauthCreds?.oauthToken) {
        // Post tweet using OAuth 1.0a
        const oauth = new OAuth(
          'https://api.twitter.com/oauth/request_token',
          'https://api.twitter.com/oauth/access_token',
          oauthCreds.consumerKey,
          oauthCreds.consumerSecret,
          '1.0A', null, 'HMAC-SHA1'
        );
        const authHeader = oauth.authHeader(
          'https://api.twitter.com/2/tweets',
          oauthCreds.oauthToken,
          oauthCreds.oauthTokenSecret,
          'POST'
        );
        response = await axios.post('https://api.twitter.com/2/tweets', payload, {
          headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' }
        });
      } else {
        // Fallback: post tweet using OAuth 2.0 Bearer (no media support)
        response = await axios.post('https://api.twitter.com/2/tweets', payload, {
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
        });
      }

      const responseData = response.data?.data || response.data;
      return {
        success: true,
        postId: responseData.id,
        postUrl: `https://twitter.com/i/web/status/${responseData.id}`
      };
    } catch (error) {
      console.error('Twitter publish error:', error.response?.data || error.message);
      const msg = error.response?.data?.detail || error.response?.data?.message || error.message;
      throw new Error(`Twitter publishing failed: ${msg}`);
    }
  }

  async uploadTwitterMedia(mediaUrl, oauthCreds) {
    try {
      const { consumerKey, consumerSecret, oauthToken, oauthTokenSecret } = oauthCreds;

      const oauth = new OAuth(
        'https://api.twitter.com/oauth/request_token',
        'https://api.twitter.com/oauth/access_token',
        consumerKey, consumerSecret, '1.0A', null, 'HMAC-SHA1'
      );

      let resolvedUrl = mediaUrl;
      if (!mediaUrl.startsWith('http')) {
        const baseUrl = process.env.APP_URL || 'http://localhost:3000';
        resolvedUrl = `${baseUrl.replace(/\/+$/, '')}/${mediaUrl.replace(/^\/+/, '')}`;
      }
      let mediaBuffer;
      if (resolvedUrl.startsWith('http')) {
        const mediaRes = await axios.get(resolvedUrl, { responseType: 'arraybuffer', timeout: 30000 });
        mediaBuffer = Buffer.from(mediaRes.data, 'binary');
      } else {
        const filePath = path.isAbsolute(resolvedUrl) ? resolvedUrl : path.join(process.cwd(), resolvedUrl);
        mediaBuffer = fs.readFileSync(filePath);
      }

      const ext = resolvedUrl.split('.').pop().toLowerCase().split('?')[0];
      const videoExts = ['mp4', 'mov', 'avi'];
      const isVideo = videoExts.includes(ext);
      const mimeType = isVideo ? 'video/mp4' : 'image/jpeg';
      const mediaCategory = isVideo ? 'tweet_video' : 'tweet_image';

      const initResult = await new Promise((resolve, reject) => {
        oauth.post(
          'https://upload.twitter.com/1.1/media/upload.json',
          oauthToken, oauthTokenSecret,
          { command: 'INIT', total_bytes: mediaBuffer.length.toString(), media_type: mimeType, media_category: mediaCategory },
          'application/x-www-form-urlencoded',
          (err, data) => {
            if (err) return reject(new Error(err.data || err.message || JSON.stringify(err)));
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`INIT parse error: ${data}`)); }
          }
        );
      });

      const mediaId = initResult.media_id_string;
      if (!mediaId) throw new Error(`Twitter INIT did not return media_id: ${JSON.stringify(initResult)}`);

      const chunkSize = 5 * 1024 * 1024;
      let segmentIndex = 0;
      for (let offset = 0; offset < mediaBuffer.length; offset += chunkSize) {
        const chunk = mediaBuffer.slice(offset, offset + chunkSize);
        const appendForm = new FormData();
        appendForm.append('command', 'APPEND');
        appendForm.append('media_id', mediaId);
        appendForm.append('segment_index', segmentIndex.toString());
        appendForm.append('media', chunk, { filename: 'media', contentType: mimeType });
        const authHeader = oauth.authHeader(
          'https://upload.twitter.com/1.1/media/upload.json',
          oauthToken, oauthTokenSecret, 'POST'
        );
        await axios.post('https://upload.twitter.com/1.1/media/upload.json', appendForm, {
          headers: { ...appendForm.getHeaders(), Authorization: authHeader }
        });
        segmentIndex++;
      }

      const finalizeResult = await new Promise((resolve, reject) => {
        oauth.post(
          'https://upload.twitter.com/1.1/media/upload.json',
          oauthToken, oauthTokenSecret,
          { command: 'FINALIZE', media_id: mediaId },
          'application/x-www-form-urlencoded',
          (err, data) => {
            if (err) return reject(new Error(err.data || err.message || JSON.stringify(err)));
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`FINALIZE parse error: ${data}`)); }
          }
        );
      });

      if (finalizeResult.processing_info) {
        await this._waitForTwitterMedia(mediaId, oauthToken, oauthTokenSecret, oauth);
      }

      return mediaId;
    } catch (error) {
      console.error('Twitter: uploadTwitterMedia error:', error.message);
      return null;
    }
  }

  async _waitForTwitterMedia(mediaId, oauthToken, oauthTokenSecret, oauth) {
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const status = await new Promise((resolve, reject) => {
        oauth.get(
          `https://upload.twitter.com/1.1/media/upload.json?command=STATUS&media_id=${mediaId}`,
          oauthToken, oauthTokenSecret,
          (err, data) => {
            if (err) return reject(new Error(err.data || err.message || JSON.stringify(err)));
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`STATUS parse error: ${data}`)); }
          }
        );
      });
      const state = status.processing_info?.state;
      if (state === 'succeeded') return;
      if (state === 'failed') {
        throw new Error(`Twitter media processing failed: ${JSON.stringify(status.processing_info?.error)}`);
      }
    }
    throw new Error('Twitter media processing timeout after ~60s');
  }

  async publishToYouTube(account, mediaUrls, caption, contentType, adminSettings) {
    const accessToken = account.access_token;
    const refreshToken = account.refresh_token ? getDecryptedToken(account.refresh_token) : null;
    const urls = Array.isArray(mediaUrls) ? mediaUrls : (mediaUrls ? [mediaUrls] : []);

    if (urls.length === 0) {
      throw new Error('YouTube requires at least one video file.');
    }

    const videoUrl = urls[0];
    try {
      const oauth2Client = new google.auth.OAuth2(
        adminSettings.youtube_client_id,
        adminSettings.youtube_client_secret
      );

      oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
        expiry_date: account.token_expiry ? new Date(account.token_expiry).getTime() : null
      });

      oauth2Client.on('tokens', async (tokens) => {
        const updateData = {};
        if (tokens.access_token) updateData.access_token = tokens.access_token;
        if (tokens.expiry_date) updateData.token_expiry = new Date(tokens.expiry_date);
        if (tokens.refresh_token) updateData.refresh_token = tokens.refresh_token;

        if (Object.keys(updateData).length > 0) {
          await SocialMediaConnection.findByIdAndUpdate(account._id, updateData);
        }
      });

      await oauth2Client.getAccessToken();
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

      const tempDir = path.join(process.cwd(), 'uploads', 'social-post');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const tempFileName = `yt_upload_${Date.now()}.mp4`;
      const tempFilePath = path.join(tempDir, tempFileName);

      const videoResponse = await axios({ method: 'get', url: videoUrl, responseType: 'stream', timeout: 300000 });
      const writer = fs.createWriteStream(tempFilePath);
      videoResponse.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      const isShort = contentType === 'shorts' || contentType === 'reel';
      let title = caption ? caption.substring(0, 100).replace(/#\S+/g, '').trim() || 'Video' : 'Video';
      if (isShort) title = `${title} #Shorts`.substring(0, 100);

      const uploadResponse = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: { title, description: caption || '', categoryId: '22' },
          status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
        },
        media: { body: fs.createReadStream(tempFilePath) }
      });

      try { fs.unlinkSync(tempFilePath); } catch (e) { }

      const videoId = uploadResponse.data.id;
      return {
        success: true,
        postId: videoId,
        postUrl: isShort ? `https://youtube.com/shorts/${videoId}` : `https://youtube.com/watch?v=${videoId}`
      };
    } catch (error) {
      console.error('YouTube publish error:', error);
      const errorMsg = error.response?.data?.error?.message || error.message;
      throw new Error(`YouTube publishing failed: ${errorMsg}`);
    }
  }

  async publishToTikTok(account, mediaUrls, caption, contentType, adminSettings) {
    let accessToken = account.access_token;
    const urls = Array.isArray(mediaUrls) ? mediaUrls : (mediaUrls ? [mediaUrls] : []);
    if (urls.length === 0) throw new Error('TikTok requires a video file.');

    const videoUrl = urls[0];
    try {
      const response = await this._makeRequest({
        method: 'post',
        url: 'https://open.tiktokapis.com/v2/post/publish/video/init/',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8'
        },
        data: {
          post_info: {
            title: caption ? caption.substring(0, 2000) : '',
            privacy_level: 'SELF_ONLY',
            disable_comment: false,
            disable_duet: false,
            disable_stitch: false
          },
          source_info: { source: 'PULL_FROM_URL', video_url: videoUrl }
        }
      });

      const publishId = response.data?.data?.publish_id;
      if (!publishId) throw new Error('Failed to initialize TikTok publish');

      return {
        success: true,
        postId: publishId,
        postUrl: `https://www.tiktok.com/@${account.account_username || 'user'}`
      };
    } catch (error) {
      console.error('TikTok publish error:', error.response?.data || error.message);
      throw error;
    }
  }

  async publishContent(socialPostId, userId, mediaUrls, caption, contentType, platform, baseUrl) {
    const socialPost = await SocialMediaPost.findById(socialPostId);
    if (!socialPost) {
      console.error(`SocialMediaPost ${socialPostId} not found`);
      return;
    }

    try {
      const account = await this.getAccountWithToken(socialPost.connection_id, userId);

      await SocialMediaConnection.findByIdAndUpdate(socialPost.connection_id, { last_used: new Date() });

      const fullMediaUrls = Array.isArray(mediaUrls)
        ? mediaUrls.map(url => url.startsWith('http') ? url : `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`)
        : (mediaUrls ? [mediaUrls.startsWith('http') ? mediaUrls : `${baseUrl.replace(/\/+$/, '')}/${mediaUrls.replace(/^\/+/, '')}`] : []);

      let result;
      if (platform === 'facebook') {
        result = await this.publishToFacebook(account, fullMediaUrls, caption, contentType);
      } else if (platform === 'instagram') {
        result = await this.publishToInstagram(account, fullMediaUrls, caption, contentType);
      } else if (platform === 'threads') {
        result = await this.publishToThreads(account, fullMediaUrls, caption, contentType);
      } else if (platform === 'linkedin') {
        const adminSettings = await Setting.findOne();
        result = await this.publishToLinkedIn(account, fullMediaUrls, caption, contentType, adminSettings);
      } else if (platform === 'twitter') {
        const adminSettings = await Setting.findOne();
        result = await this.publishToTwitter(account, fullMediaUrls, caption, contentType, adminSettings);
      } else if (platform === 'youtube') {
        const adminSettings = await Setting.findOne();
        result = await this.publishToYouTube(account, fullMediaUrls, caption, contentType, adminSettings);
      } else if (platform === 'tiktok') {
        const adminSettings = await Setting.findOne();
        result = await this.publishToTikTok(account, fullMediaUrls, caption, contentType, adminSettings);
      } else {
        throw new Error(`Platform ${platform} is not supported for publishing`);
      }

      if (result && result.success && result.postId) {
        socialPost.media_id = result.postId;
        socialPost.permalink = result.postUrl;
        socialPost.status = 'published';
        socialPost.published_at = new Date();
        await socialPost.save();
      }
      return result;
    } catch (error) {
      console.error(`Background publishing failed for ${socialPostId}:`, error);
      socialPost.status = 'failed';
      socialPost.error_message = error.message;
      await socialPost.save();
      throw error;
    }
  }

  async deleteSocialPost(historyId, userId) {
    const post = await SocialMediaPost.findOne({ _id: historyId, user_id: userId });
    if (!post) throw new Error('Post not found in history');
    if (post.status === 'deleted') throw new Error('Post is already marked as deleted');

    const account = await this.getAccountWithToken(post.connection_id, userId);
    const accessToken = account.access_token;
    const apiVersion = DEFAULT_FACEBOOK_API_VERSION;
    const baseUrl = `https://graph.facebook.com/${apiVersion}`;

    let platformDeleted = false;
    let platformMessage = '';

    if (post.platform === 'facebook') {
      try {
        await this._makeRequest({ method: 'delete', url: `${baseUrl}/${post.media_id}`, params: { access_token: accessToken } });
        platformDeleted = true;
      } catch (error) {
        const fbError = error.response?.data?.error;
        if (fbError?.code === 100 || fbError?.code === 21) {
          platformDeleted = true;
          platformMessage = 'Post was already deleted from Facebook.';
        } else {
          throw new Error(`Failed to delete post from Facebook: ${fbError?.message || error.message}`);
        }
      }
    } else if (post.platform === 'instagram') {
      try {
        await axios.delete(`${baseUrl}/${post.media_id}`, { params: { access_token: accessToken } });
        platformDeleted = true;
      } catch (error) {
        const fbError = error.response?.data?.error;
        if (fbError?.code === 100 || fbError?.code === 21) {
          platformDeleted = true;
          platformMessage = 'Post was already deleted from Instagram.';
        } else {
          throw new Error(`Failed to delete post from Instagram: ${fbError?.message || error.message}`);
        }
      }
    } else if (post.platform === 'linkedin') {
      try {
        await this._makeRequest({
          method: 'delete',
          url: `https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(post.media_id)}`,
          headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Restli-Protocol-Version': '2.0.0' }
        });
        platformDeleted = true;
      } catch (error) {
        platformMessage = 'Failed to delete from LinkedIn, or it was already deleted.';
      }
    } else if (post.platform === 'twitter') {
      try {
        const adminSettings = await Setting.findOne();
        const url = `https://api.twitter.com/2/tweets/${post.media_id}`;
        const { default: OAuthModule } = await import('oauth');
        const oauth = new OAuthModule.OAuth(
          'https://api.twitter.com/oauth/request_token',
          'https://api.twitter.com/oauth/access_token',
          adminSettings.twitter_consumer_key,
          adminSettings.twitter_consumer_secret,
          '1.0A', null, 'HMAC-SHA1'
        );
        const authHeader = oauth.authHeader(url, adminSettings.twitter_oauth_token, adminSettings.twitter_oauth_token_secret, 'DELETE');
        await axios.delete(url, { headers: { 'Authorization': authHeader } });
        platformDeleted = true;
      } catch (error) {
        platformMessage = 'Failed to delete from Twitter, or it was already deleted.';
      }
    } else if (post.platform === 'youtube') {
      try {
        const adminSettings = await Setting.findOne();
        const oauth2Client = new google.auth.OAuth2(adminSettings.youtube_client_id, adminSettings.youtube_client_secret);
        oauth2Client.setCredentials({
          access_token: accessToken,
          refresh_token: account.refresh_token ? getDecryptedToken(account.refresh_token) : null,
          expiry_date: account.token_expiry ? new Date(account.token_expiry).getTime() : null
        });
        await oauth2Client.getAccessToken();
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        await youtube.videos.delete({ id: post.media_id });
        platformDeleted = true;
      } catch (error) {
        platformMessage = 'Failed to delete video from YouTube, or it was already deleted.';
      }
    }

    await SocialMediaPost.findByIdAndDelete(historyId);

    return {
      success: true,
      platformDeleted,
      message: platformDeleted ? 'Post deleted successfully from both platform and history.' : platformMessage
    };
  }
}

export default new SocialMediaService();
