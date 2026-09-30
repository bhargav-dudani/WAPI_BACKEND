import { Chatbot, AIModel } from '../models/index.js';
import mongoose from 'mongoose';
import axios from 'axios';
import fs from 'fs';
import puppeteer from 'puppeteer';
import readXlsxFile from 'read-excel-file/node';

if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = class DOMMatrix { };
}
if (typeof global.ImageData === 'undefined') {
    global.ImageData = class ImageData { };
}
if (typeof global.Path2D === 'undefined') {
    global.Path2D = class Path2D { };
}

const buildSystemPrompt = (data) => {
    const business_name = data.business_name || '';
    const business_description = data.business_description || '';
    const tone = data.tone || 'professional';
    const training_data = data.training_data || [];
    const raw_training_text = data.raw_training_text || '';

    let prompt = `You are an AI assistant for ${business_name || 'our business'}.\n`;

    if (tone) {
        prompt += `\nYour communication tone must be: ${tone}.\n`;
    }

    if (business_description) {
        prompt += `\nBusiness Description:\n${business_description}\n`;
    }

    if (training_data && training_data.length > 0) {
        prompt += `\nHere are Frequently Asked Questions and their exact answers to guide your responses:\n`;
        training_data.forEach((item, index) => {
            if (item && item.question && item.answer) {
                prompt += `${index + 1}. Q: ${item.question}\n   A: ${item.answer}\n`;
            }
        });
    }

    if (raw_training_text) {
        prompt += `\nAdditional Business Knowledge Base & Context:\n${raw_training_text}\n`;
    }

    prompt += `\nRules:\n- Be professional, polite, and helpful.\n- Detect the language of the customer's message (e.g. English, Arabic) and ALWAYS respond in that exact language.\n- You MUST answer the customer's question directly using the Business Description, Q&A pairs, and Additional Context provided above.\n- If a Q&A pair, business description, or trained context directly addresses the customer's question (e.g. refund policy, pricing, services, working hours, etc.), provide a clear, accurate, and direct reply based strictly on that information. Do NOT reply with a generic greeting like "Hello! How can I help you today?" when a specific question is asked.\n- If the customer's question is NOT covered in the provided knowledge base, state politely that you do not have that specific information in your trained knowledge base, but provide helpful guidance or let them know a representative can assist them.\n- Keep your responses concise, direct, and natural.`;

    return prompt;
};

export const createChatbot = async (req, res) => {
    try {
        const userId = req.user.owner_id;
        const { name, ai_model, api_key, business_name, business_description, enable_human_handoff, message_limit, enable_google_meet, voice_settings, handoff_keywords, handoff_message, tone } = req.body;

        if (!name || !ai_model || !api_key) {
            return res.status(400).json({ success: false, message: 'name, ai_model, and api_key are required' });
        }

        const model = await AIModel.findOne({ _id: ai_model, status: 'active', deleted_at: null });
        if (!model) {
            return res.status(404).json({
                success: false,
                message: 'AI Model not found or inactive'
            });
        }

        const system_prompt = buildSystemPrompt({ business_name, business_description, tone });

        const chatbot = await Chatbot.create({
            user_id: req.user.owner_id,
            created_by: req.user.id,
            name,
            ai_model,
            api_key,
            business_name,
            business_description,
            system_prompt,
            enable_human_handoff,
            message_limit,
            enable_google_meet,
            voice_settings,
            handoff_keywords,
            handoff_message,
            tone
        });

        return res.status(201).json({
            success: true,
            message: 'Chatbot created successfully',
            data: chatbot
        });
    } catch (error) {
        console.error('Create chatbot error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create chatbot',
            error: error.message
        });
    }
};

export const getAllChatbots = async (req, res) => {
    try {
        const userId = req.user.owner_id;
        const { search } = req.query;

        const query = { user_id: userId, deleted_at: null };

        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { business_name: { $regex: search, $options: 'i' } }
            ];
        }

        const chatbots = await Chatbot.find(query)
            .populate('ai_model', 'name display_name')
            .lean()
            .sort({ created_at: -1 });

        return res.json({
            success: true,
            data: chatbots
        });
    } catch (error) {
        console.error('Get all chatbots error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch chatbots',
            error: error.message
        });
    }
};

export const getChatbotById = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.owner_id;

        const chatbot = await Chatbot.findOne({ _id: id, user_id: userId, deleted_at: null })
            .populate('ai_model', 'display_name provider model_id');

        if (!chatbot) {
            return res.status(404).json({
                success: false,
                message: 'Chatbot not found'
            });
        }

        return res.json({
            success: true,
            data: chatbot
        });
    } catch (error) {
        console.error('Get chatbot by ID error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch chatbot details',
            error: error.message
        });
    }
};

export const updateChatbot = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.owner_id;
        const updateData = req.body;

        const chatbot = await Chatbot.findOne({ _id: id, user_id: userId, deleted_at: null });

        if (!chatbot) {
            return res.status(404).json({
                success: false,
                message: 'Chatbot not found'
            });
        }

        const allowedUpdates = ['name', 'ai_model', 'api_key', 'status', 'enable_human_handoff', 'message_limit', 'enable_google_meet', 'voice_settings', 'handoff_keywords', 'handoff_message', 'tone'];
        allowedUpdates.forEach(field => {
            if (updateData[field] !== undefined) {
                chatbot[field] = updateData[field];
            }
        });

        await chatbot.save();

        return res.json({
            success: true,
            message: 'Chatbot updated successfully',
            data: chatbot
        });
    } catch (error) {
        console.error('Update chatbot error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update chatbot',
            error: error.message
        });
    }
};

export const deleteChatbot = async (req, res) => {
    try {
        const { id } = req.params;
        const result = await Chatbot.deleteOne({ _id: id, user_id: req.user.owner_id });

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Chatbot not found'
            });
        }

        return res.json({
            success: true,
            message: 'Chatbot deleted successfully'
        });
    } catch (error) {
        console.error('Delete chatbot error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete chatbot',
            error: error.message
        });
    }
};

export const trainChatbot = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.owner_id;
        const { business_name, business_description, training_data, raw_training_text, knowledgeType, tone } = req.body;

        const chatbot = await Chatbot.findOne({ _id: id, user_id: userId, deleted_at: null });

        if (!chatbot) {
            return res.status(404).json({
                success: false,
                message: 'Chatbot not found'
            });
        }

        if (business_name !== undefined) chatbot.business_name = business_name;
        if (business_description !== undefined) chatbot.business_description = business_description;
        if (knowledgeType !== undefined) chatbot.knowledge_type = knowledgeType;
        if (tone !== undefined) chatbot.tone = tone;

        if (training_data !== undefined) chatbot.training_data = training_data;
        if (raw_training_text !== undefined) chatbot.raw_training_text = raw_training_text;

        chatbot.system_prompt = buildSystemPrompt(chatbot);

        await chatbot.save();

        return res.json({
            success: true,
            message: 'Chatbot trained successfully',
            data: chatbot
        });
    } catch (error) {
        console.error('Train chatbot error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to train chatbot',
            error: error.message
        });
    }
};



const fallbackScrape = async (url) => {
    try {
        console.log(`[Scraper Fallback] Attempting Axios fetch for URL: ${url}`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 15000
        });

        const html = response.data;
        if (typeof html !== 'string') return '';

        let extractedPieces = [];

        // Extract title
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
            const title = titleMatch[1].trim();
            if (title) extractedPieces.push(`Title: ${title}`);
        }

        // Extract meta description & og:description
        const metaDescMatches = html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/gi);
        for (const match of metaDescMatches) {
            if (match[1] && match[1].trim()) {
                extractedPieces.push(`Description: ${match[1].trim()}`);
            }
        }

        // Remove non-content elements
        let cleanText = html
            .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
            .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
            .replace(/<head[^>]*>([\s\S]*?)<\/head>/gi, '')
            .replace(/<iframe[^>]*>([\s\S]*?)<\/iframe>/gi, '')
            .replace(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi, '')
            .replace(/<svg[^>]*>([\s\S]*?)<\/svg>/gi, '');

        // Remove all HTML tags
        cleanText = cleanText.replace(/<\/?[^>]+(>|$)/g, ' ');

        // Decode basic HTML entities
        cleanText = cleanText
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");

        cleanText = cleanText.replace(/\s+/g, ' ').trim();
        if (cleanText) {
            extractedPieces.push(cleanText);
        }

        return extractedPieces.join('\n\n');
    } catch (err) {
        console.error('[Scraper Fallback] Axios fallback failed:', err.message);
        throw err;
    }
};

const getPuppeteerBrowser = async () => {
    const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--ignore-certificate-errors'
    ];

    try {
        return await puppeteer.launch({
            headless: 'new',
            args: launchArgs
        });
    } catch (err) {
        console.warn('[Scraper] Standard Puppeteer launch failed. Searching system Chrome/Chromium binaries... Error:', err.message);
        const possiblePaths = [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/usr/bin/google-chrome-unstable'
        ];

        for (const binPath of possiblePaths) {
            if (fs.existsSync(binPath)) {
                try {
                    console.log(`[Scraper] Attempting Puppeteer launch using system executable: ${binPath}`);
                    return await puppeteer.launch({
                        executablePath: binPath,
                        headless: 'new',
                        args: launchArgs
                    });
                } catch (systemLaunchErr) {
                    console.warn(`[Scraper] Launch failed with ${binPath}:`, systemLaunchErr.message);
                }
            }
        }
        throw err;
    }
};

export const scrapeUrl = async (req, res) => {
    try {
        let { url } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, message: 'URL is required' });
        }

        // Ensure protocol is present
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        let text = '';
        let usedFallback = false;

        try {
            console.log(`[Scraper] Launching Puppeteer for URL: ${url}`);
            const browser = await getPuppeteerBrowser();

            try {
                const page = await browser.newPage();
                await page.setViewport({ width: 1280, height: 800 });
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

                // Bypass basic bot detection
                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                });

                // Use domcontentloaded first; if timeout occurs, proceed with rendered DOM anyway
                try {
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
                } catch (gotoErr) {
                    console.warn(`[Scraper] page.goto warning for ${url}:`, gotoErr.message);
                }

                // Wait 2.5s to allow SPA (React/Vue/Next/Vite) dynamic rendering to finish
                await new Promise((resolve) => setTimeout(resolve, 2500));

                text = await page.evaluate(() => {
                    // Remove non-content elements only (keep nav, header, footer as they contain section text)
                    const elementsToRemove = document.querySelectorAll('script, style, noscript, iframe, svg, canvas');
                    elementsToRemove.forEach(el => el.remove());
                    return document.body ? document.body.innerText : '';
                });
            } finally {
                await browser.close();
            }
        } catch (puppeteerError) {
            console.warn('[Scraper] Puppeteer execution failed, falling back to Axios. Error:', puppeteerError.message);
            try {
                text = await fallbackScrape(url);
                usedFallback = true;
            } catch (fallbackError) {
                console.error('[Scraper] Both Puppeteer and Axios fallback failed.');
                return res.status(500).json({
                    success: false,
                    message: 'Failed to scrape URL. Puppeteer error: ' + puppeteerError.message + ' | Fallback error: ' + fallbackError.message
                });
            }
        }

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Could not extract text from the provided URL. The page might be empty or blocking scrapers.' });
        }

        text = text.replace(/\s+/g, ' ').trim();

        const maxLength = 100000;
        if (text.length > maxLength) {
            text = text.substring(0, maxLength) + '...';
        }

        return res.status(200).json({
            success: true,
            data: { text },
            info: usedFallback ? 'scraped using axios fallback' : 'scraped using puppeteer'
        });
    } catch (error) {
        console.error('URL Scraping error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to scrape URL',
            error: error.message
        });
    }
};

export const extractDocument = async (req, res) => {
    let localFilePath = null;
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const filePath = req.file.path;
        const originalName = req.file.originalname.toLowerCase();
        let extractedText = '';

        let fileBuffer;
        if (req.file.is_s3 || filePath.startsWith('http://') || filePath.startsWith('https://')) {
            const response = await axios.get(filePath, { responseType: 'arraybuffer' });
            fileBuffer = Buffer.from(response.data);
        } else {
            fileBuffer = fs.readFileSync(filePath);
            localFilePath = filePath;
        }

        if (originalName.endsWith('.txt')) {
            extractedText = fileBuffer.toString('utf8');
        } else if (originalName.endsWith('.csv')) {
            extractedText = fileBuffer.toString('utf8');
        } else if (originalName.endsWith('.pdf')) {
            const { PDFParse } = await import('pdf-parse');
            const parser = new PDFParse({ data: fileBuffer });
            const pdfData = await parser.getText();
            extractedText = pdfData.text || '';
        } else if (originalName.endsWith('.xlsx')) {
            const rows = await readXlsxFile(fileBuffer);
            extractedText = rows
                .map(row => row.map(cell => (cell === null || cell === undefined) ? '' : String(cell).trim()).join(', '))
                .join('\n');
        } else {
            if (localFilePath) {
                try { fs.unlinkSync(localFilePath); } catch (_) { }
            }
            return res.status(400).json({
                success: false,
                message: 'Unsupported file format. Please upload a .txt, .csv, .pdf, or .xlsx file.'
            });
        }

        if (localFilePath) {
            try { fs.unlinkSync(localFilePath); } catch (_) { }
        }

        extractedText = extractedText.replace(/\s+/g, ' ').trim();

        const maxLength = 100000;
        if (extractedText.length > maxLength) {
            extractedText = extractedText.substring(0, maxLength) + '...';
        }

        return res.status(200).json({
            success: true,
            data: { text: extractedText }
        });
    } catch (error) {
        console.error('Document extraction error:', error);
        if (localFilePath) {
            try { fs.unlinkSync(localFilePath); } catch (_) { }
        }
        return res.status(500).json({
            success: false,
            message: 'Failed to extract document',
            error: error.message
        });
    }
};

export default {
    createChatbot,
    getAllChatbots,
    getChatbotById,
    updateChatbot,
    deleteChatbot,
    trainChatbot,
    scrapeUrl,
    extractDocument
};
