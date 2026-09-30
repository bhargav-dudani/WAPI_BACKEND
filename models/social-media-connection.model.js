import mongoose from 'mongoose';

const socialMediaConnectionSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    workspace_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true
    },
    platform: {
      type: String,
      required: true,
      enum: ['youtube', 'linkedin', 'twitter', 'threads', 'tiktok', 'facebook', 'instagram'],
      index: true
    },

    account_id: {
      type: String,
      required: true
    },
    account_name: {
      type: String,
      required: true
    },
    account_username: {
      type: String,
      default: null
    },
    profile_picture: {
      type: String,
      default: null
    },

    access_token: {
      type: String,
      required: true
    },
    refresh_token: {
      type: String,
      default: null
    },
    token_expiry: {
      type: Date,
      default: null
    },

    permissions: {
      type: [String],
      default: []
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },

    is_active: {
      type: Boolean,
      default: true,
      index: true
    },
    connected_at: {
      type: Date,
      default: Date.now
    },
    last_used: {
      type: Date,
      default: null
    }
  },
  {
    collection: 'social_media_connections',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

socialMediaConnectionSchema.index(
  { workspace_id: 1, platform: 1 },
  { unique: true }
);

socialMediaConnectionSchema.index({ workspace_id: 1, is_active: 1 });
socialMediaConnectionSchema.index({ platform: 1, account_id: 1 });
socialMediaConnectionSchema.index({ token_expiry: 1 });

export default mongoose.model('SocialMediaConnection', socialMediaConnectionSchema);
