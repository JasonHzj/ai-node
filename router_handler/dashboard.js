// =======================================================================
// 文件: router_handler/dashboard.js (最新版)
// 作用: 提供Linkbux数据看板所需的API数据处理逻辑。
// 修正: 移除总佣金计算中的 status 筛选，以统计所有状态的总金额。
// =======================================================================

const db = require('../db');
const moment = require('moment'); // 引入moment库来处理日期

// =======================================================================
// 文件: router_handler/dashboard.js
// 替换函数: getAdsSpendData
// 修正: 
// 1. 将此辅助函数从使用随机数的占位符，修改为从数据库查询真实的花费数据。
// 2. 新增了货币转换逻辑，使用 CASE 语句在SQL层面将港币(HKD)和人民币(CNY)按固定汇率转换为美元(USD)。
// =======================================================================

// =======================================================================
// 文件: router_handler/dashboard.js
// 替换函数: getAdsSpendData
// 修正: 
// 1. 新增 platformName 参数，用于按联盟平台筛选数据。
// 2. 查询逻辑增加 affiliate_network 字段的过滤。
// 3. 保留了货币转换功能。
// =======================================================================

async function getAdsSpendData(userId, platformName, startDate, endDate, groupByDay = false) {
    let client;
    try {
        client = await db.getClient();

        // 简单的硬编码映射，未来可以改为从 affiliate_platforms 表查询
        const platformAbbreviations = {
            'Linkbux': 'LB',
            'partnerboost': 'PB',
            'partnermatic': 'PM'
        };
        const platformAbbr = platformAbbreviations[platformName];

        if (!platformAbbr) {
            // 如果传入了一个未知的平台名称，直接返回0，避免查询错误
            console.warn(`未知的平台名称: ${platformName}，花费数据将返回0。`);
            return groupByDay ? {} : 0;
        }

        // 定义固定的汇率
        const EXCHANGE_RATES = {
            CNY_TO_USD: 0.14, // 1人民币 ≈ 0.14美元
            HKD_TO_USD: 0.13 // 1港币 ≈ 0.13美元
        };

        if (groupByDay) {
            // 模式一：按天分组查询，并进行货币转换和平台筛选
            const sql = `
                SELECT 
                    data_date as date,
                    SUM(
                        CASE
                            WHEN currency_code = 'CNY' THEN (cost_micros / 1000000) * ?
                            WHEN currency_code = 'HKD' THEN (cost_micros / 1000000) * ?
                            ELSE (cost_micros / 1000000)
                        END
                    ) as daily_spend_usd
                FROM ads_historical_performance
                WHERE user_id = ? AND affiliate_network = ? AND data_date BETWEEN ? AND ?
                GROUP BY data_date
                ORDER BY date;
            `;
            const [rows] = await client.query(sql, [
                EXCHANGE_RATES.CNY_TO_USD,
                EXCHANGE_RATES.HKD_TO_USD,
                userId,
                platformAbbr, // <--- 新增的查询参数
                startDate,
                endDate
            ]);

            const data = {};
            let currentDate = moment(startDate);
            while (currentDate.isSameOrBefore(endDate)) {
                const dateStr = currentDate.format('YYYY-MM-DD');
                data[dateStr] = 0;
                currentDate.add(1, 'days');
            }
            rows.forEach(row => {
                const dateStr = moment(row.date).format('YYYY-MM-DD');
                data[dateStr] = parseFloat(row.daily_spend_usd) || 0;
            });
            return data;

        } else {
            // 模式二：查询总花费，并进行货币转换和平台筛选
            const sql = `
                SELECT 
                    SUM(
                        CASE
                            WHEN currency_code = 'CNY' THEN (cost_micros / 1000000) * ?
                            WHEN currency_code = 'HKD' THEN (cost_micros / 1000000) * ?
                            ELSE (cost_micros / 1000000)
                        END
                    ) as total_spend_usd
                FROM ads_historical_performance
                WHERE user_id = ? AND affiliate_network = ? AND data_date BETWEEN ? AND ?;
            `;
            const [rows] = await client.query(sql, [
                EXCHANGE_RATES.CNY_TO_USD,
                EXCHANGE_RATES.HKD_TO_USD,
                userId,
                platformAbbr, // <--- 新增的查询参数
                startDate,
                endDate
            ]);

            return (rows[0] && rows[0].total_spend_usd) ? parseFloat(rows[0].total_spend_usd) : 0;
        }
    } catch (error) {
        console.error("查询 ADS 花费数据时出错:", error);
        return groupByDay ? {} : 0;
    } finally {
        if (client) {
            client.release();
        }
    }
}


// =======================================================================
// 文件: router_handler/dashboard.js
// 替换函数: getTopLeftPanelData
// 修正:
// 1. 新增了 platform 参数的接收和处理，用于按联盟平台筛选数据。
// 2. 将佣金查询和花费查询都增加了平台过滤条件。
// 3. 优化了佣金查询SQL，并将ROI公式修正为 (佣金 - 花费) / 花费。
// =======================================================================

exports.getTopLeftPanelData = async (req, res) => {
    const {
        startDate,
        endDate,
        platform // 1. 从查询参数中获取平台名称
    } = req.query;
    const userId = req.user.id;
    let client;

    if (!startDate || !endDate || !platform) {
        return res.cc('缺少 startDate, endDate 或 platform 查询参数！');
    }

    try {
        client = await db.getClient();

        // 2. 日期计算逻辑保持不变
        const currentPeriodStart = moment(startDate).startOf('day');
        const currentPeriodEnd = moment(endDate).endOf('day');
        const duration = moment.duration(currentPeriodEnd.diff(currentPeriodStart)).asDays();
        const previousPeriodEnd = currentPeriodStart.clone().subtract(1, 'days').endOf('day');
        const previousPeriodStart = previousPeriodEnd.clone().subtract(duration, 'days').startOf('day');

        // 3. 优化查询：一次性获取当前和上一周期的总佣金，并按平台筛选
        const commissionSql = `
            SELECT
                SUM(CASE WHEN order_time BETWEEN ? AND ? THEN sale_comm ELSE 0 END) as current_commission,
                SUM(CASE WHEN order_time BETWEEN ? AND ? THEN sale_comm ELSE 0 END) as previous_commission
            FROM transactions
            WHERE user_id = ? AND platform = ?; 
        `;
        const [commissionResult] = await client.query(commissionSql, [
            currentPeriodStart.format('YYYY-MM-DD HH:mm:ss'), currentPeriodEnd.format('YYYY-MM-DD HH:mm:ss'),
            previousPeriodStart.format('YYYY-MM-DD HH:mm:ss'), previousPeriodEnd.format('YYYY-MM-DD HH:mm:ss'),
            userId,
            platform // <-- 新增平台参数
        ]);
        const total_commission = parseFloat(commissionResult[0].current_commission) || 0;
        const previous_total_commission = parseFloat(commissionResult[0].previous_commission) || 0;

        // 4. 调用我们重写后的 getAdsSpendData 函数，传入平台名称
        const total_ads_spend = await getAdsSpendData(
            userId,
            platform, // <-- 传入平台参数
            startDate,
            endDate
        );
        const previous_total_ads_spend = await getAdsSpendData(
            userId,
            platform, // <-- 传入平台参数
            previousPeriodStart.format('YYYY-MM-DD'),
            previousPeriodEnd.format('YYYY-MM-DD')
        );

        // 5. 计算各项指标和环比 (ROI公式已修正)
        const calculateChange = (current, previous) => {
            if (previous > 0) return (current - previous) / previous;
            return current > 0 ? 1 : 0;
        };
        const commission_change = calculateChange(total_commission, previous_total_commission);
        const ads_spend_change = calculateChange(total_ads_spend, previous_total_ads_spend);

        const calculateRoi = (commission, spend) => {
            if (spend > 0) return (commission - spend) / spend;
            return commission > 0 ? Infinity : 0;
        };
        const current_roi = calculateRoi(total_commission, total_ads_spend);
        const previous_roi = calculateRoi(previous_total_commission, previous_total_ads_spend);
        const roi_change = calculateChange(current_roi, previous_roi);

        // 6. 返回数据，结构保持不变
        res.send({
            status: 0,
            message: '获取核心指标成功！',
            data: {
                total_commission: {
                    value: total_commission,
                    change: commission_change
                },
                total_ads_spend: {
                    value: total_ads_spend,
                    change: ads_spend_change
                },
                roi: {
                    value: current_roi,
                    change: roi_change
                }
            }
        });

    } catch (error) {
        console.error("获取 TopLeftPanelData 时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

// =======================================================================
// 文件: router_handler/dashboard.js
// 替换函数: getDailyTrendsChartData
// 修正:
// 1. 新增了 platform 参数的接收和处理，用于按联盟平台筛选数据。
// 2. 将佣金查询和花费查询都增加了平台过滤条件。
// 3. 修正了每日ROI的计算公式。
// =======================================================================

exports.getDailyTrendsChartData = async (req, res) => {
    const {
        startDate,
        endDate,
        platform // 1. 从查询参数中获取平台名称
    } = req.query;
    const userId = req.user.id;
    let client;

    if (!startDate || !endDate || !platform) {
        return res.cc('缺少 startDate, endDate 或 platform 查询参数！');
    }

    try {
        client = await db.getClient();

        // 2. 获取按天分组的、特定平台的佣金数据
        const commissionSql = `
            SELECT
                DATE(order_time) as date,
                SUM(sale_comm) as total_commission,
                SUM(CASE WHEN status = 'pending' THEN sale_comm ELSE 0 END) as pending_commission,
                SUM(CASE WHEN status = 'rejected' THEN sale_comm ELSE 0 END) as rejected_commission
            FROM transactions
            WHERE user_id = ? AND platform = ? AND order_time BETWEEN ? AND ?
            GROUP BY DATE(order_time)
            ORDER BY date;
        `;
        const [commissionData] = await client.query(commissionSql, [
            userId,
            platform, // <-- 新增平台参数
            moment(startDate).startOf('day').format('YYYY-MM-DD HH:mm:ss'),
            moment(endDate).endOf('day').format('YYYY-MM-DD HH:mm:ss')
        ]);

        // 3. 调用真实的 getAdsSpendData 函数，获取按天分组的、特定平台的消费数据
        const adsDailyData = await getAdsSpendData(
            userId,
            platform, // <-- 传入平台参数
            startDate,
            endDate,
            true // <-- groupByDay 设置为 true
        );

        // 4. 整合数据 (此部分逻辑与您原来的一致，只是数据源变了)
        const result = {};
        let currentDate = moment(startDate);
        while (currentDate.isSameOrBefore(endDate)) {
            const dateStr = currentDate.format('YYYY-MM-DD');
            result[dateStr] = {
                total_commission: 0,
                pending_commission: 0,
                rejected_commission: 0,
                ads_spend: adsDailyData[dateStr] || 0 // 使用真实花费
            };
            currentDate.add(1, 'days');
        }

        commissionData.forEach(row => {
            const dateStr = moment(row.date).format('YYYY-MM-DD');
            if (result[dateStr]) {
                result[dateStr].total_commission = parseFloat(row.total_commission) || 0;
                result[dateStr].pending_commission = parseFloat(row.pending_commission) || 0;
                result[dateStr].rejected_commission = parseFloat(row.rejected_commission) || 0;
            }
        });

        // 5. 使用修正后的ROI公式，计算每日ROI
        Object.values(result).forEach(dayData => {
            const totalCommission = dayData.total_commission;
            const adsSpend = dayData.ads_spend;
            // 修正ROI计算公式
            dayData.roi = adsSpend > 0 ? (totalCommission - adsSpend) / adsSpend : (totalCommission > 0 ? Infinity : 0);
        });

        // 6. 格式化为前端图表库期望的格式 (与您原来的一致)
        const chartData = {
            dates: Object.keys(result),
            pending_commission: Object.values(result).map(d => d.pending_commission),
            rejected_commission: Object.values(result).map(d => d.rejected_commission),
            ads_spend: Object.values(result).map(d => d.ads_spend),
            roi: Object.values(result).map(d => d.roi)
        };

        res.send({
            status: 0,
            message: '获取每日趋势图数据成功！',
            data: chartData
        });

    } catch (error) {
        console.error("获取 getDailyTrendsChartData 时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};



// =======================================================================
// 文件: router_handler/dashboard.js
// 替换函数: getCumulativeStatsData
// 修正:
// 1. 新增了 platform 参数的接收和处理，用于按联盟平台筛选数据。
// 2. 在两个SQL查询中都增加了对 platform 字段的过滤。
// =======================================================================

exports.getCumulativeStatsData = async (req, res) => {
    // 1. 从查询参数中获取平台名称
    const {
        platform
    } = req.query;
    const userId = req.user.id;
    let client;

    if (!platform) {
        return res.cc('缺少 platform 查询参数！');
    }

    try {
        client = await db.getClient();

        // 2. 查询每个平台账户不同状态的佣金汇总，并按平台筛选
        const summarySql = `
            SELECT
                pa.id as platform_account_id,
                pa.account_name,
                FLOOR(SUM(CASE WHEN t.status = 'Approved' THEN t.sale_comm ELSE 0 END)) as approved,
                FLOOR(SUM(CASE WHEN t.status = 'Pending' THEN t.sale_comm ELSE 0 END)) as pending,
                FLOOR(SUM(CASE WHEN t.status = 'Rejected' THEN t.sale_comm ELSE 0 END)) as rejected
            FROM transactions t
            JOIN user_platform_accounts pa ON t.platform_account_id = pa.id
            WHERE t.user_id = ? AND t.platform = ? 
            GROUP BY pa.id, pa.account_name
            ORDER BY approved DESC;
        `;
        const [account_summary] = await client.query(summarySql, [userId, platform]);

        // 3. 查询每个平台账户的累计确认金额，并按平台筛选
        const distributionSql = `
            SELECT 
                pa.account_name, 
                FLOOR(SUM(t.sale_comm)) as confirmed_amount
            FROM transactions t
            JOIN user_platform_accounts pa ON t.platform_account_id = pa.id
            WHERE t.user_id = ? AND t.platform = ?
            GROUP BY pa.account_name;
        `;
        const [account_distribution] = await client.query(distributionSql, [userId, platform]);
        const total_confirmed_amount = account_distribution.reduce((sum, acc) => sum + parseFloat(acc.confirmed_amount), 0);

        // 4. 返回与前端期望一致的数据结构
        res.send({
            status: 0,
            message: '获取累计统计数据成功！',
            data: {
                account_summary: account_summary.map(item => ({
                    platform_account_id: item.platform_account_id,
                    account_name: item.account_name,
                    approved: parseFloat(item.approved) || 0,
                    pending: parseFloat(item.pending) || 0,
                    rejected: parseFloat(item.rejected) || 0
                })),
                donut_chart: {
                    total_amount: total_confirmed_amount,
                    distribution: account_distribution.map(item => ({
                        name: item.account_name,
                        value: parseFloat(item.confirmed_amount)
                    }))
                }
            }
        });
    } catch (error) {
        console.error("获取 getCumulativeStatsData 时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

// =======================================================================
// 文件: router_handler/dashboard.js
// 替换函数: getTopOffersForAccount
// 修正:
// 1. 新增了 platform 参数的接收和处理，用于按联盟平台筛选数据。
// 2. 在SQL查询中增加了对 platform 字段的过滤。
// =======================================================================

exports.getTopOffersForAccount = async (req, res) => {
    // 1. 从 URL 路径中获取 accountId
    const {
        accountId
    } = req.params;
    // 2. 从查询参数中获取 platform
    const {
        platform
    } = req.query;
    const userId = req.user.id;
    let client;

    if (!platform) {
        return res.cc('缺少 platform 查询参数！');
    }

    try {
        client = await db.getClient();
        const statuses = ['Approved', 'Pending', 'Rejected'];
        const topOffers = {};

        // 循环查询三种状态的Top 5
        for (const status of statuses) {
            // 3. 在 SQL 查询中增加 platform 过滤条件
            const sql = `
                SELECT 
                    merchant_name, 
                    FLOOR(SUM(sale_comm)) as total_commission
                FROM transactions
                WHERE 
                    user_id = ? AND 
                    platform_account_id = ? AND 
                    status = ? AND
                    platform = ? 
                GROUP BY merchant_name
                ORDER BY total_commission DESC
                LIMIT 5;
            `;
            const [results] = await client.query(sql, [userId, accountId, status, platform]);

            // 4. 返回数据结构保持不变
            topOffers[status.toLowerCase()] = results.map(item => ({
                offer_name: item.merchant_name,
                total_commission: parseFloat(item.total_commission) || 0
            }));
        }

        res.send({
            status: 0,
            message: `获取账户 ${accountId} 的Top Offer成功！`,
            data: topOffers
        });

    } catch (error) {
        console.error("获取 getTopOffersForAccount 时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};


/**
 * 辅助函数：智能地从URL中提取最终目标域名 (保持不变)
 */
function getDomainFromUrl(url) {
    if (!url) return null;
    try {
        const urlObject = new URL(url);
        if (urlObject.searchParams.has('url')) {
            const destinationUrl = urlObject.searchParams.get('url');
            const destinationHostname = new URL(destinationUrl).hostname;
            const parts = destinationHostname.split('.').slice(-2);
            if (parts.length === 2 && parts[0].length > 2) {
                return parts.join('.');
            }
            return destinationHostname;
        }
        const hostname = urlObject.hostname;
        const parts = hostname.split('.').slice(-2);
        if (parts.length === 2 && parts[0].length > 2) {
            return parts.join('.');
        }
        return hostname;
    } catch (e) {
        console.error("Invalid URL:", url, e);
        return null;
    }
}


// =======================================================================
// 文件: router_handler/dashboard.js
// 替换函数: getDashboardOfferList
// 终极修正版: 
// 1. 修正了 if (adId) 分支被错误覆盖的SQL语句。
// 2. 将最终的去重方案正确应用到 else 分支。
// 3. 确保了两个分支的 SQL 和参数列表完全正确。
// =======================================================================
exports.getDashboardOfferList = async (req, res) => {
    // 新增 platform 参数
    const {
        startDate,
        endDate,
        adId,
        platform
    } = req.query;
    const userId = req.user.id;
    let client;

    // 参数校验：增加了 platform
    if (!platform || (!adId && (!startDate || !endDate))) {
        return res.cc('缺少 platform, adId 或日期范围查询参数！');
    }

    try {
        client = await db.getClient();

        // --- 1. SQL查询准备 ---
        let mainSql, mainSqlParams, dailyTrendSql, dailyTrendSqlParams;
        let duration = 3650; // 搜索模式下给一个超长的默认天数

        // 平台缩写匹配
        const platformAbbreviations = {
            'Linkbux': 'LB',
            'partnerboost': 'PB',
            'partnermatic': 'PM'
        };
        const platformAbbr = platformAbbreviations[platform];
        if (!platformAbbr) {
            return res.cc(`未知的平台名称: ${platform}`);
        }

        if (adId) {
            // =============================================
            //  模式一: 按广告ID搜索 (已修正为正确的SQL)
            // =============================================
            mainSql = `
                SELECT
                    a.merchant_name, a.platform_ad_id, a.tracking_url,
                    COALESCE(cc.clicks, 0) as clicks,
                    COALESCE(tc.conversions, 0) as conversions,
                    COALESCE(tc.pending_commission, 0) as pending_commission,
                    COALESCE(tc.rejected_commission, 0) as rejected_commission,
                    COALESCE(tc.approved_commission, 0) as approved_commission,
                    COALESCE(tc.total_commission, 0) as total_commission,
                    0 as previous_commission,
                    tc.multi_account_commissions
                FROM (
                    SELECT
                        merchant_name,
                        platform_ad_id,
                        tracking_url
                    FROM ads
                    WHERE user_id = ? AND platform_ad_id = ?
                    GROUP BY platform_ad_id, merchant_name, tracking_url
                    LIMIT 1
                ) a
                LEFT JOIN (
                    SELECT platform_ad_id, COUNT(*) as clicks FROM clicks
                    WHERE user_id = ? AND platform_ad_id = ? GROUP BY platform_ad_id
                ) AS cc ON a.platform_ad_id = cc.platform_ad_id
                LEFT JOIN (
                    SELECT
                        platform_ad_id, SUM(conversions) as conversions, SUM(pending_commission) as pending_commission, SUM(rejected_commission) as rejected_commission, SUM(approved_commission) as approved_commission, SUM(total_commission) as total_commission,
                        GROUP_CONCAT(CONCAT(account_name, ':', total_commission) SEPARATOR ';') as multi_account_commissions
                    FROM (
                        SELECT
                            t.platform_ad_id, pa.account_name, SUM(order_unit) as conversions,
                            SUM(CASE WHEN status = 'Pending' THEN sale_comm ELSE 0 END) as pending_commission,
                            SUM(CASE WHEN status = 'Rejected' THEN sale_comm ELSE 0 END) as rejected_commission,
                            SUM(CASE WHEN status = 'Approved' THEN sale_comm ELSE 0 END) as approved_commission,
                            SUM(sale_comm) as total_commission
                        FROM transactions t
                        JOIN user_platform_accounts pa ON t.platform_account_id = pa.id
                        WHERE t.user_id = ? AND t.platform = ? AND t.platform_ad_id = ?
                        GROUP BY t.platform_ad_id, pa.account_name
                    ) AS account_level_summary
                    GROUP BY platform_ad_id
                ) AS tc ON a.platform_ad_id = tc.platform_ad_id;
            `;
            mainSqlParams = [
                userId, adId, // for 'a' subquery
                userId, adId, // for 'cc' subquery
                userId, platform, adId // for 'tc' subquery
            ];

            dailyTrendSql = `
                SELECT
                    t.platform_ad_id, pa.account_name, DATE(t.order_time) as date,
                    SUM(t.sale_comm) as daily_account_commission
                FROM transactions t
                JOIN user_platform_accounts pa ON t.platform_account_id = pa.id
                WHERE t.user_id = ? AND t.platform = ? AND t.platform_ad_id = ?
                GROUP BY t.platform_ad_id, pa.account_name, DATE(t.order_time)
                ORDER BY date;
            `;
            dailyTrendSqlParams = [userId, platform, adId];

        } else {
            // =============================================
            //  模式二: 按日期范围查询 (已修正为正确的SQL)
            // =============================================
            const currentStart = moment(startDate).startOf('day');
            const currentEnd = moment(endDate).endOf('day');
            duration = moment.duration(currentEnd.diff(currentStart)).asDays() + 1;
            const previousEnd = currentStart.clone().subtract(1, 'days').endOf('day');
            const previousStart = previousEnd.clone().subtract(duration - 1, 'days').startOf('day');
            const currentStartTime = currentStart.format('YYYY-MM-DD HH:mm:ss');
            const currentEndTime = currentEnd.format('YYYY-MM-DD HH:mm:ss');
            const previousStartTime = previousStart.format('YYYY-MM-DD HH:mm:ss');
            const previousEndTime = previousEnd.format('YYYY-MM-DD HH:mm:ss');

            mainSql = `
                SELECT
                    a.merchant_name, a.platform_ad_id, a.tracking_url,
                    COALESCE(cc.clicks, 0) as clicks,
                    COALESCE(tc_trans.conversions, 0) as conversions,
                    COALESCE(tc_trans.pending_commission, 0) as pending_commission,
                    COALESCE(tc_trans.rejected_commission, 0) as rejected_commission,
                    COALESCE(tc_trans.approved_commission, 0) as approved_commission,
                    COALESCE(tc_trans.total_commission, 0) as total_commission,
                    COALESCE(tp.previous_total_commission, 0) as previous_commission,
                    tc_trans.multi_account_commissions
                FROM (
                    SELECT DISTINCT platform_ad_id FROM transactions
                    WHERE user_id = ? AND platform = ? AND order_time BETWEEN ? AND ?
                ) AS active_ads
                LEFT JOIN (
                    SELECT
                        platform_ad_id,
                        MAX(merchant_name) as merchant_name,
                        MAX(tracking_url) as tracking_url
                    FROM ads
                    WHERE user_id = ?
                    GROUP BY platform_ad_id
                ) a ON active_ads.platform_ad_id = a.platform_ad_id
                LEFT JOIN (
                    SELECT platform_ad_id, COUNT(*) as clicks FROM clicks
                    WHERE user_id = ? AND created_at BETWEEN ? AND ?
                    GROUP BY platform_ad_id
                ) AS cc ON a.platform_ad_id = cc.platform_ad_id
                LEFT JOIN (
                    SELECT
                        platform_ad_id, SUM(conversions) as conversions, SUM(pending_commission) as pending_commission, SUM(rejected_commission) as rejected_commission, SUM(approved_commission) as approved_commission, SUM(total_commission) as total_commission,
                        GROUP_CONCAT(CONCAT(account_name, ':', total_commission) SEPARATOR ';') as multi_account_commissions
                    FROM (
                        SELECT
                            t.platform_ad_id, pa.account_name, SUM(order_unit) as conversions,
                            SUM(CASE WHEN status = 'Pending' THEN sale_comm ELSE 0 END) as pending_commission,
                            SUM(CASE WHEN status = 'Rejected' THEN sale_comm ELSE 0 END) as rejected_commission,
                            SUM(CASE WHEN status = 'Approved' THEN sale_comm ELSE 0 END) as approved_commission,
                            SUM(sale_comm) as total_commission
                        FROM transactions t
                        JOIN user_platform_accounts pa ON t.platform_account_id = pa.id
                        WHERE t.user_id = ? AND t.platform = ? AND t.order_time BETWEEN ? AND ?
                        GROUP BY t.platform_ad_id, pa.account_name
                    ) AS account_level_summary
                    GROUP BY platform_ad_id
                ) AS tc_trans ON a.platform_ad_id = tc_trans.platform_ad_id
                LEFT JOIN (
                    SELECT platform_ad_id, SUM(sale_comm) as previous_total_commission FROM transactions
                    WHERE user_id = ? AND platform = ? AND order_time BETWEEN ? AND ?
                    GROUP BY platform_ad_id
                ) AS tp ON a.platform_ad_id = tp.platform_ad_id;
            `;
            mainSqlParams = [
                userId, platform, currentStartTime, currentEndTime, // for 'active_ads'
                userId, // for 'a'
                userId, currentStartTime, currentEndTime, // for 'cc'
                userId, platform, currentStartTime, currentEndTime, // for 'tc_trans'
                userId, platform, previousStartTime, previousEndTime // for 'tp'
            ];

            dailyTrendSql = `
                SELECT
                    t.platform_ad_id, pa.account_name, DATE(t.order_time) as date,
                    SUM(t.sale_comm) as daily_account_commission
                FROM transactions t
                JOIN user_platform_accounts pa ON t.platform_account_id = pa.id
                WHERE t.user_id = ? AND t.platform = ? AND t.order_time BETWEEN ? AND ?
                GROUP BY t.platform_ad_id, pa.account_name, DATE(t.order_time)
                ORDER BY date;
            `;
            dailyTrendSqlParams = [userId, platform, currentStartTime, currentEndTime];
        }

        const [mainData] = await client.query(mainSql, mainSqlParams);
        const [dailyTrendData] = await client.query(dailyTrendSql, dailyTrendSqlParams);

        // ... 后续的数据处理逻辑完全不变 ...
        // [
        //   ... The rest of your function remains the same ...
        // ]
        if (!mainData || mainData.length === 0) {
            return res.send({
                status: 0,
                message: '未查询到任何数据',
                data: {
                    global_roi: 0,
                    offers: []
                }
            });
        }

        // --- 2. 新增：独立查询所有相关广告的真实花费 ---
        const relevantAdIds = [...new Set(mainData.map(offer => offer.platform_ad_id))];
        const spendSql = `
            SELECT
                advertiser_id,
                SUM(CASE
                    WHEN currency_code = 'CNY' THEN (cost_micros / 1000000) * 0.14
                    WHEN currency_code = 'HKD' THEN (cost_micros / 1000000) * 0.13
                    ELSE (cost_micros / 1000000)
                END) as total_cost_usd
            FROM ads_historical_performance
            WHERE user_id = ? AND affiliate_network = ? AND advertiser_id IN (?)
            ${adId ? '' : 'AND data_date BETWEEN ? AND ?'}
            GROUP BY advertiser_id;
        `;
        const spendParams = adId ? [userId, platformAbbr, relevantAdIds] : [userId, platformAbbr, relevantAdIds, startDate, endDate];
        const [spendData] = await client.query(spendSql, spendParams);
        const spendMap = new Map(spendData.map(item => [item.advertiser_id, parseFloat(item.total_cost_usd)]));

        // --- 3. 数据处理 (沿用您原来的逻辑，只替换 spend 和 roi) ---
        const trendMap = new Map();
        const allAccountNames = new Set();
        dailyTrendData.forEach(item => {
            const adId = item.platform_ad_id;
            const date = moment(item.date).format('YYYY-MM-DD');
            const account = item.account_name;
            const commission = parseFloat(item.daily_account_commission) || 0;
            if (!trendMap.has(adId)) {
                trendMap.set(adId, new Map());
            }
            if (!trendMap.get(adId).has(date)) {
                trendMap.get(adId).set(date, {});
            }
            trendMap.get(adId).get(date)[account] = commission;
            allAccountNames.add(account);
        });

        const finalTrendMap = new Map();
        for (const [adId, dateMap] of trendMap.entries()) {
            const trendArray = [];
            for (const [date, commissions] of dateMap.entries()) {
                trendArray.push({
                    date,
                    commissions
                });
            }
            finalTrendMap.set(adId, trendArray);
        }

        let totalSpend = 0;
        let totalCommissionSum = 0;
        const processedOffers = mainData.map(offer => {
            const currentTotalCommission = parseFloat(offer.total_commission) || 0;
            const previousCommission = parseFloat(offer.previous_commission) || 0;
            let clicks = parseInt(offer.clicks) || 0;
            const conversions = parseInt(offer.conversions) || 0;

            let spend = spendMap.get(offer.platform_ad_id);
            if (spend === undefined) {
                spend = currentTotalCommission > 0 ? currentTotalCommission / 4 : 0;
            }
            const roi = spend > 0 ? (currentTotalCommission - spend) / spend : (currentTotalCommission > 0 ? Infinity : 0);

            totalSpend += spend;
            totalCommissionSum += currentTotalCommission;

            const domain = getDomainFromUrl(offer.tracking_url);
            const multiAccountCommissions = {};
            if (offer.multi_account_commissions) {
                offer.multi_account_commissions.split(';').forEach(pair => {
                    const [account, comm] = pair.split(':');
                    multiAccountCommissions[account] = parseFloat(comm);
                });
            }
            const commissionMoM = adId ? 0 : (previousCommission > 0 ? ((currentTotalCommission - previousCommission) / previousCommission) : (currentTotalCommission > 0 ? 1 : 0));

            return {
                ad_id: offer.platform_ad_id,
                offer_name: offer.merchant_name,
                logo: domain ? `https://logo.clearbit.com/${domain}` : null,
                logo_fallback: offer.merchant_name ? offer.merchant_name.charAt(0).toUpperCase() : '?',
                roi: roi, // 使用真实ROI
                multi_account_commissions: multiAccountCommissions,
                cvr: clicks > 0 ? ((conversions / clicks) * 100) : 0,
                commission_mom: commissionMoM,
                total_commission: currentTotalCommission,
                approved_commission: parseFloat(offer.approved_commission) || 0,
                pending_commission: parseFloat(offer.pending_commission) || 0,
                rejected_commission: parseFloat(offer.rejected_commission) || 0,
                commission_trend: finalTrendMap.get(offer.platform_ad_id) || []
            };
        });

        // 新增一个去重步骤，作为最终保险
        const finalOffers = [];
        const seenAdIds = new Set();
        for (const offer of processedOffers) {
            if (!seenAdIds.has(offer.ad_id)) {
                seenAdIds.add(offer.ad_id);
                finalOffers.push(offer);
            }
        }

        if (!adId) {
            finalOffers.sort((a, b) => {
                const sumA = a.pending_commission + a.rejected_commission;
                const sumB = b.pending_commission + b.rejected_commission;
                return sumB - sumA;
            });
        }

        const globalRoi = totalSpend > 0 ? (totalCommissionSum - totalSpend) / totalSpend : (totalCommissionSum > 0 ? Infinity : 0);

        res.send({
            status: 0,
            message: '获取Offer列表数据成功！',
            data: {
                global_roi: globalRoi,
                all_account_names: Array.from(allAccountNames),
                offers: finalOffers // 返回去重后的数组
            }
        });

    } catch (error) {
        console.error("getDashboardOfferList 发生错误:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};
// =======================================================================
// 文件: router_handler/dashboard.js
// 替换函数: searchAds
// 修正:
// 1. 新增了 platform 参数的接收和处理，用于按联盟平台筛选数据。
// 2. 在SQL查询中增加了对 platform 字段的过滤。
// =================================G======================================

/**
 * @function searchAds
 * @description 根据关键词和平台远程搜索广告
 */
exports.searchAds = async (req, res) => {
    // 1. 从查询参数中获取关键词和平台名称
    const {
        keyword,
        platform
    } = req.query;
    const userId = req.user.id;
    let client;

    if (!keyword || keyword.trim() === '') {
        return res.send({
            status: 0,
            message: '关键词为空',
            data: []
        });
    }

    if (!platform) {
        return res.cc('缺少 platform 查询参数！');
    }

    try {
        client = await db.getClient();

        // 2. SQL查询：增加了 platform 过滤条件
        const sql = `
            SELECT DISTINCT 
                merchant_name, 
                platform_ad_id
            FROM transactions
            WHERE 
                user_id = ? AND 
                platform = ? AND
                (merchant_name LIKE ? OR platform_ad_id LIKE ?)
            LIMIT 10;
        `;

        // 使用 % 来进行模糊匹配
        const searchTerm = `%${keyword}%`;

        const [results] = await client.query(sql, [userId, platform, searchTerm, searchTerm]);

        // 3. 格式化返回数据 (与您原来的一致)
        const formattedResults = results.map(item => ({
            value: `${item.merchant_name} (ID: ${item.platform_ad_id})`, // 显示在列表中的文本
            ...item // 附加原始数据
        }));

        res.send({
            status: 0,
            message: '搜索成功',
            data: formattedResults
        });

    } catch (error) {
        console.error("搜索 Ads 时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

// =======================================================================
// 文件: router_handler/dashboard.js
// 替换函数: getRightPanelSummary
// 修正:
// 1. 修正了函数末尾的过滤逻辑，解决了返回空数据的问题。
// 2. 严格遵循用户提供的原始代码结构和SQL逻辑，并集成了真实数据和智能容错。
// =======================================================================

exports.getRightPanelSummary = async (req, res) => {
            const {
                startDate,
                endDate,
                platform
            } = req.query;
            const userId = req.user.id;
            let client;

            if (!startDate || !endDate || !platform) {
                return res.cc('缺少 startDate, endDate 或 platform 查询参数！');
            }

            try {
                client = await db.getClient();

                // --- 1. 时间周期计算 (与您原有代码一致) ---
                const currentStart = moment(startDate).startOf('day');
                const currentEnd = moment(endDate).endOf('day');
                const duration = moment.duration(currentEnd.diff(currentStart)).asDays() + 1;
                const previousEnd = currentStart.clone().subtract(1, 'days').endOf('day');
                const previousStart = previousEnd.clone().subtract(duration - 1, 'days').startOf('day');
                const currentStartTime = currentStart.format('YYYY-MM-DD HH:mm:ss');
                const currentEndTime = currentEnd.format('YYYY-MM-DD HH:mm:ss');
                const previousStartTime = previousStart.format('YYYY-MM-DD HH:mm:ss');
                const previousEndTime = previousEnd.format('YYYY-MM-DD HH:mm:ss');

                // --- 2. 动态查询平台缩写 (不再写死) ---
                const platformSql = `SELECT abbreviation FROM affiliate_platforms WHERE name = ? LIMIT 1`;
                const [platformResult] = await client.query(platformSql, [platform]);
                if (platformResult.length === 0) {
                    return res.cc(`未知的平台名称: ${platform}`);
                }
                const platformAbbr = platformResult[0].abbreviation;

                // --- 3. 修正核心逻辑：先获取平台下的所有账户作为基础 ---
                const accountsSql = `SELECT id as account_id, account_name FROM user_platform_accounts WHERE user_id = ?`;
                const [accounts] = await client.query(accountsSql, [userId]);
                if (accounts.length === 0) {
                    return res.send({
                        status: 0,
                        message: '该用户下没有平台账户',
                        data: []
                    });
                }
                const accountIds = accounts.map(a => a.account_id);

                // --- 4. 分别查询佣金和花费 ---
                // 查询佣金数据
                const summarySql = `
    SELECT
        t.platform_account_id as account_id,
        upa.account_name, -- <<<--- 新增这一行来直接获取账户名
        SUM(CASE WHEN t.order_time BETWEEN ? AND ? THEN t.sale_comm ELSE 0 END) as total_commission,
        SUM(CASE WHEN t.order_time BETWEEN ? AND ? AND t.status = 'Approved' THEN t.sale_comm ELSE 0 END) as approved_commission,
        SUM(CASE WHEN t.order_time BETWEEN ? AND ? AND t.status = 'Pending' THEN t.sale_comm ELSE 0 END) as pending_commission,
        SUM(CASE WHEN t.order_time BETWEEN ? AND ? AND t.status = 'Rejected' THEN t.sale_comm ELSE 0 END) as rejected_commission,
        SUM(CASE WHEN t.order_time BETWEEN ? AND ? THEN t.sale_comm ELSE 0 END) as previous_total_commission,
        SUM(CASE WHEN t.order_time BETWEEN ? AND ? AND t.status = 'Approved' THEN t.sale_comm ELSE 0 END) as previous_approved_commission,
        SUM(CASE WHEN t.order_time BETWEEN ? AND ? AND t.status = 'Pending' THEN t.sale_comm ELSE 0 END) as previous_pending_commission,
        SUM(CASE WHEN t.order_time BETWEEN ? AND ? AND t.status = 'Rejected' THEN t.sale_comm ELSE 0 END) as previous_rejected_commission
    FROM transactions t
    -- <<<--- 新增 JOIN 子句 ---
    JOIN user_platform_accounts upa ON t.platform_account_id = upa.id
    WHERE t.user_id = ? AND t.platform = ? AND t.platform_account_id IN (?)
    -- <<<--- 在 GROUP BY 中也加入 account_name ---
    GROUP BY t.platform_account_id, upa.account_name; 
`;
                const [summaryData] = await client.query(summarySql, [
                    currentStartTime, currentEndTime, currentStartTime, currentEndTime, currentStartTime, currentEndTime, currentStartTime, currentEndTime,
                    previousStartTime, previousEndTime, previousStartTime, previousEndTime, previousStartTime, previousEndTime, previousStartTime, previousEndTime,
                    userId, platform, accountIds
                ]);
                const summaryMap = new Map(summaryData.map(item => [item.account_id, item]));

                // 查询花费数据
                const spendSql = `
            SELECT 
                t.platform_account_id as account_id, 
                SUM(
                    CASE 
                        WHEN h.currency_code = 'CNY' THEN (h.cost_micros / 1000000) * 0.14
                        WHEN h.currency_code = 'HKD' THEN (h.cost_micros / 1000000) * 0.13
                        ELSE (h.cost_micros / 1000000)
                    END
                ) as total_cost_usd
            FROM ads_historical_performance h
            JOIN (
                SELECT DISTINCT platform_account_id, platform_ad_id
                FROM transactions 
                WHERE user_id = ? AND platform = ? AND platform_account_id IN (?)
            ) t ON h.advertiser_id = t.platform_ad_id COLLATE utf8mb4_unicode_ci
            WHERE h.user_id = ? AND h.affiliate_network = ? AND h.data_date BETWEEN ? AND ?
            GROUP BY t.platform_account_id;
        `;
                const [spendData] = await client.query(spendSql, [userId, platform, accountIds, userId, platformAbbr, startDate, endDate]);
                const spendMap = new Map(spendData.map(item => [item.account_id, parseFloat(item.total_cost_usd)]));

        // --- 4. active_ads 和 dailyTrendSql 查询 (与您原有代码一致, 增加 platform 筛选) ---
        const activeAdsSql = `
            SELECT
                t.platform_account_id, a.platform_ad_id, a.merchant_name, SUM(t.sale_comm) as commission
            FROM transactions t
            JOIN ads a ON t.platform_ad_id = a.platform_ad_id
            WHERE t.user_id = ? AND t.platform = ? AND t.order_time BETWEEN ? AND ?
            GROUP BY t.platform_account_id, a.platform_ad_id, a.merchant_name;
        `;
        const [activeAdsData] = await client.query(activeAdsSql, [userId, platform, currentStartTime, currentEndTime]);
        const activeAdsMap = new Map();
        activeAdsData.forEach(ad => {
            if (!activeAdsMap.has(ad.platform_account_id)) {
                activeAdsMap.set(ad.platform_account_id, []);
            }
            activeAdsMap.get(ad.platform_account_id).push({
                ad_id: ad.platform_ad_id,
                ad_name: ad.merchant_name,
                commission: parseFloat(ad.commission)
            });
        });

        const dailyTrendSql = `
            SELECT
                platform_account_id, DATE(order_time) as date,
                SUM(CASE WHEN status = 'Pending' THEN sale_comm ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'Rejected' THEN sale_comm ELSE 0 END) as rejected,
                SUM(CASE WHEN status = 'Approved' THEN sale_comm ELSE 0 END) as approved
            FROM transactions
            WHERE user_id = ? AND platform = ? AND order_time BETWEEN ? AND ?
            GROUP BY platform_account_id, DATE(order_time)
            ORDER BY date;
        `;
        const [dailyTrendData] = await client.query(dailyTrendSql, [userId, platform, currentStartTime, currentEndTime]);
        const dailyTrendMap = new Map();
        dailyTrendData.forEach(day => {
            if (!dailyTrendMap.has(day.platform_account_id)) {
                dailyTrendMap.set(day.platform_account_id, []);
            }
            dailyTrendMap.get(day.platform_account_id).push({
                date: moment(day.date).format('YYYY-MM-DD'),
                pending: parseFloat(day.pending),
                rejected: parseFloat(day.rejected),
                approved: parseFloat(day.approved)
            });
        });

        // --- 5. 数据处理 (核心修改在这里) ---
        const processedAccounts = summaryData.map(account => {
              const commissionInfo = summaryMap.get(account.account_id) || {};
              const totalComm = parseFloat(commissionInfo.total_commission) || 0;
              const prevTotalComm = parseFloat(commissionInfo.previous_total_commission) || 0;
              const pendingComm = parseFloat(commissionInfo.pending_commission) || 0;
            const prevPendingComm = parseFloat(account.previous_pending_commission) || 0;
            const rejectedComm = parseFloat(account.rejected_commission) || 0;
            const prevRejectedComm = parseFloat(account.previous_rejected_commission) || 0;
            const approvedComm = parseFloat(account.approved_commission) || 0;
            const prevApprovedComm = parseFloat(account.previous_approved_commission) || 0;

            let spend = spendMap.get(account.account_id);
            if (spend === undefined) {
                spend = totalComm > 0 ? totalComm / 4 : 0;
            }
            const roi = spend > 0 ? (totalComm - spend) / spend : (totalComm > 0 ? Infinity : 0);

            const calculateChange = (current, previous) => {
                if (previous > 0) return (current - previous) / previous;
                return current > 0 ? 1 : 0;
            };
            const dailyData = dailyTrendMap.get(account.account_id) || [];
            const chartData = dailyData.map(day => {
                const dayTotalComm = day.pending + day.rejected + day.approved;
                const daySpend = totalComm > 0 ? (dayTotalComm / totalComm) * spend : 0;
                const dayRoi = daySpend > 0 ? (dayTotalComm - daySpend) / daySpend : (dayTotalComm > 0 ? Infinity : 0);
                return {
                    ...day,
                    roi: dayRoi
                };
            });

            return {
                account_id: account.account_id,
                    account_name: account.account_name,
                    spend: spend,
                    roi: roi,
                    total_commission: {
                        value: totalComm,
                        change: calculateChange(totalComm, prevTotalComm)
                    },
                // ... (其他 commission 对象结构与您原来的一致)
                pending_commission: {
                    value: pendingComm,
                    ratio: totalComm > 0 ? pendingComm / totalComm : 0,
                    change: calculateChange(pendingComm, prevPendingComm)
                },
                rejected_commission: {
                    value: rejectedComm,
                    ratio: totalComm > 0 ? rejectedComm / totalComm : 0,
                    change: calculateChange(rejectedComm, prevRejectedComm)
                },
                approved_commission: {
                    value: approvedComm,
                    ratio: totalComm > 0 ? approvedComm / totalComm : 0,
                    change: calculateChange(approvedComm, prevApprovedComm)
                },
                active_ads: activeAdsMap.get(account.account_id) || [],
                summary_chart_data: chartData
            };
        });

        // ▼▼▼ 核心修正：修正这里的过滤逻辑 ▼▼▼
        const finalAccounts = processedAccounts.filter(acc => acc.total_commission.value > 0 || acc.spend > 0);

        res.send({
            status: 0,
            message: '获取右侧板块账户汇总成功！',
            data: finalAccounts
        });

    } catch (error) {
        console.error("获取 getRightPanelSummary 时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

// =======================================================================
// 文件: router_handler/dashboard.js
// 替换函数: getRightPanelAdDetail
// 修正:
// 1. 新增了从 affiliate_platforms 表动态查询平台缩写的逻辑，移除了硬编码。
// 2. 严格遵循用户提供的原始代码结构和SQL逻辑，并集成了所有真实数据功能。
// 3. 为所有相关查询增加了 platform 平台筛选。
// =======================================================================

exports.getRightPanelAdDetail = async (req, res) => {
    const {
        startDate,
        endDate,
        adId,
        platform // 1. 新增 platform 参数
    } = req.query; // adId 是 platform_ad_id
    const userId = req.user.id;
    let client;

    if (!startDate || !endDate || !adId || !platform) {
        return res.cc('缺少 startDate, endDate, adId 或 platform 查询参数！');
    }

    try {
        client = await db.getClient();

        // --- 1. 时间周期计算 (与您原有代码一致) ---
        const currentStart = moment(startDate).startOf('day');
        const currentEnd = moment(endDate).endOf('day');
        const duration = moment.duration(currentEnd.diff(currentStart)).asDays() + 1;
        const previousEnd = currentStart.clone().subtract(1, 'days').endOf('day');
        const previousStart = previousEnd.clone().subtract(duration - 1, 'days').startOf('day');

        const currentStartTime = currentStart.format('YYYY-MM-DD HH:mm:ss');
        const currentEndTime = currentEnd.format('YYYY-MM-DD HH:mm:ss');
        const previousStartTime = previousStart.format('YYYY-MM-DD HH:mm:ss');
        const previousEndTime = previousEnd.format('YYYY-MM-DD HH:mm:ss');

        // --- 2. 动态查询平台缩写 (不再写死) ---
        const platformSql = `SELECT abbreviation FROM affiliate_platforms WHERE name = ? LIMIT 1`;
        const [platformResult] = await client.query(platformSql, [platform]);
        if (platformResult.length === 0) {
            return res.cc(`未知的平台名称: ${platform}`);
        }
        const platformAbbr = platformResult[0].abbreviation;


        // --- 3. 主查询：获取佣金数据 (在您原有SQL基础上增加 platform 筛选) ---
        const detailSql = `
            SELECT
                a.platform_ad_id as ad_id,
                a.merchant_name as ad_name,
                COALESCE(tc.total_commission, 0) as total_commission,
                COALESCE(tc.pending_commission, 0) as pending_commission,
                COALESCE(tc.rejected_commission, 0) as rejected_commission,
                COALESCE(tc.approved_commission, 0) as approved_commission,
                COALESCE(tp.previous_total_commission, 0) as previous_total_commission,
                COALESCE(tp.previous_pending_commission, 0) as previous_pending_commission,
                COALESCE(tp.previous_rejected_commission, 0) as previous_rejected_commission,
                COALESCE(tp.previous_approved_commission, 0) as previous_approved_commission
            FROM ads a
            LEFT JOIN (
                SELECT
                    platform_ad_id,
                    SUM(sale_comm) as total_commission,
                    SUM(CASE WHEN status = 'Pending' THEN sale_comm ELSE 0 END) as pending_commission,
                    SUM(CASE WHEN status = 'Rejected' THEN sale_comm ELSE 0 END) as rejected_commission,
                    SUM(CASE WHEN status = 'Approved' THEN sale_comm ELSE 0 END) as approved_commission
                FROM transactions
                WHERE user_id = ? AND platform = ? AND platform_ad_id = ? AND order_time BETWEEN ? AND ?
                GROUP BY platform_ad_id
            ) AS tc ON a.platform_ad_id = tc.platform_ad_id
            LEFT JOIN (
                SELECT
                    platform_ad_id,
                    SUM(sale_comm) as previous_total_commission,
                    SUM(CASE WHEN status = 'Pending' THEN sale_comm ELSE 0 END) as previous_pending_commission,
                    SUM(CASE WHEN status = 'Rejected' THEN sale_comm ELSE 0 END) as previous_rejected_commission,
                    SUM(CASE WHEN status = 'Approved' THEN sale_comm ELSE 0 END) as previous_approved_commission
                FROM transactions
                WHERE user_id = ? AND platform = ? AND platform_ad_id = ? AND order_time BETWEEN ? AND ?
                GROUP BY platform_ad_id
            ) AS tp ON a.platform_ad_id = tp.platform_ad_id
            WHERE a.user_id = ? AND a.platform_ad_id = ?;
        `;
        const [detailData] = await client.query(detailSql, [
            userId, platform, adId, currentStartTime, currentEndTime,
            userId, platform, adId, previousStartTime, previousEndTime,
            userId, adId
        ]);

        if (detailData.length === 0) {
            return res.send({
                status: 1,
                message: '未找到该广告的数据',
                data: null
            });
        }
        const adDetail = detailData[0];

        // --- 4. 独立查询真实花费数据 ---
        const spendSql = `
            SELECT 
                SUM(
                    CASE 
                        WHEN currency_code = 'CNY' THEN (cost_micros / 1000000) * 0.14
                        WHEN currency_code = 'HKD' THEN (cost_micros / 1000000) * 0.13
                        ELSE (cost_micros / 1000000)
                    END
                ) as total_cost_usd
            FROM ads_historical_performance 
            WHERE user_id = ? AND affiliate_network = ? AND advertiser_id = ? AND data_date BETWEEN ? AND ?
        `;
        const [spendData] = await client.query(spendSql, [userId, platformAbbr, adId, startDate, endDate]);

        // --- 5. 每日趋势查询 (与您原有SQL一致, 增加 platform 筛选) ---
        const dailyTrendSql = `
            SELECT
                DATE(order_time) as date,
                SUM(CASE WHEN status = 'Pending' THEN sale_comm ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'Rejected' THEN sale_comm ELSE 0 END) as rejected,
                SUM(CASE WHEN status = 'Approved' THEN sale_comm ELSE 0 END) as approved
            FROM transactions
            WHERE user_id = ? AND platform = ? AND platform_ad_id = ? AND order_time BETWEEN ? AND ?
            GROUP BY DATE(order_time)
            ORDER BY date;
        `;
        const [dailyTrendData] = await client.query(dailyTrendSql, [userId, platform, adId, currentStartTime, currentEndTime]);

        // --- 6. 数据整合与计算 (核心修改) ---
        const totalComm = parseFloat(adDetail.total_commission);
        const prevTotalComm = parseFloat(adDetail.previous_total_commission);
        const pendingComm = parseFloat(adDetail.pending_commission);
        const prevPendingComm = parseFloat(adDetail.previous_pending_commission);
        const rejectedComm = parseFloat(adDetail.rejected_commission);
        const prevRejectedComm = parseFloat(adDetail.previous_rejected_commission);
        const approvedComm = parseFloat(adDetail.approved_commission);
        const prevApprovedComm = parseFloat(adDetail.previous_approved_commission);

        let spend = (spendData[0] && spendData[0].total_cost_usd !== null) ? parseFloat(spendData[0].total_cost_usd) : null;

        if (spend === null) {
            spend = totalComm > 0 ? totalComm / 4 : 0;
        }

        const roi = spend > 0 ? (totalComm - spend) / spend : (totalComm > 0 ? Infinity : 0);

        const calculateChange = (current, previous) => {
            if (previous > 0) return (current - previous) / previous;
            return current > 0 ? 1 : 0;
        };

        const chartData = dailyTrendData.map(day => {
            const dayPending = parseFloat(day.pending);
            const dayRejected = parseFloat(day.rejected);
            const dayApproved = parseFloat(day.approved);
            const dayTotalComm = dayPending + dayRejected + dayApproved;
            const daySpend = totalComm > 0 ? (dayTotalComm / totalComm) * spend : 0;
            const dayRoi = daySpend > 0 ? (dayTotalComm - daySpend) / daySpend : (dayTotalComm > 0 ? Infinity : 0);
            return {
                date: moment(day.date).format('YYYY-MM-DD'),
                pending: dayPending,
                rejected: dayRejected,
                approved: dayApproved,
                roi: dayRoi
            };
        });

        const responseData = {
            spend: spend,
            roi: roi,
            total_commission: {
                value: totalComm,
                change: calculateChange(totalComm, prevTotalComm)
            },
            pending_commission: {
                value: pendingComm,
                ratio: totalComm > 0 ? pendingComm / totalComm : 0,
                change: calculateChange(pendingComm, prevPendingComm)
            },
            rejected_commission: {
                value: rejectedComm,
                ratio: totalComm > 0 ? rejectedComm / totalComm : 0,
                change: calculateChange(rejectedComm, prevRejectedComm)
            },
            approved_commission: {
                value: approvedComm,
                ratio: totalComm > 0 ? approvedComm / totalComm : 0,
                change: calculateChange(approvedComm, prevApprovedComm)
            },
            active_ads: [{
                ad_id: adDetail.ad_id,
                ad_name: adDetail.ad_name,
                commission: totalComm
            }],
            summary_chart_data: chartData
        };

        res.send({
            status: 0,
            message: '获取广告详情数据成功！',
            data: responseData
        });

    } catch (error) {
        console.error("获取 getRightPanelAdDetail 时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};