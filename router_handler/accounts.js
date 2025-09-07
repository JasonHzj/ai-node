const db = require('../db');

exports.getAccounts = async (req, res) => {
    console.log('--- 收到获取关联账户列表的 [POST] 请求 (V-Final-Fix) ---');
    let client;
    try {
        // ▼▼▼ 保留您的核心代码：执行“双重验证” ▼▼▼
        const userIdFromToken = req.user.id;
        const {
            userId: userIdFromBody
        } = req.body;
        if (!userIdFromBody || userIdFromToken !== userIdFromBody) {
            console.error(`[安全警告] 身份验证不匹配！Token ID: ${userIdFromToken}, Body ID: ${userIdFromBody}`);
            return res.status(403).send({
                status: 1,
                message: '身份验证不匹配，禁止访问！'
            });
        }
        const userId = userIdFromToken;
        // ▲▲▲ 验证结束 ▲▲▲

        client = await db.getClient();

        // ▼▼▼ 保留您的核心代码：预加载国家和语言映射表 ▼▼▼
        const [countries] = await client.query('SELECT criterion_id, name_zh FROM google_ads_countries');
        const [languages] = await client.query('SELECT criterion_id, name_zh FROM google_ads_languages');
        const countryMap = new Map(countries.map((c) => [c.criterion_id.toString(), c.name_zh]));
        const languageMap = new Map(languages.map((l) => [l.criterion_id.toString(), l.name_zh]));
        // ▲▲▲ 映射表加载结束 ▲▲▲

        // ▼▼▼ 【核心SQL融合】: 在您的SQL基础上，增加了LEFT JOIN lcj 的逻辑 ▼▼▼
        const sql = `
            SELECT 
                acc.id, acc.user_id, acc.manager_id, acc.manager_name, acc.sub_account_id,
                acc.sub_account_name, acc.account_status, acc.currency_code, acc.affiliate_account,
                acc.affiliate_network, acc.advertiser_name, acc.country_code_from_name,
                acc.advertiser_id, acc.campaigns_data, acc.last_manual_update,
                DATE_FORMAT(acc.last_updated, '%Y-%m-%d %H:%i:%s') as last_updated,
                job.id as job_id, 
                job.status as job_status, 
                job.action_type as job_action_type, 
                job.result_message as job_result_message,
                job.payload as job_payload, 
                DATE_FORMAT(job.processed_at, '%Y-%m-%d %H:%i:%s') as job_processed_at,
                lcj.affiliate_offer_link,
                lcj.affiliate_offer_params,
                lcj.change_interval_minutes,
                lcj.referer_link
            FROM google_ads_accounts acc
            LEFT JOIN ad_creation_jobs job 
                ON acc.sub_account_id = job.sub_account_id AND job.user_id = ?
            LEFT JOIN link_change_jobs lcj 
                ON acc.manager_name = lcj.mcc_name COLLATE utf8mb4_unicode_ci
                AND acc.sub_account_name = lcj.sub_account_name COLLATE utf8mb4_unicode_ci
                AND JSON_CONTAINS(acc.campaigns_data, JSON_OBJECT('name', lcj.campaign_name), '$')
            WHERE acc.user_id = ?
            ORDER BY acc.manager_name, acc.sub_account_name ASC
        `;
        // ▲▲▲ SQL融合结束 ▲▲▲

        const [accounts] = await client.query(sql, [userId, userId]);

        // ▼▼▼ 保留您的核心代码：数据处理循环 ▼▼▼
        const processedAccounts = accounts.map((account) => {
            let processedAccount = {
                ...account
            }; // 创建一个可修改的副本

            // 1. 处理 campaigns_data (您原来的正确逻辑)
            if (processedAccount.campaigns_data && Array.isArray(processedAccount.campaigns_data)) {
                const updatedCampaignsData = processedAccount.campaigns_data.map((campaign) => {
                    const mappedLocations = campaign.locations.map((id) => countryMap.get(id.toString()) || id);
                    const mappedLanguages = campaign.languages.map((id) => languageMap.get(id.toString()) || id);
                    return {
                        ...campaign,
                        locations: mappedLocations,
                        languages: mappedLanguages
                    };
                });
                processedAccount.campaigns_data = updatedCampaignsData;
            }

            // 2. 【新增逻辑】组合 link_change_job 对象
            if (processedAccount.affiliate_offer_link) {
                processedAccount.link_change_job = {
                    affiliate_offer_link: processedAccount.affiliate_offer_link,
                    affiliate_offer_params: processedAccount.affiliate_offer_params,
                    change_interval_minutes: processedAccount.change_interval_minutes,
                    referer_link: processedAccount.referer_link,
                };
            }
            // 删除多余的顶层字段
            delete processedAccount.affiliate_offer_link;
            delete processedAccount.affiliate_offer_params;
            delete processedAccount.change_interval_minutes;
            delete processedAccount.referer_link;

            return processedAccount;
        });
        // ▲▲▲ 数据处理结束 ▲▲▲

        res.send({
            status: 0,
            message: '获取关联账户列表成功！',
            data: processedAccounts
        });

    } catch (error) {
        console.error('获取关联账户列表时发生错误:', error);
        res.cc(error);
    } finally {
        if (client) {
            client.release();
            console.log("GetAccounts: 数据库连接已释放");
        }
    }
};