import { AIModel, User } from '../models/index.js';

async function seedAIModels() {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@admin.com';
    const admin = await User.findOne({ email: adminEmail });
    const adminId = admin ? admin._id : null;

    const aiModels = [
      {
        name: 'openai-gpt-4o',
        display_name: 'OpenAI GPT-4o',
        provider: 'openai',
        model_id: 'gpt-4o',
        api_endpoint: 'https://api.openai.com/v1/chat/completions',
        request_format: 'openai',
        status: 'active',
        description: 'OpenAI flagship multimodal model.',
        created_by: adminId
      },
      {
        name: 'google-gemini-1.5-flash',
        display_name: 'Google Gemini 1.5 Flash',
        provider: 'google',
        model_id: 'gemini-1.5-flash',
        api_endpoint: 'https://generativelanguage.googleapis.com/v1',
        request_format: 'google',
        status: 'active',
        description: 'Google fast and efficient multimodal model.',
        created_by: adminId
      },
      {
        name: 'xai-grok-beta',
        display_name: 'xAI Grok 2',
        provider: 'xai',
        model_id: 'grok-2-latest',
        api_endpoint: 'https://api.x.ai/v1/chat/completions',
        request_format: 'openai',
        status: 'active',
        description: 'xAI Grok model, known for its real-time knowledge.',
        created_by: adminId
      },
      {
        name: 'deepseek-chat',
        display_name: 'DeepSeek Chat',
        provider: 'deepseek',
        model_id: 'deepseek-chat',
        api_endpoint: 'https://api.deepseek.com/chat/completions',
        request_format: 'openai',
        status: 'active',
        description: 'DeepSeek highly efficient and capable model.',
        created_by: adminId
      }
    ];

    for (const modelData of aiModels) {
      await AIModel.findOneAndUpdate(
        { name: modelData.name },
        { $setOnInsert: modelData },
        { upsert: true, returnDocument: 'after' }
      );
    }

    console.log('AI models seeded successfully!');
  } catch (error) {
    console.error('Error seeding AI models:', error);
    throw error;
  }
}

export default seedAIModels;
