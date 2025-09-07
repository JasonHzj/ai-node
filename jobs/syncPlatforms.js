const cron = require('node-cron');
const db = require('../db');
const linkbuxService = require('../services/linkbux.service');
const {
    Buffer
} = require('buffer');

// --- 通用辅助函数 ---

const getAccountsToSync = async (client) => {
    const getAccountsSql = `
        SELECT id, user_id, api_token 
        FROM user_platform_accounts 
        WHERE platform_name = 'Linkbux' AND api_token IS NOT NULL
    `;
    const [accounts] = await client.query(getAccountsSql);
    return accounts.map(acc => ({
        user_id: acc.user_id,
        account_id: acc.id,
        token: Buffer.from(acc.api_token, 'base64').toString('ascii')
    }));
};


// --- 定时任务核心逻辑 ---

const syncRecentTransactions = async () => {
    console.log('[任务启动] 每10分钟: 同步近3天交易数据');
    let client;
    try {
        client = await db.getClient();
        const accounts = await getAccountsToSync(client);
        if (accounts.length === 0) return;

        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

        for (const acc of accounts) {
            const transactions = await linkbuxService.fetchTransactions(acc.token, threeDaysAgo, new Date());
            if (transactions && transactions.length > 0) {
                const values = transactions.map(tx => [
                    acc.user_id, 'Linkbux', acc.account_id, tx.linkbux_id, tx.mid, tx.uid,
                    tx.order_time ? new Date(tx.order_time * 1000) : null,
                    tx.sale_amount, tx.sale_comm, tx.validation_date || null, tx.order_unit, tx.ip, tx.referer_url, tx.status, tx.merchant_name
                ]);
                const sql = `
                    INSERT INTO transactions (user_id, platform, platform_account_id, platform_transaction_id, platform_ad_id, uid, order_time, sale_amount, sale_comm, validation_date, order_unit, ip, referer_url, status, merchant_name) VALUES ?
                    ON DUPLICATE KEY UPDATE sale_amount=VALUES(sale_amount), sale_comm=VALUES(sale_comm), validation_date=VALUES(validation_date), status=VALUES(status), updated_at=NOW()`;
                await client.query(sql, [values]);
            }
        }
    } catch (error) {
        console.error('[任务失败] 每10分钟 - 同步交易数据:', error.message);
    } finally {
        if (client) client.release();
        console.log('[任务结束] 每10分钟: 同步近3天交易数据');
    }
};

const syncHourlyClicks = async () => {
    console.log('[任务启动] 每小时: 同步点击数据');
    let client;
    try {
        client = await db.getClient();
        const accounts = await getAccountsToSync(client);
        if (accounts.length === 0) return;

        const oneHourAgo = new Date();
        oneHourAgo.setHours(oneHourAgo.getHours() - 1);

        for (const acc of accounts) {
            const clicks = await linkbuxService.fetchClicks(acc.token, oneHourAgo, new Date());
            if (clicks && clicks.length > 0) {
                const values = clicks.map(c => [
                    acc.user_id, 'Linkbux', acc.account_id, c.mid, c.merchant_name, c.uid, c.ip,
                    c.click_time ? new Date(c.click_time * 1000) : null,
                ]);
                const sql = `
                    INSERT IGNORE INTO clicks 
                    (user_id, platform, platform_account_id, platform_ad_id, merchant_name, uid, ip, click_time) 
                    VALUES ?
                `;
                await client.query(sql, [values]);
            }
        }
    } catch (error) {
        console.error('[任务失败] 每小时 - 同步点击数据:', error.message);
    } finally {
        if (client) client.release();
        console.log('[任务结束] 每小时: 同步点击数据');
    }
};

const syncDailyMajorData = async () => {
    console.log('[任务启动] 每日: 同步60天交易和全量广告');
    let client;
    try {
        client = await db.getClient();
        const accounts = await getAccountsToSync(client);
        if (accounts.length === 0) return;

        const sixtyDaysAgo = new Date();
        sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

        for (const acc of accounts) {
            const transactions = await linkbuxService.fetchTransactions(acc.token, sixtyDaysAgo, new Date());
            if (transactions && transactions.length > 0) {
                const values = transactions.map(tx => [
                    acc.user_id, 'Linkbux', acc.account_id, tx.linkbux_id, tx.mid, tx.uid,
                    tx.order_time ? new Date(tx.order_time * 1000) : null,
                    tx.sale_amount, tx.sale_comm, tx.validation_date || null, tx.order_unit, tx.ip, tx.referer_url, tx.status, tx.merchant_name
                ]);
                const sql = `
                    INSERT INTO transactions (user_id, platform, platform_account_id, platform_transaction_id, platform_ad_id, uid, order_time, sale_amount, sale_comm, validation_date, order_unit, ip, referer_url, status, merchant_name) VALUES ?
                    ON DUPLICATE KEY UPDATE sale_amount=VALUES(sale_amount), sale_comm=VALUES(sale_comm), validation_date=VALUES(validation_date), status=VALUES(status), updated_at=NOW()`;
                await client.query(sql, [values]);
            }

            const ads = await linkbuxService.fetchAds(acc.token);
            if (ads && ads.length > 0) {
                await client.beginTransaction();
                await client.query('DELETE FROM ads WHERE platform_account_id = ?', [acc.account_id]);
                const values = ads.map(ad => [
                    acc.user_id, 'Linkbux', acc.account_id, ad.mid, ad.merchant_name, ad.comm_rate, ad.tracking_url, ad.relationship, ad.comm_detail, ad.site_url, ad.logo, ad.categories, ad.offer_type, ad.avg_payment_cycle, ad.avg_payout, ad.primary_region, ad.support_region, ad.rd
                ]);
                const sql = `
                    INSERT INTO ads (user_id, platform, platform_account_id, platform_ad_id, merchant_name, comm_rate, tracking_url, relationship, comm_detail, site_url, logo, categories, offer_type, avg_payment_cycle, avg_payout, primary_region, support_region, rd) VALUES ?`;
                await client.query(sql, [values]);
                await client.commit();
            }
        }
    } catch (error) {
        if (client) await client.rollback();
        console.error('[任务失败] 每日 - 同步主数据:', error.message);
    } finally {
        if (client) client.release();
        console.log('[任务结束] 每日: 同步60天交易和全量广告');
    }
};

const syncMonthlyFinancials = async () => {
    console.log('[任务启动] 每月3次: 同步财务结算数据');
    let client;
    try {
        client = await db.getClient();
        const accounts = await getAccountsToSync(client);
        if (accounts.length === 0) return;

        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        for (const acc of accounts) {
            const settlements = await linkbuxService.fetchSettlements(acc.token, oneYearAgo, new Date());
            if (settlements && settlements.length > 0) {
                const values = settlements.map(s => [
                    acc.user_id, 'Linkbux', acc.account_id, s.mid, s.settlement_id,
                    s.settlement_date ? new Date(s.settlement_date) : null,
                    s.sale_comm, s.paid_date ? new Date(s.paid_date) : null,
                    s.payment_id, s.settlement_type, s.merchant_name, s.note || null
                ]);
                const sql = `
                    INSERT INTO settlements (user_id, platform, platform_account_id, platform_ad_id, settlement_id, settlement_date, sale_comm, paid_date, payment_id, settlement_type, merchant_name, note) VALUES ?
                    ON DUPLICATE KEY UPDATE platform_ad_id=VALUES(platform_ad_id), settlement_date=VALUES(settlement_date), sale_comm=VALUES(sale_comm), paid_date=VALUES(paid_date), payment_id=VALUES(payment_id), settlement_type=VALUES(settlement_type), merchant_name=VALUES(merchant_name), note=VALUES(note), updated_at=NOW()`;
                await client.query(sql, [values]);
            }
        }
    } catch (error) {
        console.error('[任务失败] 每月3次 - 同步财务数据:', error.message);
    } finally {
        if (client) client.release();
        console.log('[任务结束] 每月3次: 同步财务结算数据');
    }
};


// --- ▼▼▼ 经过优化的函数：阶段性历史数据回归 ▼▼▼ ---
/**
 * [每日凌晨4点] “阶段性”同步一“片”超过60天的历史交易数据，并增加智能判断
 */
const syncHistoricalTransactions = async () => {
    const dayOfWeek = new Date().getDay();
    const offset = dayOfWeek + 2;

    const endDate = new Date();
    endDate.setDate(endDate.getDate() - (offset * 30));
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - ((offset + 1) * 30));

    // --- 新增逻辑 1: 设定550天的最远追溯边界 ---
    const maxLookbackDate = new Date();
    maxLookbackDate.setDate(maxLookbackDate.getDate() - 550);

    // 如果我们当前要查询的时间窗口比550天还早，就直接跳过本次任务
    if (startDate < maxLookbackDate) {
        console.log(`[历史回归任务-周${dayOfWeek}] 任务跳过：要查询的日期范围（${offset+1}到${offset}个月前）已超过550天的最大限制。`);
        return;
    }

    const logPrefix = `[历史回归任务-周${dayOfWeek}]`;
    console.log(`${logPrefix} 启动，开始同步 ${offset+1} 到 ${offset} 个月前的数据...`);

    let client;
    try {
        client = await db.getClient();
        const accounts = await getAccountsToSync(client);
        if (accounts.length === 0) return;

        for (const acc of accounts) {
            // --- 新增逻辑 2: 为每个账号查找其“出生日期” ---
            const getFirstRecordSql = `
                SELECT order_time FROM transactions 
                WHERE platform_account_id = ? 
                ORDER BY order_time ASC 
                LIMIT 1`;
            const [firstRecord] = await client.query(getFirstRecordSql, [acc.account_id]);

            // 如果这个账号没有任何记录，就跳过它
            if (firstRecord.length === 0) {
                console.log(`  - ${logPrefix} [账户 ${acc.account_id}] 无任何交易记录，跳过。`);
                continue;
            }

            const accountStartDate = new Date(firstRecord[0].order_time);

            // 如果我们要查询的时间窗口比这个账号的第一条记录还早，那就没必要查了
            if (endDate < accountStartDate) {
                console.log(`  - ${logPrefix} [账户 ${acc.account_id}] 任务跳过：要查询的日期范围早于该账户的第一条记录(${accountStartDate.toISOString().slice(0,10)})。`);
                continue;
            }

            // --- 智能调整查询的开始时间 ---
            // 如果查询窗口的开始时间早于账号的“出生日期”，就把开始时间调整为“出生日期”，避免空查
            const effectiveStartDate = startDate < accountStartDate ? accountStartDate : startDate;

            const transactions = await linkbuxService.fetchTransactions(acc.token, effectiveStartDate, endDate);
            if (transactions && transactions.length > 0) {
                const values = transactions.map(tx => [
                    acc.user_id, 'Linkbux', acc.account_id, tx.linkbux_id, tx.mid, tx.uid,
                    tx.order_time ? new Date(tx.order_time * 1000) : null,
                    tx.sale_amount, tx.sale_comm, tx.validation_date || null, tx.order_unit, tx.ip, tx.referer_url, tx.status, tx.merchant_name
                ]);
                const sql = `
                    INSERT INTO transactions (user_id, platform, platform_account_id, platform_transaction_id, platform_ad_id, uid, order_time, sale_amount, sale_comm, validation_date, order_unit, ip, referer_url, status, merchant_name) VALUES ?
                    ON DUPLICATE KEY UPDATE sale_amount=VALUES(sale_amount), sale_comm=VALUES(sale_comm), validation_date=VALUES(validation_date), status=VALUES(status), updated_at=NOW()`;
                await client.query(sql, [values]);
                console.log(`  - ${logPrefix} [用户 ${acc.user_id}, 账户 ${acc.account_id}] 同步了 ${transactions.length} 条历史交易`);
            }
        }
    } catch (error) {
        console.error(`${logPrefix} 失败:`, error.message);
    } finally {
        if (client) client.release();
        console.log(`${logPrefix} 结束`);
    }
};
// --- ▲▲▲ 优化结束 ▲▲▲ ---


/**
 * 启动所有定时任务
 */
const start = () => {
    const options = {
        timezone: "Asia/Shanghai"
    };

    cron.schedule('*/10 * * * *', syncRecentTransactions, options);
    console.log('[定时任务已设置] 每10分钟同步一次近期交易。');

    cron.schedule('0 * * * *', syncHourlyClicks, options);
    console.log('[定时任务已设置] 每小时同步一次点击数据。');

    cron.schedule('0 2 * * *', syncDailyMajorData, options);
    console.log('[定时任务已设置] 每日凌晨2点进行主数据同步。');

    cron.schedule('0 4 * * *', syncHistoricalTransactions, options);
    console.log('[定时任务已设置] 每日凌晨4点执行历史交易数据阶段性回归。');

    cron.schedule('0 3 5,15,30 * *', syncMonthlyFinancials, options);
    console.log('[定时任务已设置] 每月5,15,30号凌晨3点同步财务数据。');
};

module.exports = {
    start,
    syncDailyMajorData,
    getAccountsToSync
};