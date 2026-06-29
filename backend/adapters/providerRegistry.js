// Provider registry - centralized provider detection and request building.
// Replaces URL-substring guessing scattered across routes and adapters.

const { log } = require('../utils/logger');

// Known provider definitions. Each has a unique id, a canHandle predicate,
// and helpers for endpoint construction.
const PROVIDERS = [
    {
        id: 'anthropic',
        name: 'Anthropic',
        canHandle(url) {
            return typeof url === 'string' && url.toLowerCase().includes('anthropic.com');
        },
        getEndpointUrl(baseUrl) {
            return `${baseUrl}/messages`;
        },
        getHeaders(apiKey) {
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            return headers;
        },
        getModelsUrl(baseUrl, apiKey) {
            return `${baseUrl}/models`;
        },
        getModelTestUrl(baseUrl, modelName, apiKey) {
            return `${baseUrl}/messages`;
        },
        getModelTestBody(modelName) {
            return {
                model: modelName,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'test' }]
            };
        }
    },
    {
        id: 'google',
        name: 'Google/Gemini',
        canHandle(url) {
            return typeof url === 'string' && url.toLowerCase().includes('google');
        },
        getEndpointUrl(baseUrl, modelName) {
            const cleanModelName = modelName.startsWith('models/')
                ? modelName.substring(7)
                : modelName;
            // Endpoint is built at request time with apiKey; this returns the base
            return `${baseUrl}/models/${cleanModelName}`;
        },
        getHeaders(apiKey) {
            return { 'Content-Type': 'application/json' };
        },
        getModelsUrl(baseUrl, apiKey) {
            return `${baseUrl}/models?key=${apiKey}`;
        },
        getModelTestUrl(baseUrl, modelName, apiKey) {
            const cleanModelName = modelName.startsWith('models/')
                ? modelName.substring(7)
                : modelName;
            const isEmbeddingModel = cleanModelName.includes('embedding');
            const endpoint = isEmbeddingModel ? 'embedContent' : 'generateContent';
            return `${baseUrl}/models/${cleanModelName}:${endpoint}?key=${apiKey}`;
        },
        getModelTestBody(modelName) {
            const cleanModelName = modelName.startsWith('models/')
                ? modelName.substring(7)
                : modelName;
            const isEmbeddingModel = cleanModelName.includes('embedding');
            if (isEmbeddingModel) {
                return {
                    content: { parts: [{ text: 'test' }] }
                };
            }
            return {
                contents: [{ parts: [{ text: 'test' }] }]
            };
        }
    },
    {
        id: 'openai',
        name: 'OpenAI',
        canHandle(url) {
            return typeof url === 'string' && url.toLowerCase().includes('api.openai.com');
        },
        getEndpointUrl(baseUrl) {
            return `${baseUrl}/chat/completions`;
        },
        getHeaders(apiKey) {
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            return headers;
        },
        getModelsUrl(baseUrl, apiKey) {
            return `${baseUrl}/models`;
        },
        getModelTestUrl(baseUrl, modelName) {
            return `${baseUrl}/chat/completions`;
        },
        getModelTestBody(modelName) {
            return {
                model: modelName,
                messages: [{ role: 'user', content: 'test' }],
                max_tokens: 1,
                stream: false
            };
        }
    },
    {
        id: 'openai-compatible',
        name: 'OpenAI-compatible',
        canHandle(url) {
            // Explicit match only — must NOT be Google or Anthropic
            if (typeof url !== 'string') return false;
            const lower = url.toLowerCase();
            if (lower.includes('google')) return false;
            if (lower.includes('anthropic.com')) return false;
            return true;
        },
        getEndpointUrl(baseUrl) {
            return `${baseUrl}/chat/completions`;
        },
        getHeaders(apiKey, baseUrl) {
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            // OpenRouter-specific headers
            if (baseUrl && baseUrl.includes('openrouter.ai')) {
                headers['HTTP-Referer'] = 'https://simplechatjs.local';
                headers['X-Title'] = 'SimpleChatJS';
            }
            return headers;
        },
        getModelsUrl(baseUrl, apiKey) {
            return `${baseUrl}/models`;
        },
        getModelTestUrl(baseUrl, modelName, apiKey) {
            return `${baseUrl}/chat/completions`;
        },
        getModelTestBody(modelName) {
            return {
                model: modelName,
                messages: [{ role: 'user', content: 'test' }],
                max_tokens: 1,
                stream: false
            };
        }
    }
];

/**
 * Detect provider by URL. Returns the provider definition or null.
 */
function detectProvider(settings) {
    // Explicit adapter selection overrides URL detection
    if (settings.adapterType && settings.adapterType !== 'auto') {
        const explicit = PROVIDERS.find(p => p.id === settings.adapterType);
        if (explicit) return explicit;
    }
    const url = settings.apiUrl || '';
    for (const provider of PROVIDERS) {
        if (provider.canHandle(url)) {
            return provider;
        }
    }
    return null;
}

/**
 * Get provider by id string.
 */
function getProviderById(id) {
    return PROVIDERS.find(p => p.id === id) || null;
}

/**
 * Build provider-specific request options for the models endpoint.
 */
function buildModelsRequestOptions(settings) {
    const provider = detectProvider(settings);
    if (!provider) {
        throw new Error(`Unknown provider for URL: ${settings.apiUrl}`);
    }
    const url = provider.getModelsUrl(settings.apiUrl, settings.apiKey);
    const parsedUrl = new URL(url);
    return {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: provider.getHeaders(settings.apiKey, settings.apiUrl)
    };
}

/**
 * Build provider-specific request options for the connection test endpoint.
 */
function buildTestConnectionRequestOptions(settings) {
    const provider = detectProvider(settings);
    if (!provider) {
        throw new Error(`Unknown provider for URL: ${settings.apiUrl}`);
    }
    const url = provider.getModelTestUrl(settings.apiUrl, settings.modelName, settings.apiKey);
    const parsedUrl = new URL(url);
    const body = provider.getModelTestBody(settings.modelName);
    return {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
            ...provider.getHeaders(settings.apiKey, settings.apiUrl),
            'Content-Length': Buffer.byteLength(JSON.stringify(body))
        },
        body
    };
}

module.exports = {
    PROVIDERS,
    detectProvider,
    getProviderById,
    buildModelsRequestOptions,
    buildTestConnectionRequestOptions
};
