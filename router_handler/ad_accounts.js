const db = require('../db');
const moment = require('moment');

/**
 * @function getAdAccountsDashboard
 * @description 获取Ads子账户看板的全部数据
 */
// 文件路径: router_handler/ad_accounts

exports.getAdAccountsDashboard = async (req, res) => {
    const userId = req.user.id;
    const {
        startDate,
        endDate
    } = req.query;

    const finalStartDate = startDate ? moment(startDate).format('YYYY-MM-DD') : moment().subtract(6, 'days').format('YYYY-MM-DD');
    const finalEndDate = endDate ? moment(endDate).format('YYYY-MM-DD') : moment().format('YYYY-MM-DD');

    let client;
    try {
        client = await db.getClient();

        const baseSql = `
            SELECT
                acc.id,
                acc.sub_account_id,
                acc.sub_account_name,
                acc.manager_name,
                acc.affiliate_account,
                acc.affiliate_network,
                acc.advertiser_name,
                acc.advertiser_id,
                acc.account_status,
                acc.last_updated_time,
                acc.today_clicks,
                acc.today_cost_micros,
                acc.campaigns_data,
                job.status as job_status,
                job.payload as job_payload,
                JSON_UNQUOTE(JSON_EXTRACT(acc.campaigns_data, '$[0].budget')) as daily_budget_default,
                JSON_EXTRACT(acc.campaigns_data, '$[0].locations') as target_region_json_default,
                fin.initial_balance,
                fin.total_recharge,
                lcj.id as link_job_id,
                lcj.change_interval_minutes
            FROM google_ads_accounts acc
            LEFT JOIN (
                SELECT t1.* FROM ad_creation_jobs t1 INNER JOIN (
                    SELECT sub_account_id, MAX(created_at) as max_created_at FROM ad_creation_jobs WHERE user_id = ?
                    GROUP BY sub_account_id
                ) t2 ON t1.sub_account_id = t2.sub_account_id AND t1.created_at = t2.max_created_at WHERE t1.user_id = ?
            ) job ON acc.sub_account_id = job.sub_account_id
            LEFT JOIN account_finances fin ON acc.sub_account_id = fin.sub_account_id AND fin.user_id = ?
            -- ▼▼▼ 最终修正: 在 JOIN 条件中加入 COLLATE 来统一字符集规则 ▼▼▼
            LEFT JOIN link_change_jobs lcj ON acc.sub_account_name = lcj.sub_account_name COLLATE utf8mb4_unicode_ci AND lcj.user_id = ?
            -- ▲▲▲ 最终修正 ▲▲▲
            WHERE acc.user_id = ?;
        `;

        const [accounts] = await client.query(baseSql, [userId, userId, userId, userId, userId]);

        // ... 后续代码完全不变 ...

        if (accounts.length === 0) {
            return res.send({
                status: 0,
                message: '未找到任何子账户数据',
                data: {
                    data: []
                }
            });
        }
        const accountIds = accounts.map(a => a.sub_account_id);
        const historicalSpendSql = `
            SELECT sub_account_id, SUM(cost_micros) as historical_spend, SUM(clicks) as historical_clicks
            FROM ads_historical_performance WHERE user_id = ? AND sub_account_id IN (?) AND data_date BETWEEN ? AND ?
            GROUP BY sub_account_id;
        `;
        const [spendData] = await client.query(historicalSpendSql, [userId, accountIds, finalStartDate, finalEndDate]);
        const spendMap = new Map(spendData.map(item => [item.sub_account_id, {
            spend: parseFloat(item.historical_spend) || 0,
            clicks: parseInt(item.historical_clicks) || 0
        }]));
        const affiliateAccounts = accounts.map(a => a.affiliate_account).filter(Boolean);
        let commissionMap = new Map();
        if (affiliateAccounts.length > 0) {
            const commissionSql = `
                SELECT uid, SUM(sale_comm) as total_commission, COUNT(*) as total_conversions
                FROM transactions WHERE user_id = ? AND uid IN (?) AND order_time BETWEEN ? AND ?
                GROUP BY uid;
            `;
            const [commissionData] = await client.query(commissionSql, [userId, affiliateAccounts, moment(finalStartDate).startOf('day').format('YYYY-MM-DD HH:mm:ss'), moment(finalEndDate).endOf('day').format('YYYY-MM-DD HH:mm:ss')]);
            commissionData.forEach(item => {
                commissionMap.set(item.uid, {
                    commission: parseFloat(item.total_commission) || 0,
                    conversions: parseInt(item.total_conversions) || 0
                });
            });
        }
        const finalData = accounts.map(acc => {
            const historical = spendMap.get(acc.sub_account_id) || {
                spend: 0,
                clicks: 0
            };
            const commissionInfo = commissionMap.get(acc.affiliate_account) || {
                commission: 0,
                conversions: 0
            };
            let final_account_status = acc.account_status;
            let final_daily_budget = parseFloat(acc.daily_budget_default) || 0;
            let final_target_region_json = acc.target_region_json_default;
            if (acc.job_status === 'PENDING_UPDATE' && acc.job_payload) {
                try {
                    const jobPayload = (typeof acc.job_payload === 'string') ? JSON.parse(acc.job_payload) : acc.job_payload;
                    final_account_status = jobPayload.campaignStatus || final_account_status;
                    final_daily_budget = jobPayload.budget !== undefined ? parseFloat(jobPayload.budget) : final_daily_budget;
                    if (jobPayload.locations !== undefined) {
                        final_target_region_json = JSON.stringify(jobPayload.locations);
                    }
                } catch (e) {
                    console.error(`解析 job_payload 失败, sub_account_id: ${acc.sub_account_id}`, e);
                }
            }
            const historicalClicks = historical.clicks;
            const historicalCVR = historicalClicks > 0 ? (commissionInfo.conversions / historicalClicks) * 100 : 0;
            const todayClicks = acc.today_clicks || 0;
            const realtimeCVR = todayClicks > 0 ? (commissionInfo.conversions / todayClicks) * 100 : 0;
            const historicalSpend = historical.spend / 1000000;
            const realtimeSpend = (acc.today_cost_micros || 0) / 1000000;
            const roi = historicalSpend > 0 ? ((commissionInfo.commission - historicalSpend) / historicalSpend) * 100 : (commissionInfo.commission > 0 ? Infinity : 0);
            const initialBalance = parseFloat(acc.initial_balance) || 0;
            const totalRecharge = parseFloat(acc.total_recharge) || 0;
            const balance = (initialBalance + totalRecharge) - historicalSpend - realtimeSpend;
            let targetRegion = null;
            const rawValue = final_target_region_json;
            if (rawValue) {
                try {
                    targetRegion = JSON.parse(rawValue);
                } catch (e) {
                    if (typeof rawValue === 'object') {
                        targetRegion = rawValue;
                    } else {
                        console.error(`解析target_region_json失败, sub_account_id: ${acc.sub_account_id}. 原始值:`, rawValue);
                        targetRegion = null;
                    }
                }
            }
            return {
                id: acc.id,
                sub_account_name: acc.sub_account_name,
                sub_account_id: acc.sub_account_id,
                manager_account: acc.manager_name,
                affiliate_account: acc.affiliate_account,
                affiliate_network: acc.affiliate_network,
                advertiser: acc.advertiser_name,
                advertiser_id: acc.advertiser_id,
                job_status: acc.job_status || 'COMPLETED',
                account_status: final_account_status,
                daily_budget: final_daily_budget,
                target_region: targetRegion,
                last_modified_time: moment(acc.last_updated_time).format('YYYY-MM-DD HH:mm:ss'),
                realtime_clicks: todayClicks,
                realtime_cvr: realtimeCVR.toFixed(2),
                realtime_spend: realtimeSpend,
                balance: balance.toFixed(2),
                historical_spend: historicalSpend,
                historical_clicks: historicalClicks,
                historical_cvr: historicalCVR.toFixed(2),
                commission: commissionInfo.commission,
                roi: roi === Infinity ? 'inf' : roi.toFixed(2),
                campaigns_data: acc.campaigns_data,
                link_job_id: acc.link_job_id,
                change_interval_minutes: acc.change_interval_minutes,
            };
        });
        res.send({
            status: 0,
            message: '获取看板数据成功！',
            data: finalData
        });
    } catch (error) {
        console.error("获取Ads子账户看板数据时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

/**
 * @function updateAdAccount
 * @description 在表格内修改子账户状态、预算、地区等，并创建待处理指令。
 * 新增逻辑：同时更新 link_change_jobs 表中的换链间隔时间。
 */
exports.updateAdAccount = async (req, res) => {
    // ▼▼▼ 核心修改 1: 从请求体中接收新增的字段 ▼▼▼
    const {
        sub_account_id,
        account_status,
        daily_budget,
        target_region,
        link_job_id, // 新增：接收要更新的 link_change_jobs 的 ID
        change_interval_minutes // 新增：接收新的换链间隔时间
    } = req.body;
    // ▲▲▲ 核心修改 1 结束 ▲▲▲

    const userId = req.user.id;
    let client;

    if (!userId) {
        return res.cc('无法获取用户信息，请检查登录状态');
    }

    try {
        client = await db.getClient();
        await client.beginTransaction();

        // --- 原有逻辑部分：更新或创建 ad_creation_jobs ---
        // (这部分逻辑保持不变)
        const updatesForPayload = {
            campaignStatus: account_status,
            budget: daily_budget,
            locations: target_region
        };
        const jobStatus = 'PENDING_UPDATE';
        const actionType = 'UPDATE';
        const checkJobSql = 'SELECT * FROM ad_creation_jobs WHERE sub_account_id = ? ORDER BY created_at DESC LIMIT 1';
        const [existingJobs] = await client.query(checkJobSql, [sub_account_id]);

        if (existingJobs.length > 0) {
            const existingJob = existingJobs[0];
            let existingPayload = (typeof existingJob.payload === 'string') ? JSON.parse(existingJob.payload) : existingJob.payload;
            if (typeof existingPayload !== 'object' || existingPayload === null) {
                throw new Error('数据库中的 payload 字段格式未知或为 null');
            }
            const newPayload = {
                ...existingPayload,
                ...updatesForPayload
            };
            const updateSql = 'UPDATE ad_creation_jobs SET payload = ?, status = ?, action_type = ?, updated_at = NOW() WHERE id = ?';
            const [updateResults] = await client.query(updateSql, [JSON.stringify(newPayload), jobStatus, actionType, existingJob.id]);
            if (updateResults.affectedRows !== 1) throw new Error('更新 ad_creation_jobs 失败');
        } else {
            const getCampaignDataSql = 'SELECT campaigns_data FROM google_ads_accounts WHERE sub_account_id = ?';
            const [accounts] = await client.query(getCampaignDataSql, [sub_account_id]);
            if (accounts.length === 0) {
                await client.rollback();
                return res.cc('找不到对应的 google_ads_accounts 记录');
            }
            let campaignsData = (typeof accounts[0].campaigns_data === 'string') ? JSON.parse(accounts[0].campaigns_data) : accounts[0].campaigns_data;
            const basePayload = transformCampaignDataToPayload(campaignsData);
            const finalPayload = {
                ...basePayload,
                ...updatesForPayload
            };
            const insertSql = 'INSERT INTO ad_creation_jobs (user_id, sub_account_id, payload, status, action_type) VALUES (?, ?, ?, ?, ?)';
            const [insertResults] = await client.query(insertSql, [userId, sub_account_id, JSON.stringify(finalPayload), jobStatus, actionType]);
            if (insertResults.affectedRows !== 1) throw new Error('创建 ad_creation_jobs 失败');
        }
        // --- 原有逻辑部分结束 ---


        // ▼▼▼ 核心修改 2: 新增更新 link_change_jobs 的逻辑 ▼▼▼
        // 只有当 link_job_id 存在且是一个有效数字时，才执行更新操作
        if (link_job_id && !isNaN(parseInt(link_job_id))) {

            // 根据账户状态决定 change_interval_minutes 的值
            // 如果是 ENABLED，则使用前端传来的值
            // 如果是 PAUSED，则将其设置为 NULL (清空)
            const intervalValue = (account_status === 'ENABLED') ? change_interval_minutes : null;

            const updateLinkJobSql = `
                UPDATE link_change_jobs 
                SET change_interval_minutes = ? 
                WHERE id = ? AND user_id = ?
            `;

            const [linkJobUpdateResult] = await client.query(updateLinkJobSql, [intervalValue, link_job_id, userId]);

            // 可选的检查：确认更新是否成功
            if (linkJobUpdateResult.affectedRows !== 1) {
                // 如果 link_job_id 确实存在但更新失败，可以抛出错误来回滚整个事务
                console.warn(`警告: link_change_jobs 中 ID 为 ${link_job_id} 的记录未被更新 (可能不存在或 user_id 不匹配)`);
                // 或者根据业务严格性，决定是否抛出错误
                // throw new Error(`更新 link_change_jobs 记录 (ID: ${link_job_id}) 失败`);
            }
        }
        // ▲▲▲ 核心修改 2 结束 ▲▲▲

        await client.commit();
        res.send({
            status: 0,
            message: '广告任务更新与换链设置均已成功提交'
        });

    } catch (error) {
        if (client) await client.rollback();
        console.error("更新广告任务时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

/**
 * @function manageBalance
 * @description 设置初始余额或充值，并自动处理货币转换
 */
exports.manageBalance = async (req, res) => {
    const {
        sub_account_id,
        initial_balance,
        recharge_amount,
        note
    } = req.body;
    const userId = req.user.id;
    let client;

    if (!sub_account_id || (initial_balance === undefined && recharge_amount === undefined)) {
        return res.cc('缺少必要的参数！');
    }

    try {
        client = await db.getClient();
        await client.beginTransaction(); // 开始事务

        // 1. 查询子账户的货币代码
        const [accountInfo] = await client.query(
            'SELECT currency_code FROM google_ads_accounts WHERE sub_account_id = ? AND user_id = ?',
            [sub_account_id, userId]
        );

        if (accountInfo.length === 0) {
            return res.cc('未找到指定的子账户');
        }
        const currencyCode = accountInfo[0].currency_code;

        // 2. 定义汇率 (重要：生产环境应替换为实时汇率API)
        const exchangeRates = {
            'USD': 1,
            'CNY': 0.14, // 1 CNY = 0.14 USD
            'HKD': 0.13, // 1 HKD = 0.13 USD
            // ...可根据需要添加更多币种
        };

        const rate = exchangeRates[currencyCode] || 1; // 如果找不到币种，默认为1 (不转换)

        // 3. 转换金额为美元
        let convertedInitialBalance;
        let convertedRechargeAmount;

        if (initial_balance !== undefined) {
            convertedInitialBalance = parseFloat(initial_balance) * rate;
        }
        if (recharge_amount !== undefined) {
            convertedRechargeAmount = parseFloat(recharge_amount) * rate;
        }

        // 4. 查找或创建财务记录
        let [finances] = await client.query(
            'SELECT id FROM account_finances WHERE user_id = ? AND sub_account_id = ?',
            [userId, sub_account_id]
        );
        let financeId;

        if (finances.length === 0) {
            const [insertResult] = await client.query(
                'INSERT INTO account_finances (user_id, sub_account_id) VALUES (?, ?)',
                [userId, sub_account_id]
            );
            financeId = insertResult.insertId;
        } else {
            financeId = finances[0].id;
        }

        // 5. 更新或插入数据库 (使用转换后的金额)
        if (convertedInitialBalance !== undefined) {
            await client.query(
                'UPDATE account_finances SET initial_balance = ? WHERE id = ?',
                [convertedInitialBalance, financeId]
            );
        }

        if (convertedRechargeAmount !== undefined && convertedRechargeAmount > 0) {
            const amount = convertedRechargeAmount;
            // 插入充值历史
            await client.query(
                'INSERT INTO recharge_history (finance_id, amount, note) VALUES (?, ?, ?)',
                [financeId, amount, note]
            );
            // 更新总充值额
            await client.query(
                'UPDATE account_finances SET total_recharge = total_recharge + ? WHERE id = ?',
                [amount, financeId]
            );
        }

        await client.commit(); // 提交事务
        res.cc('余额操作成功！', 0);

    } catch (error) {
        if (client) await client.rollback();
        console.error("管理余额时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

// 辅助函数：将从 google_ads_accounts 表中获取的 campaigns_data 转换为 ad_creation_jobs 表所需的 payload 格式
const transformCampaignDataToPayload = (campaignsData) => {
    // campaigns_data 是一个数组，我们通常处理第一个（主要的）广告系列
    if (!campaignsData || !Array.isArray(campaignsData) || campaignsData.length === 0) {
        throw new Error('campaigns_data 格式无效或为空');
    }
    const campaign = campaignsData[0];

    // 通常也只处理第一个广告组和第一个广告
    const adGroup = campaign.adGroups?.[0] || {};
    const ad = adGroup.ads?.[0] || {};

    // 提取并转换 headlines
    const headlines = ad.headlines?.map(h => h.text?.text).filter(Boolean) || [];

    // 提取并转换 descriptions
    const descriptions = ad.descriptions?.map(d => d.text?.text).filter(Boolean) || [];

    // 提取 keywords 和 matchType
    const keywords = adGroup.keywords?.map(k => k.text).filter(Boolean) || [];
    // 假设一个广告组的关键词匹配类型是统一的，取第一个作为代表
    const keywordMatchType = adGroup.keywords?.[0]?.matchType || 'EXACT';

    // 组装成 payload 对象
    const payload = {
        adLink: ad.finalUrls?.[0] || '',
        budget: campaign.budget, // 这是原始预算，会被前端传来的 dailyBudget 覆盖
        keywords: keywords,
        networks: [campaign.advertisingChannel || 'Google Search'], // advertisingChannel 可能是 SEARCH, DISPLAY 等
        adGroupId: adGroup.id || null,
        headlines: headlines,
        languages: campaign.languages?.map(Number) || [], // 确保是数字
        locations: campaign.locations?.map(Number) || [], // 确保是数字
        campaignId: campaign.id || null,
        adGroupName: adGroup.name || 'Ad Group 1',
        campaignName: campaign.name,
        descriptions: descriptions,
        campaignStatus: campaign.status || 'ENABLED',
        biddingStrategy: campaign.biddingStrategy || 'MANUAL_CPC',
        keywordMatchType: keywordMatchType
    };

    return payload;
};