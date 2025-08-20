// =======================================================================
// 文件: router_handler/jobs.js (已应用数据库连接池修复)
// 作用: 处理所有广告任务的创建、读取、更新、删除等核心业务。
// 核心改动: 为文件内的 *每一个* 数据库操作函数，包括辅助函数，
//           都增加了完整的 try...catch...finally 结构来管理连接生命周期。
// =======================================================================

const db = require('../db');
const xlsx = require('xlsx');

/**
 * @function getUserIdFromApiKey
 * @description (辅助函数) 通过API密钥获取用户ID，用于脚本身份验证。
 * @note 这是一个关键的修复点。此函数现在会自己管理连接的获取和释放。
 */
const getUserIdFromApiKey = async (apiKey) => {
    if (!apiKey) {
        return {
            error: '请求中缺少API密钥'
        };
    }
    let client; // 1. 声明 client

    try {
        // 2. 获取连接
        client = await db.getClient();
        const keyCheckSql = 'SELECT user_id FROM user_api_keys WHERE api_key = ?';
        const [keys] = await client.query(keyCheckSql, [apiKey]);
        if (keys.length === 0) {
            return {
                error: '无效的API密钥，禁止访问'
            };
        }
        return {
            userId: keys[0].user_id
        };
    } catch (error) {
        console.error("在 getUserIdFromApiKey 中发生错误:", error);
        return {
            error: '数据库查询API密钥时出错'
        };
    } finally {
        // 3. 释放连接
        if (client) client.release();
    }
};

// --- 以下是面向前端用户的函数 ---

exports.getJobs = async (req, res) => {
    console.log('--- 收到获取指令列表的请求 ---');
    let client;
    try {
        client = await db.getClient();
        const isAdmin = req.user.role === 'admin';
        const userId = req.user.id;
        let sql;
        let queryParams = [];
        if (isAdmin) {
            sql = 'SELECT * FROM ad_creation_jobs ORDER BY id DESC';
        } else {
            sql = 'SELECT * FROM ad_creation_jobs WHERE user_id = ? ORDER BY id DESC';
            queryParams.push(userId);
        }
        const [jobs] = await client.query(sql, queryParams);
        res.send({
            status: 0,
            message: '获取指令列表成功！',
            data: jobs
        });
    } catch (error) {
        console.error('获取指令列表时发生错误:', error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

exports.importFromExcel = async (req, res) => {
    if (!req.file) {
        return res.cc('没有上传文件！');
    }
    let client;
    try {
        client = await db.getClient();
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(worksheet);

        const sql = 'INSERT INTO ad_creation_jobs (user_id, sub_account_id, action_type, status, payload) VALUES ?';
        const jobsToInsert = data.map(row => {
            const {
                sub_account_id,
                action_type,
                ...payload
            } = row;
            return [
                req.user.id,
                sub_account_id,
                action_type || 'CREATE',
                'DRAFT',
                JSON.stringify(payload)
            ];
        });

        if (jobsToInsert.length > 0) {
            await client.query(sql, [jobsToInsert]);
            const io = req.app.get('socketio');
            io.emit('jobs_updated', {
                source: 'import'
            });
        }
        res.cc(`成功从Excel导入 ${jobsToInsert.length} 条草稿！`, 0);
    } catch (error) {
        console.error("Excel导入失败:", error);
        res.cc("Excel文件处理失败，请检查格式是否正确。");
    } finally {
        if (client) client.release();
    }
};

exports.saveDraft = async (req, res) => {
    const {
        jobId,
        subAccountId,
        actionType,
        payload
    } = req.body;
    const userId = req.user.id;
    console.log(`--- 用户 [${userId}] 正在保存草稿 ---`);
    let client;
    try {
        client = await db.getClient();
        const draftData = {
            user_id: userId,
            sub_account_id: subAccountId,
            action_type: actionType,
            status: 'DRAFT',
            payload: JSON.stringify(payload)
        };
        if (jobId) {
            const sql = 'UPDATE ad_creation_jobs SET ? WHERE id = ? AND user_id = ?';
            await client.query(sql, [draftData, jobId, userId]);
        } else {
            const sql = 'INSERT INTO ad_creation_jobs SET ?';
            await client.query(sql, draftData);
        }

        const io = req.app.get('socketio');
        io.emit('jobs_updated', {
            source: 'saveDraft'
        });

        res.cc('草稿保存成功！', 0);
    } catch (error) {
        console.error('保存草稿时发生错误:', error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

exports.submitJobs = async (req, res) => {
    const {
        jobIds
    } = req.body;
    const userId = req.user.id;
    if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
        return res.cc('请选择要提交的任务！');
    }
    let client;
    try {
        client = await db.getClient();
        const sql = 'UPDATE ad_creation_jobs SET status = "PENDING_UPDATE", submitted_at = NOW() WHERE id IN (?) AND user_id = ? AND status = "DRAFT"';
        const [result] = await client.query(sql, [jobIds, userId]);

        if (result.affectedRows > 0) {
            const io = req.app.get('socketio');
            io.emit('jobs_updated', {
                source: 'submitJobs'
            });
        }

        res.cc(`成功提交 ${result.affectedRows} 条任务！`, 0);
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

exports.requestDeletion = async (req, res) => {
    const {
        jobId
    } = req.body;
    const userId = req.user.id;
    if (!jobId) {
        return res.cc('缺少任务ID (jobId)');
    }
    console.log(`--- 用户 [${userId}] 请求删除任务 [${jobId}] ---`);
    let client;
    try {
        client = await db.getClient();
        const sql = 'UPDATE ad_creation_jobs SET action_type = "DELETE", status = "PENDING_UPDATE", submitted_at = NOW() WHERE id = ? AND user_id = ?';
        const [result] = await client.query(sql, [jobId, userId]);

        if (result.affectedRows > 0) {
            const io = req.app.get('socketio');
            io.emit('jobs_updated', {
                source: 'requestDeletion'
            });
            res.cc('删除请求已提交，等待脚本执行！', 0);
        } else {
            res.cc('未找到可删除的任务，或任务不属于您');
        }
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

exports.requestBatchDeletion = async (req, res) => {
    const {
        jobIds
    } = req.body;
    const userId = req.user.id;
    if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
        return res.cc('请选择要删除的任务！');
    }
    console.log(`--- 用户 [${userId}] 请求批量删除任务 [${jobIds.join(',')}] ---`);
    let client;
    try {
        client = await db.getClient();
        const sql = 'UPDATE ad_creation_jobs SET action_type = "DELETE", status = "PENDING_UPDATE", submitted_at = NOW() WHERE id IN (?) AND user_id = ?';
        const [result] = await client.query(sql, [jobIds, userId]);

        if (result.affectedRows > 0) {
            const io = req.app.get('socketio');
            io.emit('jobs_updated', {
                source: 'requestBatchDeletion'
            });
            res.cc(`成功提交 ${result.affectedRows} 条删除请求！`, 0);
        } else {
            res.cc('未找到可删除的任务，或任务不属于您');
        }
    } catch (error) {
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

// --- 以下是专门供Ads脚本调用的函数 ---

exports.getPendingJobs = async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    // 首先验证API Key，这个辅助函数现在是安全的
    const authResult = await getUserIdFromApiKey(apiKey);
    if (authResult.error) {
        return res.status(401).send({
            status: 1,
            message: authResult.error
        });
    }
    const userId = authResult.userId;
    console.log(`--- Ads脚本 (用户ID: ${userId}) 正在请求待处理任务 ---`);

    let client;
    try {
        client = await db.getClient();
        const selectSql = "SELECT * FROM ad_creation_jobs WHERE status = 'PENDING_UPDATE' AND user_id = ?";
        const [jobs] = await client.query(selectSql, [userId]);

        if (jobs.length > 0) {
            const jobIds = jobs.map(job => job.id);
            const updateSql = "UPDATE ad_creation_jobs SET status = 'PROCESSING' WHERE id IN (?)";
            await client.query(updateSql, [jobIds]);
            const io = req.app.get('socketio');
            io.emit('jobs_updated', {
                source: 'getPendingJobs'
            });
        }
        res.json(jobs);
    } catch (error) {
        console.error("获取待处理任务失败:", error);
        res.status(500).send({
            status: 1,
            message: "服务器内部错误"
        });
    } finally {
        if (client) client.release();
    }
};

exports.updateJobStatus = async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const authResult = await getUserIdFromApiKey(apiKey);
    if (authResult.error) {
        return res.status(401).send({
            status: 1,
            message: authResult.error
        });
    }
    const userId = authResult.userId;
    console.log(`--- Ads脚本 (用户ID: ${userId}) 正在更新任务状态 ---`);
    const {
        jobId,
        status,
        message
    } = req.body;
    if (!jobId || !status) {
        return res.status(400).send("缺少 jobId 或 status");
    }

    let client;
    try {
        client = await db.getClient();
        const sql = 'UPDATE ad_creation_jobs SET status = ?, result_message = ?, processed_at = NOW() WHERE id = ? AND user_id = ?';
        await client.query(sql, [status, message, jobId, userId]);

        const io = req.app.get('socketio');
        io.emit('jobs_updated', {
            source: 'updateJobStatus',
            updatedJob: {
                id: jobId,
                status: status
            }
        });

        res.send({
            message: '状态更新成功'
        });
    } catch (error) {
        console.error("更新任务状态失败:", error);
        res.status(500).send({
            status: 1,
            message: "服务器内部错误"
        });
    } finally {
        if (client) client.release();
    }
};
