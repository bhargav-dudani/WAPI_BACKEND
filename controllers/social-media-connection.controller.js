import SocialMediaConnection from '../models/social-media-connection.model.js';
import { Setting, FacebookConnection, InstagramConnection } from '../models/index.js';
import axios from 'axios';
import mongoose from 'mongoose';

const FB_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v22.0';


const buildCallbackUrl = (platform, baseUrl) =>
  `${baseUrl}/api/social-connections/callback/${platform}`;


const findExistingConnection = (workspaceId, platform) =>
  SocialMediaConnection.findOne({ workspace_id: workspaceId, platform });


export const getOAuthConfig = async (req, res) => {
  try {
    const { platform } = req.params;
    const setting = await Setting.findOne();
    const baseUrl = process.env.APP_URL || process.env.FRONTEND_URL;

    if (!baseUrl) {
      return res.status(500).json({ success: false, error: 'APP_URL is not configured' });
    }

    const redirectUri = buildCallbackUrl(platform, baseUrl);

    switch (platform) {
      case 'youtube': {
        if (!setting?.youtube_client_id) {
          return res.status(400).json({ success: false, error: 'YouTube Client ID not configured in settings.' });
        }
        const scope = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/userinfo.profile';
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${setting.youtube_client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;
        return res.status(200).json({
          success: true,
          data: { platform, clientId: setting.youtube_client_id, redirectUri, scope, authUrl }
        });
      }

      case 'linkedin': {
        if (!setting?.linkedin_client_id) {
          return res.status(400).json({ success: false, error: 'LinkedIn Client ID not configured in settings.' });
        }
        const scope = 'openid profile email w_member_social';
        const state = Buffer.from(JSON.stringify({ platform: 'linkedin' })).toString('base64');
        const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${setting.linkedin_client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}`;
        return res.status(200).json({
          success: true,
          data: { platform, clientId: setting.linkedin_client_id, redirectUri, scope, authUrl }
        });
      }

      case 'twitter': {
        if (!setting?.twitter_client_id) {
          return res.status(400).json({ success: false, error: 'Twitter Client ID not configured in settings.' });
        }
        const scope = 'tweet.read tweet.write users.read offline.access';
        const state = Buffer.from(JSON.stringify({ platform: 'twitter' })).toString('base64');
        const authUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${setting.twitter_client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}&code_challenge=challenge&code_challenge_method=plain`;
        return res.status(200).json({
          success: true,
          data: { platform, clientId: setting.twitter_client_id, redirectUri, scope, authUrl }
        });
      }

      case 'threads': {
        if (!setting?.threads_app_id) {
          return res.status(400).json({ success: false, error: 'Threads App ID not configured in settings.' });
        }
        const scope = 'threads_basic,threads_content_publish';
        const authUrl = `https://threads.net/oauth/authorize?client_id=${setting.threads_app_id}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&response_type=code`;
        return res.status(200).json({
          success: true,
          data: { platform, clientId: setting.threads_app_id, redirectUri, scope, authUrl }
        });
      }

      case 'tiktok': {
        if (!setting?.tiktok_client_key) {
          return res.status(400).json({ success: false, error: 'TikTok Client Key not configured in settings.' });
        }
        const scope = 'user.info.basic,video.list,video.upload';
        const state = Buffer.from(JSON.stringify({ platform: 'tiktok' })).toString('base64');
        const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${setting.tiktok_client_key}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&response_type=code&state=${state}`;
        return res.status(200).json({
          success: true,
          data: { platform, clientId: setting.tiktok_client_key, redirectUri, scope, authUrl }
        });
      }

      default:
        return res.status(400).json({ success: false, error: `Unsupported platform: ${platform}` });
    }
  } catch (error) {
    console.error('[getOAuthConfig] Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to get OAuth config', details: error.message });
  }
};


export const oauthCallback = (req, res) => {
  const { platform } = req.params;
  const { code, state, error, error_description } = req.query;

  const html = `<!DOCTYPE html>
<html>
  <head><title>${platform} Authorization</title></head>
  <body>
    <script>
      const data = {
        type: 'SOCIAL_AUTH_CALLBACK',
        platform: ${JSON.stringify(platform)},
        code: ${JSON.stringify(code || null)},
        state: ${JSON.stringify(state || null)},
        error: ${JSON.stringify(error || null)},
        error_description: ${JSON.stringify(error_description || null)}
      };
      if (window.opener) {
        window.opener.postMessage(data, '*');
        setTimeout(() => window.close(), 300);
      } else {
        document.body.innerHTML = '<h2>Authorization complete. You can close this window.</h2>';
      }
    </script>
  </body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};

export const connectAccount = async (req, res) => {
  try {
    const { platform, workspace_id, code, access_token, access_token_secret, client_id, client_secret, code_verifier, redirect_uri } = req.body;
    const userId = req.user?.owner_id || req.user?.id;

    if (!platform || !workspace_id) {
      return res.status(400).json({ success: false, error: 'platform and workspace_id are required' });
    }
    if (!mongoose.Types.ObjectId.isValid(workspace_id)) {
      return res.status(400).json({ success: false, error: 'Invalid workspace_id' });
    }

    const setting = await Setting.findOne();
    const baseUrl = process.env.APP_URL || process.env.FRONTEND_URL;
    const redirectUri = redirect_uri || buildCallbackUrl(platform, baseUrl);

    let connectionData = {};

    if (platform === 'youtube') {
      if (!code) {
        return res.status(400).json({ success: false, error: 'code is required for youtube' });
      }
      if (!setting?.youtube_client_id || !setting?.youtube_client_secret) {
        return res.status(400).json({ success: false, error: 'YouTube credentials not configured in settings' });
      }

      const tokenRes = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
        code,
        client_id: setting.youtube_client_id,
        client_secret: setting.youtube_client_secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

      const { access_token, refresh_token, expires_in } = tokenRes.data;
      const tokenExpiry = new Date(Date.now() + (expires_in || 3600) * 1000);

      const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
        params: { part: 'snippet', mine: true, access_token }
      });
      const channel = channelRes.data?.items?.[0];
      const snippet = channel?.snippet || {};

      let googleProfile = { name: snippet.title, picture: snippet.thumbnails?.default?.url };
      try {
        const profileRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${access_token}` }
        });
        googleProfile = { id: profileRes.data.id, name: profileRes.data.name, picture: profileRes.data.picture };
      } catch (e) { }

      connectionData = {
        account_id: channel?.id || googleProfile.id || 'unknown',
        account_name: snippet.title || googleProfile.name || 'YouTube Channel',
        account_username: channel?.id || null,
        profile_picture: snippet.thumbnails?.default?.url || googleProfile.picture || null,
        access_token,
        refresh_token: refresh_token || null,
        token_expiry: tokenExpiry,
        permissions: ['youtube.upload', 'youtube.readonly'],
        metadata: { channel_id: channel?.id, channel_title: snippet.title }
      };

    } else if (platform === 'linkedin') {
      if (!code) {
        return res.status(400).json({ success: false, error: 'code is required for linkedin' });
      }
      if (!setting?.linkedin_client_id || !setting?.linkedin_client_secret) {
        return res.status(400).json({ success: false, error: 'LinkedIn credentials not configured in settings' });
      }


      const tokenRes = await axios.post(
        'https://www.linkedin.com/oauth/v2/accessToken',
        new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: setting.linkedin_client_id, client_secret: setting.linkedin_client_secret }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const { access_token, expires_in } = tokenRes.data;
      const tokenExpiry = new Date(Date.now() + (expires_in || 5184000) * 1000);


      let profileData = { id: null, name: 'LinkedIn User', email: null, picture: null };
      try {
        const oidcRes = await axios.get('https://api.linkedin.com/v2/userinfo', {
          headers: { Authorization: `Bearer ${access_token}` }
        });
        profileData = { id: oidcRes.data.sub, name: oidcRes.data.name, email: oidcRes.data.email, picture: oidcRes.data.picture };
      } catch (e) {
        console.warn('[LinkedIn publish] OIDC userinfo failed, trying /v2/me:', e.message);
        try {
          const meRes = await axios.get('https://api.linkedin.com/v2/me', {
            headers: { Authorization: `Bearer ${access_token}`, 'X-Restli-Protocol-Version': '2.0.0' }
          });
          profileData = {
            id: meRes.data.id,
            name: `${meRes.data.localizedFirstName} ${meRes.data.localizedLastName}`,
            email: null, picture: null
          };
        } catch (e2) {
          console.error('[LinkedIn publish] Profile fetch failed:', e2.message);
          throw new Error('Could not retrieve LinkedIn profile. Ensure OpenID Connect is enabled.');
        }
      }

      connectionData = {
        account_id: profileData.id,
        account_name: profileData.name,
        account_username: profileData.email ? profileData.email.split('@')[0] : profileData.id,
        profile_picture: profileData.picture || null,
        access_token,
        refresh_token: null,
        token_expiry: tokenExpiry,
        permissions: ['w_member_social', 'openid', 'profile'],
        metadata: { email: profileData.email }
      };

    } else if (platform === 'twitter') {
      // --- SDK / Direct Keys path (OAuth 1.0a) ---
      if (access_token && access_token_secret && client_id && client_secret) {
        const { default: OAuthModule } = await import('oauth');
        const oauth = new OAuthModule.OAuth(
          'https://api.twitter.com/oauth/request_token',
          'https://api.twitter.com/oauth/access_token',
          client_id, client_secret, '1.0A', null, 'HMAC-SHA1'
        );

        // Verify credentials by fetching user profile
        const verifyUrl = 'https://api.twitter.com/1.1/account/verify_credentials.json?include_email=false&skip_status=true';
        const authHeader = oauth.authHeader(verifyUrl, access_token, access_token_secret, 'GET');
        const verifyRes = await axios.get(verifyUrl, { headers: { Authorization: authHeader } });
        const twUser = verifyRes.data || {};

        connectionData = {
          account_id: String(twUser.id_str || twUser.id),
          account_name: twUser.name || twUser.screen_name,
          account_username: twUser.screen_name || null,
          profile_picture: twUser.profile_image_url_https || twUser.profile_image_url || null,
          access_token,
          refresh_token: null,
          token_expiry: null,
          permissions: ['tweet.read', 'tweet.write', 'users.read'],
          metadata: {
            auth_type: 'oauth1',
            consumer_key: client_id,
            consumer_secret: client_secret,
            token_secret: access_token_secret
          }
        };

      // --- OAuth 2.0 PKCE path ---
      } else {
        if (!code) {
          return res.status(400).json({ success: false, error: 'code is required for twitter' });
        }
        if (!setting?.twitter_client_id || !setting?.twitter_client_secret) {
          return res.status(400).json({ success: false, error: 'Twitter credentials not configured in settings' });
        }

        const auth = Buffer.from(`${setting.twitter_client_id}:${setting.twitter_client_secret}`).toString('base64');
        const tokenRes = await axios.post(
          'https://api.twitter.com/2/oauth2/token',
          new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: code_verifier || 'challenge' }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` } }
        );
        const { access_token: oauthToken, refresh_token, expires_in } = tokenRes.data;
        const tokenExpiry = expires_in ? new Date(Date.now() + expires_in * 1000) : null;

        const userRes = await axios.get('https://api.twitter.com/2/users/me?user.fields=profile_image_url', {
          headers: { Authorization: `Bearer ${oauthToken}` }
        });
        const twUser = userRes.data?.data || {};

        connectionData = {
          account_id: twUser.id,
          account_name: twUser.name || twUser.username,
          account_username: twUser.username || null,
          profile_picture: twUser.profile_image_url || null,
          access_token: oauthToken,
          refresh_token: refresh_token || null,
          token_expiry: tokenExpiry,
          permissions: ['tweet.read', 'tweet.write', 'users.read'],
          metadata: { auth_type: 'oauth2' }
        };
      }

    } else if (platform === 'threads') {
      if (!code) {
        return res.status(400).json({ success: false, error: 'code is required for threads' });
      }
      if (!setting?.threads_app_id || !setting?.threads_app_secret) {
        return res.status(400).json({ success: false, error: 'Threads App credentials not configured in settings' });
      }

      const tokenForm = new URLSearchParams();
      tokenForm.append('client_id', setting.threads_app_id);
      tokenForm.append('client_secret', setting.threads_app_secret);
      tokenForm.append('grant_type', 'authorization_code');
      tokenForm.append('redirect_uri', redirectUri);
      tokenForm.append('code', code);

      const shortRes = await axios.post('https://graph.threads.net/oauth/access_token', tokenForm.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      let longToken = shortRes.data.access_token;

      try {
        const llRes = await axios.get('https://graph.threads.net/access_token', {
          params: { grant_type: 'th_exchange_token', client_secret: setting.threads_app_secret, access_token: longToken }
        });
        longToken = llRes.data.access_token || longToken;
      } catch (e) {
        console.warn('[Threads publish] Long-lived token exchange failed:', e.message);
      }

      const tokenExpiry = new Date();
      tokenExpiry.setDate(tokenExpiry.getDate() + 60);

      const profileRes = await axios.get('https://graph.threads.net/v1.0/me', {
        params: { fields: 'id,name,username,threads_profile_picture_url', access_token: longToken }
      });
      const profile = profileRes.data;

      connectionData = {
        account_id: profile.id,
        account_name: profile.name || profile.username,
        account_username: profile.username || null,
        profile_picture: profile.threads_profile_picture_url || null,
        access_token: longToken,
        refresh_token: null,
        token_expiry: tokenExpiry,
        permissions: ['threads_basic', 'threads_content_publish'],
        metadata: {}
      };

    } else if (platform === 'tiktok') {
      if (!code) {
        return res.status(400).json({ success: false, error: 'code is required for tiktok' });
      }
      if (!setting?.tiktok_client_key || !setting?.tiktok_client_secret) {
        return res.status(400).json({ success: false, error: 'TikTok credentials not configured in settings' });
      }

      const tokenRes = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', new URLSearchParams({
        client_key: setting.tiktok_client_key,
        client_secret: setting.tiktok_client_secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

      const { access_token, refresh_token, expires_in, open_id } = tokenRes.data?.data || tokenRes.data;
      const tokenExpiry = expires_in ? new Date(Date.now() + expires_in * 1000) : null;


      let tikProfile = { display_name: 'TikTok User', avatar_url: null, union_id: null };
      try {
        const userRes = await axios.get('https://open.tiktokapis.com/v2/user/info/', {
          params: { fields: 'open_id,union_id,avatar_url,display_name,username' },
          headers: { Authorization: `Bearer ${access_token}` }
        });
        tikProfile = userRes.data?.data?.user || tikProfile;
      } catch (e) {
        console.warn('[TikTok publish] User info fetch failed:', e.message);
      }

      connectionData = {
        account_id: open_id || tikProfile.open_id,
        account_name: tikProfile.display_name || 'TikTok Account',
        account_username: tikProfile.username || null,
        profile_picture: tikProfile.avatar_url || null,
        access_token,
        refresh_token: refresh_token || null,
        token_expiry: tokenExpiry,
        permissions: ['user.info.basic', 'video.upload'],
        metadata: { open_id: open_id || tikProfile.open_id, union_id: tikProfile.union_id }
      };

    } else {
      return res.status(400).json({ success: false, error: `Unsupported platform: ${platform}` });
    }

    const connection = await SocialMediaConnection.findOneAndUpdate(
      { workspace_id, platform },
      {
        $set: {
          user_id: userId,
          workspace_id,
          platform,
          is_active: true,
          connected_at: new Date(),
          ...connectionData
        }
      },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: `${platform.charAt(0).toUpperCase() + platform.slice(1)} account connected successfully`,
      data: connection
    });

  } catch (error) {
    console.error('[connectAccount] Error:', error.response?.data || error.message);
    const errMsg = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    res.status(500).json({ success: false, error: 'Failed to connect account', details: errMsg });
  }
};

export const getConnectedAccounts = async (req, res) => {
  try {
    const { workspace_id, platform } = req.query;

    if (!workspace_id) {
      return res.status(400).json({ success: false, error: 'workspace_id is required' });
    }
    if (!mongoose.Types.ObjectId.isValid(workspace_id)) {
      return res.status(400).json({ success: false, error: 'Invalid workspace_id' });
    }

    const query = { workspace_id, is_active: true };
    if (platform) query.platform = platform;

    const connections = [];

    // 1. Fetch SocialMediaConnection (YouTube, LinkedIn, etc.)
    if (!platform || (platform !== 'facebook' && platform !== 'instagram')) {
      const smConnections = await SocialMediaConnection.find(query)
        .select('-access_token -refresh_token')
        .sort({ connected_at: -1 })
        .lean();
      connections.push(...smConnections);
    }

    // 2. Fetch Facebook Connection Pages
    if (!platform || platform === 'facebook') {
      const fbConnections = await FacebookConnection.find({ workspace_id, is_active: true }).lean();
      for (const conn of fbConnections) {
        if (conn.pages && conn.pages.length > 0) {
          for (const page of conn.pages) {
            if (page.is_active !== false) {
              connections.push({
                _id: page._id,
                workspace_id: conn.workspace_id,
                platform: 'facebook',
                account_id: page.page_id,
                account_name: page.page_name,
                account_username: page.page_name,
                profile_picture: null,
                is_active: true,
                connected_at: conn.created_at || new Date()
              });
            }
          }
        }
      }
    }

    // 3. Fetch Instagram Connection Pages
    if (!platform || platform === 'instagram') {
      const igConnections = await InstagramConnection.find({ workspace_id, is_active: true }).lean();
      for (const conn of igConnections) {
        if (conn.pages && conn.pages.length > 0) {
          for (const page of conn.pages) {
            if (page.is_active !== false) {
              connections.push({
                _id: page._id,
                workspace_id: conn.workspace_id,
                platform: 'instagram',
                account_id: page.instagram_account_id,
                account_name: page.instagram_username || page.page_name,
                account_username: page.instagram_username || null,
                profile_picture: null,
                is_active: true,
                connected_at: conn.created_at || new Date()
              });
            }
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: connections,
      total: connections.length
    });
  } catch (error) {
    console.error('[getConnectedAccounts] Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch connected accounts' });
  }
};

export const disconnectAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.owner_id || req.user?.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid connection ID' });
    }

    const connection = await SocialMediaConnection.findById(id);
    if (!connection) {
      return res.status(404).json({ success: false, error: 'Connection not found' });
    }

    await SocialMediaConnection.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: `${connection.platform} account disconnected successfully`
    });
  } catch (error) {
    console.error('[disconnectAccount] Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to disconnect account' });
  }
};

export const getConnectionById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid connection ID' });
    }

    const connection = await SocialMediaConnection.findById(id)
      .select('-access_token -refresh_token')
      .lean();

    if (!connection) {
      return res.status(404).json({ success: false, error: 'Connection not found' });
    }

    return res.status(200).json({ success: true, data: connection });
  } catch (error) {
    console.error('[getConnectionById] Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch connection' });
  }
};
