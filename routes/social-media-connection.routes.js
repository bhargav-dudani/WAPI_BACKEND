import express from 'express';
import {
  getOAuthConfig,
  oauthCallback,
  connectAccount,
  getConnectedAccounts,
  getConnectionById,
  disconnectAccount
} from '../controllers/social-media-connection.controller.js';
import { authenticate } from '../middlewares/auth.js';
import { requireSubscription } from '../middlewares/plan-permission.js';

const router = express.Router();

router.get('/callback/:platform', oauthCallback);

router.use(authenticate);
router.use(requireSubscription);

router.get('/config/:platform', getOAuthConfig);
router.post('/connect', connectAccount);
router.get('/', getConnectedAccounts);
router.get('/:id', getConnectionById);
router.delete('/:id', disconnectAccount);

export default router;
