// =======================================================================
// 文件: router_handler/keys.js (已应用数据库连接池修复)
// 作用: 包含生成、获取、删除API密钥的核心业务逻辑。
// 核心改动: 为所有函数增加了 finally 块来确保数据库连接被安全释放。
// =======================================================================

const db = require('../db');
const crypto = require('crypto'); // 导入Node.js内置的加密模块

/**
 * @function getMyApiKeys
 * @description 获取当前登录用户的所有Ads脚本API密钥
 */
exports.getMyApiKeys = async (req, res) => {
    const userId = req.user.id;
    let client; // 1. 在 try 外部声明 client

    try {
        // 2. 从连接池获取连接
        client = await db.getClient();
        const sql = 'SELECT id, api_key, description, created_at FROM user_api_keys WHERE user_id = ? ORDER BY id DESC';
        const [keys] = await client.query(sql, [userId]);
        res.send({
            status: 0,
            message: '获取API密钥列表成功！',
            data: keys
        });
    } catch (error) {
        res.cc(error);
    } finally {
        // 3. 关键：释放连接
        if (client) {
            client.release();
            console.log("GetMyApiKeys: 数据库连接已释放");
        }
    }
};

/**
 * @function generateApiKey
 * @description 为当前登录的用户生成一个新的API密钥
 */
exports.generateApiKey = async (req, res) => {
    const userId = req.user.id;
    const {
        description
    } = req.body;
    let client; // 1. 声明 client

    try {
        // 2. 获取连接
        client = await db.getClient();
        const apiKey = crypto.randomBytes(32).toString('hex');
        const newKeyData = {
            user_id: userId,
            api_key: apiKey,
            description: description || 'Ads Script Key'
        };
        const sql = 'INSERT INTO user_api_keys SET ?';
        const [result] = await client.query(sql, newKeyData);

        if (result.affectedRows !== 1) {
            return res.cc('生成API密钥失败，请稍后再试');
        }

        res.send({
            status: 0,
            message: 'API密钥生成成功！请立即复制并妥善保管。',
            data: {
                id: result.insertId,
                apiKey: apiKey,
                description: newKeyData.description,
                created_at: new Date()
            }
        });
    } catch (error) {
        res.cc(error);
    } finally {
        // 3. 释放连接
        if (client) {
            client.release();
            console.log("GenerateApiKey: 数据库连接已释放");
        }
    }
};

/**
 * @function deleteApiKey
 * @description 删除一个属于当前用户的API密钥
 */
exports.deleteApiKey = async (req, res) => {
    const keyId = req.params.id;
    const userId = req.user.id;
    let client; // 1. 声明 client

    try {
        // 2. 获取连接
        client = await db.getClient();
        const sql = 'DELETE FROM user_api_keys WHERE id = ? AND user_id = ?';
        const [result] = await client.query(sql, [keyId, userId]);

        if (result.affectedRows !== 1) {
            return res.cc('删除失败，密钥不存在或不属于您');
        }

        res.cc('API密钥删除成功！', 0);
    } catch (error) {
        res.cc(error);
    } finally {
        // 3. 释放连接
        if (client) {
            client.release();
            console.log("DeleteApiKey: 数据库连接已释放");
        }
    }
};
