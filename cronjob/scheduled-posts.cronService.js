import cron from 'node-cron';
import SocialMediaPost from '../models/social-media-post.model.js';
import socialMediaService from '../services/social-media.service.js';

async function scheduledPostsCronService() {
    // Run every minute
    cron.schedule('* * * * *', async () => {
        console.log('Running scheduled posts processing cron...');
        try {
            const now = new Date();
            const scheduledPosts = await SocialMediaPost.find({
                status: 'scheduled',
                scheduled_at: { $lte: now }
            });

            if (scheduledPosts.length === 0) return;

            const baseUrl = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000';

            for (const post of scheduledPosts) {
                post.status = 'pending';
                await post.save();

                try {
                    console.log(`[CRON] Publishing scheduled post ${post._id} to ${post.platform}`);
                    await socialMediaService.publishContent(
                        post._id,
                        post.user_id,
                        post.media_urls,
                        post.caption,
                        post.content_type,
                        post.platform,
                        baseUrl
                    );
                } catch (error) {
                    console.error(`[CRON] Failed to publish scheduled post ${post._id}:`, error.message);
                    post.status = 'failed';
                    post.error_message = error.message;
                    await post.save();
                }
            }
        } catch (error) {
            console.error('[CRON] Error in processScheduledPosts:', error.message);
        }
    });

    console.log('Scheduled posts cron job scheduled.');
}

export default scheduledPostsCronService;
