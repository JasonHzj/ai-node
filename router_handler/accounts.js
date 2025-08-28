// =======================================================================
// 文件: router_handler/accounts.js (最终修复版)
// 核心改动: 1. 使用正确的 client.query 语法
//           2. 确保函数有完整的 try/catch/finally 结构
// =======================================================================

const db = require('../db');

exports.getAccounts = async (req, res) => {
            console.log('--- 收到获取关联账户列表的 [POST] 请求 ---');
            let client;
            try {
                // ▼▼▼ 核心修正：执行“双重验证” ▼▼▼

                // 1. 从 JWT Token 中获取用户ID (这是可信的)
                const userIdFromToken = req.user.id;

                // 2. 从 POST 请求的 Body 中获取用户ID
                const {
                    userId: userIdFromBody
                } = req.body;

                // 3. 严格比较这两个ID
                if (!userIdFromBody || userIdFromToken !== userIdFromBody) {
                    console.error(`[安全警告] 身份验证不匹配！Token ID: ${userIdFromToken}, Body ID: ${userIdFromBody}`);
                    // 403 Forbidden: 服务器理解请求，但拒绝授权
                    return res.status(403).send({
                        status: 1,
                        message: '身份验证不匹配，禁止访问！'
                    });
                }

                // 4. 验证通过后，使用这个可信的ID进行后续操作
                const userId = userIdFromToken;

                // ▲▲▲ 修正结束 ▲▲▲

                client = await db.getClient();

                const [countries] = await client.query('SELECT criterion_id, name_zh FROM google_ads_countries');
                const [languages] = await client.query('SELECT criterion_id, name_zh FROM google_ads_languages');

                const countryMap = new Map(countries.map((c) => [c.criterion_id.toString(), c.name_zh]));
                const languageMap = new Map(languages.map((l) => [l.criterion_id.toString(), l.name_zh]));

               const sql = `
  SELECT 
      acc.id,
      acc.user_id,
      acc.manager_id,
      acc.manager_name,
      acc.sub_account_id,
      acc.sub_account_name,
      acc.account_status,
      acc.currency_code,
      acc.affiliate_account,
      acc.affiliate_network,
      acc.advertiser_name,
      acc.country_code_from_name,
      acc.advertiser_id,
      acc.campaigns_data,
      acc.last_manual_update,
      DATE_FORMAT(acc.last_updated, '%Y-%m-%d %H:%i:%s') as last_updated,
      job.id as job_id, 
      job.status as job_status, 
      job.action_type as job_action_type, 
      job.result_message as job_result_message,
      job.payload as job_payload, 
      DATE_FORMAT(job.processed_at, '%Y-%m-%d %H:%i:%s') as job_processed_at
  FROM google_ads_accounts acc
  LEFT JOIN ad_creation_jobs job 
    ON acc.sub_account_id = job.sub_account_id AND job.user_id = ?
  WHERE acc.user_id = ?
  ORDER BY acc.manager_name, acc.sub_account_name ASC
`;
               const [accounts] = await client.query(sql, [userId, userId]);

        const processedAccounts = accounts.map((account) => {
            if (account.campaigns_data && Array.isArray(account.campaigns_data)) {
                const updatedCampaignsData = account.campaigns_data.map((campaign) => {
                    const mappedLocations = campaign.locations.map((id) => countryMap.get(id.toString()) || id);
                    const mappedLanguages = campaign.languages.map((id) => languageMap.get(id.toString()) || id);
                    return {
                        ...campaign,
                        locations: mappedLocations,
                        languages: mappedLanguages
                    };
                });
                return {
                    ...account,
                    campaigns_data: updatedCampaignsData
                };
            }
            return account;
        });

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
