import mongoose from 'mongoose';

const whatsappPhoneSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  waba_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WhatsappWaba',
    required: true,
    index: true
  },

  phone_number_id: {
    type: String,
    required: true,
    unique: true
  },

  display_phone_number: {
    type: String,
    required: true
  },

  verified_name: {
    type: String
  },

  quality_rating: {
    type: String
  },

  name_status: {
    type: String,
    default: null
  },

  code_verification_status: {
    type: String,
    default: null
  },

  status: {
    type: String,
    default: null
  },

  rejection_reason: {
    type: String,
    default: null
  },

  is_active: {
    type: Boolean,
    default: true
  },

  deleted_at: {
    type: Date,
    default: null
  },

  last_used_at: {
    type: Date,
    default: null
  },

  is_primary: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true,
  collection: 'whatsapp_phone_numbers'
});

// whatsappPhoneSchema.index({ waba_id: 1 });
whatsappPhoneSchema.index({ is_active: 1 });
whatsappPhoneSchema.index({ last_used_at: 1 });
whatsappPhoneSchema.index({ is_primary: 1 });

export default mongoose.model('WhatsappPhoneNumber', whatsappPhoneSchema);
