/**
 * Campaign Recovery Cron
 * 
 * Detects campaigns stuck in "sending" state with no recent activity
 * and re-queues them. This fixes the issue where a server restart
 * causes BullMQ/Redis jobs to be lost while the DB still shows
 * jobs_queued=true, leaving campaigns permanently stuck.
 * 
 * Runs every 5 minutes.
 */

import Campaign from '../models/campaign.model.js';
import { processCampaignInBackground } from '../utils/campaign-processing.js';

const STUCK_THRESHOLD_MINUTES = 10; // Campaign stuck longer than this → re-queue
const RECOVERY_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

let isRecovering = false;

export const recoverStuckCampaigns = async () => {
  if (isRecovering) return; // Prevent concurrent runs
  isRecovering = true;

  try {
    const stuckThreshold = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000);

    // Find campaigns that are "sending" with jobs queued, but haven't had
    // any recipient updates in the last STUCK_THRESHOLD_MINUTES minutes
    const stuckCampaigns = await Campaign.find({
      status: 'sending',
      jobs_queued: true,
      is_paused: { $ne: true },
      deleted_at: null,
      // Stuck = has pending recipients but no progress recently
      $or: [
        { updated_at: { $lt: stuckThreshold } },
        { updated_at: { $exists: false } }
      ],
      'stats.pending_count': { $gt: 0 }
    }).select('_id name stats sent_at updated_at').lean();

    if (stuckCampaigns.length === 0) return;

    console.log(`[CampaignRecovery] Found ${stuckCampaigns.length} stuck campaign(s) — re-queuing...`);

    for (const campaign of stuckCampaigns) {
      try {
        console.log(`[CampaignRecovery] Re-queuing campaign: ${campaign._id} ("${campaign.name}") — pending: ${campaign.stats?.pending_count}`);

        // Reset jobs_queued so processCampaignInBackground will re-queue it
        await Campaign.updateOne(
          { _id: campaign._id },
          { $set: { jobs_queued: false } }
        );

        await processCampaignInBackground(campaign._id, { isResuming: true });

        console.log(`[CampaignRecovery] ✅ Successfully re-queued campaign ${campaign._id}`);
      } catch (err) {
        console.error(`[CampaignRecovery] ❌ Failed to re-queue campaign ${campaign._id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[CampaignRecovery] Error during recovery check:', err.message);
  } finally {
    isRecovering = false;
  }
};

export const startCampaignRecoveryCron = () => {
  console.log('[CampaignRecovery] Starting campaign recovery cron (every 5 minutes)');

  // Run immediately on startup to fix any campaigns stuck from last restart
  setTimeout(recoverStuckCampaigns, 30 * 1000); // 30s after startup

  // Then run every 5 minutes
  setInterval(recoverStuckCampaigns, RECOVERY_INTERVAL_MS);
};
