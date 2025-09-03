// 1. 导入数据库模块和moment库
const db = require('../db/index')
const moment = require('moment');

// 2. 定义获取换链接管理页面整合数据的处理函数
exports.getLinkManagementData = async (req, res) => {
    // 获取前端传来的筛选和搜索参数
    const params = Object.keys(req.body).length > 0 ? req.body : req.query;
    const {
        manager_name,
        affiliate_account,
        affiliate_network,
        search_query
    } = params;

    const userId = req.user.id;
    let client;

    try {
        client = await db.getClient();

        // 【核心修复】在 JOIN ON 条件中，使用 COLLATE 关键字来统一字符集
        let sql = `
            SELECT
                g.manager_name,
                g.sub_account_id,
                g.sub_account_name,
                JSON_UNQUOTE(JSON_EXTRACT(g.campaigns_data, '$[0].name')) AS campaign_name,
                g.affiliate_account,
                g.affiliate_network,
                g.advertiser_name,
                g.country_code_from_name,
                g.advertiser_id,
                j.id as job_id,
                j.affiliate_offer_link,
                j.affiliate_offer_params,
                j.advertiser_link,
                j.proxy_country,
                j.change_interval_minutes,
                j.referer_link,
                j.status,
                j.ads_last_operation,
                j.ads_last_operation_time,
                j.last_generated_link,
                j.last_generated_time,
                j.generated_link_1,
                j.generated_link_2,
                j.error_message
            FROM
                google_ads_accounts g
            LEFT JOIN
                link_change_jobs j ON g.manager_name = j.mcc_name COLLATE utf8mb4_unicode_ci
                                  AND g.sub_account_name = j.sub_account_name COLLATE utf8mb4_unicode_ci
                                  AND JSON_UNQUOTE(JSON_EXTRACT(g.campaigns_data, '$[0].name')) = j.campaign_name COLLATE utf8mb4_unicode_ci
            WHERE g.user_id = ?
        `;

        const sqlParams = [userId];

        // ... (后续的筛选和搜索逻辑保持不变) ...
        if (manager_name) {
            sql += " AND g.manager_name = ?";
            sqlParams.push(manager_name);
        }
        if (affiliate_account) {
            sql += " AND g.affiliate_account = ?";
            sqlParams.push(affiliate_account);
        }
        if (affiliate_network) {
            sql += " AND g.affiliate_network = ?";
            sqlParams.push(affiliate_network);
        }
        if (search_query) {
            sql += " AND (g.sub_account_name LIKE ? OR g.sub_account_id LIKE ?)";
            sqlParams.push(`%${search_query}%`);
            sqlParams.push(`%${search_query}%`);
        }

        sql += " ORDER BY g.manager_name, g.sub_account_name";

        const [results] = await client.query(sql, sqlParams);

        const formattedResults = results.map(row => ({
            ...row,
            ads_last_operation_time: row.ads_last_operation_time ? moment(row.ads_last_operation_time).format('YYYY-MM-DD HH:mm:ss') : null,
            last_generated_time: row.last_generated_time ? moment(row.last_generated_time).format('YYYY-MM-DD HH:mm:ss') : null,
        }));

        res.send({
            code: 0,
            message: '获取换链接管理数据成功！',
            data: formattedResults,
        });

    } catch (error) {
        console.error("获取换链接管理数据时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

// 请将此函数添加到 router_handler/management.js 文件的末尾


// 根据联盟平台和广告ID，获取智能填充建议
exports.getOfferSuggestions = async (req, res) => {
    const {
        affiliate_network,
        advertiser_id
    } = req.query;
    const userId = req.user.id;
    let client;

    if (!affiliate_network || !advertiser_id) {
        return res.cc('缺少必要的参数: affiliate_network 和 advertiser_id');
    }

    try {
        client = await db.getClient();

        // 【核心修复】affiliate_platforms 是全局表，查询时不应包含 user_id
        let platformSql = 'SELECT name FROM affiliate_platforms WHERE abbreviation = ?';
        const [platformRows] = await client.query(platformSql, [affiliate_network]); // 移除了 userId

        if (platformRows.length === 0) {
            return res.send({
                code: 0,
                message: '未找到对应的联盟平台，返回空建议。',
                data: {
                    offer_links: [],
                    advertiser_link: ''
                }
            });
        }
        const platformName = platformRows[0].name;

        // 【保持不变】ads 表是个性化表，查询时必须包含 user_id
        let adsSql = 'SELECT tracking_url, site_url, merchant_name, platform_ad_id, comm_rate FROM ads WHERE platform = ? AND platform_ad_id = ? AND user_id = ?';
        const [adsRows] = await client.query(adsSql, [platformName, advertiser_id, userId]);

        if (adsRows.length === 0) {
            return res.send({
                code: 0,
                message: '未找到匹配的广告，返回空建议。',
                data: {
                    offer_links: [],
                    advertiser_link: ''
                }
            });
        }

        const offerLinks = adsRows.map(ad => ({
            label: `(${ad.merchant_name}_${ad.platform_ad_id}_${ad.comm_rate}) ${ad.tracking_url}`,
            value: ad.tracking_url
        }));

        const advertiserLink = adsRows[0] ? adsRows[0].site_url : '';

        res.send({
            code: 0,
            message: '获取offer建议成功！',
            data: {
                offer_links: offerLinks,
                advertiser_link: advertiserLink
            }
        });

    } catch (error) {
        console.error("获取Offer建议时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

// 保存（新增或更新）换链接任务的配置
exports.saveLinkJob = async (req, res) => {
    const jobData = req.body;
    const userId = req.user.id;
    let client;

    const requiredFields = ['mcc_name', 'sub_account_name', 'campaign_name'];
    for (const field of requiredFields) {
        if (!jobData[field]) {
            return res.cc(`缺少必要的参数: ${field}`);
        }
    }

    try {
        client = await db.getClient();

        // 【核心修复】前端传来的字段是 job_id, 我们用它来判断是新增还是更新
        if (jobData.job_id) {
            // --- 更新逻辑 ---
            const {
                job_id, // 从前端接收 job_id
                affiliate_offer_link,
                affiliate_offer_params,
                advertiser_link,
                proxy_country,
                change_interval_minutes,
                referer_link
            } = jobData;

            // 【核心修复】在 WHERE 子句中，使用数据库的真实字段名 `id`
            const updateSql = `
                UPDATE link_change_jobs 
                SET affiliate_offer_link = ?, affiliate_offer_params = ?, advertiser_link = ?, 
                    proxy_country = ?, change_interval_minutes = ?, referer_link = ?,
                    status = 'PENDING'
                WHERE id = ? AND user_id = ? 
            `;
            const [updateResult] = await client.query(updateSql, [
                affiliate_offer_link, affiliate_offer_params, advertiser_link,
                proxy_country, change_interval_minutes, referer_link,
                job_id, // 这里的 job_id 对应 WHERE id = ?
                userId
            ]);

            if (updateResult.affectedRows !== 1) {
                return res.cc('更新换链接任务失败，请检查job_id是否存在！');
            }
            res.send({
                code: 0,
                message: '更新换链接任务成功！'
            });

        } else {
            // --- 新增逻辑 (保持不变) ---
            const {
                mcc_name,
                sub_account_name,
                campaign_name,
                affiliate_offer_link,
                affiliate_offer_params,
                advertiser_link,
                proxy_country,
                change_interval_minutes,
                referer_link
            } = jobData;
            const insertSql = `
                INSERT INTO link_change_jobs 
                (user_id, mcc_name, sub_account_name, campaign_name, affiliate_offer_link, 
                 affiliate_offer_params, advertiser_link, proxy_country, change_interval_minutes, referer_link, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
            `;
            const [insertResult] = await client.query(insertSql, [
                userId, mcc_name, sub_account_name, campaign_name, affiliate_offer_link,
                affiliate_offer_params, advertiser_link, proxy_country, change_interval_minutes, referer_link
            ]);
            if (insertResult.affectedRows !== 1) {
                return res.cc('新增换链接任务失败！');
            }
            res.send({
                code: 0,
                message: '新增换链接任务成功！'
            });
        }

    } catch (error) {
        console.error("保存换链接任务时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};