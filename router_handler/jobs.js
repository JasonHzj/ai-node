// 文件: router_handler/jobs.js (最终修改版，与您的项目文件结构完全匹配)
// 核心改动:
// 1. 在 saveDraft 函数中集成了创建/更新/删除 link_change_jobs 的逻辑。
// 2. 使用了数据库事务来确保数据一致性。
// 3. 表名和字段名 (ad_creation_jobs, status) 均与您的代码保持一致。
// =======================================================================

const db = require('../db');
const xlsx = require('xlsx');


const getUserIdFromApiKey = async (apiKey) => {
    if (!apiKey) {
        return {
            error: '请求中缺少API密钥'
        };
    }
    let client;
    try {
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
        if (client) client.release();
    }
};

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

/**
 * @function saveDraft (V2 - 集成换链接任务)
 * @description 创建或更新一个广告任务草稿，并根据需要同步创建、更新或删除关联的换链接任务。
 */
exports.saveDraft = async (req, res) => {
    const userId = req.user.id;
    const {
        // --- 原有字段 ---
        jobId: existingJobId, // 重命名以区分
        subAccountId,
        actionType,
        payload,
        // --- 新增字段 ---
        enable_link_change,
        affiliate_offer_link,
        affiliate_offer_params,
        change_interval_minutes,
        referer_link
    } = req.body;

    console.log(`--- 用户 [${userId}] 正在保存草稿 (换链接任务: ${enable_link_change ? '启用' : '禁用'}) ---`);
    if (!subAccountId || !actionType || !payload) {
        return res.cc('缺少必要的参数: subAccountId, actionType, payload');
    }

    let client;
    try {
        client = await db.getClient();
        await client.beginTransaction(); // <--- 开启事务

        // --- 步骤 1: 创建或更新 ad_creation_jobs 表的主任务 ---
        let jobId = existingJobId;
        let message;

        const draftData = {
            user_id: userId,
            sub_account_id: subAccountId,
            action_type: actionType,
            status: 'DRAFT', // 保存时总是重置为 DRAFT
            payload: JSON.stringify(payload),
            result_message: null // 清空之前的错误信息
        };

        if (jobId) {
            // 更新现有任务
            const sql = 'UPDATE ad_creation_jobs SET ? WHERE id = ? AND user_id = ?';
            await client.query(sql, [draftData, jobId, userId]);
            message = '广告草稿已成功更新！';
        } else {
            // 插入新任务
            const sql = 'INSERT INTO ad_creation_jobs SET ?';
            const [createResult] = await client.query(sql, draftData);
            jobId = createResult.insertId;
            message = '广告草稿已成功创建！';
        }

        // --- 步骤 2: 根据 enable_link_change 的状态，处理 link_change_jobs 表 ---
        if (enable_link_change) {
            // --- 2a: 如果启用了换链接，则创建或更新 ---
            const getAccountInfoSql = 'SELECT manager_name, sub_account_name FROM google_ads_accounts WHERE sub_account_id = ? AND user_id = ?';
            const [accounts] = await client.query(getAccountInfoSql, [subAccountId, userId]);
            if (accounts.length === 0) throw new Error(`找不到ID为 ${subAccountId} 的账户信息。`);
            const {
                manager_name,
                sub_account_name
            } = accounts[0];

          // ▼▼▼ 【V3 核心修复】处理默认国家 ▼▼▼
          let proxy_country = 'US'; // 默认设置为 'US'
          if (payload.locations && payload.locations.length > 0) {
              const getCountryCodesSql = 'SELECT country_code FROM google_ads_countries WHERE criterion_id IN (?)';
              const [countries] = await client.query(getCountryCodesSql, [payload.locations]);
              if (countries.length > 0) {
                  proxy_country = countries.map(c => c.country_code).join(',');
              }
          }
          // ▲▲▲ 修复结束 ▲▲▲

            const linkJobData = {
                user_id: userId,
                ad_job_id: jobId, // 关联主任务ID
                mcc_name: manager_name,
                sub_account_name: sub_account_name,
                campaign_name: payload.campaignName,
                affiliate_offer_link,
                affiliate_offer_params,
                advertiser_link: payload.adLink, // 广告主链接就是广告链接
                proxy_country,
                change_interval_minutes: change_interval_minutes || 10,
                referer_link
            };

            const findLinkJobSql = 'SELECT id FROM link_change_jobs WHERE ad_job_id = ?';
            const [existingLinkJobs] = await client.query(findLinkJobSql, [jobId]);

            if (existingLinkJobs.length > 0) {
                const updateLinkJobSql = 'UPDATE link_change_jobs SET ? WHERE id = ?';
                await client.query(updateLinkJobSql, [linkJobData, existingLinkJobs[0].id]);
            } else {
                const createLinkJobSql = 'INSERT INTO link_change_jobs SET ?';
                await client.query(createLinkJobSql, linkJobData);
            }
        } else {
            // --- 2b: 如果未启用，则删除可能存在的旧记录 ---
            const deleteLinkJobSql = 'DELETE FROM link_change_jobs WHERE ad_job_id = ?';
            await client.query(deleteLinkJobSql, [jobId]);
        }

        await client.commit(); // <--- 提交事务

        const io = req.app.get('socketio');
        io.emit('jobs_updated', {
            source: 'saveDraft',
            jobId
        });
        res.cc(message, 0);

    } catch (error) {
        if (client) await client.rollback(); // <--- 回滚事务
        console.error('保存草稿时发生错误:', error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};


// ... (submitJobs, requestDeletion, requestBatchDeletion 等其他函数保持不变) ...
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