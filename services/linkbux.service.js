const axios = require('axios');
const {
    Buffer
} = require('buffer');
const db = require('../db');
const BASE_URL = 'https://www.linkbux.com/api.php';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatDate(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function fetchPaginatedData(params, progressContext = null) {
    let allData = [];
    let currentPage = 1;
    let totalPages = 1;
    do {
        const MAX_RETRIES = 5;
        const INITIAL_DELAY = 30000;
        let success = false;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await axios.get(BASE_URL, {
                    params: {
                        ...params,
                        page: currentPage
                    }
                });
                const data = response.data;
                let pageData = [];

                if (data.status && data.status.code === 0) {
                    if (data.data && Array.isArray(data.data.list)) {
                        // 适用于 transactions 和 ads
                        pageData = data.data.list;
                        totalPages = data.data.total_page || 1;
                    } else if (Array.isArray(data.data)) {
                        // 适用于 settlements
                        pageData = data.data;
                        totalPages = 1; // settlements 接口似乎不分页
                    }
                    // --- ▼▼▼ 核心修正之处 ▼▼▼ ---
                    // 使用 API 错误的拼写 `payliad` 来正确解析数据
                    } else if (data?.payliad?.list) {
                        pageData = data.payliad.list;
                        totalPages = data.payliad.total?.total_page || 1;
                    } else if (data?.status === 200 && data?.payliad) { // 针对您提供的成功状态码
                        pageData = data.payliad.list || [];
                        totalPages = data.payliad.total?.total_page || 1;
                        // --- ▲▲▲ 修正结束 ▲▲▲ ---
                } else {
                
                  if (data?.status?.code === 1) {
                      console.log(`[API提示] 接口 [${params.op}] 在第 ${currentPage} 页没有返回数据，任务将正常结束。`);
                      totalPages = 0; // 设置为0，结束循环
                  } else {
                      // 使用可选链操作符 (?.) 来安全地访问属性，避免因 undefined 而崩溃
                      const errorMessage = data?.status?.msg || '未在响应中找到明确的错误信息';
                      throw new Error(`API返回错误或非预期的格式: ${errorMessage}`);
                  }
                  // --- ▲▲▲ 修正结束 ▲▲▲ ---
                }
                // --- ▲▲▲ 修正结束 ▲▲▲ ---

                allData = allData.concat(pageData);

                if (progressContext && pageData.length > 0) {
                    const {
                        io,
                        userId,
                        accountName,
                        dataType,
                        baseProgress,
                        progressWeight
                    } = progressContext;
                    const progress = baseProgress + Math.round((currentPage / totalPages) * progressWeight);
                    const message = `[${accountName}] 正在获取 ${dataType} 数据，第 ${currentPage} / ${totalPages} 页...`;
                    io.to(userId.toString()).emit('sync_progress', {
                        progress,
                        message
                    });
                    console.log(`[后台任务] ==> ${message}`);
                }

                success = true;
                break;

            } catch (error) {
                console.error(`请求 Linkbux API [${params.op}] 第 ${currentPage} 页失败 (第 ${attempt} 次尝试):`, error.message);
                if (attempt === MAX_RETRIES) throw error;
                const waitTime = INITIAL_DELAY * attempt;
                const message = `[${progressContext?.accountName || '定时任务'}] API请求失败，将在 ${waitTime / 1000} 秒后重试...`;
                if (progressContext) {
                    progressContext.io.to(progressContext.userId.toString()).emit('sync_progress', {
                        progress: progressContext.baseProgress,
                        message
                    });
                }
                console.log(`[后台任务] ==> ${message}`);
                await delay(waitTime);
            }
        }
        currentPage++;
    } while (currentPage <= totalPages);
    return allData;
}


const fetchTransactions = (token, beginDate, endDate, progressContext) => fetchPaginatedData({
    mod: 'medium',
    op: 'transaction_v2',
    token,
    begin_date: formatDate(beginDate),
    end_date: formatDate(endDate),
    limit: 2000
}, progressContext);

const fetchSettlements = (token, beginDate, endDate, progressContext) => fetchPaginatedData({
    mod: 'settlement',
    op: 'merchant_commission',
    token,
    begin_date: formatDate(beginDate),
    end_date: formatDate(endDate)
}, progressContext);

const fetchAds = (token, progressContext) => fetchPaginatedData({
    mod: 'medium',
    op: 'monetization_api',
    token,
    limit: 1000
}, progressContext);

// --- ▼▼▼ 修正 2: 使用您提供的正确接口名 'user_click' ▼▼▼ ---
const fetchClicks = (token, beginDate, endDate, progressContext) => fetchPaginatedData({
    mod: 'medium',
    op: 'user_click', // 将 op 修正为您提供的 'user_click'
    token,
    begin_date: formatDate(beginDate),
    end_date: formatDate(endDate),
    limit: 2000
}, progressContext);
// --- ▲▲▲ 修正结束 ▲▲▲ ---


async function runInitialSyncForUser(io, userId, account, startDate) {
    const initialLog = `[后台任务] ==> 用户 [${userId}] 的账户 [${account.account_name}]`;
    console.log(`${initialLog} - 任务已接收，准备执行...`);

    const decryptedToken = Buffer.from(account.api_token, 'base64').toString('ascii');
    const GLOBAL_START_DATE = new Date(startDate || '2024-01-01');

    let client;
    try {
        io.to(userId.toString()).emit('sync_progress', {
            progress: 0,
            message: `正在准备任务: ${account.account_name}...`
        });
        client = await db.getClient();

        const syncStatus = {
            shouldSyncTransactions: false,
            shouldSyncAds: false,
            shouldSyncSettlements: false,
        };

        const txSql = `SELECT 1 FROM transactions WHERE platform_account_id = ? LIMIT 1`;
        const [txData] = await client.query(txSql, [account.id]);
        if (txData.length === 0) {
            syncStatus.shouldSyncTransactions = true;
        }

        const adSql = `SELECT 1 FROM ads WHERE platform_account_id = ? LIMIT 1`;
        const [adData] = await client.query(adSql, [account.id]);
        if (adData.length === 0) {
            syncStatus.shouldSyncAds = true;
        }

        const stSql = `SELECT 1 FROM settlements WHERE platform_account_id = ? LIMIT 1`;
        const [stData] = await client.query(stSql, [account.id]);
        if (stData.length === 0) {
            syncStatus.shouldSyncSettlements = true;
        }

        if (!Object.values(syncStatus).some(status => status)) {
            io.to(userId.toString()).emit('sync_complete', {
                message: `所有核心数据均已存在，无需执行历史同步。`
            });
            return;
        }

        if (syncStatus.shouldSyncAds) {
            const adsProgressContext = {
                io,
                userId,
                accountName: account.account_name,
                dataType: '广告',
                baseProgress: 5,
                progressWeight: 25
            };
            const ads = await fetchAds(decryptedToken, adsProgressContext);
            if (ads.length > 0) {
                // --- ▼▼▼ 核心修正之处 ▼▼▼ ---
                // 采用和每日任务一致的“先删除，后插入”策略
                await client.beginTransaction();
                console.log(`${initialLog} - 正在为账户 [${account.id}] 删除旧的广告数据...`);
                await client.query('DELETE FROM ads WHERE platform_account_id = ?', [account.id]);

                console.log(`${initialLog} - 正在为账户 [${account.id}] 插入 ${ads.length} 条新广告数据...`);
                const values = ads.map(ad => [
                    userId, 'Linkbux', account.id, ad.mid, ad.merchant_name,
                    ad.comm_rate, ad.tracking_url, ad.relationship, ad.comm_detail, ad.site_url,
                    ad.logo, ad.categories, ad.offer_type, ad.avg_payment_cycle, ad.avg_payout,
                    ad.primary_region, ad.support_region, ad.rd
                ]);
                // 注意：这里不再需要 ON DUPLICATE KEY UPDATE
                const sql = `
                INSERT INTO ads (
                    user_id, platform, platform_account_id, platform_ad_id, merchant_name, 
                    comm_rate, tracking_url, relationship, comm_detail, site_url, 
                    logo, categories, offer_type, avg_payment_cycle, avg_payout, 
                    primary_region, support_region, rd 
                ) VALUES ?`;
                await client.query(sql, [values]);
                await client.commit();
                console.log(`${initialLog} - 广告数据事务提交成功。`);
                // --- ▲▲▲ 修正结束 ▲▲▲ ---
            }
            io.to(userId.toString()).emit('sync_progress', {
                progress: 30,
                message: `[${account.account_name}] 广告数据同步完成!`
            });
        } else {
            io.to(userId.toString()).emit('sync_progress', {
                progress: 30,
                message: `[${account.account_name}] 广告数据已存在，跳过同步。`
            });
        }

        if (syncStatus.shouldSyncTransactions || syncStatus.shouldSyncSettlements) {
            let currentStartDate = new Date(GLOBAL_START_DATE);
            while (currentStartDate <= new Date()) {
                let currentEndDate = new Date(currentStartDate);
                currentEndDate.setDate(currentEndDate.getDate() + 60);

                if (syncStatus.shouldSyncTransactions) {
                    const transactions = await fetchTransactions(decryptedToken, currentStartDate, currentEndDate);
                    if (transactions.length > 0) {
                        const values = transactions.map(tx => [
                            userId, 'Linkbux', account.id, tx.linkbux_id, tx.mid, tx.uid, tx.order_time ? new Date(tx.order_time * 1000) : null, tx.sale_amount, tx.sale_comm, tx.validation_date || null, tx.order_unit, tx.ip, tx.referer_url, tx.status, tx.merchant_name
                        ]);
                        const sql = `INSERT INTO transactions (user_id, platform, platform_account_id, platform_transaction_id, platform_ad_id, uid, order_time, sale_amount, sale_comm, validation_date, order_unit, ip, referer_url, status, merchant_name) VALUES ? ON DUPLICATE KEY UPDATE sale_amount=VALUES(sale_amount), sale_comm=VALUES(sale_comm), validation_date=VALUES(validation_date), status=VALUES(status), updated_at=NOW()`;
                        await client.query(sql, [values]);
                    }
                }
                // (此处可以按需补充结算同步逻辑)

                currentStartDate.setDate(currentStartDate.getDate() + 61);
            }
        }

        io.to(userId.toString()).emit('sync_complete', {
            message: `账户 [${account.account_name}] 的数据补充同步完成！`
        });
        console.log(`${initialLog} - 同步成功！`);
    } catch (error) {
        if (client) await client.rollback();
        io.to(userId.toString()).emit('sync_error', {
            message: `账户 [${account.account_name}] 同步失败: ${error.message}`
        });
        console.error(`${initialLog} - 同步时出错:`, error);
    } finally {
        if (client) client.release();
        console.log(`${initialLog} - 数据库客户端已释放。`);
    }
}

module.exports = {
    fetchTransactions,
    fetchSettlements,
    fetchAds,
    fetchClicks,
    runInitialSyncForUser, // 确保 runInitialSyncForUser 被正确导出
    delay
};