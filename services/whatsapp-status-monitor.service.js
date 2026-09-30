import axios from 'axios';
import { WhatsappWaba, WhatsappPhoneNumber, User } from '../models/index.js';
import EmailTemplateService from './email-template.service.js';
import { sendPushNotification } from '../utils/one-signal.js';

const META_GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v25.0';

export const syncWabaAndPhoneStatus = async (wabaId) => {
  try {
    const waba = await WhatsappWaba.findOne({ _id: wabaId, deleted_at: null });
    if (!waba || waba.provider === 'baileys' || !waba.access_token || !waba.whatsapp_business_account_id) {
      return;
    }

    const user = await User.findById(waba.user_id).lean();
    if (!user) {
      return;
    }

    // 1. Fetch WABA status from Meta
    let newAccountReviewStatus = waba.account_review_status;
    let newBusinessVerificationStatus = waba.business_verification_status;

    try {
      const wabaRes = await axios.get(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${waba.whatsapp_business_account_id}`,
        {
          params: {
            fields: 'account_review_status,business_verification_status'
          },
          headers: {
            Authorization: `Bearer ${waba.access_token}`
          }
        }
      );

      if (wabaRes.data) {
        newAccountReviewStatus = wabaRes.data.account_review_status || null;
        newBusinessVerificationStatus = wabaRes.data.business_verification_status || null;
      }
    } catch (wabaErr) {
      console.error(`Failed to fetch WABA Meta status for ${waba.whatsapp_business_account_id}:`, wabaErr.message);
    }

    // Check WABA status changes and notify
    if (newAccountReviewStatus !== waba.account_review_status) {
      if (waba.account_review_status !== null && waba.account_review_status !== undefined) {
        await handleStatusChange(
          user,
          waba,
          null,
          'Account Review',
          waba.account_review_status,
          newAccountReviewStatus
        );
      }
      waba.account_review_status = newAccountReviewStatus;
    }

    if (newBusinessVerificationStatus !== waba.business_verification_status) {
      if (waba.business_verification_status !== null && waba.business_verification_status !== undefined) {
        await handleStatusChange(
          user,
          waba,
          null,
          'Business Verification',
          waba.business_verification_status,
          newBusinessVerificationStatus
        );
      }
      waba.business_verification_status = newBusinessVerificationStatus;
    }

    await waba.save();

    // 2. Fetch Phone Numbers status from Meta
    const phoneNumbers = await WhatsappPhoneNumber.find({
      waba_id: waba._id,
      deleted_at: null
    });

    for (const phone of phoneNumbers) {
      let newNameStatus = phone.name_status;
      let newCodeVerificationStatus = phone.code_verification_status;
      let newStatus = phone.status;
      let newVerifiedName = phone.verified_name;
      let newQualityRating = phone.quality_rating;

      try {
        const phoneRes = await axios.get(
          `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phone.phone_number_id}`,
          {
            params: {
              fields: 'verified_name,quality_rating,name_status,code_verification_status,status'
            },
            headers: {
              Authorization: `Bearer ${waba.access_token}`
            }
          }
        );

        if (phoneRes.data) {
          newNameStatus = phoneRes.data.name_status || null;
          newCodeVerificationStatus = phoneRes.data.code_verification_status || null;
          newStatus = phoneRes.data.status || null;
          newVerifiedName = phoneRes.data.verified_name || newVerifiedName;
          newQualityRating = phoneRes.data.quality_rating || newQualityRating;
        }
      } catch (phoneErr) {
        console.error(`Failed to fetch Phone Number Meta status for ${phone.phone_number_id}:`, phoneErr.message);
      }

      let phoneUpdated = false;

      if (newNameStatus !== phone.name_status) {
        if (phone.name_status !== null && phone.name_status !== undefined) {
          await handleStatusChange(
            user,
            waba,
            phone,
            'Display Name',
            phone.name_status,
            newNameStatus
          );
        }
        phone.name_status = newNameStatus;
        phoneUpdated = true;
      }

      if (newCodeVerificationStatus !== phone.code_verification_status) {
        if (phone.code_verification_status !== null && phone.code_verification_status !== undefined) {
          await handleStatusChange(
            user,
            waba,
            phone,
            'Phone Verification',
            phone.code_verification_status,
            newCodeVerificationStatus
          );
        }
        phone.code_verification_status = newCodeVerificationStatus;
        phoneUpdated = true;
      }

      if (newStatus !== phone.status) {
        if (phone.status !== null && phone.status !== undefined) {
          await handleStatusChange(
            user,
            waba,
            phone,
            'Operational Status',
            phone.status,
            newStatus
          );
        }
        phone.status = newStatus;
        phoneUpdated = true;
      }

      if (newVerifiedName !== phone.verified_name) {
        phone.verified_name = newVerifiedName;
        phoneUpdated = true;
      }

      if (newQualityRating !== phone.quality_rating) {
        phone.quality_rating = newQualityRating;
        phoneUpdated = true;
      }

      // If name status is declined/rejected, set rejection reason
      if (newNameStatus === 'DECLINED' || newNameStatus === 'REJECTED') {
        phone.rejection_reason = "The submitted display name does not comply with WhatsApp Display Name Guidelines.";
        phoneUpdated = true;
      } else if (phone.rejection_reason) {
        phone.rejection_reason = null;
        phoneUpdated = true;
      }

      if (phoneUpdated) {
        await phone.save();
      }
    }
  } catch (err) {
    console.error(`Error in syncWabaAndPhoneStatus for ${wabaId}:`, err);
  }
};

const handleStatusChange = async (user, waba, phone, type, oldStatus, newStatus) => {
  try {
    const wabaName = waba.name || waba.whatsapp_business_account_id;
    let statusTitle = `${type} Status Changed`;
    let statusMessage = `The ${type} status of your WhatsApp Business Account connection (${wabaName}) has changed from "${oldStatus || 'N/A'}" to "${newStatus || 'N/A'}".`;
    let requiredAction = 'No action required.';
    let actionText = 'Open WhatsApp Manager';
    let actionUrl = `https://business.facebook.com/wa/manage/phone-numbers/?waba_id=${waba.whatsapp_business_account_id}`;

    // Define user friendly action guidelines
    if (type === 'Display Name') {
      if (newStatus === 'APPROVED' || newStatus === 'AVAILABLE_WITHOUT_REVIEW') {
        statusTitle = 'Display Name Approved';
        statusMessage = `Your WhatsApp display name "${phone?.verified_name || ''}" has been approved by Meta.`;
        requiredAction = 'No action required. You can now use this display name.';
      } else if (newStatus === 'DECLINED' || newStatus === 'REJECTED') {
        statusTitle = 'Display Name Rejected';
        statusMessage = `Your WhatsApp display name "${phone?.verified_name || ''}" was rejected by Meta.`;
        requiredAction = 'Update the display name in Meta WhatsApp Manager and resubmit it for review. Make sure it complies with Meta guidelines.';
      } else if (newStatus === 'PENDING_REVIEW') {
        statusTitle = 'Display Name Under Review';
        statusMessage = `Your WhatsApp display name "${phone?.verified_name || ''}" is currently under review by Meta.`;
        requiredAction = 'Meta is reviewing your display name. This process typically takes up to 24 hours.';
      }
    } else if (type === 'Business Verification') {
      if (newStatus === 'verified') {
        statusTitle = 'Business Verification Approved';
        statusMessage = `Your Meta Business Verification has been approved.`;
        requiredAction = 'No action required. Your account limits have been updated.';
      } else if (['rejected', 'failed', 'revoked'].includes(newStatus)) {
        statusTitle = 'Business Verification Failed / Rejected';
        statusMessage = `Your Meta Business Verification status is now "${newStatus}".`;
        requiredAction = 'Submit valid business documents and appeal in Meta Business Suite Security Center.';
      } else if (['pending', 'pending_submission', 'pending_need_more_info'].includes(newStatus)) {
        statusTitle = 'Business Verification Pending / Action Required';
        statusMessage = `Your Meta Business Verification is pending or requires additional information.`;
        requiredAction = 'Check the Security Center in Meta Business Suite and submit any required documents.';
      }
    } else if (type === 'Account Review') {
      if (['REJECTED', 'DISABLED', 'BLOCKED', 'SUSPENDED'].includes(newStatus)) {
        statusTitle = 'WhatsApp Account Disabled';
        statusMessage = `Your WhatsApp Business Account has been disabled or rejected by Meta.`;
        requiredAction = 'Appeal this decision immediately in Meta Business Support.';
      }
    } else if (type === 'Operational Status') {
      if (newStatus === 'CONNECTED') {
        statusTitle = 'Messaging Enabled';
        statusMessage = `Your WhatsApp phone number (${phone?.display_phone_number || ''}) is now CONNECTED and messaging is enabled.`;
        requiredAction = 'None. You can now send and receive messages.';
      } else if (newStatus === 'FLAGGED') {
        statusTitle = 'WhatsApp Number Flagged';
        statusMessage = `Your WhatsApp phone number (${phone?.display_phone_number || ''}) has been FLAGGED by Meta due to low quality rating.`;
        requiredAction = 'Review your message content and delivery practices to improve quality rating.';
      } else if (newStatus === 'RESTRICTED') {
        statusTitle = 'WhatsApp Number Restricted';
        statusMessage = `Your WhatsApp phone number (${phone?.display_phone_number || ''}) is RESTRICTED because you have reached your messaging limit.`;
        requiredAction = 'Wait for the 24-hour limit reset window to resume outbound notifications.';
      } else if (newStatus === 'UNVERIFIED') {
        statusTitle = 'Phone Number Registration Failed';
        statusMessage = `Your WhatsApp phone number (${phone?.display_phone_number || ''}) is unverified or registration failed.`;
        requiredAction = 'Complete registration and verify your phone number using the default PIN.';
      }
    }

    // 1. Send Email Notification
    if (user.email) {
      await EmailTemplateService.send('whatsapp-status-update', user.email, {
        user_name: user.name || 'User',
        waba_name: wabaName,
        status_title: statusTitle,
        status_message: statusMessage,
        required_action: requiredAction,
        action_url: actionUrl,
        action_text: actionText
      });
    }

    // 2. Send Push Notification via OneSignal
    if (user.player_id) {
      try {
        const playerIds = Array.isArray(user.player_id) ? user.player_id : [user.player_id];
        await sendPushNotification({
          userIds: playerIds,
          heading: statusTitle,
          content: statusMessage,
          data: {
            waba_id: waba._id.toString(),
            type: 'whatsapp_status_update'
          }
        });
      } catch (pushErr) {
        console.error('Failed to send status update push notification:', pushErr.message);
      }
    }
  } catch (err) {
    console.error('Error handling status change notification:', err);
  }
};

export const syncAllActiveWabas = async () => {
  console.log('Starting sync of all active WhatsApp Business Accounts...');
  try {
    const activeWabas = await WhatsappWaba.find({
      is_active: true,
      deleted_at: null
    });

    console.log(`Found ${activeWabas.length} active WABAs to sync.`);

    for (const waba of activeWabas) {
      await syncWabaAndPhoneStatus(waba._id);
    }

    console.log('WhatsApp status sync complete.');
  } catch (err) {
    console.error('Error syncing all active WABAs:', err);
  }
};

export default {
  syncWabaAndPhoneStatus,
  syncAllActiveWabas
};
