// background-worker.js

/**
 * 这是我们的“后台大脑”，负责：
 * 1. 周期性地检查所有开启了“主动消息”的联系人。
 * 2. 在满足条件时，调用 AI 生成回复。
 * 3. 管理和更新未读消息计数。
 */

// --- 核心配置 ---
const PROACTIVE_CHECK_INTERVAL = 15000; // 每 15 秒检查一次
const PROACTIVE_REPLY_DELAY = 300000;   // 5 分钟 (300,000 毫秒)

// --- 未读消息管理 ---

function getUnreadCounts() {
    return JSON.parse(localStorage.getItem('unreadCounts') || '{}');
}

function saveUnreadCounts(counts) {
    localStorage.setItem('unreadCounts', JSON.stringify(counts));
}

function incrementUnreadCount(contactId, messageCount = 1) {
    const counts = getUnreadCounts();
    counts[contactId] = (counts[contactId] || 0) + messageCount;
    saveUnreadCounts(counts);
    console.log(`[Worker] Contact ${contactId} has new messages. Total unread: ${counts[contactId]}`);
}

function clearUnreadCount(contactId) {
    const counts = getUnreadCounts();
    if (counts[contactId]) {
        delete counts[contactId];
        saveUnreadCounts(counts);
        console.log(`[Worker] Cleared unread for ${contactId}`);
    }
}


// --- 后台 AI 逻辑 ---

async function startGlobalProactiveCheck() {
    console.log('[Worker] Global proactive check started.');

    setInterval(async () => {
        // 如果页面被隐藏（切换到其他APP或锁屏），则不执行，节省资源
        if (document.hidden) {
            return;
        }

        const allSettings = JSON.parse(localStorage.getItem('chatSettings') || '{}');
        const contacts = JSON.parse(localStorage.getItem('contacts') || '[]');
        const allChats = JSON.parse(localStorage.getItem('chats') || '{}');

        // 遍历所有联系人
        for (const contact of contacts) {
            const contactId = contact.id;
            const settings = allSettings[contactId];

            // 检查条件：1. 开启了主动消息 2. 必须有聊天记录 3. 最后一条是用户发的
            if (settings && settings.proactive) {
                const history = allChats[contactId] || [];
                if (history.length === 0) continue;

                const lastMsg = history[history.length - 1];
                if (lastMsg.role !== 'user') continue;

                const now = Date.now();
                if (now - lastMsg.timestamp > PROACTIVE_REPLY_DELAY) {
                    
                    // 防止短时间内重复触发
                    // 使用一个临时标记来记录正在为谁生成消息
                    const processingFlag = `processing_${contactId}`;
                    if (sessionStorage.getItem(processingFlag)) continue;
                    
                    sessionStorage.setItem(processingFlag, 'true');
                    console.log(`[Worker] Triggering proactive reply for ${contactId}`);
                    
                    try {
                        await triggerGlobalAiReply(contactId);
                    } catch (e) {
                        console.error(`[Worker] Error during proactive reply for ${contactId}:`, e);
                    } finally {
                        // 无论成功失败，都在1分钟后移除标记，允许再次触发
                        setTimeout(() => sessionStorage.removeItem(processingFlag), 60000);
                    }
                }
            }
        }
    }, PROACTIVE_CHECK_INTERVAL);
}


async function triggerGlobalAiReply(contactId) {
    try {
        const rawReply = await callGlobalAiApi(contactId);
        let replyMessages = [];
        let parsedReply = null;

        try {
            parsedReply = JSON.parse(rawReply);
            if (parsedReply && Array.isArray(parsedReply.replies)) {
                replyMessages = parsedReply.replies.filter(m => m.trim() !== "");
            } else {
                replyMessages.push(rawReply);
            }
        } catch (e) {
            replyMessages.push(rawReply);
        }

        if (replyMessages.length > 0) {
            // 将所有新消息一次性添加到聊天记录中
            const allChats = JSON.parse(localStorage.getItem('chats') || '{}');
            if (!allChats[contactId]) allChats[contactId] = [];

            const newMessages = replyMessages.map(content => ({
                id: Date.now() + Math.random(), // 增加随机数防止ID冲突
                role: 'assistant',
                content: content,
                timestamp: Date.now()
            }));
            
            allChats[contactId].push(...newMessages);
            localStorage.setItem('chats', JSON.stringify(allChats));

            // 更新未读消息数量
            incrementUnreadCount(contactId, newMessages.length);
        }

    } catch (err) {
        console.error(`[Worker] AI API call failed for ${contactId}:`, err);
        // 这里不进行UI提示，因为是后台任务
    }
}

async function callGlobalAiApi(contactId) {
    const apiUrl = localStorage.getItem('apiUrl');
    const apiKey = localStorage.getItem('apiKey');
    const model = localStorage.getItem('selectedModel');
    if (!apiUrl || !apiKey) throw new Error("API not configured");

    const allChats = JSON.parse(localStorage.getItem('chats') || '{}');
    const history = allChats[contactId] || [];
    const contacts = JSON.parse(localStorage.getItem('contacts') || '[]');
    const charData = contacts.find(c => c.id === contactId);
    
    // 如果找不到角色，则不执行
    if (!charData) throw new Error(`Contact with id ${contactId} not found`);

    const persona = charData.persona || "";
    const note = charData.note || "";
    const charName = charData.name || "Character";
    const userPersona = localStorage.getItem('user_persona') || "";
    const now = new Date().toLocaleString();

    // 复用 sms.html 中的 system prompt
    const systemPrompt = `你现在扮演 ${charName}。你正在通过手机短信与 User 聊天。当前现实时间是: ${now}。

[角色设定]:
${persona}

${userPersona ? `[关于 User 的信息]:\n${userPersona}` : ""}

${note ? `[备注/强制指令]:\n${note}` : ""}

[回复规则 - 你必须严格遵守]:
1.  你的回复**必须**是一个 JSON 对象，且只包含一个名为 "replies" 的键。
2.  "replies" 的值**必须**是一个数组，数组中包含 1 到 3 条字符串。
3.  数组中的每个字符串就是一条独立的短信内容。
4.  每条短信内容都必须简短、口语化，就像真人在发短信一样。
5.  严禁在字符串内使用 Markdown 或任何格式化语法。
6.  根据聊天上下文，决定回复 1 条还是多条。如果内容简单，就只回 1 条。如果内容复杂或情绪激动，可以回 2-3 条来模拟连续输入。

[回复范例]:
{
  "replies": [
    "天啊！",
    "真的假的？",
    "快给我看看！"
  ]
}`;

    const msgsToSend = [
        { role: "system", content: systemPrompt.trim() },
        ...history.slice(-15).map(m => ({ role: m.role, content: m.content }))
    ];

    let fullUrl = apiUrl;
    if (!apiUrl.includes('/chat/completions')) {
        fullUrl = apiUrl.replace(/\/$/, '') + '/chat/completions';
    }

    const res = await fetch(fullUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: msgsToSend,
            response_format: { type: "json_object" }, 
            temperature: parseFloat(localStorage.getItem('temperature') || 0.9)
        })
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || res.statusText);
    }
    const data = await res.json();
    return data.choices[0].message.content;
}
