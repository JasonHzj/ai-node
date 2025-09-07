const db = require('./db');
const linkbuxService = require('./services/linkbux.service');
const {
    getAccountsToSync,
    syncDailyMajorData
} = require('./jobs/syncPlatforms');

/**
 * 手动回填指定时间范围内的点击数据
 */
async function backfillClicks(startDate, endDate) {
    console.log(`[手动任务] ==> 开始回填从 ${startDate.toISOString().slice(0, 10)} 到 ${endDate.toISOString().slice(0, 10)} 的点击数据...`);
    let client;
    try {
        client = await db.getClient();
        const accounts = await getAccountsToSync(client);
        if (client) client.release();
        client = null;

        if (accounts.length === 0) {
            console.log('[手动任务] ==> 没有找到需要同步的账户。');
            return;
        }

        // --- ▼▼▼ 核心修正：按天循环获取数据 ▼▼▼ ---
        // 循环遍历从开始日期到结束日期的每一天
        let currentDay = new Date(startDate);
        while (currentDay <= endDate) {

            // 将当前循环的日期格式化为 YYYY-MM-DD
            const formattedDate = currentDay.toISOString().slice(0, 10);
            console.log(`\n--- 正在处理日期: ${formattedDate} ---`);

            // 对于每一天，都去为所有账户获取数据
            for (const acc of accounts) {
                // 将当天的开始时间和结束时间传入接口，确保跨度不超过24小时
                const clicks = await linkbuxService.fetchClicks(acc.token, currentDay, currentDay);

                if (clicks && clicks.length > 0) {
                    client = await db.getClient();
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
                    console.log(`  - [用户 ${acc.user_id}, 账户 ${acc.account_id}] 在 ${formattedDate} 成功处理了 ${clicks.length} 条点击数据。`);
                    if (client) client.release();
                    client = null;
                } else {
                    console.log(`  - [用户 ${acc.user_id}, 账户 ${acc.account_id}] 在 ${formattedDate} 没有发现新的点击。`);
                }
            }
            // 将日期增加一天，进行下一次循环
            currentDay.setDate(currentDay.getDate() + 1);
        }
        // --- ▲▲▲ 修正结束 ▲▲▲ ---

    } catch (error) {
        console.error('[手动任务] ==> 回填点击数据时出错:', error.message);
    } finally {
        if (client) client.release();
        console.log('\n[手动任务] ==> 所有日期的点击数据回填任务结束。');
    }
}

/**
 * 主执行函数
 */
async function runManualSync() {
    try {
        console.log('--- [手动同步脚本] 开始执行 ---');

        console.log('--- 正在初始化数据库连接... ---');
        await db.initializePool();
        console.log('--- 数据库连接成功！ ---');

        // 1. 执行每日主任务 (补全交易和广告)
        console.log('\n--- 步骤 1/2: 正在补全交易和广告数据... ---');
        await syncDailyMajorData();
        console.log('--- 步骤 1/2: 交易和广告数据补全完成！ ---\n');

        // 2. 接着执行点击数据的回填
        console.log('--- 步骤 2/2: 正在补全点击数据... ---');
        const missingDataStartDate = new Date('2025-08-01');
        const missingDataEndDate = new Date('2025-09-03');
        await backfillClicks(missingDataStartDate, missingDataEndDate);
        console.log('--- 步骤 2/2: 点击数据补全完成！ ---\n');

    } catch (error) {
        console.error('--- [手动同步脚本] 发生严重错误:', error);
    } finally {
        console.log('--- [手动同步脚本] 所有任务执行完毕，正在关闭数据库连接... ---');
        await db.closePool();
        console.log('--- 数据库连接已关闭。脚本退出。 ---');
    }
}

// 运行主函数
runManualSync();