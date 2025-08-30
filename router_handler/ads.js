// =======================================================================
// 文件: router_handler/ads.js (功能增强版)
// 作用: 接收并处理来自 Google Ads 脚本的数据同步请求。
// 核心改动:
// 1. 修改 receiveData 函数，增加对实时性能数据的处理。
// 2. 新增 receiveHistoricalData 函数，用于接收和存储每日历史数据。
// =======================================================================

const db = require('../db');

/**
 * @function receiveData
 * @description (实时/高频) 接收并刷新 google_ads_accounts 表中的账户信息及当日性能数据
 */
exports.receiveData = async (req, res) => {
    console.log('--- 收到Ads账户及广告详情(实时)同步请求 ---');

    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.cc('请求中缺少API密钥');
    }

    let client;
    try {
        client = await db.getClient();

        const keyCheckSql = 'SELECT user_id FROM user_api_keys WHERE api_key = ?';
        const [keys] = await client.query(keyCheckSql, [apiKey]);
        if (keys.length === 0) {
            client.release();
            return res.cc('无效的API密钥，禁止访问');
        }
        const userId = keys[0].user_id;

        const accountsDataFromScript = req.body;
        if (!accountsDataFromScript || !Array.isArray(accountsDataFromScript)) {
            return res.cc('请求体不是有效的JSON数组');
        }

        if (accountsDataFromScript.length === 0) {
            return res.cc('脚本未返回任何账户数据', 0);
        }

        const managerId = accountsDataFromScript[0].manager_id;
        console.log(`密钥验证成功！正在为用户ID [${userId}] 处理经理账户 [${managerId}] 的实时数据...`);

        // --- 数据对账逻辑 (Shelved) ---
        const newAccountIds = new Set(accountsDataFromScript.map(acc => acc.sub_account_id));
        const oldAccountsSql = 'SELECT sub_account_id FROM google_ads_accounts WHERE user_id = ? AND manager_id = ?';
        const [oldAccounts] = await client.query(oldAccountsSql, [userId, managerId]);
        const oldAccountIds = new Set(oldAccounts.map(acc => acc.sub_account_id));
        const shelvedAccountIds = [...oldAccountIds].filter(id => !newAccountIds.has(id));

        if (shelvedAccountIds.length > 0) {
            const updateShelvedSql = 'UPDATE google_ads_accounts SET account_status = "SHELVED" WHERE user_id = ? AND manager_id = ? AND sub_account_id IN (?)';
            await client.query(updateShelvedSql, [userId, managerId, shelvedAccountIds]);
        }

        // --- 循环处理并准备写入数据 ---
        const valuesToUpsert = accountsDataFromScript.map(account => {
            const name = account.sub_account_name || '';
            let parsedData = {
                affiliate_account: null,
                affiliate_network: null,
                advertiser_name: null,
                country_code_from_name: null,
                advertiser_id: null
            };
            const match = name.match(/^【(.*?)_(.*?)】(.*?)(?:_([A-Z]{2}))?_(\d+)$/);
            if (match) {
                parsedData = {
                    affiliate_account: match[1] || null,
                    affiliate_network: match[2] || null,
                    advertiser_name: match[3] || null,
                    country_code_from_name: match[4] || null,
                    advertiser_id: match[5] || null
                };
            }

            let accountStatus = 'ENABLED';
            if (name.includes('备用')) {
                accountStatus = 'PAUSED';
            } else if (account.campaigns_data && Array.isArray(account.campaigns_data) && account.campaigns_data.length > 0) {
                if (account.campaigns_data.every(campaign => campaign.status === 'PAUSED')) {
                    accountStatus = 'PAUSED';
                }
            }

            return [
                userId, account.manager_id, account.manager_name, account.sub_account_id, name, accountStatus, account.currency_code,
                parsedData.affiliate_account, parsedData.affiliate_network, parsedData.advertiser_name, parsedData.country_code_from_name, parsedData.advertiser_id,
                JSON.stringify(account.campaigns_data),
                // 新增的性能字段
                account.impressions, account.clicks, account.ctr, account.cpc, account.cost_micros
            ];
        });

        // --- 执行数据库写入 ---
        if (valuesToUpsert.length > 0) {
            const sql = `
                INSERT INTO google_ads_accounts (
                    user_id, manager_id, manager_name, sub_account_id, sub_account_name, account_status, currency_code, 
                    affiliate_account, affiliate_network, advertiser_name, country_code_from_name, advertiser_id, campaigns_data,
                    today_impressions, today_clicks, today_ctr, today_cpc, today_cost_micros, last_updated_time
                ) VALUES ?
                ON DUPLICATE KEY UPDATE 
                    manager_name = VALUES(manager_name), sub_account_name = VALUES(sub_account_name),
                    account_status = VALUES(account_status), currency_code = VALUES(currency_code),
                    affiliate_account = VALUES(affiliate_account), affiliate_network = VALUES(affiliate_network),
                    advertiser_name = VALUES(advertiser_name), country_code_from_name = VALUES(country_code_from_name),
                    advertiser_id = VALUES(advertiser_id), campaigns_data = VALUES(campaigns_data),
                    today_impressions = VALUES(today_impressions), today_clicks = VALUES(today_clicks),
                    today_ctr = VALUES(today_ctr), today_cpc = VALUES(today_cpc),
                    today_cost_micros = VALUES(today_cost_micros), last_updated_time = NOW()
            `;
            await client.query(sql, [valuesToUpsert]);
        }

        console.log(`${accountsDataFromScript.length} 条账户实时数据已成功同步。`);

        const io = req.app.get('socketio');
        io.emit('accounts_updated', {
            source: 'syncAllAccounts'
        });

        res.cc('数据接收并成功对账写入数据库！', 0);

    } catch (error) {
        console.error('数据库写入或对账失败:', error);
        res.cc('服务器内部错误');
    } finally {
        if (client) {
            client.release();
            console.log("ReceiveData: 数据库连接已释放");
        }
    }
};


/**
 * @function receiveHistoricalData
 * @description (每日) 接收并写入 ads_historical_performance 表
 */
exports.receiveHistoricalData = async (req, res) => {
    console.log('--- 收到Ads账户历史数据同步请求 ---');

    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.cc('请求中缺少API密钥');
    }

    let client;
    try {
        client = await db.getClient();

        const keyCheckSql = 'SELECT user_id FROM user_api_keys WHERE api_key = ?';
        const [keys] = await client.query(keyCheckSql, [apiKey]);
        if (keys.length === 0) {
            client.release();
            return res.cc('无效的API密钥，禁止访问');
        }
        const userId = keys[0].user_id;

        const historicalDataFromScript = req.body;
        if (!historicalDataFromScript || !Array.isArray(historicalDataFromScript)) {
            return res.cc('请求体不是有效的JSON数组');
        }

        if (historicalDataFromScript.length === 0) {
            return res.cc('脚本未返回任何历史数据', 0);
        }

        console.log(`密钥验证成功！正在为用户ID [${userId}] 处理 ${historicalDataFromScript.length} 条历史数据...`);

        // --- 准备写入数据 ---
        const valuesToUpsert = historicalDataFromScript.map(record => {
            const name = record.sub_account_name || '';
            let parsedData = {
                affiliate_account: null,
                affiliate_network: null,
                advertiser_name: null,
                country_code_from_name: null,
                advertiser_id: null
            };
            const match = name.match(/^【(.*?)_(.*?)】(.*?)(?:_([A-Z]{2}))?_(\d+)$/);
            if (match) {
                parsedData = {
                    affiliate_account: match[1] || null,
                    affiliate_network: match[2] || null,
                    advertiser_name: match[3] || null,
                    country_code_from_name: match[4] || null,
                    advertiser_id: match[5] || null
                };
            }
            return [
                userId, record.manager_id, record.manager_name, record.sub_account_id, record.sub_account_name, record.currency_code,
                parsedData.affiliate_account, parsedData.affiliate_network, parsedData.advertiser_name, parsedData.country_code_from_name, parsedData.advertiser_id,
                record.impressions, record.clicks, record.ctr, record.cpc, record.cost_micros, record.data_date
            ];
        });

        // --- 执行数据库写入 ---
        if (valuesToUpsert.length > 0) {
            const sql = `
                INSERT INTO ads_historical_performance (
                    user_id, manager_id, manager_name, sub_account_id, sub_account_name, currency_code,
                    affiliate_account, affiliate_network, advertiser_name, country_code_from_name, advertiser_id,
                    impressions, clicks, ctr, cpc, cost_micros, data_date
                ) VALUES ?
                ON DUPLICATE KEY UPDATE
                    manager_name = VALUES(manager_name), sub_account_name = VALUES(sub_account_name), currency_code = VALUES(currency_code),
                    affiliate_account = VALUES(affiliate_account), affiliate_network = VALUES(affiliate_network),
                    advertiser_name = VALUES(advertiser_name), country_code_from_name = VALUES(country_code_from_name), advertiser_id = VALUES(advertiser_id),
                    impressions = VALUES(impressions), clicks = VALUES(clicks), ctr = VALUES(ctr),
                    cpc = VALUES(cpc), cost_micros = VALUES(cost_micros), collection_time = NOW()
            `;
            await client.query(sql, [valuesToUpsert]);
        }

        console.log(`${historicalDataFromScript.length} 条历史数据已成功同步。`);
        res.cc('历史数据接收并成功写入数据库！', 0);

    } catch (error) {
        console.error('历史数据写入失败:', error);
        res.cc('服务器内部错误');
    } finally {
        if (client) {
            client.release();
            console.log("ReceiveHistoricalData: 数据库连接已释放");
        }
    }
}