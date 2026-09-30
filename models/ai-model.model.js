import mongoose from 'mongoose';

const aiModelSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            unique: true,
            trim: true
        },
        display_name: {
            type: String,
            required: true,
            trim: true
        },
        provider: {
            type: String,
            required: true,
            enum: ['openai', 'anthropic', 'google', 'cohere', 'mistral', 'groq', 'deepseek', 'xai', 'custom'],
            lowercase: true
        },
        model_id: {
            type: String,
            required: true,
            trim: true
        },
        api_endpoint: {
            type: String,
            required: true,
            trim: true
        },
        api_version: {
            type: String,
            default: null
        },
        capabilities: {
            translate: { type: Boolean, default: true },
            summarize: { type: Boolean, default: true },
            improve: { type: Boolean, default: true },
            formalize: { type: Boolean, default: true },
            casualize: { type: Boolean, default: true },
            reply_suggestion: { type: Boolean, default: true }
        },
        config: {
            type: mongoose.Schema.Types.Mixed,
            default: {
                max_tokens: 1000,
                temperature: 0.7,
                top_p: 1,
                frequency_penalty: 0,
                presence_penalty: 0,
                api_key: null,
                payload_type: 'json',
                payload: ''
            }
        },
        encrypted_config: {
            type: Map,
            of: String,
            default: {}
        },
        headers_template: {
            type: Map,
            of: String,
            default: {}
        },
        request_format: {
            type: String,
            enum: ['openai', 'anthropic', 'google', 'custom'],
            default: 'openai'
        },
        response_path: {
            type: String,
            default: 'choices.0.message.content'
        },
        status: {
            type: String,
            enum: ['active', 'inactive'],
            default: 'active'
        },
        is_default: {
            type: Boolean,
            default: false
        },
        description: {
            type: String,
            default: ''
        },
        created_by: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },
        deleted_at: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

aiModelSchema.index({ provider: 1, status: 1 });
aiModelSchema.index({ name: 1, deleted_at: 1 });
aiModelSchema.index({ status: 1, deleted_at: 1 });

aiModelSchema.pre('validate', function(next) {
  if (!this.api_endpoint && this.provider && this.provider !== 'custom') {
    const defaults = {
      openai: 'https://api.openai.com/v1/chat/completions',
      google: 'https://generativelanguage.googleapis.com/v1',
      anthropic: 'https://api.anthropic.com/v1/messages',
      xai: 'https://api.x.ai/v1/chat/completions',
      deepseek: 'https://api.deepseek.com/chat/completions',
      groq: 'https://api.groq.com/openai/v1/chat/completions',
      mistral: 'https://api.mistral.ai/v1/chat/completions',
      cohere: 'https://api.cohere.ai/v1/chat',
    };
    this.api_endpoint = defaults[this.provider] || '';
  }
  next();
});

export default mongoose.model('AIModel', aiModelSchema);
