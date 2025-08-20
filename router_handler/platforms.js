const db = require('../db');
const linkbuxService = require('../services/linkbux.service');

const {
    Buffer
} = require('buffer'); // 引入 Buffer 用于加密解密

/**
 * @function saveLinkbuxConfig
 * @description 保存或更新当前用户的Linkbux API Token
 */
exports.saveLinkbuxConfig = async (req, res) => {
    const userId = req.user.id;
    const {
        token
    } = req.body;

    if (!token) {
        return res.cc('API Token 不能为空！');
    }

    let client;
    try {
        client = await db.getClient();

        // 注意：简单的 Base64 不是真正的加密，仅用于示例。
        // 在生产环境中，推荐使用 crypto 模块的 AES 加密，并安全存储密钥。
        const encryptedToken = Buffer.from(token).toString('base64');

        const sql = 'UPDATE users SET linkbux_api_token = ? WHERE id = ?';
        const [result] = await client.query(sql, [encryptedToken, userId]);

        if (result.affectedRows !== 1) {
            return res.cc('配置保存失败，请重试！');
        }

        res.cc('Linkbux 配置保存成功！', 0);

    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
        }
    }
};

/**
 * @function getTransactions
 * @description 获取当前登录用户的所有平台交易数据
 */
exports.getTransactions = async (req, res) => {
    const userId = req.user.id;
    let client;
    try {
        client = await db.getClient();
        const sql = 'SELECT * FROM transactions WHERE user_id = ? ORDER BY order_time DESC';
        const [transactions] = await client.query(sql, [userId]);

        res.send({
            status: 0,
            message: '获取交易数据成功！',
            data: transactions
        });

    } catch (error) {
        res.cc(error);
    } finally {
        if (client) {
            client.release();
        }
    }
};

exports.triggerInitialSync = async (req, res) => {
    const {
        accountId,
        startDate
    } = req.body;
    const userId = req.user.id;
    let client;

    if (!accountId || !startDate) {
        return res.cc('缺少账户ID或起始日期！');
    }

    try {
        client = await db.getClient();

        // 1. 快速从数据库获取账户信息
        const sql = 'SELECT * FROM user_platform_accounts WHERE id = ? AND user_id = ?';
        const [accounts] = await client.query(sql, [accountId, userId]);

        if (accounts.length !== 1) {
            return res.cc('未找到指定的平台账户或账户不属于您。');
        }

        const account = accounts[0];
        const io = req.app.get('socketio');

        // --- 核心改动：不再使用 await 等待任务完成 ---
        // 立即向前端返回成功响应
        res.cc('历史数据同步任务已在后台成功启动，请关注进度更新。', 0);

        // 使用 setTimeout(..., 0) 将重量级任务推入事件循环的下一个tick执行
        // 这确保了HTTP响应可以被优先发送出去，从而释放主线程
        setTimeout(() => {
            console.log(`[任务调度] ==> API请求已响应，开始在后台为用户 [${userId}] 执行同步任务...`);
            // 在后台异步执行，不阻塞API响应
            linkbuxService.runInitialSyncForUser(io, userId, account, startDate)
                .catch(err => {
                    // 即使是后台任务，也应该有错误处理
                    console.error(`[后台任务] ==> 用户 [${userId}] 的账户 [${account.account_name}] 同步任务执行时发生未捕获的严重错误:`, err);
                });
        }, 0);
        // --- 改动结束 ---

    } catch (error) {
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};