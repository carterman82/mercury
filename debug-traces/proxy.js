// Logging proxy for llama.cpp server - captures request/response pairs
const http = require('http');
const fs = require('fs');
const path = require('path');

// Configuration
const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL || 'http://localhost:8080';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8081');
const LOG_FILE = path.join(__dirname, 'traces.jsonl');

// Convert buffer to string safely
function bufferToString(buffer) {
  try {
    return buffer.toString('utf8');
  } catch (e) {
    return buffer.toString();
  }
}

// Parse stream from llama.cpp SSE format
function parseSSE(data) {
  const lines = data.split('\n');
  const events = [];
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const content = line.slice(6).trim();
      if (content && content !== '[DONE]') {
        try {
          events.push(JSON.parse(content));
        } catch (e) {
          // Skip non-JSON content
        }
      }
    }
  }
  return events;
}

// Parse Ollama format (raw JSON per line)
function parseOllama(data) {
  const lines = data.split('\n');
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed !== '[DONE]') {
      try {
        events.push(JSON.parse(trimmed));
      } catch (e) {
        // Skip non-JSON content
      }
    }
  }
  return events;
}

// Convert to OpenAI format for comparison
function convertToOpenAIFormat(events, provider) {
  const converted = [];
  
  for (const event of events) {
    if (provider === 'ollama') {
      // Ollama format: { message: { content, thinking, tool_calls }, done, done_reason, prompt_eval_count, eval_count }
      if (event.message) {
        converted.push({
          choices: [{
            delta: {
              content: event.message.content || '',
              reasoning: event.message.thinking || null,
              reasoning_content: event.message.thinking || null
            }
          }]
        });
        
        // Add tool calls if present
        if (event.message.tool_calls && event.message.tool_calls.length > 0) {
          for (let i = 0; i < event.message.tool_calls.length; i++) {
            const toolCall = event.message.tool_calls[i];
            converted.push({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: i,
                    id: toolCall.id || `call_${i}`,
                    type: 'function',
                    function: {
                      name: toolCall.function?.name || '',
                      arguments: JSON.stringify(toolCall.function?.arguments || {})
                    }
                  }]
                }
              }]
            });
          }
        }
      }
      
      if (event.done) {
        converted.push({
          choices: [{
            delta: {},
            finish_reason: event.done_reason === 'length' ? 'length' : 'stop'
          }],
          usage: {
            prompt_tokens: event.prompt_eval_count,
            completion_tokens: event.eval_count
          }
        });
      }
    } else if (provider === 'lmstudio' || provider === 'openai') {
      // Already in OpenAI format
      converted.push(event);
    }
  }
  
  return converted;
}

// Log request/response pair
function logRequestResponse(requestId, method, url, headers, body, responseStatus, responseHeaders, responseBody, provider) {
  let parsedBody = null;
  try {
    if (body) {
      parsedBody = JSON.parse(body);
    }
  } catch (e) {
    // Keep original body if not JSON
  }

  let parsedResponse = null;
  try {
    if (responseBody) {
      parsedResponse = JSON.parse(responseBody);
    }
  } catch (e) {
    // Keep original response if not JSON
  }

  const logEntry = {
    requestId,
    timestamp: new Date().toISOString(),
    method,
    url,
    headers: { ...headers },
    requestBody: parsedBody || (body ? body.slice(0, 5000) : null),
    responseStatus,
    responseHeaders: { ...responseHeaders },
    responseBody: parsedResponse || (responseBody ? responseBody.slice(0, 5000) : null),
    provider
  };

  fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n');
}

// Create proxy server
const server = http.createServer(async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const isMessagesEndpoint = req.url?.includes('/v1/messages');
  const isChatCompletions = req.url?.includes('/v1/chat/completions') || req.url?.includes('/api/chat');
  const isOllama = req.url?.includes('/api/chat') || req.url?.includes('/api/tags');
  
  let provider = 'unknown';
  if (isOllama) provider = 'ollama';
  else if (isMessagesEndpoint) provider = 'lmstudio'; // LM Studio uses /v1/messages
  else if (isChatCompletions) provider = 'openai';

  // Read request body
  let requestBody = '';
  req.on('data', chunk => {
    requestBody += chunk;
  });

  req.on('end', async () => {
    try {
      // Parse request to determine provider
      let parsedBody = null;
      if (requestBody) {
        try {
          parsedBody = JSON.parse(requestBody);
        } catch (e) {
          // Keep as string
        }
      }

      // Set up request options
      const url = new URL(LLAMA_SERVER_URL + req.url);
      
      // Forward request to llama server
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: url.host
        }
      };

      const proxyReq = http.request(options, async (proxyRes) => {
        let responseBody = '';
        
        proxyRes.on('data', chunk => {
          responseBody += chunk;
        });

        proxyRes.on('end', () => {
          // Log the request/response
          logRequestResponse(
            requestId,
            req.method,
            req.url,
            req.headers,
            requestBody,
            proxyRes.statusCode || 0,
            proxyRes.headers,
            responseBody,
            provider
          );
          
          // Forward response to client
          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
          res.end(responseBody);
        });
      });

      proxyReq.on('error', (error) => {
        console.error(`Proxy error for ${requestId}:`, error.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      });

      // Send request body if present
      if (requestBody) {
        proxyReq.write(requestBody);
      }
      
      proxyReq.end();
    } catch (error) {
      console.error(`Error handling request ${requestId}:`, error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

server.listen(PROXY_PORT, () => {
  console.log(`Proxy server running on http://localhost:${PROXY_PORT}`);
  console.log(`Forwarding to: ${LLAMA_SERVER_URL}`);
  console.log(`Logs written to: ${LOG_FILE}`);
});
