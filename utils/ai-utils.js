import { AiPromptLog } from '../models/index.js'

const getNestedValue = (obj, path) => {
  return path.split('.').reduce((current, key) => current?.[key], obj);
};


const getFormat = (model) => {
  const { provider, api_endpoint, request_format } = model;

  if (request_format && request_format !== 'openai') {
    return request_format;
  }

  if (provider === 'custom' && api_endpoint) {
    const url = api_endpoint.toLowerCase();
    if (url.includes('googleapis.com') || url.includes('generativelanguage')) {
      return 'google';
    }
    if (url.includes('anthropic.com')) {
      return 'anthropic';
    }
  }

  return request_format || provider;
};


const formatRequestBody = (model, prompt) => {
  const { model_id, config } = model;
  const safeConfig = config || {};
  const format = getFormat(model);
  console.log("formatRequestBody format:", format, "modelId:", model_id, "safeConfig:", safeConfig);

  switch (format) {
    case 'anthropic':
      return {
        model: model_id,
        max_tokens: safeConfig.max_tokens || 1024,
        messages: [{ role: 'user', content: prompt }]
      };

    case 'google':
      return {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: safeConfig.temperature ?? 0.7,
          maxOutputTokens: safeConfig.max_tokens ?? 1024,
          topP: safeConfig.top_p ?? 0.95
        }
      };

    case 'custom':
      if (safeConfig.payload) {
        if (safeConfig.payload_type === 'json' || typeof safeConfig.payload === 'string') {
          try {
            let payloadStr = typeof safeConfig.payload === 'string' ? safeConfig.payload : JSON.stringify(safeConfig.payload);
            payloadStr = payloadStr.replace(/\{\{\s*prompt\s*\}\}/gi, prompt);
            return JSON.parse(payloadStr);
          } catch (e) {
            console.error("Failed to parse custom payload JSON:", e);
          }
        } else if (typeof safeConfig.payload === 'object') {
          const parsedPayload = {};
          Object.entries(safeConfig.payload).forEach(([key, val]) => {
            if (typeof val === 'string') {
              parsedPayload[key] = val.replace(/\{\{\s*prompt\s*\}\}/gi, prompt);
            } else {
              parsedPayload[key] = val;
            }
          });
          return parsedPayload;
        }
      }
      return {
        model: model_id,
        messages: [{ role: 'user', content: prompt }],
        temperature: safeConfig.temperature ?? 0.7,
        max_tokens: safeConfig.max_tokens || 1024,
        top_p: safeConfig.top_p ?? 1,
        frequency_penalty: safeConfig.frequency_penalty ?? 0,
        presence_penalty: safeConfig.presence_penalty ?? 0
      };

    case 'openai':
    default:
      const isReasoningModel = typeof model_id === 'string' && (model_id.startsWith('o1') || model_id.startsWith('o3'));
      if (isReasoningModel) {
        return {
          model: model_id,
          messages: [{ role: 'user', content: prompt }],
          ...(safeConfig.max_tokens ? { max_completion_tokens: safeConfig.max_tokens } : {})
        };
      }
      return {
        model: model_id,
        messages: [{ role: 'user', content: prompt }],
        temperature: safeConfig.temperature ?? 0.7,
        max_tokens: safeConfig.max_tokens || 1024,
        top_p: safeConfig.top_p ?? 1,
        frequency_penalty: safeConfig.frequency_penalty ?? 0,
        presence_penalty: safeConfig.presence_penalty ?? 0
      };
  }
};


const formatRequestHeaders = (model, apiKey, prompt) => {
  const { api_version, headers_template } = model;
  const format = getFormat(model);
  const headers = {
    'Content-Type': 'application/json'
  };

  if (headers_template) {
    const templateObj = headers_template instanceof Map ? Object.fromEntries(headers_template) : headers_template;
    if (Object.keys(templateObj).length > 0) {
      Object.entries(templateObj).forEach(([key, value]) => {
        if (typeof key !== 'string' || key.startsWith('$')) {
          return;
        }

        let headerValue = value;
        if (typeof headerValue === 'string') {
          headerValue = headerValue.replace('{{API_KEY}}', apiKey);
          if (prompt) {
            headerValue = headerValue.replace(/\{\{\s*prompt\s*\}\}/gi, prompt);
          }
        }

        if (typeof headerValue === 'string' && headerValue.trim() !== '') {
          headers[key] = headerValue;
        }
      });

      if (headers['Authorization'] || headers['x-api-key'] || headers['x-goog-api-key']) {
        return headers;
      }
    }
  }

  switch (format) {
    case 'anthropic':
      if (!headers['x-api-key'] && typeof apiKey === 'string') {
        headers['x-api-key'] = apiKey;
      }
      if (typeof api_version === 'string') {
        headers['anthropic-version'] = api_version || '2023-06-01';
      }
      break;

    case 'google':
      if (headers_template) {
        const templateObj = headers_template instanceof Map ? Object.fromEntries(headers_template) : headers_template;
        if (templateObj['x-goog-api-key'] && typeof apiKey === 'string') {
          headers['x-goog-api-key'] = apiKey;
        }
      }
      break;

    case 'custom':
    case 'openai':
    case 'groq':
    case 'mistral':
    default:
      if (!headers['Authorization'] && !headers['x-api-key'] && typeof apiKey === 'string' && apiKey.trim() !== '' && apiKey !== 'null') {
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
      }
      break;
  }

  return headers;
};


const buildApiEndpoint = (model, apiKey, prompt) => {
  let { api_endpoint, model_id } = model;
  const format = getFormat(model);

  if (format === 'google') {
    let url = api_endpoint || 'https://generativelanguage.googleapis.com/v1/models';

    // Normalize googleapis.com to generativelanguage.googleapis.com if they entered it
    if (url.includes('googleapis.com') && !url.includes('generativelanguage')) {
      url = url.replace('googleapis.com', 'generativelanguage.googleapis.com');
    }

    if (url.includes('generativelanguage.googleapis.com')) {
      if (!url.includes('/v1') && !url.includes('/v1beta')) {
        url = `${url.replace(/\/$/, '')}/v1`;
      }
    }

    if (url.includes('v1beta') && (model_id.includes('gemini-1.5') || model_id.includes('gemini-2.'))) {
      url = url.replace('v1beta', 'v1');
    }

    if (url.endsWith('/models') || url.endsWith('/v1') || url.endsWith('/v1beta')) {
      const baseUrl = url.endsWith('/models') ? url : `${url.replace(/\/$/, '')}/models`;
      url = `${baseUrl}/${model_id}:generateContent`;
    } else if (!url.includes(':generateContent')) {
      if (url.endsWith(model_id)) {
        url = `${url}:generateContent`;
      } else if (!url.includes('/models/')) {
        url = `${url.replace(/\/$/, '')}/models/${model_id}:generateContent`;
      }
    }

    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}key=${apiKey}`;
  }

  if (format === 'custom') {
    let url = api_endpoint || '';
    url = url.replace(/\{\{\s*API_KEY\s*\}\}/gi, apiKey);
    url = url.replace(/\{\{\s*MODEL_ID\s*\}\}/gi, model_id);
    if (prompt) {
      url = url.replace(/\{\{\s*prompt\s*\}\}/gi, encodeURIComponent(prompt));
    }
    return url;
  }

  return api_endpoint;
};


const callAIModel = async (userId, model, apiKey, prompt) => {
  const requestBody = formatRequestBody(model, prompt);
  console.log('Generated Request Body:', JSON.stringify(requestBody, null, 2));
  const requestHeaders = formatRequestHeaders(model, apiKey, prompt);
  const apiEndpoint = buildApiEndpoint(model, apiKey, prompt);
  const format = getFormat(model);

  let body;
  if (format === 'custom' && model.config?.payload_type === 'formdata') {
    requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(requestBody).toString();
  } else {
    body = JSON.stringify(requestBody);
  }

  console.log('Calling Endpoint:', apiEndpoint);
  const response = await fetch(apiEndpoint, {
    method: 'POST',
    headers: requestHeaders,
    body: body
  });

  if (!response.ok) {
    let errorDetails = '';
    try {
      const responseText = await response.text();
      try {
        const errorData = JSON.parse(responseText);
        console.error('[AI Model Error Response]', JSON.stringify(errorData, null, 2));

        const targetObj = Array.isArray(errorData) ? errorData[0] : errorData;
        if (typeof targetObj?.error === 'string') {
          errorDetails = targetObj.error;
        } else if (targetObj?.error?.message) {
          errorDetails = targetObj.error.message;
        } else if (targetObj?.message) {
          errorDetails = targetObj.message;
        } else if (targetObj?.detail) {
          errorDetails = typeof targetObj.detail === 'string' ? targetObj.detail : JSON.stringify(targetObj.detail);
        } else if (targetObj?.error_description) {
          errorDetails = targetObj.error_description;
        } else if (targetObj?.msg) {
          errorDetails = targetObj.msg;
        } else {
          errorDetails = responseText;
        }
      } catch {
        errorDetails = responseText;
      }
    } catch {
      errorDetails = response.statusText;
    }

    console.error(`[AI Model API Failed] Status: ${response.status}, Endpoint: ${apiEndpoint}, Details: ${errorDetails}`);
    throw new Error(
      `API request failed with status ${response.status}${errorDetails ? `: ${errorDetails}` : ''}`
    );
  }

  const contentType = response.headers.get('content-type') || '';
  let responseText;

  if (contentType.includes('application/json')) {
    let data;
    try {
      data = await response.json();
    } catch (e) {
      console.warn("JSON parsing failed, reading as plain text:", e);
    }

    if (data) {
      if (format === 'google') {
        const parts = data.candidates?.[0]?.content?.parts || [];
        responseText = parts.map(part => part.text).join('');
      } else {
        responseText = getNestedValue(data, model.response_path || 'choices.0.message.content');
        
        // Fallback paths if specified path is not found or empty
        if (!responseText) {
          const commonPaths = [
            'choices.0.message.content',
            'content.0.text',
            'candidates.0.content.parts.0.text',
            'response',
            'output',
            'result',
            'text',
            'generated_text',
            'message',
            'data.response',
            'data.text',
            'data.result'
          ];
          for (const path of commonPaths) {
            const val = getNestedValue(data, path);
            if (typeof val === 'string' && val.trim() !== '') {
              responseText = val;
              break;
            }
          }
        }
      }
    }
  }

  // If not parsed as JSON (or JSON parsing yielded empty response text), read as plain text
  if (!responseText) {
    responseText = await response.text().catch(() => '');
  }

  if (!responseText || responseText.trim() === '') {
    throw new Error('Unable to extract response from AI model');
  }

  try {
    if (userId) {
      await AiPromptLog.create({
        user_id: userId,
        feature: 'ai_prompts'
      });
    }
  } catch (err) {
    console.error('AI log failed:', err);
  }

  return responseText;
};


const testAIModel = async (model, prompt, apiKey) => {

  if (!apiKey) {
    throw new Error('API key not found in model configuration');
  }

  return await callAIModel(null, model, apiKey, prompt);
};

export {
  getNestedValue,
  formatRequestBody,
  formatRequestHeaders,
  buildApiEndpoint,
  callAIModel,
  testAIModel
};
