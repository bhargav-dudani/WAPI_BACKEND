import { google } from 'googleapis';
import { decrypt, encrypt } from './encryption-utils.js';
import { GoogleAccount } from '../models/index.js';
import mongoose from 'mongoose';
import moment from 'moment';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'openid'
];


export const getOAuth2Client = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
};

export const parseToDate = (dateStr) => {
  if (!dateStr) return new Date();
  if (dateStr instanceof Date) return isNaN(dateStr.getTime()) ? new Date() : dateStr;

  const parsed = moment(dateStr, [
    moment.ISO_8601,
    'YYYY-MM-DDTHH:mm:ss.SSSZ',
    'YYYY-MM-DDTHH:mm:ssZ',
    'YYYY-MM-DDTHH:mm',
    'YYYY-MM-DD HH:mm:ss',
    'YYYY-MM-DD HH:mm',
    'DD-MM-YYYY HH:mm:ss',
    'DD-MM-YYYY HH:mm',
    'DD/MM/YYYY HH:mm:ss',
    'DD/MM/YYYY HH:mm'
  ]);

  if (parsed.isValid()) {
    return parsed.toDate();
  }

  const nativeDate = new Date(dateStr);
  if (!isNaN(nativeDate.getTime())) {
    return nativeDate;
  }

  return new Date();
};


export const getAuthenticatedClient = async (googleAccountId) => {
  let account;
  if (mongoose.Types.ObjectId.isValid(googleAccountId)) {
    account = await GoogleAccount.findById(googleAccountId);
  } else {
    account = await GoogleAccount.findOne({ email: googleAccountId, deleted_at: null });
  }

  if (!account) {
    throw new Error('Google account not found');
  }

  const oauth2Client = getOAuth2Client();

  oauth2Client.setCredentials({
    access_token: decrypt(account.access_token),
    refresh_token: decrypt(account.refresh_token),
    expiry_date: account.expires_at.getTime()
  });

  oauth2Client.on('tokens', async (tokens) => {
    const updateData = {};
    if (tokens.access_token) {
      updateData.access_token = encrypt(tokens.access_token);
    }
    if (tokens.expiry_date) {
      updateData.expires_at = new Date(tokens.expiry_date);
    }
    if (tokens.refresh_token) {
      updateData.refresh_token = encrypt(tokens.refresh_token);
    }

    if (Object.keys(updateData).length > 0) {
      await GoogleAccount.findByIdAndUpdate(googleAccountId, updateData);
    }
  });

  return oauth2Client;
};



export const handleGoogleApiError = async (error, googleAccountId) => {
  const isInvalidGrant =
    (error.response?.data?.error === 'invalid_grant') ||
    (error.message && error.message.includes('invalid_grant'));

  const isInsufficientScope =
    (error.response?.status === 403 && error.message?.includes('insufficient authentication scopes'));
  if (isInvalidGrant || isInsufficientScope) {
    try {
      await GoogleAccount.findByIdAndUpdate(googleAccountId, {
        status: 'expired',
        updated_at: new Date()
      });
      return true;
    } catch (dbErr) {
      console.error(`Failed to update account status:`, dbErr.message);
    }
  }
  return false;
};

export const getCalendarClient = async (googleAccountId) => {
  const auth = await getAuthenticatedClient(googleAccountId);
  return google.calendar({ version: 'v3', auth });
};

export const getSheetsClient = async (googleAccountId) => {
  const auth = await getAuthenticatedClient(googleAccountId);
  return google.sheets({ version: 'v4', auth });
};

export const getFormsClient = async (googleAccountId) => {
  const auth = await getAuthenticatedClient(googleAccountId);
  return google.forms({ version: 'v1', auth });
};

export default {
  getOAuth2Client,
  getAuthenticatedClient,
  getCalendarClient,
  getSheetsClient,
  getFormsClient,
  handleGoogleApiError,
  parseToDate,
  SCOPES
};
