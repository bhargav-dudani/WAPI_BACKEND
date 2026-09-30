import mongoose from 'mongoose';

const widgetSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    whatsapp_phone_number: {
      type: String,
      required: true
    },

    widget_image_url: {
      type: String,
      default: null,
      trim: true,
    },

    body_background_image: {
      type: String,
      default: null,
      trim: true,
    },

    header_text: {
      type: String,
      default: 'Chat with us',
      trim: true,
    },

    header_text_color: {
      type: String,
      default: 'var(--white)',
      trim: true,
    },

    header_background_color: {
      type: String,
      default: 'var(--primary)',
      trim: true,
    },

    body_background_color: {
      type: String,
      default: 'var(--whatsapp-light-bg)',
      trim: true,
    },

    welcome_text: {
      type: String,
      default: 'Welcome to our support! \n\nThank you for reaching out to us on WhatsApp.',
      trim: true,
    },

    welcome_text_color: {
      type: String,
      default: 'var(--dark-gray)',
      trim: true,
    },

    welcome_text_background: {
      type: String,
      default: 'var(--white)',
      trim: true,
    },

    start_chat_button_text: {
      type: String,
      default: 'Start Chat on WhatsApp',
      trim: true,
    },

    start_chat_button_background: {
      type: String,
      default: 'var(--primary)',
      trim: true,
    },

    start_chat_button_text_color: {
      type: String,
      default: 'var(--white)',
      trim: true,
    },

    default_open_popup: {
      type: Boolean,
      default: false,
    },

    default_user_message: {
      type: String,
      default: 'Hi, I need help !!',
      trim: true,
    },

    widget_position: {
      type: String,
      default: 'bottom-right',
      trim: true,
      enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    },

    widget_color: {
      type: String,
      default: null,
      trim: true,
    },

    deleted_at: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'widgets',
  }
);

export default mongoose.model('Widget', widgetSchema);
