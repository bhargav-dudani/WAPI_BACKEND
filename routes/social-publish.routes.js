import express from 'express';
import {
  publishContent,
  cancelScheduledPost,
  getPostHistory,
  getPostById,
  deletePost,
  validateMedia,
  getSupportedPlatforms,
  generateCaption,
  saveDraft,
  getDrafts,
  getDraftById,
  updateDraft,
  deleteDraft,
  bulkPublish
} from '../controllers/social-publish.controller.js';
import { authenticate } from '../middlewares/auth.js';
import { requireSubscription } from '../middlewares/plan-permission.js';

const router = express.Router();

router.use(authenticate);
router.use(requireSubscription);

router.post('/publish', publishContent);
router.post('/cancel/:historyId', cancelScheduledPost);
router.get('/history', getPostHistory);
router.get('/history/:historyId', getPostById);
router.delete('/history/:historyId', deletePost);
router.post('/validate-media', validateMedia);
router.get('/platforms', getSupportedPlatforms);
router.post('/generate-caption', generateCaption);

router.post('/bulk', bulkPublish);
router.post('/drafts', saveDraft);
router.get('/drafts', getDrafts);
router.get('/drafts/:draftId', getDraftById);
router.put('/drafts/:draftId', updateDraft);
router.delete('/drafts/:draftId', deleteDraft);

export default router;
