const db = require('../db');
const moment = require('moment');

/**
 * @function createLinkJob
 * @description 创建一个新的换链接任务
 */
exports.createLinkJob = async (req, res) => {
    const userId = req.user.id;
    const {
        mcc_name,
        sub_account_name,
        campaign_name,
        affiliate_offer_link,
        affiliate_offer_params,
        advertiser_link,
        proxy_country,
        change_interval_minutes,
        referer_link
    } = req.body;

    // 基本的参数校验
    if (!sub_account_name || !campaign_name || !affiliate_offer_link) {
        return res.cc('子账号名称、广告系列名称和Offer链接为必填项');
    }

    let client;
    try {
        client = await db.getClient();
        const sql = `
            INSERT INTO link_change_jobs (
                user_id, mcc_name, sub_account_name, campaign_name, affiliate_offer_link,
                affiliate_offer_params, advertiser_link, proxy_country, change_interval_minutes, referer_link
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const [results] = await client.query(sql, [
            userId,
            mcc_name,
            sub_account_name,
            campaign_name,
            affiliate_offer_link,
            affiliate_offer_params,
            advertiser_link,
            proxy_country,
            change_interval_minutes || 10, // 如果前端没传，默认为10分钟
            referer_link
        ]);

        if (results.affectedRows !== 1) {
            return res.cc('创建换链接任务失败，请稍后再试');
        }

        res.send({
            status: 0,
            message: '换链接任务已成功创建！'
        });

    } catch (error) {
        console.error("创建换链接任务时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

/**
 * @function getLinkJobs
 * @description 获取当前用户的所有换链接任务
 */
exports.getLinkJobs = async (req, res) => {
    const userId = req.user.id;
    let client;

    try {
        client = await db.getClient();
        const sql = 'SELECT * FROM link_change_jobs WHERE user_id = ? ORDER BY created_at DESC';
        const [jobs] = await client.query(sql, [userId]);

        // 格式化时间字段，使其对前端更友好
        const formattedJobs = jobs.map(job => ({
            ...job,
            ads_last_operation_time: job.ads_last_operation_time ? moment(job.ads_last_operation_time).format('YYYY-MM-DD HH:mm:ss') : null,
            last_change_time: job.last_change_time ? moment(job.last_change_time).format('YYYY-MM-DD HH:mm:ss') : null,
            last_generated_time: job.last_generated_time ? moment(job.last_generated_time).format('YYYY-MM-DD HH:mm:ss') : null,
            created_at: moment(job.created_at).format('YYYY-MM-DD HH:mm:ss'),
            updated_at: moment(job.updated_at).format('YYYY-MM-DD HH:mm:ss')
        }));

        res.send({
            status: 0,
            message: '获取换链接任务列表成功！',
            data: formattedJobs
        });

    } catch (error) {
        console.error("获取换链接任务列表时出错:", error);
        res.cc(error);
    } finally {
        if (client) client.release();
    }
};

