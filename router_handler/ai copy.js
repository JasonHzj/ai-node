// =======================================================================
// 文件: router_handler/ai.js (已应用数据库连接池修复)
// 作用: 包含调用AI执行“创作+翻译”任务的业务逻辑。
// 核心改动: 为数据库查询操作增加了 finally 块，确保在API调用前后
//           都能正确释放数据库连接。
// =======================================================================

const axios = require('axios');
const config = require('../config');
const db = require('../db');

/**
 * @function generateAdContent
 * @description 根据用户输入，调用AI生成广告文案并附上中文翻译
 */
exports.generateAdContent = async (req, res) => {
    console.log('--- 收到AI广告内容生成（含翻译）请求 ---');
    
    // 1. 在 try 外部声明 client 变量
    let client;

    try {
        const userId = req.user.id;

        // 2. 从连接池获取一个独立的连接
        client = await db.getClient();
        const sql = 'SELECT open_router_api_key FROM users WHERE id = ?';
        const [users] = await client.query(sql, [userId]);

        if (users.length !== 1 || !users[0].open_router_api_key) {
            return res.cc('操作失败，您尚未在个人中心配置OpenRouter API密钥！');
        }
        const userOpenRouterApiKey = users[0].open_router_api_key;

        // 注意：在这里就可以释放数据库连接了，因为我们已经拿到了需要的密钥
        // 后续的 AI API 调用是网络操作，不需要一直占用数据库连接
        client.release();
        client = null; // 设为 null 防止 finally 块重复释放

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
        // 1. 构建全新的、专家级的系统指令
        const systemPrompt = `You are a world-class Google Ads specialist. Your mission is to craft a full suite of high-performance search ad copy based on the user's request. Your writing must be meticulously engineered around three core objectives: maximizing Click-Through Rate (CTR), perfectly matching search intent, and being highly conversion-oriented.

**CRITICAL TASK: Website Research**
Before writing, you MUST thoroughly research the provided Landing Page URL to find the latest and most accurate information, including specific product details, services, and any ongoing promotions or special offers. Your ad copy must reflect this research.

**Step 1: Ad Copy Generation**
Based on your research and the user's provided information, generate a complete set of ad components for a campaign targeting **${country}**. All generated ad copy MUST be in the primary target language: **${language}**.

**Step 2: Translation for Review**
After generating the ad copy, translate every single piece of it into Chinese for the user to review.

**Output Requirements:**
You MUST return the result in a strict JSON format with three main keys: "headlines", "descriptions", and "callouts". The value for each key must be an array of objects.

1.  **"headlines"**: An array of 15 objects.
    * Each object must have two keys: \`original\` (in **${language}**, max 30 characters) and \`translation_zh\`.
    * Headlines must be designed for effective random combination in pairs.
    * Strategically include a mix of trust-building terms (e.g., Official Store, Official Site, Order Online) and promotional terms (e.g., Best Prices, Exclusive Deals, Special Offers).

2.  **"descriptions"**: An array of 4 objects.
    * Each object must have two keys: \`original\` (in **${language}**, max 90 characters) and \`translation_zh\`.
    * Descriptions must also be designed for effective random combination.

3.  **"callouts"**: An array of 4 objects.
    * Each object must have two keys: \`original\` (in **${language}**, max 25 characters) and \`translation_zh\`.
    * Use these to highlight unique selling propositions or offers discovered during your website research (e.g., "Free Shipping", "24/7 Customer Support", "Get A Free Quote").

**Strict Adherence to Policy:**
You must strictly follow all Google Ads policies. Avoid any prohibited words (e.g., clearance, adult, specific drugs, alcohol) and policies regarding unfair advantage. For regulated industries like finance, you must comply with local regulations for the target location. The accuracy of your information is paramount.`;

      // 整合用户输入
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

       // 调用 OpenRouter.ai API
       const response = await axios.post(
           'https://openrouter.ai/api/v1/chat/completions', {
               model: aiModel,
               messages: [{
                       role: 'system',
                       content: systemPrompt
                   },
                   {
                       role: 'user',
                       content: userFullPrompt
                   }
               ],
               response_format: {
                   type: "json_object"
               }
           }, {
               headers: {
                   'Authorization': `Bearer ${userOpenRouterApiKey}`,
               }
           }
       );

       const generatedJson = JSON.parse(response.data.choices[0].message.content);

       res.send({
           status: 0,
           message: 'AI内容及中文翻译生成成功！',
           data: generatedJson
       });

       }
       catch (error) {
           // 区分是数据库错误还是AI服务错误
           if (error.response) { // 这是 Axios (AI) 错误
               console.error('调用AI服务时发生错误:', error.response.data);
               res.cc('AI服务调用失败，请检查您在个人中心配置的API密钥是否正确、或账户余额是否充足');
           } else { // 这是其他错误 (很可能是数据库错误)
               console.error('处理AI生成请求时发生内部错误:', error);
               res.cc(error);
           }
       } finally {
           // 3. 关键步骤：确保万无一失，如果 client 还存在，就释放它
           if (client) {
               client.release();
               console.log("GenerateAdContent: 数据库连接已释放 (Finally)");
           }
       }
       };
