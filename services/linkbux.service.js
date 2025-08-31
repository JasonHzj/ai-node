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
                } else if (data?.payliad?.list) {
                    // 适用于 clicks
                    pageData = data.payliad.list;
                    totalPages = data.payliad.total.total_page || 1;
                } else {
                    throw new Error(`API returned an error or unexpected format: ${data.status ? data.status.msg : 'Unknown error'}`);
                }

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
                console.error(`Request to Linkbux API [${params.op}] page ${currentPage} failed on attempt ${attempt}:`, error.message);
                if (attempt === MAX_RETRIES) throw error;
                const waitTime = INITIAL_DELAY * attempt;
                const message = `[${progressContext.accountName}] API请求失败，将在 ${waitTime / 1000} 秒后重试...`;
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

        // --- 核心改动 1: 状态检查模式 ---
        // 我们不再直接reject，而是记录每个表是否需要同步
        const syncStatus = {
            shouldSyncTransactions: false,
            shouldSyncAds: false,
            shouldSyncSettlements: false,
        };

        console.log(`${initialLog} - 正在执行数据存在性检查...`);
        const txSql = `SELECT 1 FROM transactions WHERE platform_account_id = ? AND order_time >= ? LIMIT 1`;
        const [txData] = await client.query(txSql, [account.id, GLOBAL_START_DATE]);
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
        console.log(`${initialLog} - 检查完成:`, syncStatus);
        // --- 状态检查结束 ---


        // --- 核心改动 2: 检查是否无事可做 ---
        if (!syncStatus.shouldSyncTransactions && !syncStatus.shouldSyncAds && !syncStatus.shouldSyncSettlements) {
            const message = `所有核心数据均已存在，无需执行历史同步。`;
            io.to(userId.toString()).emit('sync_complete', {
                message
            });
            console.log(`${initialLog} - ${message}`);
            return; // 提前结束函数
        }
        // --- 判断结束 ---


        // --- 核心改动 3: 条件性同步 Ads ---
        if (syncStatus.shouldSyncAds) {
            const adsProgressContext = {
                io,
                userId,
                accountName: account.account_name,
                dataType: '广告',
                baseProgress: 5,
                progressWeight: 5
            };
            const ads = await fetchAds(decryptedToken, adsProgressContext);
            if (ads.length > 0) {
                // ... (广告插入逻辑保持不变)
               const sql = `
                INSERT INTO ads (
                    user_id, platform, platform_account_id, platform_ad_id, merchant_name, 
                    comm_rate, tracking_url, relationship, comm_detail, site_url, 
                    logo, categories, offer_type, avg_payment_cycle, avg_payout, 
                    primary_region, support_region, rd 
                ) VALUES ? 
                ON DUPLICATE KEY UPDATE 
                    merchant_name=VALUES(merchant_name), comm_rate=VALUES(comm_rate), tracking_url=VALUES(tracking_url),
                    relationship=VALUES(relationship), comm_detail=VALUES(comm_detail), site_url=VALUES(site_url),
                    logo=VALUES(logo), categories=VALUES(categories), offer_type=VALUES(offer_type),
                    avg_payment_cycle=VALUES(avg_payment_cycle), avg_payout=VALUES(avg_payout),
                    primary_region=VALUES(primary_region), support_region=VALUES(support_region),
                    rd=VALUES(rd), 
                    updated_at=NOW()
            `;
               const values = ads.map(ad => [
                   userId, 'Linkbux', account.id, ad.mid, ad.merchant_name,
                   ad.comm_rate, ad.tracking_url, ad.relationship, ad.comm_detail, ad.site_url,
                   ad.logo, ad.categories, ad.offer_type, ad.avg_payment_cycle, ad.avg_payout,
                   ad.primary_region, ad.support_region, ad.rd
               ]);
               await client.query(sql, [values]);
            }
            io.to(userId.toString()).emit('sync_progress', {
                progress: 10,
                message: `[${account.account_name}] 广告数据同步完成!`
            });
        } else {
            const message = `[${account.account_name}] 广告数据已存在，跳过同步。`;
            io.to(userId.toString()).emit('sync_progress', {
                progress: 10,
                message
            });
            console.log(`${initialLog} - ${message}`);
        }
        await delay(500);
        // --- Ads 同步结束 ---


        // --- 核心改动 4: 条件性进入主循环（如果交易或结算有任何一个需要同步） ---
        if (syncStatus.shouldSyncTransactions || syncStatus.shouldSyncSettlements) {
            const GLOBAL_END_DATE = new Date();
            const totalDays = Math.max((GLOBAL_END_DATE - GLOBAL_START_DATE) / (1000 * 60 * 60 * 24), 1);
            let completedDays = 0;
            let currentStartDate = new Date(GLOBAL_START_DATE);

            while (currentStartDate <= GLOBAL_END_DATE) {
                let currentEndDate = new Date(currentStartDate);
                currentEndDate.setDate(currentEndDate.getDate() + 60);
                if (currentEndDate > GLOBAL_END_DATE) currentEndDate = new Date(GLOBAL_END_DATE);

                const baseProgress = 10 + Math.min(Math.round((completedDays / totalDays) * 85), 85);
                const formattedStart = formatDate(currentStartDate);
                const formattedEnd = formatDate(currentEndDate);
                io.to(userId.toString()).emit('sync_progress', {
                    progress: baseProgress,
                    message: `[${account.account_name}] 检查 ${formattedStart} -> ${formattedEnd} 区间...`
                });

                // --- 核心改动 5: 在循环内部分别进行条件性同步 ---
                if (syncStatus.shouldSyncTransactions) {
                    const transactionProgressContext = {
                        io,
                        userId,
                        accountName: account.account_name,
                        dataType: '交易',
                        baseProgress,
                        progressWeight: 0
                    };
                    const transactions = await fetchTransactions(decryptedToken, currentStartDate, currentEndDate, transactionProgressContext);
                    if (transactions.length > 0) {
                       const sql = `
                    INSERT INTO transactions (
                        user_id, platform, platform_account_id, platform_transaction_id, platform_ad_id, uid, 
                        order_time, sale_amount, sale_comm, validation_date, order_unit, ip, referer_url, status, merchant_name
                    ) VALUES ? 
                    ON DUPLICATE KEY UPDATE 
                        sale_amount=VALUES(sale_amount), sale_comm=VALUES(sale_comm), validation_date=VALUES(validation_date),
                        order_unit = VALUES(order_unit), ip = VALUES(ip), referer_url = VALUES(referer_url), status = VALUES(status), merchant_name = VALUES(merchant_name), updated_at=NOW()
                `;
                       const values = transactions.map(tx => [
                           userId, 'Linkbux', account.id, tx.linkbux_id, tx.mid, tx.uid,
                           tx.order_time ? new Date(tx.order_time * 1000) : null,
                           tx.sale_amount, tx.sale_comm, tx.validation_date || null, tx.order_unit, tx.ip, tx.referer_url, tx.status, tx.merchant_name
                       ]);
                        await client.query(sql, [values]);
                    }
                }

                if (syncStatus.shouldSyncSettlements) {
                    const settlementProgressContext = {
                        io,
                        userId,
                        accountName: account.account_name,
                        dataType: '结算',
                        baseProgress,
                        progressWeight: 0
                    };
                    const settlements = await fetchSettlements(decryptedToken, currentStartDate, currentEndDate, settlementProgressContext);
                    if (settlements.length > 0) {
                      const sql = `
                    INSERT INTO settlements (
                        user_id, platform, platform_account_id, platform_ad_id,
                        settlement_id, settlement_date, sale_comm, paid_date, payment_id, settlement_type, merchant_name, note
                    ) VALUES ? 
                    ON DUPLICATE KEY UPDATE 
                        platform_ad_id=VALUES(platform_ad_id), settlement_date=VALUES(settlement_date),
                        sale_comm = VALUES(sale_comm), paid_date = VALUES(paid_date), payment_id = VALUES(payment_id),
                        settlement_type = VALUES(settlement_type), merchant_name = VALUES(merchant_name), note = VALUES(note), updated_at = NOW()
                `;
                      const values = settlements.map(s => [
                          userId, 'Linkbux', account.id, s.mid,
                          s.settlement_id,
                          s.settlement_date ? new Date(s.settlement_date) : null,
                          s.sale_comm,
                          s.paid_date ? new Date(s.paid_date) : null,
                          s.payment_id,
                          s.settlement_type,
                          s.merchant_name,
                          s.note || null
                      ]);
                        await client.query(sql, [values]);
                    }
                }
                // --- 分别同步结束 ---

                completedDays += 61;
                currentStartDate.setDate(currentStartDate.getDate() + 61);
                await delay(500);
            }
        } else {
            const message = `[${account.account_name}] 交易和结算数据均已存在，跳过同步。`;
            io.to(userId.toString()).emit('sync_progress', {
                progress: 95,
                message
            }); // 给一个较高的进度
            console.log(`${initialLog} - ${message}`);
        }

        io.to(userId.toString()).emit('sync_complete', {
            message: `账户 [${account.account_name}] 的数据补充同步完成！`
        });
        console.log(`${initialLog} - 同步成功！`);
    } catch (error) {
        io.to(userId.toString()).emit('sync_error', {
            message: `账户 [${account.account_name}] 同步失败: ${error.message}`
        });
        console.error(`${initialLog} - 同步时出错:`, error.message);
    } finally {
        if (client) {
            client.release();
            console.log(`${initialLog} - 数据库客户端已释放。`);
        }
    }
}

module.exports = {
    fetchTransactions,
    runInitialSyncForUser,
    delay
};