import mongoose from 'mongoose';

const socialMediaPostSchema = new mongoose.Schema({
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    workspace_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Workspace',
        required: true
    },
    connection_id: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    platform: {
        type: String,
        enum: ['youtube', 'linkedin', 'twitter', 'threads', 'tiktok', 'facebook', 'instagram'],
        required: true
    },
    media_id: {
        type: String,
        default: 'PENDING'
    },
    media_type: {
        type: String
    },
    caption: {
        type: String
    },
    media_url: {
        type: String
    },
    media_urls: [{
        type: String
    }],
    thumbnail_url: {
        type: String
    },
    permalink: {
        type: String
    },
    status: {
        type: String,
        enum: ['pending', 'scheduled', 'published', 'failed', 'cancelled', 'draft'],
        default: 'pending'
    },
    content_type: {
        type: String,
        default: 'post'
    },
    error_message: {
        type: String,
        default: null
    },
    scheduled_at: {
        type: Date,
        default: null
    },
    published_at: {
        type: Date,
        default: null
    },
    timestamp: {
        type: Date
    },
    suggested_keywords: [{
        type: String
    }],
    children: {
        type: mongoose.Schema.Types.Mixed
    },
    is_imported: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

socialMediaPostSchema.index({ connection_id: 1, media_id: 1 }, { unique: true, partialFilterExpression: { media_id: { $ne: 'PENDING' } } });

const SocialMediaPost = mongoose.model('SocialMediaPost', socialMediaPostSchema);

export default SocialMediaPost;
