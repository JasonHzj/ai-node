const cron = require('node-cron');
const db = require('../db');
const linkbuxService = require('../services/linkbux.service'); // 引入我们刚创建的 service
const {
    Buffer
} = require('buffer');

/**
 * @function syncAllUsersData
 * @description 定时任务，为所有配置了Token的用户同步数据
 */
const syncAllUsersData = async () => {
    console.log('--- [定时任务] 开始执行每日联盟数据同步 ---');
    let client;

    try {
        client = await db.getClient();

        // 1. 找到所有配置了Linkbux Token的用户
        const getUsersSql = 'SELECT id, linkbux_api_token FROM users WHERE linkbux_api_token IS NOT NULL';
        const [usersToSync] = await client.query(getUsersSql);

        if (usersToSync.length === 0) {
            console.log('--- [定时任务] 没有找到任何需要同步的用户。 ---');
            return;
        }

        console.log(`--- [定时任务] 发现 ${usersToSync.length} 个用户需要同步数据。 ---`);

        // 2. 为每个用户单独执行同步
        for (const user of usersToSync) {
            try {
                // 解密Token
                const token = Buffer.from(user.linkbux_api_token, 'base64').toString('ascii');

                // 我们采用分层更新策略
                // a. 高频更新区：同步过去30天的数据，捕获近期新订单和状态变更
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                const transactions = await linkbuxService.fetchTransactions(token, thirtyDaysAgo, new Date());

                // b. 将数据存入数据库 (UPSERT)
                if (transactions && transactions.length > 0) {
                    const values = transactions.map(tx => [
                        user.id,
                        'Linkbux',
                        tx.linkbux_id,
                        tx.mid,
                        tx.merchant_name,
                        tx.uid,
                        tx.order_time ? new Date(tx.order_time * 1000) : null,
                        tx.validation_date || null,
                        tx.sale_amount,
                        tx.sale_comm,
                        tx.status,
                        tx.order_unit,
                        tx.ip,
                        tx.referer_url
                    ]);

                    const upsertSql = `
                        INSERT INTO transactions (
                            user_id, platform, platform_transaction_id, platform_ad_id, merchant_name,
                            uid, order_time, validation_date, sale_amount, sale_comm, status,
                            order_unit, ip, referer_url
                        ) VALUES ?
                        ON DUPLICATE KEY UPDATE
                            platform_ad_id = VALUES(platform_ad_id),
                            merchant_name = VALUES(merchant_name),
                            uid = VALUES(uid),
                            order_time = VALUES(order_time),
                            validation_date = VALUES(validation_date),
                            sale_amount = VALUES(sale_amount),
                            sale_comm = VALUES(sale_comm),
                            status = VALUES(status),
                            order_unit = VALUES(order_unit),
                            ip = VALUES(ip),
                            referer_url = VALUES(referer_url),
                            updated_at = NOW()
                    `;
                    await client.query(upsertSql, [values]);
                }
                console.log(`--- [定时任务] 成功为用户 [${user.id}] 同步了 ${transactions.length} 条数据。 ---`);

            } catch (error) {
                console.error(`--- [定时任务] 为用户ID [${user.id}] 同步数据时失败:`, error.message);
            }
        }
    } catch (error) {
        console.error('--- [定时任务] 执行失败:', error.message);
    } finally {
        if (client) {
            client.release();
        }
        console.log('--- [定时任务] 本次联盟数据同步结束 ---');
    }
};

/**
 * 启动定时任务
 * 每天凌晨3点执行一次
 */
const start = () => {
    cron.schedule('0 3 * * *', syncAllUsersData, {
        timezone: "Asia/Shanghai" // 建议指定时区
    });
    console.log('联盟数据同步定时任务已设置，将在每天凌晨3点运行。');
};

module.exports = {
    start
};