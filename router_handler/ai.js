const axios = require('axios');
const config = require('../config');
const db = require('../db');

// --- 辅助函数：调用AI进行文本优化 ---
async function callAiToRefine(userOpenRouterApiKey, aiModel, systemPrompt, userPrompt) {
    const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions', {
            model: aiModel,
            messages: [{
                role: 'system',
                content: systemPrompt
            }, {
                role: 'user',
                content: userPrompt
            }],
            response_format: {
                type: "json_object"
            }
        }, {
            headers: {
                'Authorization': `Bearer ${userOpenRouterApiKey}`,
            },
             timeout: 120000 // 120秒，单位为毫秒
        }
    );
    return JSON.parse(response.data.choices[0].message.content);
}


/**
 * @function generateAdContent
 * @description 根据用户输入，调用AI生成广告文案并附上中文翻译
 */
exports.generateAdContent = async (req, res) => {
    console.log('--- 收到AI广告内容生成（含翻译）请求 ---');

    let client;

    try {
        const userId = req.user.id;
        client = await db.getClient();
        const sql = 'SELECT open_router_api_key FROM users WHERE id = ?';
        const [users] = await client.query(sql, [userId]);

        if (users.length !== 1 || !users[0].open_router_api_key) {
            return res.cc('操作失败，您尚未在个人中心配置OpenRouter API密钥！');
        }
        const userOpenRouterApiKey = users[0].open_router_api_key;

        client.release();
        client = null;

        const {
            ad_link,
            keywords,
            ai_prompt,
            model,
            target_language,
            target_country,
            example_headlines,
            example_descriptions
        } = req.body;

        if (!ai_prompt) {
            return res.cc('AI提示词 (ai_prompt) 不能为空');
        }

        const language = target_language || 'English';
        const country = target_country || 'the specified target country';

        const systemPrompt = `You are a world-class Google Ads specialist. Your mission is to craft a full suite of high-performance search ad copy based on the user's request. Your writing must be meticulously engineered around three core objectives: maximizing Click-Through Rate (CTR), perfectly matching search intent, and being highly conversion-oriented.

**CRITICAL TASK: Website Research**
Before writing, you MUST thoroughly research the provided Landing Page URL to find the latest and most accurate information, including specific product details, services, and any ongoing promotions or special offers. Your ad copy must reflect this research.

**Step 1: Ad Copy Generation**
Based on your research and the user's provided information, generate a complete set of ad components for a campaign targeting **${country}**. All generated ad copy MUST be in the primary target language: **${language}**.

**Step 2: Translation for Review**
After generating the ad copy, translate every single piece of it into Chinese for the user to review.

**Output Requirements:**
You MUST return the result in a strict JSON format with three main keys: "headlines", "descriptions", and "callouts".

1.  **"headlines"**: An array of 15 objects.
    * Each object must have two keys: \`original\` (in **${language}**, strictly limited to a maximum of 25 characters, **and all symbols or punctuation are absolutely forbidden**) and \`translation_zh\`.
    * Headlines must be designed for effective random combination.

2.  **"descriptions"**: An array of 4 objects.
    * Each object must have two keys: \`original\` (in **${language}**,strictly limited to a maximum of 80 characters, **and any symbols or punctuation, except for , ., and !, are absolutely forbidden**) and \`translation_zh\`.
    * **Allowed punctuation is limited to: comma, question mark, exclamation mark, semicolon.** No other symbols are permitted.

3.  **"callouts"**: An array of 4 objects.
    * Each object has two keys: \`original\` (in **${language}**, strictly limited to a maximum of 20 characters) and \`translation_zh\`.

**Strict Adherence to Policy:**
You must strictly follow all Google Ads policies.`;

        let userFullPrompt = `
        Landing Page URL: ${ad_link || 'Not provided'}
        Keywords: ${keywords || 'Not provided'}
        Core Idea: ${ai_prompt}
        `;

        if (example_headlines && Array.isArray(example_headlines) && example_headlines.length > 0) {
            userFullPrompt += `\n\n--- Reference Headlines (for style and tone) ---\n- ${example_headlines.join('\n- ')}`;
        }
        if (example_descriptions && Array.isArray(example_descriptions) && example_descriptions.length > 0) {
            userFullPrompt += `\n\n--- Reference Descriptions (for style and tone) ---\n- ${example_descriptions.join('\n- ')}`;
        }

        const aiModel = model || 'openai/gpt-3.5-turbo';
        console.log(`正在使用模型 [${aiModel}] 为提示生成内容...`);

        let generatedJson = await callAiToRefine(userOpenRouterApiKey, aiModel, systemPrompt, userFullPrompt);

        let retryCount = 0;
        const maxRetries = 10;

        // 新的、更强大的正则表达式:
        // \p{L} 匹配任何语言的字母, \p{N} 匹配任何数字
            const headlineInvalidCharsRegex = /[^\p{L}\p{N}\s]/gu;
            const descriptionInvalidCharsRegex = /[^\p{L}\p{N}\s,?!;.]/gu;

        while (retryCount < maxRetries) {
            const issuesToFix = {
                headlines: {},
                descriptions: {}
            };

             generatedJson.headlines.forEach((h, index) => {
                 // 如果 h 或者 h.original 不存在，则跳过此条的验证
                 if (!h || typeof h.original !== 'string') return;

                 const issues = [];
                 // 使用可选链 ?. 安全地访问 length
                 if ((h.original?.length || 0) > 30) {
                     issues.push(`长度超标 (${h.original.length}/30)`);
                 }

                 headlineInvalidCharsRegex.lastIndex = 0;
                 if (headlineInvalidCharsRegex.test(h.original)) {
                     headlineInvalidCharsRegex.lastIndex = 0;
                     const invalidSymbols = h.original.match(headlineInvalidCharsRegex)?.join(', ');
                     issues.push(`包含非法符号: ${invalidSymbols}`);
                 }

                 if (issues.length > 0) {
                     issuesToFix.headlines[index] = {
                         text: h.original,
                         issues: issues.join(' and ')
                     };
                 }
             });

        generatedJson.descriptions.forEach((d, index) => {
            // 如果 d 或者 d.original 不存在，则跳过此条的验证
            if (!d || typeof d.original !== 'string') return;

            const issues = [];
            // 使用可选链 ?. 安全地访问 length
            if ((d.original?.length || 0) > 90) {
                issues.push(`长度超标 (${d.original.length}/90)`);
            }

            descriptionInvalidCharsRegex.lastIndex = 0;
            if (descriptionInvalidCharsRegex.test(d.original)) {
                descriptionInvalidCharsRegex.lastIndex = 0;
                const invalidSymbols = d.original.match(descriptionInvalidCharsRegex)?.join(', ');
                issues.push(`包含非法符号: ${invalidSymbols}`);
            }
            if (issues.length > 0) {
                issuesToFix.descriptions[index] = {
                    text: d.original,
                    issues: issues.join(' and ')
                };
            }
        });
            const headlinesWithIssues = Object.keys(issuesToFix.headlines);
            const descriptionsWithIssues = Object.keys(issuesToFix.descriptions);

            if (headlinesWithIssues.length === 0 && descriptionsWithIssues.length === 0) {
                console.log('所有内容均符合要求，验证通过！');
                break;
            }

            retryCount++;

            // =======================================================================
            // 核心改动：开始 (增加详细的日志输出)
            // =======================================================================
            console.log(`\n- - - [ 第 ${retryCount} 次修正 ] 检测到不合规内容 - - -`);
            if (headlinesWithIssues.length > 0) {
                console.log("不合规的广告标题:");
                headlinesWithIssues.forEach(index => {
                    const issue = issuesToFix.headlines[index];
                    console.log(`  - 索引[${index}]: "${issue.text}" -> [问题: ${issue.issues}]`);
                });
            }
            if (descriptionsWithIssues.length > 0) {
                console.log("不合规的广告描述:");
                descriptionsWithIssues.forEach(index => {
                    const issue = issuesToFix.descriptions[index];
                    console.log(`  - 索引[${index}]: "${issue.text}" -> [问题: ${issue.issues}]`);
                });
            }
            console.log("- - - 正在请求AI进行修正... - - -\n");
            // =======================================================================
            // 核心改动：结束
            // =======================================================================

            const refineSystemPrompt = `You are an expert copy editor. Your task is to correct the provided ad copy to meet strict character and symbol limits while preserving the core message. Respond in the exact same JSON format as the user's request. For each item, provide both the corrected 'original' in ${language} and its 'translation_zh'.`;

            let refineUserPrompt = `Please correct the following ad copy based on the specified issues.

**Context:**
- Main Idea: ${ai_prompt}
- Target Language: ${language}
`;
            if (headlinesWithIssues.length > 0) {
                refineUserPrompt += `
**Headlines to Fix (max 30 chars, NO symbols):**
${JSON.stringify(issuesToFix.headlines, null, 2)}
`;
            }
            if (descriptionsWithIssues.length > 0) {
                refineUserPrompt += `
**Descriptions to Fix (max 90 chars, only ,?!; allowed):**
${JSON.stringify(issuesToFix.descriptions, null, 2)}
`;
            }
            refineUserPrompt += `
**Your Task:**
Rewrite ONLY the items listed above to fix the specified issues. Return a JSON object with "headlines" and/or "descriptions" keys, containing an array of objects with the corrected "original" and a new "translation_zh". The structure should match the problematic items provided.`;

            const refinedJson = await callAiToRefine(userOpenRouterApiKey, aiModel, refineSystemPrompt, refineUserPrompt);

            if (refinedJson.headlines && Array.isArray(refinedJson.headlines)) {
                Object.keys(refinedJson.headlines).forEach(key => {
                    const originalIndex = headlinesWithIssues[key];
                    if (originalIndex !== undefined) {
                        generatedJson.headlines[originalIndex] = refinedJson.headlines[key];
                    }
                });
            }
            if (refinedJson.descriptions && Array.isArray(refinedJson.descriptions)) {
                Object.keys(refinedJson.descriptions).forEach(key => {
                    const originalIndex = descriptionsWithIssues[key];
                    if (originalIndex !== undefined) {
                        generatedJson.descriptions[originalIndex] = refinedJson.descriptions[key];
                    }
                });
            }
        }

        if (retryCount >= maxRetries) {
            console.warn('已达到最大重试次数，但仍有内容不合规。将返回当前结果。');
        }

        res.send({
            status: 0,
            message: 'AI内容及中文翻译生成成功！',
            data: generatedJson
        });

    } catch (error) {
        if (error.response) {
            console.error('调用AI服务时发生错误:', error.response.data);
            res.cc('AI服务调用失败，请检查您在个人中心配置的API密钥是否正确、或账户余额是否充足');
        } else {
            console.error('处理AI生成请求时发生内部错误:', error);
            res.cc(error);
        }
    } finally {
        if (client) {
            client.release();
            console.log("GenerateAdContent: 数据库连接已释放 (Finally)");
        }
    }
};

// --- 新增：处理单项重写请求的函数 ---
/**
 * @function rewriteAdItem
 * @description 根据用户提供的单条文本和上下文，调用AI重写该条目
 */
exports.rewriteAdItem = async (req, res) => {
    console.log('--- 收到AI单项重写请求 ---');
    let client;
    try {
        const userId = req.user.id;
        client = await db.getClient();
        const sql = 'SELECT open_router_api_key FROM users WHERE id = ?';
        const [users] = await client.query(sql, [userId]);

        if (users.length !== 1 || !users[0].open_router_api_key) {
            return res.cc('操作失败，您尚未配置OpenRouter API密钥！');
        }
        const userOpenRouterApiKey = users[0].open_router_api_key;
        client.release();
        client = null;

        const {
            textToRewrite, // 要重写的文本
            itemType, // 'headline' 或 'description'
            context, // 原始的核心创意 (ai_prompt)
            model,
            target_language
        } = req.body;

        if (!textToRewrite || !itemType || !context) {
            return res.cc('缺少必要的参数 (textToRewrite, itemType, context)');
        }

        const language = target_language || 'English';
        const rules = itemType === 'headline' ?
            `max 30 characters, NO symbols or punctuation.` :
            `max 90 characters, only punctuation allowed is comma, question mark, exclamation mark, semicolon, and period.`;

        const systemPrompt = `You are an expert copy editor. Your task is to rewrite a single piece of ad copy to meet strict rules, while preserving the core message. You MUST respond in a strict JSON format with two keys: "original" (the rewritten text in ${language}) and "translation_zh".`;

        const userPrompt = `
        **Original Core Idea:**
        ${context}

        **Text to Rewrite:**
        "${textToRewrite}"

        **Your Task:**
        Rewrite the text above to comply with the following rule: **${rules}**
        Return the result in the specified JSON format.`;

        const aiModel = model || 'openai/gpt-3.5-turbo';
        console.log(`正在使用模型 [${aiModel}] 重写内容...`);

        // 直接复用 callAiToRefine 函数
        const rewrittenJson = await callAiToRefine(userOpenRouterApiKey, aiModel, systemPrompt, userPrompt);

        res.send({
            status: 0,
            message: '内容重写成功！',
            data: rewrittenJson
        });

    } catch (error) {
        if (error.response) {
            console.error('调用AI服务时发生错误:', error.response.data);
            res.cc('AI服务调用失败');
        } else {
            console.error('处理AI重写请求时发生内部错误:', error);
            res.cc(error);
        }
    } finally {
        if (client) client.release();
    }
};