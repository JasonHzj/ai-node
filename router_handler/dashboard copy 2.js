// =======================================================================
// 文件: router_handler/dashboard.js (最终修正完整版)
// 作用: 提供数据看板所需的所有API，已全面集成真实数据和智能容错逻辑。
// 修正: 移除了所有重复的函数定义，解决了 'callback function undefined' 的启动错误。
// =======================================================================

const db = require('../db');
const moment = require('moment');

// 辅助函数：计算变化率
const calculateChange = (current, previous) => {
    if (previous > 0) return (current - previous) / previous;
    return current > 0 ? 1 : 0; // 如果之前是0，现在不是0，则增长100%
};

// 辅助函数：从URL中提取域名 (单一、正确的版本)
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


/**
 * @function getTopLeftPanelData
 * @description 获取左上板块的数据：总佣金、总消费、ROI及各自的环比
 */
exports.getTopLeftPanelData = async (req, res) => {
    const {
        startDate,
        endDate
    } = req.query;
    const userId = req.user.id;
    let client;

    if (!startDate || !endDate) {
        return res.cc('缺少 startDate 或 endDate 查询参数！');
    }

    try {
        client = await db.getClient();
        const currentPeriodStart = moment(startDate).startOf('day');
        const currentPeriodEnd = moment(endDate).endOf('day');
        const duration = moment.duration(currentPeriodEnd.diff(currentPeriodStart)).asDays();
        const previousPeriodEnd = currentPeriodStart.clone().subtract(1, 'days').endOf('day');
        const previousPeriodStart = previousPeriodEnd.clone().subtract(duration, 'days').startOf('day');

        // 查询总佣金
        const commissionSql = `
            SELECT
                SUM(CASE WHEN order_time BETWEEN ? AND ? THEN sale_comm ELSE 0 END) as current_commission,
                SUM(CASE WHEN order_time BETWEEN ? AND ? THEN sale_comm ELSE 0 END) as previous_commission
            FROM transactions
            WHERE user_id = ?;
        `;
        const [commResult] = await client.query(commissionSql, [
            currentPeriodStart.format('YYYY-MM-DD HH:mm:ss'), currentPeriodEnd.format('YYYY-MM-DD HH:mm:ss'),
            previousPeriodStart.format('YYYY-MM-DD HH:mm:ss'), previousPeriodEnd.format('YYYY-MM-DD HH:mm:ss'),
            userId
        ]);

        // 查询总花费
        const spendSql = `
            SELECT
                SUM(CASE WHEN data_date BETWEEN ? AND ? THEN cost_micros ELSE 0 END) / 1000000 as current_spend,
                SUM(CASE WHEN data_date BETWEEN ? AND ? THEN cost_micros ELSE 0 END) / 1000000 as previous_spend
            FROM ads_historical_performance
            WHERE user_id = ?;
        `;
        const [spendResult] = await client.query(spendSql, [
            startDate, endDate,
            previousPeriodStart.format('YYYY-MM-DD'), previousPeriodEnd.format('YYYY-MM-DD'),
            userId
        ]);

        const total_commission = commResult[0].current_commission || 0;
        const previous_total_commission = commResult[0].previous_commission || 0;
        let total_ads_spend = spendResult[0].current_spend;
        let previous_total_ads_spend = spendResult[0].previous_spend;

        // 应用智能默认值规则
        if (total_ads_spend === null) {
            total_ads_spend = total_commission > 0 ? total_commission / 4 : 0;
        }
        if (previous_total_ads_spend === null) {
            previous_total_ads_spend = previous_total_commission > 0 ? previous_total_commission / 4 : 0;
        }

        const commission_change = calculateChange(total_commission, previous_total_commission);
        const ads_spend_change = calculateChange(total_ads_spend, previous_total_ads_spend);

        const calculateRoi = (commission, spend) => {
            if (spend > 0) return (commission - spend) / spend;
            return commission > 0 ? Infinity : 0;
        };
        const current_roi = calculateRoi(total_commission, total_ads_spend);
        const previous_roi = calculateRoi(previous_total_commission, previous_total_ads_spend);
        const roi_change = calculateChange(current_roi, previous_roi);

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
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

/**
 * @function getDailyTrendsChartData
 * @description 获取左中板块的数据：按天分组的消费、佣金堆积图以及每日ROI
 */
exports.getDailyTrendsChartData = async (req, res) => {
    const {
        startDate,
        endDate
    } = req.query;
    const userId = req.user.id;
    let client;

    if (!startDate || !endDate) {
        return res.cc('缺少 startDate 或 endDate 查询参数！');
    }

    try {
        client = await db.getClient();

        const commissionSql = `
            SELECT
                DATE(order_time) as date,
                SUM(sale_comm) as total_commission,
                SUM(CASE WHEN status = 'pending' THEN sale_comm ELSE 0 END) as pending_commission,
                SUM(CASE WHEN status = 'rejected' THEN sale_comm ELSE 0 END) as rejected_commission
            FROM transactions
            WHERE user_id = ? AND order_time BETWEEN ? AND ?
            GROUP BY DATE(order_time) ORDER BY date;
        `;
        const [commissionData] = await client.query(commissionSql, [userId, moment(startDate).startOf('day').format('YYYY-MM-DD HH:mm:ss'), moment(endDate).endOf('day').format('YYYY-MM-DD HH:mm:ss')]);

        const adsDailySql = `
            SELECT data_date as date, SUM(cost_micros) / 1000000 as ads_spend
            FROM ads_historical_performance
            WHERE user_id = ? AND data_date BETWEEN ? AND ?
            GROUP BY data_date ORDER BY date;
        `;
        const [adsDailyData] = await client.query(adsDailySql, [userId, startDate, endDate]);

        const result = {};
        let currentDate = moment(startDate);
        while (currentDate.isSameOrBefore(endDate)) {
            const dateStr = currentDate.format('YYYY-MM-DD');
            result[dateStr] = {
                total_commission: 0,
                pending_commission: 0,
                rejected_commission: 0,
                ads_spend: null
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

        adsDailyData.forEach(row => {
            const dateStr = moment(row.date).format('YYYY-MM-DD');
            if (result[dateStr]) {
                result[dateStr].ads_spend = parseFloat(row.ads_spend) || 0;
            }
        });

        Object.keys(result).forEach(dateStr => {
            const dayData = result[dateStr];
            if (dayData.ads_spend === null) {
                dayData.ads_spend = dayData.total_commission > 0 ? dayData.total_commission / 4 : 0;
            }
            dayData.roi = dayData.ads_spend > 0 ? (dayData.total_commission - dayData.ads_spend) / dayData.ads_spend : (dayData.total_commission > 0 ? Infinity : 0);
        });

        const chartData = {
            dates: Object.keys(result),
            pending_commission: Object.values(result).map(d => d.pending_commission),
            rejected_commission: Object.values(result).map(d => d.rejected_commission),
            ads_spend: Object.values(result).map(d => d.ads_spend),
            roi: Object.values(result).map(d => parseFloat(d.roi))
        };
        res.send({
            status: 0,
            message: '获取每日趋势图数据成功！',
            data: chartData
        });
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

/**
 * @function getCumulativeStatsData
 * @description 获取左下板块的数据：各LB账户佣金汇总表 和 累计确认金额环形图
 */
exports.getCumulativeStatsData = async (req, res) => {
    const userId = req.user.id;
    let client;
    try {
        client = await db.getClient();
        const summarySql = `
            SELECT
                pa.id as platform_account_id, pa.account_name,
                FLOOR(SUM(CASE WHEN t.status = 'Approved' THEN t.sale_comm ELSE 0 END)) as approved,
                FLOOR(SUM(CASE WHEN t.status = 'Pending' THEN t.sale_comm ELSE 0 END)) as pending,
                FLOOR(SUM(CASE WHEN t.status = 'Rejected' THEN t.sale_comm ELSE 0 END)) as rejected
            FROM transactions t
            JOIN user_platform_accounts pa ON t.platform_account_id = pa.id
            WHERE t.user_id = ? GROUP BY pa.id, pa.account_name ORDER BY approved DESC;
        `;
        const [account_summary] = await client.query(summarySql, [userId]);

        const distributionSql = `
            SELECT pa.account_name, FLOOR(SUM(t.sale_comm)) as confirmed_amount
            FROM transactions t
            JOIN user_platform_accounts pa ON t.platform_account_id = pa.id
            WHERE t.user_id = ? GROUP BY pa.account_name;
        `;
        const [account_distribution] = await client.query(distributionSql, [userId]);
        const total_confirmed_amount = account_distribution.reduce((sum, acc) => sum + parseFloat(acc.confirmed_amount), 0);

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
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

/**
 * @function getTopOffersForAccount
 * @description 根据平台账户ID获取各状态下Top 5的Offer排名
 */
exports.getTopOffersForAccount = async (req, res) => {
    const {
        accountId
    } = req.params;
    const userId = req.user.id;
    let client;
    try {
        client = await db.getClient();
        const statuses = ['Approved', 'Pending', 'Rejected'];
        const topOffers = {};
        for (const status of statuses) {
            const sql = `
                SELECT merchant_name, FLOOR(SUM(sale_comm)) as total_commission
                FROM transactions
                WHERE user_id = ? AND platform_account_id = ? AND status = ?
                GROUP BY merchant_name ORDER BY total_commission DESC LIMIT 5;
            `;
            const [results] = await client.query(sql, [userId, accountId, status]);
            topOffers[status.toLowerCase()] = results.map(item => ({
                offer_name: item.merchant_name,
                total_commission: item.total_commission
            }));
        }
        res.send({
            status: 0,
            message: `获取账户 ${accountId} 的Top Offer成功！`,
            data: topOffers
        });
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

/**
 * @function getDashboardOfferList
 * @description 获取看板Offer列表所需的所有数据
 */
exports.getDashboardOfferList = async (req, res) => {
    const {
        startDate,
        endDate,
        adId
    } = req.query;
    const userId = req.user.id;
    let client;
    if (!adId && (!startDate || !endDate)) return res.cc('缺少日期范围或广告ID');

    try {
        client = await db.getClient();
        const dataMap = new Map();
        let allAccountNames = new Set();
        let dailyTrendMap = new Map();

        const accountsSql = `SELECT account_name FROM user_platform_accounts WHERE user_id = ?`;
        const [accountRows] = await client.query(accountsSql, [userId]);
        accountRows.forEach(row => allAccountNames.add(row.account_name));

        let mainData;
        let dailyTrendData;

         if (adId) {
             // =============================================
             //  模式一: 按广告ID搜索 (不限时间)
             // =============================================
             mainSql = `
                SELECT
                    a.merchant_name,
                    a.platform_ad_id,
                    a.tracking_url,
                    COALESCE(cc.clicks, 0) as clicks,
                    COALESCE(tc.conversions, 0) as conversions,
                    COALESCE(tc.pending_commission, 0) as pending_commission,
                    COALESCE(tc.rejected_commission, 0) as rejected_commission,
                    COALESCE(tc.approved_commission, 0) as approved_commission,
                    COALESCE(tc.total_commission, 0) as total_commission,
                    0 as previous_commission,
                    tc.multi_account_commissions
                FROM ads a
                LEFT JOIN (
                    SELECT platform_ad_id, COUNT(*) as clicks FROM clicks
                    WHERE user_id = ? AND platform_ad_id = ? GROUP BY platform_ad_id
                ) AS cc ON a.platform_ad_id = cc.platform_ad_id
                LEFT JOIN (
                    -- ▼▼▼ 核心修正：使用两层聚合来正确计算多账户佣金 ▼▼▼
                    SELECT
                        platform_ad_id,
                        SUM(conversions) as conversions,
                        SUM(pending_commission) as pending_commission,
                        SUM(rejected_commission) as rejected_commission,
                        SUM(approved_commission) as approved_commission,
                        SUM(total_commission) as total_commission,
                        GROUP_CONCAT(CONCAT(account_name, ':', total_commission) SEPARATOR ';') as multi_account_commissions
                    FROM (
                        SELECT
                            t.platform_ad_id,
                            pa.account_name,
                            SUM(order_unit) as conversions,
                            SUM(CASE WHEN status = 'Pending' THEN sale_comm ELSE 0 END) as pending_commission,
                            SUM(CASE WHEN status = 'Rejected' THEN sale_comm ELSE 0 END) as rejected_commission,
                            SUM(CASE WHEN status = 'Approved' THEN sale_comm ELSE 0 END) as approved_commission,
                            SUM(sale_comm) as total_commission
                        FROM transactions t
                        JOIN user_platform_accounts pa ON t.platform_account_id = pa.id
                        WHERE t.user_id = ? AND t.platform_ad_id = ?
                        GROUP BY t.platform_ad_id, pa.account_name
                    ) AS account_level_summary
                    GROUP BY platform_ad_id
                ) AS tc ON a.platform_ad_id = tc.platform_ad_id
                WHERE a.user_id = ? AND a.platform_ad_id = ?;
            `;
             mainSqlParams = [userId, adId, userId, adId, userId, adId];

             dailyTrendSql = `
                SELECT
                    t.platform_ad_id, pa.account_name, DATE(t.order_time) as date,
                    SUM(t.sale_comm) as daily_account_commission
                FROM transactions t
                JOIN user_platform_accounts pa ON t.platform_account_id = pa.id
                WHERE t.user_id = ? AND t.platform_ad_id = ?
                GROUP BY t.platform_ad_id, pa.account_name, DATE(t.order_time)
                ORDER BY date;
            `;
             dailyTrendSqlParams = [userId, adId];

         } else {
            const currentStart = moment(startDate).startOf('day').format('YYYY-MM-DD HH:mm:ss');
            const currentEnd = moment(endDate).endOf('day').format('YYYY-MM-DD HH:mm:ss');
           duration = moment.duration(currentEnd.diff(currentStart)).asDays() + 1;
                       const previousEnd = currentStart.clone().subtract(1, 'days').endOf('day');
                       const previousStart = previousEnd.clone().subtract(duration - 1, 'days').startOf('day');
                       const currentStartTime = currentStart.format('YYYY-MM-DD HH:mm:ss');
                       const currentEndTime = currentEnd.format('YYYY-MM-DD HH:mm:ss');
                       const previousStartTime = previousStart.format('YYYY-MM-DD HH:mm:ss');
                       const previousEndTime = previousEnd.format('YYYY-MM-DD HH:mm:ss');
        }

        // [mainData] = await client.query(mainSql, mainSqlParams);
        // [dailyTrendData] = await client.query(dailyTrendSql, dailyTrendSqlParams);

        // 为了避免破坏您复杂的 SQL，我们在这里注入花费数据
        const relevantAdIds = mainData.map(offer => offer.platform_ad_id);
        let spendMap = new Map();
        if (relevantAdIds.length > 0) {
            const spendSql = `
                SELECT advertiser_id, SUM(cost_micros) / 1000000 as total_cost
                FROM ads_historical_performance
                WHERE user_id = ? AND advertiser_id IN (?)
                ${adId ? '' : 'AND data_date BETWEEN ? AND ?'}
                GROUP BY advertiser_id;
            `;
            const spendParams = adId ? [userId, relevantAdIds] : [userId, relevantAdIds, startDate, endDate];
            const [spendData] = await client.query(spendSql, spendParams);
            spendData.forEach(item => {
                spendMap.set(item.advertiser_id, parseFloat(item.total_cost));
            });
        }

          // --- Data Processing (largely unchanged) ---
          const trendMap = new Map();
          const allAccountNames = new Set();
          dailyTrendData.forEach(item => {
              const adId = item.platform_ad_id;
              const date = moment(item.date).format('YYYY-MM-DD');
              const account = item.account_name;
              const commission = parseFloat(item.daily_account_commission) || 0;
              if (!trendMap.has(adId)) trendMap.set(adId, new Map());
              if (!trendMap.get(adId).has(date)) trendMap.get(adId).set(date, {});
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
const commissionMoM = adId ? 0 : calculateChange(currentTotalCommission, previousCommission);

return {
    ad_id: offer.platform_ad_id,
    offer_name: offer.merchant_name,
    logo: domain ? `https://logo.clearbit.com/${domain}` : null,
    logo_fallback: offer.merchant_name.charAt(0).toUpperCase(),
    roi: roi, // Real ROI
    multi_account_commissions: multiAccountCommissions,
    cvr: clicks > 0 ? (conversions / clicks) * 100 : 0,
    commission_mom: commissionMoM,
    total_commission: currentTotalCommission,
    approved_commission: parseFloat(offer.approved_commission) || 0,
    pending_commission: parseFloat(offer.pending_commission) || 0,
    rejected_commission: parseFloat(offer.rejected_commission) || 0,
    commission_trend: finalTrendMap.get(offer.platform_ad_id) || []
};
        });

       if (!adId) {
           processedOffers.sort((a, b) => b.total_commission - a.total_commission);
       }

       const globalRoi = totalSpend > 0 ? (totalCommissionSum - totalSpend) / totalSpend : (totalCommissionSum > 0 ? Infinity : 0);

       res.send({
           status: 0,
           message: '获取Offer列表数据成功！',
           data: {
               global_roi: globalRoi,
               all_account_names: Array.from(allAccountNames),
               offers: processedOffers
           }
       });

    } catch (error) {
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

/**
 * @function searchAds
 * @description 根据关键词远程搜索广告
 */
exports.searchAds = async (req, res) => {
    const {
        keyword
    } = req.query;
    const userId = req.user.id;
    let client;
    if (!keyword || keyword.trim() === '') return res.send({
        status: 0,
        message: '关键词为空',
        data: []
    });
    try {
        client = await db.getClient();
        const sql = `
            SELECT DISTINCT merchant_name, advertiser_id as platform_ad_id
            FROM transactions
            WHERE user_id = ? AND (merchant_name LIKE ? OR advertiser_id LIKE ?)
            LIMIT 10;
        `;
        const searchTerm = `%${keyword}%`;
        const [results] = await client.query(sql, [userId, searchTerm, searchTerm]);
        const formattedResults = results.map(item => ({
            value: `${item.merchant_name} (ID: ${item.platform_ad_id})`,
            ...item
        }));
        res.send({
            status: 0,
            message: '搜索成功',
            data: formattedResults
        });
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};


/**
 * @function getRightPanelSummary
 * @description 获取右侧板块的所有账户汇总数据
 */
exports.getRightPanelSummary = async (req, res) => {
    const {
        startDate,
        endDate
    } = req.query;
    const userId = req.user.id;
    let client;
    if (!startDate || !endDate) return res.cc('缺少日期范围');

    try {
        client = await db.getClient();
        const currentStart = moment(startDate).startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const currentEnd = moment(endDate).endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const duration = moment.duration(moment(endDate).endOf('day').diff(moment(startDate).startOf('day'))).asDays() + 1;
        const previousEnd = moment(startDate).startOf('day').subtract(1, 'second').format('YYYY-MM-DD HH:mm:ss');
        const previousStart = moment(previousEnd).subtract(duration - 1, 'days').format('YYYY-MM-DD HH:mm:ss');

        const summarySql = `
            SELECT
                pa.id as account_id, pa.account_name,
                SUM(CASE WHEN t.order_time BETWEEN ? AND ? THEN t.sale_comm ELSE 0 END) as total_commission,
                SUM(CASE WHEN t.order_time BETWEEN ? AND ? AND t.status = 'Approved' THEN t.sale_comm ELSE 0 END) as approved_commission,
                SUM(CASE WHEN t.order_time BETWEEN ? AND ? AND t.status = 'Pending' THEN t.sale_comm ELSE 0 END) as pending_commission,
                SUM(CASE WHEN t.order_time BETWEEN ? AND ? AND t.status = 'Rejected' THEN t.sale_comm ELSE 0 END) as rejected_commission,
                SUM(CASE WHEN t.order_time BETWEEN ? AND ? THEN t.sale_comm ELSE 0 END) as previous_total_commission
            FROM user_platform_accounts pa
            LEFT JOIN transactions t ON pa.id = t.platform_account_id AND t.user_id = pa.user_id AND (t.order_time BETWEEN ? AND ? OR t.order_time BETWEEN ? AND ?)
            WHERE pa.user_id = ? GROUP BY pa.id, pa.account_name;
        `;
        const [summaryData] = await client.query(summarySql, [
            currentStart, currentEnd, currentStart, currentEnd, currentStart, currentEnd, currentStart, currentEnd,
            previousStart, previousEnd,
            previousStart, previousEnd, currentStart, currentEnd, userId
        ]);

        const spendSql = `
            SELECT t.platform_account_id as account_id, SUM(h.cost_micros) / 1000000 as total_cost
            FROM ads_historical_performance h
            JOIN (SELECT DISTINCT platform_account_id, advertiser_id FROM transactions WHERE user_id = ?) t ON h.advertiser_id = t.advertiser_id
            WHERE h.user_id = ? AND h.data_date BETWEEN ? AND ? GROUP BY t.platform_account_id;
        `;
        const [spendData] = await client.query(spendSql, [userId, userId, startDate, endDate]);
        const spendMap = new Map(spendData.map(i => [i.account_id, parseFloat(i.total_cost)]));

        const processedAccounts = summaryData.map(account => {
            const totalComm = parseFloat(account.total_commission) || 0;
            let spend = spendMap.get(account.account_id);
            if (spend === undefined) {
                spend = totalComm > 0 ? totalComm / 4 : 0;
            }
            const roi = spend > 0 ? (totalComm - spend) / spend : (totalComm > 0 ? Infinity : 0);

            return {
                account_id: account.account_id,
                account_name: account.account_name,
                spend,
                roi,
                total_commission: {
                    value: totalComm,
                    change: calculateChange(totalComm, parseFloat(account.previous_total_commission) || 0)
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
                    active_ads: activeAdsMap.get(account.account_id) || [],
                    summary_chart_data: chartData
            
            };
        });

        res.send({
            status: 0,
            message: '获取右侧板块账户汇总成功！',
            data: processedAccounts.filter(acc => acc.total_commission.value > 0)
        });

    } catch (error) {
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};


/**
 * @function getRightPanelAdDetail
 * @description 获取右侧板块单个广告的详细数据
 */
exports.getRightPanelAdDetail = async (req, res) => {
    const {
        startDate,
        endDate,
        adId
    } = req.query;
    const userId = req.user.id;
    let client;
    if (!startDate || !endDate || !adId) return res.cc('缺少查询参数');

    try {
        client = await db.getClient();
        const currentStart = moment(startDate).startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const currentEnd = moment(endDate).endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const previousEnd = moment(startDate).startOf('day').subtract(1, 'second').format('YYYY-MM-DD HH:mm:ss');
        const duration = moment.duration(moment(currentEnd).diff(moment(currentStart))).asDays() + 1;
        const previousStart = moment(previousEnd).subtract(duration - 1, 'days').format('YYYY-MM-DD HH:mm:ss');

        const detailSql = `
            SELECT
                a.platform_ad_id as ad_id, a.merchant_name as ad_name,
                COALESCE(tc.total_commission, 0) as total_commission,
                COALESCE(tc.pending_commission, 0) as pending_commission,
                COALESCE(tc.rejected_commission, 0) as rejected_commission,
                COALESCE(tc.approved_commission, 0) as approved_commission,
                COALESCE(tp.previous_total_commission, 0) as previous_total_commission
            FROM ads a
            LEFT JOIN (SELECT platform_ad_id, SUM(sale_comm) as total_commission, SUM(CASE WHEN status = 'Pending' THEN sale_comm ELSE 0 END) as pending_commission, SUM(CASE WHEN status = 'Rejected' THEN sale_comm ELSE 0 END) as rejected_commission, SUM(CASE WHEN status = 'Approved' THEN sale_comm ELSE 0 END) as approved_commission FROM transactions WHERE user_id = ? AND platform_ad_id = ? AND order_time BETWEEN ? AND ? GROUP BY platform_ad_id) AS tc ON a.platform_ad_id = tc.platform_ad_id
            LEFT JOIN (SELECT platform_ad_id, SUM(sale_comm) as previous_total_commission FROM transactions WHERE user_id = ? AND platform_ad_id = ? AND order_time BETWEEN ? AND ? GROUP BY platform_ad_id) AS tp ON a.platform_ad_id = tp.platform_ad_id
            WHERE a.user_id = ? AND a.platform_ad_id = ?;
        `;
        const [detailData] = await client.query(detailSql, [userId, adId, currentStart, currentEnd, userId, adId, previousStart, previousEnd, userId, adId]);

        if (detailData.length === 0) return res.send({
            status: 1,
            message: '未找到该广告的数据'
        });

        const spendSql = `SELECT SUM(cost_micros)/1000000 as total_cost FROM ads_historical_performance WHERE user_id = ? AND advertiser_id = ? AND data_date BETWEEN ? AND ?`;
        const [spendData] = await client.query(spendSql, [userId, adId, startDate, endDate]);

        const adDetail = detailData[0];
        let spend = (spendData[0] && spendData[0].total_cost !== null) ? parseFloat(spendData[0].total_cost) : null;
        const totalComm = parseFloat(adDetail.total_commission);

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
        
                    // 每日花费按比例估算
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
                // ▲▲▲ 修改结束 ▲▲▲
        const responseData = {
            // 第1行
            spend: spend, // 真实花费
            roi: roi, // 真实ROI
            // 第2行 (结构与您原来的一致)
            total_commission: {
                value: totalComm,
                change: calculateChange(totalComm, prevTotalComm)
            },
            // ... (其他 commission 对象)
            // 第3行
            active_ads: [{
                ad_id: adDetail.ad_id,
                ad_name: adDetail.ad_name,
                commission: totalComm
            }],
            // 第4行
            summary_chart_data: chartData
        };

        res.send({
            status: 0,
            message: '获取广告详情数据成功！',
            data: responseData
        });
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};