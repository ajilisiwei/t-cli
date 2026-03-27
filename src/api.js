import process from 'node:process';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

/**
 * 无状态调用 DeepSeek API（流式输出）
 * @param {string} systemPrompt 系统提示词，用于设定角色和规则
 * @param {string} userText 用户输入的文本
 * @param {function} onChunk 当接收到新的文本块时的回调函数
 * @returns {Promise<void>}
 */
export async function callDeepSeekStream(systemPrompt, userText, onChunk) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY environment variable not found');
  }

  const payload = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ],
    temperature: 0.3,
    stream: true
  };

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let errorMsg = response.statusText;
    try {
      const errorBody = await response.json();
      if (errorBody.error && errorBody.error.message) {
        errorMsg = errorBody.error.message;
      }
    } catch (e) {
      // Ignore JSON parse error, fallback to statusText
    }
    throw new Error(`API Request Failed (HTTP ${response.status}): ${errorMsg}`);
  }

  // Parse Server-Sent Events (SSE)
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    
    // Process full lines
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.startsWith('data: ')) {
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') {
          return;
        }

        try {
          const data = JSON.parse(dataStr);
          if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
            onChunk(data.choices[0].delta.content);
          }
        } catch (e) {
          // Ignore parse errors for incomplete chunks in extreme cases
        }
      }
    }
  }
}
